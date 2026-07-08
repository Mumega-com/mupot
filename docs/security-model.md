# Mupot security model

Mupot is a self-hosted agent control plane. Its core security job is to let
humans, runtime workers, webhooks, and integrations act on one pot without
letting any caller self-assert identity, scope, tenant, or authority.

This document is the operator-facing map of the trust boundaries implemented in
code. Code remains authoritative; this file names the intended invariants and
the files that enforce them.

## Core Invariants

1. Identity is server-derived. Request bodies and message text may name a target
   object, but never prove who the caller is.
2. Tenant scope comes from `env.TENANT_SLUG` and the pot's own bindings, not
   from caller input.
3. Authorization is capability-based and scoped. Coarse owner/admin roles are
   only a legacy dashboard escape where explicitly documented.
4. Secrets are either stored as hashes, stored in Worker secrets, or held outside
   the pot on the runtime host. Raw member tokens are shown once and never stored.
5. Machine ingress fails closed when its verifier secret/key is missing.
6. Mutating browser/session routes use same-origin CSRF checks in addition to
   SameSite cookies.
7. Risky customer-facing actions go through gates or approval-specific routes
   rather than being forged as terminal task state.

## Credential and Verifier Matrix

| Boundary | Credential | Verifier | Storage | Failure mode |
|---|---|---|---|---|
| Dashboard session | `mupot_session` cookie | `requireAuth` loads `sess:<id>` from `SESSIONS` KV | Random session id in HttpOnly cookie; session record in KV | Missing/expired session returns `401` or redirects to login |
| Dashboard Google OAuth | Google authorization code plus state | `/auth/callback` validates state, exchanges code, requires verified email | OAuth state in KV; users in D1 | Invalid state/code/email returns `400`, `401`, or `403` |
| Dashboard SSO handoff | Mumega-signed handoff claim | `verifyHandoffClaim`, audience check, one-time `jti` marker | Public key in env; `jti` marker in KV | Invalid or replayed claim redirects to local login |
| MCP OAuth seat | OAuthProvider access token | OAuthProvider plus `McpOAuthApiHandler` | OAuthProvider KV props; `member_tokens` D1 row for revocation | Revoked/inactive row returns JSON-RPC `401` |
| MCP member API key | `Authorization: Bearer mupot_...` | SHA-256 lookup in `member_tokens`, active `members` row | Token hash in D1; raw shown once | Missing/bad/revoked token returns `401` |
| Agent-bound member token | Bearer token with `member_tokens.agent_id` | Same token lookup plus `boundAgentId` equality checks | Token hash plus `agent_id` weld in D1 | Wrong or pure-human token returns `403` on agent-only paths |
| Fleet signed attach | Ed25519 signature | `verifySignedAttach` validates tenant-bound canonical bytes, public key, timestamp, nonce | Public key in `agent_keys`; private key stays on host; nonce ledger in D1 | Bad/stale/replayed signature returns `401` or `409` |
| IM webhook | Telegram secret-token header | `X-Telegram-Bot-Api-Secret-Token` equals `IM_WEBHOOK_SECRET` | Worker secret | Missing secret returns `503`; bad header returns `401` |
| Channel webhooks | Platform-specific signature/secret | `ChannelAdapter.verify` or adapter `respond` | Platform secrets in Worker secrets | Unknown/unverified platform returns `503` or `401` |
| Hermes channel relay | `X-Relay-Secret` | Header equals `HERMES_RELAY_SECRET` | Worker secret | Missing secret returns `503`; bad header returns `401` |
| Generic event ingest | HMAC of raw body | `x-mupot-signature` using `EVENT_INGEST_SECRET` | Worker secret | Missing secret returns `503`; bad signature returns `401` |
| GHL inbound | HMAC of raw body | `x-ghl-signature` using `GHL_WEBHOOK_SECRET` | Worker secret | Missing secret returns `503`; bad signature returns `401` |
| GitHub inbound | HMAC of raw body | `x-hub-signature-256` using `GITHUB_WEBHOOK_SECRET` | Worker secret | Missing secret returns `503`; bad signature returns `401` |
| Billing tier event | HMAC of raw body plus tenant/event ordering | `x-mupot-signature` using `BILLING_PLAN_SECRET` | Worker secret; last event state in D1 | Missing/bad secret returns `503`/`401`; wrong tenant returns `403` |
| Claude Code spend rollup | HMAC of raw body plus tenant/freshness | `x-mupot-signature` using `CC_SPEND_SECRET` | Worker secret; daily rows in D1 | Missing/bad secret returns `503`/`401`; wrong tenant returns `403` |

## Identity Planes

### Browser Humans

Dashboard users authenticate through `src/auth/index.ts`. The browser receives
only a random opaque cookie. The server reloads the user, email, role, and tenant
from KV on every authenticated request.

Google OAuth creates or resolves a local `users` row by verified email. The first
local Google login can bootstrap owner. The SSO handoff path cannot bootstrap the
first owner.

### Members and Workspace Keys

Members are the principal used by MCP, IM, channel messages, and runtime worker
seams. `src/members/service.ts` mints member tokens by generating a random
`mupot_...` token, storing only its SHA-256 hash in `member_tokens`, and returning
the raw value once.

`src/mcp/index.ts` and `src/auth/member-bearer.ts` resolve a bearer token by:

- extracting `Authorization: Bearer <token>`
- hashing the raw token
- joining `member_tokens` to an active `members` row
- deriving `memberId`, token channel, and optional `boundAgentId`
- resolving capabilities live from D1

The caller never supplies its own member id.

### Agent-Bound Tokens

Agent-bound member tokens weld a member-token row to one `agent_id`. The shared
mint path is `mintAgentBoundToken` in `src/members/service.ts`. It writes the
member envelope, one squad-scoped capability, and the agent-welded token in one
D1 batch. The grant is hard-capped to the agent's own squad and may only be
`observer` or `member` (`member` is the default); mint cannot create `lead`,
`admin`, `owner`, department, or org grants.

This means a runtime using that token can act as that agent only where the token
and capability allow. The fleet bearer attach route rejects pure human tokens and
tokens welded to a different agent.

### Signed Runtime Hosts

The stronger runtime identity proof is Ed25519 signed attach/detach:

- host keeps the private key
- pot stores only the public key in `agent_keys`
- signed attach bytes include protocol domain, tenant, agent id, type, runtime,
  lifecycle, timestamp, and nonce
- signed detach bytes use the separate `fleet-detach:v1` domain and bind tenant,
  agent id, timestamp, and nonce
- timestamp must be within the signature freshness window
- nonce is burned after successful signature verification

`/api/fleet/attach-signed` writes running presence only after verification.
`/api/fleet/detach-signed` writes stopped presence only for the key-bound row. If
an agent has a registered public key, the older bearer attach route refuses it to
avoid an auth downgrade.

## Authorization Model

The canonical capability implementation is `src/auth/capability.ts`.

Capability rank:

```text
owner > admin > lead > member > observer
```

Scope rules:

- org grants cover all scopes
- department grants cover that department and its squads
- squad grants cover only that squad
- grants never bubble upward

Important APIs:

- `resolveCapabilities(env, memberId)` loads direct grants and channel-derived
  squad grants.
- `hasCapability(...)` performs pure rank/scope checks.
- `requireCapability(...)` and `requireOrgCapability(...)` gate Hono routes.
- `holdsCapabilityFloor(...)` is the MCP dispatch floor before tool handlers run.
- `actorMaxRankOnScope(...)` enforces grant ceilings for token/grant minting.
- `hasSurfaceCap(...)` and `requireSurfaceCap(...)` enforce named surface caps
  such as `outreach:send-gated`.

Directory-channel OAuth seats deliberately receive `capabilities: []` in
`buildAuthContextFromProps`. They do not inherit a member's standing workspace
grants through the public OAuth registration door. Workspace/API-key tokens keep
their live D1 capabilities and agent weld.

## Sensitive Write Path Matrix

| Surface | Route/file | AuthN | AuthZ / gate |
|---|---|---|---|
| Create/update tasks | `src/tasks/index.ts` | Dashboard session | `member+` on target squad; owner/admin legacy escape |
| Task verdicts and gate grants | `src/tasks/index.ts` | Dashboard session | gate-specific route checks and surface caps |
| Agents wake/status | `src/agents/index.ts`, `src/im/index.ts`, `src/channels/index.ts` | Session, IM secret, channel signature, or MCP token | `lead+` on target squad for wake |
| Member/token/admin UI | `src/dashboard/index.ts`, `src/members/service.ts` | Dashboard session | owner/admin or scoped capability; grant ceiling prevents minting above actor rank |
| MCP tools | `src/mcp/index.ts` | OAuthProvider token or member API key | tool-level `min` floor plus per-tool target-scope checks |
| Agent inbox/send | `src/mcp/index.ts`, `src/agents/inbox-routes.ts` | Agent-welded member token | `boundAgentId` self-scopes sender/receiver |
| Fleet attach/detach | `src/fleet/attach-routes.ts` | Bound bearer token or Ed25519 signature | token weld or registered public key; signed path verifies nonce/timestamp |
| Fleet control | `src/fleet/control-routes.ts`, `src/fleet/control-request.ts`, `fleet-runtime/fleet-control-daemon.mjs` | Dashboard/session controls and signed host consumption | owner gate, `fleet-control.v1` signature, host public-key verification, local nonce ledger |
| Channel relay/webhooks | `src/channels/index.ts` | Adapter verify or `HERMES_RELAY_SECRET` | platform user -> member mapping, then capability checks |
| IM webhook | `src/im/index.ts` | `IM_WEBHOOK_SECRET` | `chat_id` -> member mapping, then capability checks |
| External event -> task | `src/events/ingest.ts` | HMAC secret | squad existence plus canonical task creation |
| GHL inbound | `src/integrations/ghl-routes.ts` | HMAC secret | configured/default squad plus canonical task creation |
| GitHub inbound | `src/integrations/github-routes.ts` | HMAC secret | label/default squad routing plus canonical task creation |
| Billing plan | `src/billing/admin.ts` | HMAC secret | tenant audience plus event ordering |
| Spend rollup | `src/economy/cc-spend.ts` | HMAC secret | tenant audience, timestamp freshness, row validation |

## Webhook and Ingress Rules

Webhook routes are not protected by browser sessions. They must prove source at
the route boundary before any mutation.

Current expected pattern:

1. Reject if verifier secret is absent.
2. Apply a body cap before HMAC work when the route accepts large payloads.
3. Verify HMAC/signature over the raw body.
4. Add audience, replay, and freshness checks where the source supports them.
5. Parse JSON only after authenticity succeeds.
6. Create work through canonical services such as `createTask`, not direct SQL.

Routes using this pattern include generic event ingest, GHL inbound, GitHub
inbound, billing plan events, and Claude Code spend rollups. GitHub, GHL, and
generic event ingest cap declared and actual UTF-8 body size before HMAC work.

## Dashboard CSRF

The dashboard uses HttpOnly SameSite=Lax session cookies. Session-backed
mutating Hono apps also use `hono/csrf`, which checks same-origin unsafe methods.
This protects browser-driven POST/PATCH/DELETE routes from relying on SameSite
alone.

## Approval and Work Lifecycle Rules

Tasks cannot be born in terminal gate states. `src/tasks/index.ts` allows create
status only for `open` or `in_progress`; `approved`, `rejected`, `review`, and
`done` must be reached through lifecycle-specific paths.

Task creation requires a non-empty `done_when` predicate at the REST and MCP
boundaries. Customer-facing or high-risk work should land in `/approvals` or a
gate-specific verdict route rather than being completed by direct status writes.

## Current Gaps and Follow-Ups

- Member tokens are tenant-scoped structurally by one D1 database per pot and by
  `env.TENANT_SLUG`, but the token row itself does not yet carry an explicit
  tenant claim. Keep the per-pot database invariant or add token-row tenant
  binding before any shared-database mode. Track this in GitHub issue #58.
- `runtime-adapter/v1` is documented and has a local signed HTTP conformance
  smoke for attach, inbox, fleet control, and detach. Broader runtime/webhook
  conformance suites remain follow-up under GitHub issue #269.
- Browser workflow coverage still needs deeper operator flows beyond page smoke
  and basic Hermes checks. Track this in GitHub issue #270.
- Dashboard health/observability needs a single operator view for failed
  webhooks, runtime liveness, gates, and integration errors. Track this in
  GitHub issue #271.
- Production self-hosting still needs backup, rollback, incident, and upgrade
  runbooks. Track this in GitHub issue #272.

## Operator Checklist

Before trusting a new pot or new integration:

1. Confirm `npm audit`, typecheck, tests, and CI are green.
2. Confirm all required Worker secrets are set for enabled webhooks.
3. Confirm no raw `mupot_...` token appears in git, logs, docs, or config files.
4. Confirm runtime hosts keep Ed25519 private keys outside the pot and register
   only public keys.
5. Confirm every runtime worker uses a token or key bound to that worker.
6. Confirm risky actions land in approvals or gate-specific routes.
7. Confirm webhook test deliveries fail closed when the verifier secret is absent
   or the signature is wrong.
8. Confirm offboarding suspends the member and revokes relevant member tokens.
