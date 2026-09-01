# Human-Approved, Session-Bound Agent Elevation

**Status:** Product direction approved by Hadi; architecture ready for implementation planning

**Date:** 2026-09-01

**Release boundary:** Post-`v0.30.0`; target the `v0.31.0` identity and access flight

## Decision

A human signs in to the correct tenant through an ordinary expiring web session. An
already-authenticated agent may then request additional access for its **exact current
session**. Mupot opens an approval page where the human chooses an allowed subset of
scope, actions, rank, and duration. Approval creates a server-side, expiring session
grant. It does not mint a new secret and does not change the agent member's standing
capabilities. When the chosen duration ends, the human signs out, the agent session
ends, the human loses the approving authority, or either party revokes the grant, the
agent immediately returns to its ordinary access.

This is session-admin: “sudo for agents,” with the human as the second party.

## Product Intent

Hadi's operating case is direct:

- Hadi is signed into the Mumega pot as `hadi@mumega.com`, the Mumega owner.
- Hadi is talking with an agent already connected to that pot through OAuth or a
  workspace credential.
- The agent needs a bounded capability to help with a task.
- The agent opens or returns a Mupot approval link.
- Hadi chooses exactly what the agent may do and for how long.
- The same agent session gains that access; other sessions for the same agent do not.
- When Hadi leaves or the duration expires, the agent falls back to its normal access.

Tenant identity is not portable authority. `hadi@mumega.com` is owner in the Mumega
tenant. `hadi@digid.ca` is a distinct Digid tenant identity with the role granted by
that tenant. No email, OAuth subject, session, role, or grant crosses pots.

## What Exists Today

### Human dashboard session

`src/auth/index.ts` already issues an opaque `mupot_session` cookie and stores the
record server-side in the `SESSIONS` binding. The cookie is `HttpOnly`, `Secure`,
`SameSite=Lax`, and has a fixed seven-day lifetime. Logout deletes the current KV
record.

That is a partial website session, not the finished operator model:

- the session snapshots the coarse legacy `users.role` at login;
- real scoped authority lives on a separate `members` identity;
- the email-to-member bridge only partially reconciles the two planes;
- sessions cannot be listed or remotely revoked;
- there is no idle timeout, recent-reauth marker, or “sign out other devices”; and
- a role change may not affect a legacy role cached in an existing session.

Issue #1162 records the concrete result: the authenticated human owner can still be
authorized for nothing because the owner capability is held by a different member
identity.

### PR #1246 device grant

PR #1246 implements an RFC 8628-shaped type-then-click flow:

1. an agent asks for a short code;
2. the human signs in and types the code;
3. the human clicks Allow or Deny; and
4. Allow mints a separate one-hour agent token.

It proves the approval interaction but not the target model. It has a fixed `member`
grant, fixed one-hour duration, no action or scope chooser, and produces a new bearer
secret. It should be mined for its code-entry and approval UX, then changed from
**token mint** to **existing-session elevation**.

### Prior temporary-admin design

Commit `bde8bfbe` contains the approved temporary-admin-token design. Its important
properties remain correct: admin is below owner, expiry is mandatory, delegation is
explicit, grants are token-specific, and expiry/revocation fail closed. This design
generalizes those properties from a newly minted token to the exact agent session that
asked.

### Rejected standing action grants

Commit `4af0f0b3` experimented with `action:*` values in the standing `gate_grants`
table. That is not the elevation mechanism. A standing member grant is inherited by
every live token for that member and has no natural session expiry. Action names are
useful, but their temporary instances belong on session grants.

### PR #1254 enrollment

PR #1254 enrolls a new seat and issues a new workspace credential. Enrollment answers
“how does this harness obtain an identity?” Session elevation answers “what may this
already-authenticated session temporarily do?” They may share UI components but remain
separate authorization flows.

## Approaches Considered

### Chosen: server-side grant on the exact existing agent session

The request is authenticated before it is created. Mupot derives tenant, agent,
credential, and session identity server-side. Approval creates no new secret. The
existing session resolves the temporary grant on later requests.

Benefits:

- no credential sprawl;
- one River/Kasra/Codex session can be elevated without elevating sibling sessions;
- expiry and revocation remove authority without rotating the underlying credential;
- works for OAuth and workspace credentials through one runtime-session abstraction;
- matches the user's mental model: approve the agent already in the conversation.

### Rejected for routine elevation: mint a separate temporary token

This is PR #1246's current model. It is still appropriate for **first enrollment**,
where no authenticated session exists. It is unnecessary and riskier when the agent is
already authenticated: the agent must collect, store, select, and later delete another
secret.

### Rejected: standing member or agent capability

Writing `org:admin`, `action:deploy`, or similar authority onto the agent member affects
all its credentials and outlives the human's presence. Token expiry cannot remove the
standing grant. This is exactly the River-admin blast-radius problem and must not be the
normal approval path.

## Identity Model

### Human login identity

Add a tenant-local binding from an external verified login identity to one canonical
human member:

```sql
CREATE TABLE human_login_identities (
  id                  TEXT PRIMARY KEY,
  tenant              TEXT NOT NULL,
  provider            TEXT NOT NULL,
  provider_subject    TEXT NOT NULL,
  verified_email      TEXT,
  member_id           TEXT NOT NULL REFERENCES members(id),
  linked_by_member_id TEXT,
  created_at          TEXT NOT NULL,
  revoked_at          TEXT,
  UNIQUE(tenant, provider, provider_subject)
);
```

Authorization binds to `(tenant, provider, provider_subject)`, not to a display email.
Email is verified and retained for legibility. It is not an authority join key and never
merges identities across tenants.

The existing pot owner performs a one-time explicit link for the production owner
identity. Login never silently makes “the first user in a table” owner and never copies
authority because two email strings happen to match.

### Human web session

Replace the unlistable KV-only session record with a queryable server-side registry:

```sql
CREATE TABLE web_sessions (
  id_hash             TEXT PRIMARY KEY,
  tenant              TEXT NOT NULL,
  member_id           TEXT NOT NULL REFERENCES members(id),
  login_identity_id   TEXT NOT NULL REFERENCES human_login_identities(id),
  created_at          TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  idle_expires_at     TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  recent_reauth_at    TEXT,
  revoked_at          TEXT,
  revoke_reason       TEXT
);
```

The browser carries only the random opaque session value. D1 stores its hash. The v1
policy is:

- 24-hour inactivity timeout;
- seven-day absolute maximum;
- `last_seen_at` writes coalesced to at most once every five minutes;
- current authority loaded live from the linked member on every request;
- a current-session logout and a “sign out all devices” operation;
- session inventory showing created, last active, expiry, and revoked state; and
- recent IdP reauthentication within five minutes for approving admin-tier or sensitive
  action grants.

An OAuth provider login is the authentication factor. The agent request plus a separate
human approval is a two-party control. It is only called cryptographic “2FA” when the
configured identity provider itself enforces a second factor; the product must not make
a stronger claim than its evidence.

### Agent runtime session

Both workspace bearer and OAuth connector authentication resolve to one server-derived
runtime-session shape:

```sql
CREATE TABLE agent_sessions (
  id                  TEXT PRIMARY KEY,
  tenant              TEXT NOT NULL,
  agent_id            TEXT NOT NULL REFERENCES agents(id),
  member_id           TEXT NOT NULL REFERENCES members(id),
  auth_kind           TEXT NOT NULL CHECK (auth_kind IN ('workspace_token','oauth')),
  credential_id       TEXT NOT NULL,
  seat                TEXT,
  created_at          TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  expires_at          TEXT,
  revoked_at          TEXT,
  UNIQUE(tenant, auth_kind, credential_id)
);
```

For a workspace bearer, `credential_id` is the server-resolved `member_tokens.id`. For
OAuth, Mupot creates a stable opaque authorization-session id in the OAuth props and
preserves it across access-token refresh. `check_in` may refresh the runtime session's
liveness metadata, but it cannot choose or overwrite agent identity. Agent identity is
always derived from the authenticated credential.

If an OAuth refresh cannot prove continuity with the same authorization session, the
elevation ends. It never falls back to agent-wide authority.

## Elevation Data Model

```sql
CREATE TABLE elevation_requests (
  id                    TEXT PRIMARY KEY,
  tenant                TEXT NOT NULL,
  agent_session_id      TEXT NOT NULL REFERENCES agent_sessions(id),
  user_code_hash        TEXT NOT NULL UNIQUE,
  requested_json        TEXT NOT NULL,
  reason                TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN
                          ('pending','approved','denied','expired','revoked')),
  created_at            TEXT NOT NULL,
  decision_expires_at   TEXT NOT NULL,
  decided_at            TEXT,
  decided_by_member_id  TEXT REFERENCES members(id),
  decided_by_web_session_hash TEXT REFERENCES web_sessions(id_hash),
  decision_note         TEXT
);

CREATE TABLE agent_session_grants (
  id                    TEXT PRIMARY KEY,
  tenant                TEXT NOT NULL,
  elevation_request_id  TEXT NOT NULL REFERENCES elevation_requests(id),
  agent_session_id      TEXT NOT NULL REFERENCES agent_sessions(id),
  grant_type            TEXT NOT NULL CHECK (grant_type IN ('rank','action')),
  scope_type            TEXT NOT NULL CHECK (scope_type IN
                          ('org','department','squad','project')),
  scope_id_key          TEXT NOT NULL DEFAULT '',
  grant_name            TEXT NOT NULL,
  approved_by_member_id TEXT NOT NULL REFERENCES members(id),
  approved_by_web_session_hash TEXT NOT NULL REFERENCES web_sessions(id_hash),
  created_at            TEXT NOT NULL,
  expires_at            TEXT NOT NULL,
  revoked_at            TEXT,
  revoke_reason         TEXT,
  CHECK (
    (grant_type = 'rank' AND grant_name IN
      ('admin','lead','member','observer')) OR
    (grant_type = 'action' AND grant_name LIKE 'action:%')
  ),
  UNIQUE(agent_session_id, grant_type, scope_type, scope_id_key,
         grant_name)
);
```

`grant_name` is deliberately non-null so SQLite uniqueness remains real. For a rank
grant it contains `admin`, `lead`, `member`, or `observer`; `owner` is excluded. For an
action grant it contains the allow-listed `action:*` key. Request, decision, and grants
are durable D1 records. KV is not used for the authorization decision or a get/delete
single-use race.

## Approval Flow

1. **Agent requests elevation.** An authenticated agent calls
   `request_elevation` with a human-readable reason, requested scope/actions/rank, and
   requested duration. Mupot derives the exact `agent_session_id`; the caller cannot
   supply it. An unbound session cannot request elevation: it must first complete the
   separate consent/enrollment flow and prove an agent identity.
2. **Mupot returns a door.** The response contains a ten-minute user code,
   `verification_uri`, and `verification_uri_complete`. It contains no credential and
   grants no authority.
3. **Human opens Mupot.** The approval route signs the human into the request's tenant.
   It shows the exact agent, seat when proven, harness/session age, requested reason,
   requested access, current standing access, and expiry.
4. **Human chooses the subset.** The human may reduce but never widen the request. They
   select named action presets, scope, maximum rank, and duration. V1 duration choices
   are 15 minutes, 1 hour, 4 hours, 8 hours, and 24 hours; one hour is the default.
   Owner-level delegation and non-expiring elevation do not exist.
5. **Sensitive approval steps up.** Admin rank and `action:manage_access`,
   `action:deploy`, `action:migrate`, `action:secrets`, and equivalent money or
   destructive actions require a human session reauthenticated in the previous five
   minutes.
6. **Server clamps and commits.** In one D1 transaction, Mupot re-resolves the human's
   live tenant authority, verifies strict rank dominance, verifies the exact agent
   session is still live, records the decision, and writes only the selected grants.
7. **Same agent session activates.** The agent polls `elevation_status`, or simply makes
   its next call. Authentication resolves active grants for that exact session. No new
   bearer is returned.
8. **Access ends automatically.** The grant becomes ineffective at the earliest of its
   chosen expiry, target agent-session expiry/revocation, approving web-session
   logout/revocation, approver authority loss, explicit human revocation, or agent
   self-revocation.

Closing a browser tab is not a reliable security event and is never described as one.
“When I am gone” means the chosen deadline, explicit End Access, or sign-out. Signing
out revokes every still-active elevation approved by that exact web session.

## Authorization Semantics

Standing and temporary authority stay distinguishable:

```text
effective request authority =
  standing authority of this authenticated principal
  PLUS active grants for this exact agent_session_id
  CLAMPED by tenant, scope, action, expiry, approver authority, and policy
```

The session grant may elevate above the agent's standing rank because that is its
purpose, but never above the approving human's current live rank and never to `owner`.
An admin may delegate only below their rank. An owner may delegate at most `admin`.

Action grants are preferred over broad rank grants. The first presets are:

- **Manage access** — `action:manage_access` on the chosen scope;
- **Deploy** — `action:deploy` on the chosen project/tenant surface;
- **Migrate** — `action:migrate` on the chosen tenant;
- **Secrets** — `action:secrets`, with values still protected by the existing custody
  rules;
- **Dispatch** — `action:dispatch` on the chosen project/squad; and
- **Admin session** — advanced owner-only preset, rank `admin`, maximum 24 hours.

Every sensitive route must use one canonical authorization primitive that evaluates
standing and session grants. There are no route-local bypasses and no conversion of a
temporary grant into a `capabilities` or standing `gate_grants` row.

## User Experience

### Agent-facing

The agent receives:

- a short code;
- an approval link it may open in the host browser when supported;
- the exact requested access and duration;
- status: pending, approved, denied, expired, or revoked; and
- after approval, `boot_context`/`status` fields showing temporary grants, scope,
  approver identity class, and remaining lifetime without exposing private human data.

Tools and doors unavailable under the current effective access are hidden or grouped as
unavailable. A refusal names the missing scope/action and offers “Ask owner for temporary
access” when that path is valid.

### Human-facing

The page answers five questions before the approval button:

1. Which tenant am I in?
2. Which exact agent session is asking?
3. What is it asking to do, and why?
4. What is the narrowest selectable scope and duration?
5. What ends the access?

The owner has an Active Elevations page with remaining time, agent, seat, scope,
actions, reason, approving session, and one-click revoke. The web-session page has
current-session logout and sign-out-all-devices controls.

## Security Invariants

1. Requested tenant, agent, member, credential, and session identity are derived from
   authentication, never request text.
2. A grant applies to one exact `agent_session_id`; sibling tokens, OAuth sessions,
   seats, and agents inherit nothing.
3. A human can approve only within their current live tenant authority and strictly
   below `owner`.
4. The approval page may reduce a request but cannot add permissions the request did
   not name.
5. A pending request grants zero authority.
6. Approval is single-decision and atomic. Concurrent Allow/Deny or double-Allow yields
   one terminal decision and one grant set.
7. Expired, revoked, orphaned, cross-tenant, malformed, or authority-loss grants fail
   closed to ordinary standing access.
8. No raw bearer, cookie, OAuth token, or secret value appears in D1 receipts, logs,
   Mupot messages, GitHub, or UI after initial credential issuance.
9. Revoking the underlying credential or deactivating the agent immediately invalidates
   the runtime session and all its elevations.
10. Human logout/revocation immediately ends grants approved by that web session.
11. Email is display and recovery evidence, not a cross-tenant authority key.
12. UI visibility follows effective authorization; it does not advertise inaccessible
    rooms and then fail after entry.

## Failure Behavior

- unauthenticated or unbound request: `not_agent_session`;
- unsupported scope/action/rank: `invalid_elevation_request`;
- pending-request ceiling reached: `elevation_rate_limited`;
- unknown, reused, or expired code: one collapsed `request_not_available` response;
- wrong tenant: not found, never a cross-tenant existence oracle;
- human lacks authority: legible 403 naming their own standing and the required scope;
- recent reauthentication missing: redirect to step-up and preserve only a signed,
  single-use return nonce;
- agent session ended before decision: `request_not_available` and no grant;
- D1 transaction failure: no approval and no grant;
- grant expiry/revocation: the next request executes only with standing authority;
- authorization infrastructure unavailable: sensitive elevated action fails closed;
- OAuth refresh continuity unproven: session grant is ignored, never widened to the
  whole agent.

## Testing

Use `createSqliteD1()` plus `applyAllMigrations()` and the real authentication and
authorization paths. Required RED/GREEN coverage:

### Human session

- `hadi@mumega.com` resolves to the Mumega owner member and live capabilities;
- `hadi@digid.ca` in the Digid tenant resolves only to the Digid-granted role;
- no cross-tenant identity or capability merge occurs;
- session cookie contains only opaque random material; D1 stores only its hash;
- 24-hour idle and seven-day absolute expiry are enforced with a controlled clock;
- logout, revoke-current, and revoke-all invalidate sessions;
- authority changes take effect without a new login; and
- recent reauthentication is required for sensitive approval.

### Exact agent session

- two tokens for the same agent produce distinct `agent_sessions`;
- elevating token/session A does not affect token/session B;
- OAuth access-token refresh preserves the same authorization session only when the
  provider proves continuity;
- workspace-token rotation or revocation ends the associated runtime session;
- caller-supplied agent, seat, token, or session ids cannot retarget a request; and
- `check_in` cannot widen or rewrite identity.

### Approval and grants

- pending requests grant nothing;
- the human can approve a strict subset of the request;
- the human cannot add unrequested access;
- an owner can grant admin but never owner;
- an admin cannot delegate at or above their own rank;
- action-only approval does not satisfy unrelated admin gates;
- grants expire at each duration preset;
- approval-session logout, approver downgrade, agent-session end, and explicit revoke
  each remove authority on the next request;
- concurrent decisions create exactly one terminal result and one grant set;
- D1 write failure leaves no partial grant;
- codes and status reads expose no other pending requests; and
- no new bearer token is created or returned by elevation.

### Route conformance

- every route mapped to each standard `action:*` name admits the exact session grant;
- removing the grant at the route or resolver turns the test red;
- unrelated routes remain denied;
- MCP, HTTP, and dashboard checks return the same decision for the same principal,
  session, scope, and action; and
- `boot_context` reports effective temporary grants and expiry without treating them as
  standing capabilities.

## Delivery Sequence

This is one architecture delivered in bounded flights after `v0.30.0` is stable:

1. **Human session foundation.** Add tenant-local login identity binding, live member
   authority, listable/revocable web sessions, idle/absolute expiry, and recent reauth.
2. **Agent-session foundation.** Give workspace and OAuth authentication one stable,
   exact runtime-session identity; wire `check_in` without caller-selected identity.
3. **Elevation ledger and flow.** Add request/grant tables, authenticated MCP tools,
   approval UI, single-decision transaction, expiry, and revocation.
4. **Authorization convergence.** Introduce the canonical effective-authority primitive
   and migrate the first sensitive action surfaces with conformance tests.
5. **UX convergence.** Active Sessions, Active Elevations, actionable refusals, and
   capability-aware doors/tool guidance.
6. **PR reconciliation.** Reuse PR #1246's type-then-click UX but remove its routine
   token mint. Keep PR #1254 as the separate enrollment path. Close or supersede any
   standing `action:*` implementation that bypasses session expiry.
7. **Independent gate and canary.** Athena reviews exact head. A separately approved
   synthetic canary proves request → human approval → exact-session elevated action →
   expiry/revocation → standing-access fallback. No production credential or ACL change
   is inferred from test green.

Each flight receives its own PR, exact-head CI, adversarial review, and receipt. The
schema, resolver, route migrations, and live canary do not ride in one mega-PR.

## Done When

The architecture is complete only when:

- a human signs into the correct tenant with an expiring, listable, revocable session;
- the session resolves the correct tenant-local human member and current live authority;
- an authenticated agent requests a named scope/action/duration for its exact session;
- the human sees and may narrow the request, steps up when required, and approves it;
- no new bearer is minted for elevation;
- only the requesting agent session gains the selected access;
- sibling sessions remain unchanged;
- expiry, human logout, human downgrade, credential revocation, and manual revoke each
  return the agent to standing authority;
- every transition has a non-secret durable receipt; and
- a real exact-session canary plus Athena's independent verdict proves the full chain.

## Out of Scope

- owner-level delegation;
- non-expiring elevation;
- cross-tenant roles or identity merging;
- implicit elevation from chat text, model intent, agent name, seat label, or check-in;
- browser-tab-close detection;
- replacing first enrollment, OAuth consent, or PR #1254's seat-key flow;
- automatically merging or deploying PR #1246; and
- production migration, deployment, ACL change, credential mint, or live authority
  change without separate explicit approval.

## Next Session

Start with an implementation plan for Delivery Sequence step 1 only. Pin the current
post-`v0.30.0` main SHA, review migration numbering and production schema first, and do
not begin the elevation ledger until the human session and tenant-local identity tests
are green. The design is intentionally complete enough that the next session should not
reopen the core product decision.
