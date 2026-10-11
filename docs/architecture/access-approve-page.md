# Access approve page: the agent prepares, the human taps once

Status: implemented behind a feature flag, off by default. Code: `src/access/*`, migration `0211_seed_attach_requests.sql`, MCP tool `seed_attach_request`.

## What it is

A server-rendered page at `/approve/*` that a human opens from a link an agent hands them. It sits behind a Cloudflare Access application, so the person proves who they are with a passkey or biometric at the edge, and the Worker re-verifies that proof on every request. It decides two things:

1. **Seed attach**: applying a `mupot.seed/v1` that an agent filed with `seed_attach_request`.
2. **Elevation requests**: approving or denying a pending request an agent filed with `request_elevation`, optionally narrowed.

Nothing is decided over MCP, chat or any bearer. Those channels only carry the link (`approve_url`).

## Flag

`ACCESS_APPROVE_ENABLED` unset (or anything but `1`/`true`): every `/approve/*` path answers 404 and the request tools return no `approve_url` (`seed_attach_request` refuses with `access_approve_not_enabled` before writing anything).

## Environment

| Variable | Meaning |
|---|---|
| `ACCESS_APPROVE_ENABLED` | `1` or `true` turns the page on |
| `ACCESS_TEAM_DOMAIN` | `<team>.cloudflareaccess.com` (scheme optional; any other host is rejected) |
| `ACCESS_AUD` | the Access application's AUD tag, matched exactly |
| `ACCESS_CANONICAL_HOST` | the only Host the page answers on, for example `pot.example.com` |
| `ACCESS_MAX_JWT_AGE_SECONDS` | optional, default 60, capped at 300: how recent the Access login must be |
| `CONNECTOR_MASTER_KEY` | existing server secret; the CSRF key is derived from it (HKDF, info `mupot_access_approve_csrf_v1`). Absent: the page and POST fail closed with 503 |

Enabled with any of the first four missing or malformed: 503, never an open page.

## What the Worker checks on every request (GET and POST)

1. Flag on, config complete.
2. `Host` equals `ACCESS_CANONICAL_HOST`. Anything else (including a `workers.dev` hostname) is 403.
3. `Cf-Access-Jwt-Assertion` verifies: RS256 only, signature against the team JWKS (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, cached one hour, refetched on an unknown `kid` at most once per 30 seconds), `iss` equals `https://<team>.cloudflareaccess.com`, `aud` contains the configured tag exactly, `exp` in the future, `iat` within the freshness window, and the token names a human (`email` and `sub` present; service-token JWTs have neither).
4. The Access identity (provider `cloudflare-access`, subject = JWT `sub`) resolves, through the existing human-identity path (`resolveLoginIdentity` / `resolveHumanMemberId` / `linkLoginIdentity` with exclusive-control checks), to a member that is **active, unarchived and not an agent's welded member row**. A bare email match never suffices.
5. The member holds the authority the decision needs: org admin for a seed; for an elevation, the existing `canDecideElevation` / `decideElevationRequest` authority on the request's scope. Out-of-authority and unknown ids read identically (404).

POST adds: a same-origin `Origin` header (and `Sec-Fetch-Site` same-origin when present), and a CSRF token bound to this login (request kind, request id, Access subject, JWT `iat`).

Freshness note: Access exposes no `auth_time` claim, so the Worker treats `iat` as the login time. If the person's Access session is older than the window, the page says so and asks them to sign out of Access and reopen the link. Keep the Access session duration short so this is rare, and approve right after signing in.

## Seed attach

1. The agent calls `seed_attach_request { seed }`. The seed is validated exactly like the `seed_attach` dry run. The canonical form, its digest and the keyed request list are stored as a pending row in `seed_attach_requests` (single-use, 24 hours, at most 10 live pending per requester; asking again for the same seed returns the same request). The result carries `request_id` and `approve_url`.
2. The human opens `approve_url`, sees the project slug, kind, repo, live URL, seat cap and every request in words, and the agent-written name and goal inside an "untrusted, written by the agent" box.
3. Approve: the stored seed is re-validated (digest and every request key must still match), the request is consumed by one guarded `UPDATE ... WHERE status = 'pending' AND expires_at > now`, then the existing `applySeed` runs with every request key accepted. The human's Access-verified POST stands in for the dry-run `accept_token`; this proof is a server-side argument that MCP arguments cannot carry. The seed receipt (`mutation_audit_entries`, origin `admin_ui`) records `via: access_passkey` and the request id. Applying a seed still grants nothing.
4. Deny writes its own receipt. A second POST, a second tab or an expired request is refused.

`seed_attach` (dry run and apply with `accept_token`) is unchanged.

## Elevation

The page lists the agent, each action with its description and effect classification, scope (read-only here), the decide-by time, and the agent's reason inside the untrusted box. The human can untick actions and pick a shorter duration; `decideElevationRequest` rejects any widening. The Access login just completed counts as the step-up (`recentReauthOk`), so sensitive actions can be approved here. The grant binds to a web session created for this login and marked freshly re-authenticated, exactly as a dashboard grant binds to its own. The decision row records `via:access_passkey` in its note and a receipt is written to `mutation_audit_entries` (origin `admin_ui`, handler `access_approve`). The receipt is written after the decision; if that write fails the page says so and the decision stands.

## Cloudflare setup the owner must do

These are account changes; nothing in this repository makes them.

1. Create an Access **self-hosted application** for the canonical host, path `/approve/*` (and no other path).
2. Policy: **Allow** exactly the owner's email through the chosen identity provider. No Bypass rule, no Service Auth rule, no service tokens.
3. Independent MFA on the application: duration `0m` (prompt on every Access login), authenticators limited to biometrics or security keys (restrict by AAGUID), **AMR matching off** so the identity provider's earlier MFA cannot skip the prompt.
4. Shortest available application session duration.
5. Enroll the owner's passkey in Access once, in their own browser.
6. Turn `workers_dev` (and preview URLs) **off** for the Worker so the page is reachable only on the canonical host behind Access.
7. Set the environment variables above (`ACCESS_AUD` is shown on the application's overview page) and the `ACCESS_APPROVE_ENABLED` flag last.
8. Link the owner's Access identity to their member once. The first Access login resolves through the guarded attach; a member that already has another live login identity or a bound chat is refused there by design (exclusive control). The refusal page shows the Access subject; the owner links it explicitly (a `human_login_identities` row with provider `cloudflare-access`, that subject and the member id), the same one-time ceremony other providers use.

## Limits (honest)

- Access gives no per-transaction signature: the page proves a fresh, strong login and a same-origin tap on a specific request, not a signed approval of its exact content. A WebAuthn assertion whose challenge is the hash of the grant would close that and is a separate, later change.
- Authority for the legacy owner role plane follows the dashboard (`users.role` by verified email); capability rows apply to plain members.
