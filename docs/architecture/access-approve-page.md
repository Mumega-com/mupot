# Access approve page: the agent prepares, the human taps once

Status: implemented behind a feature flag, off by default. Host rule and `ACCESS_REQUIRED_AMR` below. Code: `src/access/*`, migration `0211_seed_attach_requests.sql`, MCP tool `seed_attach_request`.

## What it is

A server-rendered page at `/approve/*` that a human opens from a link an agent hands them. It sits behind a Cloudflare Access application, so the person proves who they are with a passkey or biometric at the edge, and the Worker re-verifies that proof on every request. It decides two things:

1. **Seed attach**: applying a `mupot.seed/v1` that an agent filed with `seed_attach_request`.
2. **Elevation requests**: approving or denying a pending request an agent filed with `request_elevation`, optionally narrowed.

Nothing is decided over MCP, chat or any bearer. Those channels only carry the link (`approve_url`).

## Why a dedicated hostname (the rule everything else rests on)

The Cloudflare Access cookie (`CF_Authorization`) is scoped to a HOST. Anything else served on that host receives the human's Access JWT, and a route that proxies into agent-deployable code (the `/preview/*` proxy) or accepts bearers (`/mcp`) could replay it, and the approve page issues a CSRF token to whoever holds the JWT. An `Origin` check does not stop a server-side caller. So:

- the approval page lives ONLY on its own hostname, `ACCESS_CANONICAL_HOST`, which must be set and must differ from every colony host (`PUBLIC_ORIGIN`'s host and the built-in default colony host). Unset, malformed, or equal to a colony host: the page is never enabled (`seed_attach_request` refuses with the reason, no `approve_url` is issued, `/approve/*` is a 404);
- a host gate runs as the very first statement of the Worker's `fetch` (before tenant routing, hostname dispatch, OAuth, MCP, preview and the dashboard): on the approval host every path except `/approve/*` is a 404, and `/approve/*` on any other host is a 404 (percent-encoded spellings included);
- the Access application must cover the WHOLE approval hostname (not a path), and the hostname must be distinct from the colony host and must NOT sit under the colony domain or the pot host suffix (`approve.<colony>` is refused: tenant/project hostname routing keys on the first label, so an agent project named `approve` could own it). Use a host under a domain the colony does not route, e.g. `approve.<company domain>`;
- on the approval host, `/approve/*` is served directly by the approve app: tenant routing, hostname dispatch and every other handler are skipped, so nothing on that host can forward the Access cookie into a user Worker;
- create no other DNS records under the approval host, and use Access's Binding Cookie: Cloudflare scopes `CF_Authorization` to the domain and its subdomains unless the cookie path attribute is set.

## Flag

`ACCESS_APPROVE_ENABLED` unset (or anything but `1`/`true`): every `/approve/*` path answers 404 and the request tools return no `approve_url` (`seed_attach_request` refuses with `access_approve_not_enabled` before writing anything).

## Environment

| Variable | Meaning |
|---|---|
| `ACCESS_APPROVE_ENABLED` | `1` or `true` turns the page on |
| `ACCESS_TEAM_DOMAIN` | `<team>.cloudflareaccess.com` (scheme optional; any other host is rejected) |
| `ACCESS_AUD` | the Access application's AUD tag, matched exactly |
| `ACCESS_CANONICAL_HOST` | the DEDICATED approval hostname, for example `approve.example.com`. Required; must differ from the colony host. The Worker serves only `/approve/*` on it |
| `ACCESS_MAX_JWT_AGE_SECONDS` | optional, default 60, capped at 300: how recent the Access login must be |
| `ACCESS_REQUIRED_AMR` | optional comma list (for example `hwk,swk`): the Access token's `amr` claim must contain at least one. See "Proving a human, not just a login" |
| `CONNECTOR_MASTER_KEY` | existing server secret; the CSRF key is derived from it (HKDF, info `mupot_access_approve_csrf_v1`). Absent: the page and POST fail closed with 503 |

Enabled with any of the first four missing or malformed, or the host not dedicated: never an open page (503 on the approval host, 404 elsewhere).

## What the Worker checks on every request (GET and POST)

1. Flag on, config complete, host dedicated.
2. `Host` equals `ACCESS_CANONICAL_HOST`. Any other host (including a `workers.dev` hostname) is a 404.
3. `Cf-Access-Jwt-Assertion` verifies: RS256 only, signature against the team JWKS (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, cached one hour, refetched on an unknown `kid` at most once per 30 seconds), `iss` equals `https://<team>.cloudflareaccess.com`, `aud` contains the configured tag exactly, `exp` in the future, `iat` within the freshness window, and the token names a human (`email` and `sub` present; service-token JWTs have neither).
4. The Access identity (provider `cloudflare-access`, subject = JWT `sub`) resolves through an **existing, explicit, live `human_login_identities` row** (`resolveLoginIdentity`) to a member that is **active, unarchived and not an agent's welded member row**. There is no email fallback and **no auto-link on first login**: this code never writes an identity row. An unlinked identity is refused and the page shows its `sub`. The legacy org role is read from the resolved member's own email through the shared `findUserByEmail` chokepoint, never from the JWT email.
5. The member holds the authority the decision needs: org admin for a seed; for an elevation, the existing `canDecideElevation` / `decideElevationRequest` authority on the request's scope. Out-of-authority and unknown ids read identically (404).

POST adds: a same-origin `Origin` header (and `Sec-Fetch-Site` same-origin when present), and a CSRF token bound to this login (request kind, request id, Access subject, JWT `iat`). Every response carries `Referrer-Policy: same-origin` (not `no-referrer`: that makes browsers send `Origin: null` on form POSTs, which the guard refuses, so no real tap would work).

No row of any kind (approver web session, identity link) is written until every authority check has passed. The deciding POST mints the approver web session only after the member and scope authority are confirmed, because an elevation grant and its decision row bind to a session for this login; a deny therefore also records a session (it is the decision row's `decided_by_web_session_hash`).

Freshness note: Access exposes no `auth_time` claim, so the Worker treats `iat` as the login time. If the person's Access session is older than the window, the page says so and asks them to sign out of Access and reopen the link. Keep the Access session duration short so this is rare, and approve right after signing in. The default window is 60 seconds (`ACCESS_MAX_JWT_AGE_SECONDS`, max 300); it is a documented limit, not a proof of presence.

## Proving a human, not just a login

A fresh `iat` shows a recent token, not that a person touched an authenticator. What Cloudflare documents (checked 2026-10-11):

- Application token claims: `aud`, `email`, `exp`, `iat`, `nbf`, `iss`, `type`, `identity_nonce`, `sub`, `country`. No `amr` or `auth_time` is listed. Source: Cloudflare Zero Trust docs, "Application token" (`developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/`).
- MFA requirements page: "Certain identity providers also share the MFA method presented by the user. Access can add these values into the JWT", following RFC 8176 authentication method references; the page does not name the claim. To require MFA on every login it says to set the authentication duration to "Require every login" (API `session_duration: "0m"`). Source: `developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/`.

So the claim name is not confirmed by Cloudflare. `ACCESS_REQUIRED_AMR` is therefore an opt-in, fail-closed check on a claim named `amr` (the RFC 8176 name): when set, a token without an `amr` array containing one of the listed values is refused. Turn it on only after you have decoded a real token from your own Access login and seen the value your identity provider emits; if the claim is absent the page will refuse everyone, which is the safe direction.

When `ACCESS_REQUIRED_AMR` is unset, the Access application settings below are what make a fresh login mean a person: independent MFA with duration `0m` ("Require every login", every login prompts), allowed authenticators limited to security keys / biometrics (restrict by AAGUID), AMR matching off. The admin must verify these in the Access dashboard; this Worker cannot see them.

## Seed attach

1. The agent calls `seed_attach_request { seed }`. The seed is validated exactly like the `seed_attach` dry run. The canonical form, its digest and the keyed request list are stored as a pending row in `seed_attach_requests` (single-use, 24 hours, at most 10 live pending per requester; asking again for the same seed returns the same request). The result carries `request_id` and `approve_url`.
2. The human opens `approve_url`, sees the project slug, kind, repo, live URL, seat cap and every request in words, and the agent-written name and goal inside an "untrusted, written by the agent" box.
3. Approve: the stored seed is re-validated (digest and every request key must still match), the request is consumed by one guarded `UPDATE ... WHERE status = 'pending' AND expires_at > now`, then the existing `applySeed` runs with every request key accepted. The human's Access-verified POST stands in for the dry-run `accept_token`; this proof is a server-side argument that MCP arguments cannot carry. The seed receipt (`mutation_audit_entries`, origin `admin_ui`) records `via: access_passkey` and the request id. Applying a seed still grants nothing.
4. Deny writes its own receipt. A second POST, a second tab or an expired request is refused.

`seed_attach` (dry run and apply with `accept_token`) is unchanged.

## Elevation

The page lists the agent, each action with its description and effect classification, scope (read-only here), the decide-by time, and the agent's reason inside the untrusted box. The human can untick actions and pick a shorter duration; `decideElevationRequest` rejects any widening. The Access login just completed counts as the step-up (`recentReauthOk`), so sensitive actions can be approved here. The grant binds to a web session created for this login and marked freshly re-authenticated, exactly as a dashboard grant binds to its own. The decision row records `via:access_passkey` in its note and a receipt is written to `mutation_audit_entries` (origin `admin_ui`, handler `access_approve`). The receipt is written after the decision; if that write fails the page says so and the decision stands (the decision row is authoritative).

## Cloudflare setup the owner must do

These are account changes; nothing in this repository makes them.

1. Create a DNS name for the approval page that is NOT the colony host (for example `approve.example.com`) and route it to this Worker. Create an Access **self-hosted application** covering the WHOLE hostname (no path restriction: the Worker serves nothing but `/approve/*` there, and a path-scoped application would leave other paths unprotected).
2. Policy: **Allow** exactly the owner's email through the chosen identity provider. No Bypass rule, no Service Auth rule, no service tokens.
3. Independent MFA on the application: duration `0m` (prompt on every Access login), authenticators limited to biometrics or security keys (restrict by AAGUID), **AMR matching off** so the identity provider's earlier MFA cannot skip the prompt.
4. Shortest available application session duration.
5. Enroll the owner's passkey in Access once, in their own browser.
6. Turn `workers_dev` (and preview URLs) **off** for the Worker so the page is reachable only on the canonical host behind Access.
7. Set the environment variables above (`ACCESS_AUD` is shown on the application's overview page) and the `ACCESS_APPROVE_ENABLED` flag last.
8. Link the owner's Access identity to their member explicitly, once. Nothing links automatically. Open the approval link, read the Access subject the refusal page shows, and have a workspace owner create the `human_login_identities` row (provider `cloudflare-access`, that subject, the member id) through the same one-time ceremony other providers use.

## Limits (honest)

- Access gives no per-transaction signature: the page proves a fresh, strong login and a same-origin tap on a specific request, not a signed approval of its exact content. A WebAuthn assertion whose challenge is the hash of the grant would close that and is a separate, later change.
- The seed request moves `pending -> applying -> applied | failed`. If the apply throws after the claim the row is moved to `failed` (`apply_threw`) by a guarded update; a seed that was already applied (replay) is reported as already applied, not as created. At most one pending request exists per requester and seed digest (partial unique index); an expired pending row is marked `expired` when the same seed is filed again. `seed_attach_request` is not listed in `tools/list` while the flag is off.
- JWKS: keys are cached one hour; if a refetch fails, cached keys are trusted for at most 24 hours, then the page fails closed.
- Authority for the legacy owner role plane follows the dashboard (`users.role` by verified email); capability rows apply to plain members.
