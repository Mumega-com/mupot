# Coherent Agent Connection Flow

**Status:** Proposed design

**Date:** 2026-07-24

**Tracking:** [GitHub issue #528](https://github.com/Mumega-com/mupot/issues/528)

## Goal

Make any owner able to create or connect an agent, assign its home squad and
optional cross-squad access, issue an agent-bound MCP credential, and verify
messaging in one guided flow without duplicate identities or manual database
work.

The flow is complete only when:

- new and existing agents both work;
- each agent keeps exactly one home squad;
- cross-squad access reuses the same agent identity;
- the issued key works with `boot_context`, `orient`, `send`, and non-consuming
  `inbox { peek: true }`;
- Codex, Claude Code, and Cursor configuration is generated automatically;
- retries cannot leave partial or conflicting identity state; and
- Mupot records a non-secret completion receipt.

## Problem

Mupot has the required primitives, but they do not compose into one truthful
operator journey.

Today:

1. `create_agent` and the squad dashboard create an `agents` row in one home
   squad.
2. `createAgent()` also creates the home `memberships` row used by
   project-message routing.
3. `/admin/agent-token` and `mint_agent_token` separately create or reuse a
   hidden `members` identity, grant home-squad capability, and weld a token
   through `member_tokens.agent_id`.
4. `POST /api/org/agents/:id/memberships` adds routing participation in another
   squad but does not grant MCP authority to the agent's bound member identity.
5. `grant_agent_capability` grants MCP authority but refuses an agent that has
   not already been minted.
6. The token, MCP endpoint, client configuration, and verification evidence live
   on separate surfaces.

This split produces a circular onboarding path. A valid human `workspace` token
can connect to Mupot but cannot call agent-only tools. “Add agent” creates a new
agent instead of attaching an existing one. “Add to squad” can update routing
membership without updating effective MCP authority.

## Product Decisions

### One home squad

Every agent has one home squad stored in `agents.squad_id`. Creating an agent
requires choosing it. Connecting an existing agent displays its current home
squad and does not permit changing it.

Moving an agent's home squad is a separate lifecycle operation because it can
change task ownership, routing, budgets, and authorization. It is not part of
connection setup.

The canonical agent member's capability on its home squad is permanently
bounded to `observer` or `member`. No entry point—including
`setAgentSquadAccess`, `grant_agent_capability`, or direct credential mint—may
raise the home-squad grant to `lead`, `admin`, or `owner`; doing so requires a
separate future product decision that explicitly replaces this mint guard.

### Optional cross-squad access

An agent may receive access to additional squads without creating another agent
row or another logical identity. While the current schema has separate
`memberships` and `capabilities` planes, one shared service must update both so
they cannot drift:

- `memberships` expresses agent participation for project and message routing;
- `capabilities` expresses effective MCP authorization for the agent's canonical
  member identity.

The dashboard and MCP may not write either plane independently.

### One agent connection operation

The product exposes one **Create or connect agent** workflow backed by one
orchestration service. Existing low-level tools remain compatibility wrappers
until callers migrate.

The operation:

1. resolves an existing agent or validates the proposed new agent;
2. establishes or confirms the home squad;
3. establishes the home routing membership;
4. creates or resolves exactly one canonical agent authorization identity;
5. establishes the home capability grant;
6. establishes optional synchronized cross-squad access;
7. mints one agent-bound token; and
8. returns the show-once credential, endpoint, client configurations, and
   non-secret setup receipt.

### Keep the current schema behind a compatibility boundary

The first implementation does not perform the full unified-principal migration
described in `docs/architecture/identity-and-access-redesign.md`. Instead, it
puts today's split schema behind a single service boundary. A later identity
migration can replace the service internals without changing the dashboard or
MCP contract.

## Architecture

### Shared service

Add a service under the identity or members domain with a contract equivalent
to:

```ts
provisionAgentConnection(env, actor, input): Promise<AgentConnectionResult>
```

`input` contains:

- a caller-generated `request_id`;
- exactly one of `existing_agent` or `new_agent`;
- the home squad for a new agent;
- zero or more additional squad grants;
- token label; and
- home capability, limited to `observer` or `member`.

An existing agent's home squad is data-derived and cannot be overridden.
Additional grants accept `observer`, `member`, `lead`, or `admin`, subject to
the caller's authority ceiling.

The service owns all identity, membership, capability, token, receipt, and
idempotency writes. Dashboard and MCP handlers own parsing, authentication, and
response rendering only.

### Authorization

All identity and scope decisions are server-derived.

- Creating a new agent requires `lead` or higher on its home squad.
- Minting an agent credential requires `admin` or higher on the home squad.
- Adding or changing cross-squad access requires `admin` or higher on every
  affected target squad.
- When the REST membership route delegates to the synchronized writer, its
  existing target-squad authorization floor changes from `lead` to `admin`.
- A caller cannot grant above its own effective rank.
- Existing agent references resolve ID-first and refuse ambiguous slugs.
- Tenant boundaries come from the Worker environment, never request input.

The service checks every affected scope before making any write.

### Canonical agent authorization identity

Migration `0071_agent_connections.sql` introduces
`agent_member_bindings(tenant, agent_id, member_id)`. This is the canonical
authorization weld. Its database keys are:

- `PRIMARY KEY (tenant, agent_id)`, so an agent has at most one member identity;
- `UNIQUE (tenant, member_id)`, so a dedicated agent member cannot represent a
  second agent; and
- insert/update guards on agent-bound `member_tokens` requiring a matching
  `(tenant, agent_id, member_id)` binding. Multiple live tokens may therefore
  exist for one agent, but all must weld to the same member.

The service resolves the binding, not whichever active token happens to be
returned first:

- no binding and no historical welded token: atomically create one dedicated
  member and claim the binding;
- one binding: reuse its member;
- welded tokens for more than one historical member: fail closed with
  `agent_identity_ambiguous`;
- a token whose agent and member do not match the binding: reject it as
  `agent_identity_conflict`.

Retries and additional token mints always reuse the canonical identity. They
never create another `members` row for the same logical agent.

Before migration, a deployment preflight groups all welded tokens, including
revoked tokens, by `(tenant, agent_id)` and blocks if any agent has more than one
distinct `member_id`. It also blocks tenant-null welded rows. The migration
backfills only unambiguous bindings; it never chooses a winner for ambiguous
legacy data.

### Synchronized squad access

Introduce a single service operation equivalent to:

```ts
setAgentSquadAccess(env, {
  agentId,
  memberId,
  squadId,
  capability,
})
```

It idempotently ensures:

- one `memberships(agent_id, squad_id)` row marking routing participation; and
- one `capabilities(member_id, 'squad', squad_id)` row with the same effective
  level.

`capabilities` remains the sole authorization source. Current project-message
queries treat `memberships` existentially, and its legacy capability vocabulary
does not include every MCP rank. New synchronized membership rows therefore use
the neutral `member` marker; the dashboard never presents that column as
effective authority. Updating an agent's rank changes `capabilities` only while
preserving the routing edge.

During the compatibility period, all agent squad-access entry points delegate
to this operation. Removing access deletes both representations in one
transaction. Changing access rank updates the authoritative capability while
preserving the membership edge.

The home squad access cannot be removed through this operation. If the target is
the home squad, `setAgentSquadAccess` accepts only `observer` or `member` and
returns `home_capability_ceiling` for any higher rank. Deactivating or moving an
agent remains a separate lifecycle action.

### Credential mint

The credential path preserves the existing security invariants:

- generate a cryptographically random `mupot_...` token;
- store only its SHA-256 hash;
- set `member_tokens.agent_id` to the selected agent;
- return the raw token exactly once;
- never log, persist, or place the raw token in a durable receipt; and
- default the home grant to `member`, with `observer` as the only lower preset.

The home grant belongs to the canonical member identity, not to an individual
token. The first mint chooses `observer` or `member`; additional credentials
inherit that committed home grant and may not silently raise or lower it.

The result includes:

- token ID, agent ID, canonical member ID, label, and created time;
- canonical `https://<pot>/mcp` endpoint;
- Claude Code `.mcp.json`;
- Codex `config.toml` plus environment-variable instruction;
- Cursor MCP JSON; and
- a warning that the raw token cannot be recovered.

Generated snippets use Streamable HTTP (`type: "http"` where required), never
SSE. Their origin and `agent_connection_receipts.endpoint` use the existing
`canonicalOrigin()` helper introduced by #88, but this flow first requires a
configured, parseable `PUBLIC_ORIGIN`. Deployed origins must use HTTPS; HTTP is
accepted only when the parsed hostname is exactly `localhost`, `127.0.0.1`, or
`[::1]` for local development and tests. Missing, malformed, or otherwise
insecure configuration returns `public_origin_unconfigured` before reservation
or credential mutation. Provisioning never accepts the request/`Host`-derived
fallback from `canonicalOrigin()` for snippets or receipts.

## Persistence Contract

Migration `0071_agent_connections.sql` is part of this change. The
implementation may not invent request or receipt fields later in the PR.

### Canonical identity table

```sql
CREATE TABLE agent_member_bindings (
  tenant     TEXT NOT NULL,
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant, agent_id),
  UNIQUE (tenant, member_id)
);
```

The same migration adds `BEFORE INSERT` and `BEFORE UPDATE OF tenant, agent_id,
member_id` triggers on `member_tokens`. For any non-null `agent_id`, the trigger
raises `agent_identity_conflict` unless
`agent_member_bindings(tenant, agent_id, member_id)` exists. Human tokens with a
null `agent_id` are unchanged. Bindings have no normal update path: a
`BEFORE UPDATE` trigger rejects mutation, and deletion is rejected while any
welded token exists. This is stronger than a partial unique index on live tokens
because revoking every token cannot make Mupot forget the canonical identity.

### Request table

`agent_connection_requests` is the mutable operation state:

```sql
CREATE TABLE agent_connection_requests (
  tenant              TEXT NOT NULL,
  actor_kind          TEXT NOT NULL CHECK (actor_kind IN ('user','member')),
  actor_id            TEXT NOT NULL,
  request_id          TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  target_key          TEXT NOT NULL,
  agent_mode          TEXT NOT NULL CHECK (agent_mode IN ('new','existing')),
  credential_action   TEXT NOT NULL CHECK (
    credential_action IN ('issue_if_missing','add','replace')
  ),
  replace_token_id    TEXT,
  status              TEXT NOT NULL CHECK (
    status IN (
      'pending','credential_issued','client_connected',
      'messaging_verified','failed','expired'
    )
  ),
  agent_id            TEXT,
  member_id           TEXT,
  token_id            TEXT,
  receipt_id          TEXT,
  error_code          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  finalized_at        TEXT,
  expires_at          TEXT NOT NULL,
  PRIMARY KEY (tenant, actor_kind, actor_id, request_id),
  UNIQUE (receipt_id),
  CHECK (
    length(request_fingerprint) = 64
    AND request_fingerprint = lower(request_fingerprint)
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    (credential_action = 'replace' AND replace_token_id IS NOT NULL)
    OR (credential_action <> 'replace' AND replace_token_id IS NULL)
  )
);

CREATE UNIQUE INDEX idx_agent_connection_one_pending_target
  ON agent_connection_requests (tenant, target_key)
  WHERE status = 'pending';
```

`target_key` is server-normalized as `agent:<agent-id>` for an existing agent or
`new:<home-squad-id>:<normalized-slug>` for a proposed agent. It is never
accepted from the client.

### Receipt table

`agent_connection_receipts` is the durable, non-secret result:

```sql
CREATE TABLE agent_connection_receipts (
  id                          TEXT PRIMARY KEY,
  tenant                      TEXT NOT NULL,
  actor_kind                  TEXT NOT NULL CHECK (actor_kind IN ('user','member')),
  actor_id                    TEXT NOT NULL,
  request_id                  TEXT NOT NULL,
  request_fingerprint         TEXT NOT NULL,
  agent_id                    TEXT NOT NULL,
  agent_slug                  TEXT NOT NULL,
  agent_status_at_issue       TEXT NOT NULL,
  member_id                   TEXT NOT NULL,
  token_id                    TEXT NOT NULL,
  agent_disposition           TEXT NOT NULL CHECK (
    agent_disposition IN ('created','reused')
  ),
  credential_action           TEXT NOT NULL CHECK (
    credential_action IN ('issue_if_missing','add','replace')
  ),
  home_squad_id               TEXT NOT NULL,
  home_capability             TEXT NOT NULL CHECK (
    home_capability IN ('member','observer')
  ),
  additional_access_json      TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(additional_access_json)
    AND json_type(additional_access_json) = 'array'
  ),
  token_label                 TEXT NOT NULL,
  endpoint                    TEXT NOT NULL,
  transport                   TEXT NOT NULL CHECK (transport = 'streamable_http'),
  verification_status         TEXT NOT NULL CHECK (
    verification_status IN ('pending','pass','fail','expired')
  ),
  verification_challenge_hash TEXT,
  verification_expires_at     TEXT,
  client_connected_at         TEXT,
  verification_message_id     TEXT,
  verification_request_id     TEXT,
  messaging_verified_at       TEXT,
  verification_error_code     TEXT,
  checks_json                 TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(checks_json) AND json_type(checks_json) = 'object'
  ),
  credential_issued_at        TEXT NOT NULL,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL
);
```

`additional_access_json` is a canonical, squad-ID-sorted array of objects with
exactly `{"squad_id": string, "capability":
"observer"|"member"|"lead"|"admin"}`. `checks_json` has exactly the keys
`boot_context`, `orient`, `send`, `inbox_peek`, and `cleanup`, each with
`"not_run"`, `"pass"`, or `"fail"`. Parsing rejects extra keys or duplicate
squad IDs before either value is stored.

A migration trigger makes the provisioning snapshot columns immutable after
insert. Updates may change only the verification columns from
`verification_status` through `checks_json`, plus `updated_at`. The receipt page
re-reads live token revocation state by `token_id`; revocation is not copied as
a mutable receipt fact.

Neither table stores a raw token, token hash, generated client configuration,
verification challenge plaintext, or message body.

### Retention

- `pending` requests expire after 24 hours.
- Final request rows are retained for 30 days, defining the supported
  idempotency window, then purged by the scheduled maintenance job.
- Receipts are retained for 365 days, then purged by the same job unless a
  tenant audit-retention policy requires longer retention.
- Verification challenges expire after 15 minutes. Their hashes are cleared on
  pass or expiry.
- The exact loopback setup message is deleted immediately after verification;
  no general inbox cleanup is allowed.

The retention intervals are constants owned by the agent-connection service and
covered by tests; handlers cannot override them.

## Idempotency, Concurrency, and Atomicity

### Request identity

Every setup submission carries a caller-generated `request_id` and a
server-computed fingerprint of the normalized request. Mupot stores a
non-secret request record with status and resulting resource IDs.

- request identity is scoped by `(tenant, actor_kind, actor_id, request_id)`;
- the tenant and actor are authentication-derived, never client fields;
- same `request_id`, same fingerprint, still running: return `in_progress`;
- same `request_id`, same fingerprint, completed: return the non-secret receipt
  and `credential_already_issued`;
- same `request_id`, different fingerprint: return `request_id_conflict`.

A different actor may use the same request string without collision. An actor in
one tenant cannot reserve or poison another tenant's request ID. The API never
looks up a request by bare `request_id`.

A completed retry never mints another token implicitly. Because raw credentials
are intentionally not persisted, a lost show-once response requires an explicit
**Replace credential** action that revokes the lost token and mints a new one
under a new request ID.

### Concurrent different request IDs

The partial unique index on `(tenant, target_key)` serializes setup mutation for
one logical target, even when requests have different IDs or actors.

- If two requests race while one is `pending`, the loser receives
  `agent_setup_in_progress`. It receives no other actor's request or receipt
  identifiers.
- Before reserving, the service conditionally marks an expired `pending` row
  for that target as `expired`; callers do not wait for the scheduled sweep to
  release a stale reservation.
- For new agents, `target_key` plus existing `UNIQUE(squad_id, slug)` prevents
  duplicate rows.
- For an unminted existing agent, both contenders may observe no binding, but
  only one can insert `(tenant, agent_id)`. A conflict causes the loser to
  re-read and reuse the winning member; it never creates a second member.
- The compatibility `mint_agent_token` primitive uses the same binding claim.
  If two direct mints race, the losing batch rolls back its provisional member,
  re-reads the winner's binding, and mints against that member.
- After the winner completes, retrying `issue_if_missing` returns
  `agent_already_connected` and the authorized non-secret state without minting.
- `add` intentionally creates another credential on a new request after the
  first operation finishes, but it must use the existing binding.
- `replace` requires `replace_token_id`; the revoke and replacement insert occur
  together and fail if that token is no longer live or does not match the
  canonical agent/member.

### Write boundaries

Setup uses three explicit boundaries because verification requires a client
round trip:

1. **Reservation batch:** insert the actor-scoped request in `pending`. A target
   uniqueness conflict returns `agent_setup_in_progress`.
2. **Provisioning batch:** conditionally require that exact request to remain
   `pending`, then commit the new-or-reused agent, home membership, canonical
   binding, capabilities, additional memberships, welded token hash, request
   status, and receipt. The raw token exists only in Worker memory and is
   returned only after this batch succeeds.
3. **Verification batch:** after the agent-bound callback, commit the tool
   outcomes, exact cleanup result, verification status, and request status.

Each batch is transactional. Every state transition has a conditional
`WHERE status = <expected>` guard and must report exactly one changed row.
Constraint or row-count failure rolls back that entire batch. If the Worker
commits credential issuance but dies before returning the raw value, a retry
does not mint again; it reports `credential_already_issued` and requires the
explicit replacement flow.

## Dashboard Flow

Add **Agents → Create or connect agent** as one owner/admin wizard.

### Step 1: Agent

- **Existing agent:** searchable by name or slug; displays identity, status, and
  immutable home squad.
- **New agent:** collects name, slug, role, runtime/model metadata, and home
  squad.

Resolve-before-create is mandatory. A matching existing agent is shown before
the operator can create another one.

### Step 2: Access

- home squad access is shown and cannot be removed;
- optional additional squads can be added;
- every squad shows the requested capability and the caller's grant ceiling;
- the review screen states that one agent identity will be reused.

### Step 3: Credential

- choose a bounded label;
- choose `member` or `observer` for the home credential preset;
- for an already connected agent, explicitly choose **Issue additional
  credential** or **Replace credential**; simply revisiting setup never mints;
- submit once using the stable `request_id`.

### Step 4: Connect

The show-once page displays the raw credential separately from paste-ready
configuration. Copy buttons never place the token into logs, URLs, or durable
HTML history.

The page also displays a stable non-secret setup receipt URL.

### Step 5: Verify

Verification uses an agent-bound MCP callback, followed by owner-UI polling. It
does not depend on the browser receiving a webhook from the client or asking the
operator to paste tool output.

1. The show-once page displays `receipt_id` and a 15-minute verification
   challenge alongside the generated client configuration. Only its SHA-256
   hash is stored.
2. After installing the configuration, the operator asks that client to call
   `verify_agent_connection { receipt_id, challenge }` using the new key.
3. MCP authentication derives `token_id`, `member_id`, `bound_agent_id`, and
   tenant from the bearer token. The callback requires all four to match the
   receipt before recording `client_connected_at`.
4. The callback invokes the same service functions used by `boot_context`,
   `orient`, `send`, and `inbox { peek: true }`. It sends one deterministic
   loopback `request` message, peeks for that exact message, records the
   outcomes, and deletes only that message by ID.
5. The owner page polls
   `GET /api/agent-connections/:receipt_id/status` with its authenticated
   dashboard session. The endpoint re-authorizes receipt access on every poll
   and returns only non-secret status. Polling stops at `messaging_verified`,
   `fail`, or challenge expiry; manual refresh is equivalent.

Mupot records only the request ID, token ID, agent ID, tool outcomes, message
correlation ID, timestamps, and pass/fail status. It does not record the raw
credential or message body.

The callback is the client-to-Mupot reporting path. It proves that the newly
installed bearer key authenticated as the intended token and agent. Reusing the
canonical service functions makes the product check exercise the same behavior
as the four public tools; surface-level integration tests still call those
tools directly to catch handler or schema drift.

The loopback uses `kind = request` and
`request_id = agent-connection:<receipt-id>`. A replay returns the already
recorded result. Challenge mismatch, expired challenge, wrong token, wrong
member, wrong agent, or wrong tenant fails closed without revealing which
binding differed. A failed verification attempt records `fail` but may be
retried with the same bound token while the challenge remains live; a pass is
terminal.

The completion page distinguishes:

- `credential_issued`;
- `client_connected`;
- `messaging_verified`; and
- an exact blocking reason when verification is incomplete.

## MCP Contract

Add one high-level tool named `provision_agent_connection`, with the same input
and service as the dashboard. The name deliberately avoids collision with the
existing session-local `connect` tool.

The primitive/full-provision boundary is explicit:

| Entry point | May create agent row | May create binding/member | May mint token | Unminted behavior |
| --- | ---: | ---: | ---: | --- |
| `create_agent` | yes | no | no | returns the unminted agent |
| `mint_agent_token` | no | yes | yes | atomically creates or claims the canonical binding |
| `grant_agent_capability` | no | no | no | refuses `agent_identity_unminted` |
| REST squad-membership route | no | no | no | refuses `agent_identity_unminted` |
| `setAgentSquadAccess` service | no | no | no | requires an explicit canonical `memberId` |
| `provision_agent_connection` | yes, for `new_agent` | yes | yes | owns the complete create-or-reuse sequence |

`create_agent` delegates only to the existing agent primitive that creates the
agent and home routing membership. It must never create a member, capability,
binding, or token as a side effect.

`grant_agent_capability`, `register_agent_key`, and the REST membership route
are compatibility primitives, not provisioning shortcuts. They do not
create-on-missing. An unminted agent returns `agent_identity_unminted` with
`provision_agent_connection` or `mint_agent_token` as the explicit next action.
An ambiguous or conflicting binding always refuses.

`mint_agent_token` remains the narrow credential primitive. It may establish a
missing canonical binding because that is the credential operation's declared
purpose, but it may not create an agent or add cross-squad access.

Add the agent-bound `verify_agent_connection` callback described above. MCP
authentication must expose the server-derived `tokenId` in `AuthContext` so the
callback can bind evidence to the exact issued token; client input can never
supply or override that ID.

The session-local `connect` tool remains a read-only compatibility bridge. Its
response must state that it has not completed permanent setup and link callers
to `provision_agent_connection`.

Human/workspace tokens calling `send`, `broadcast`, or `inbox` continue to fail
closed with `not_agent_bound`, but the error includes the canonical next action
instead of only describing the missing weld.

## Completion Receipt

The receipt is derived from committed state and is safe to revisit. It contains:

- setup request ID and status;
- agent ID, slug, status-at-issue, and whether it was created or reused;
- home squad;
- additional squad access and effective capability;
- canonical member ID;
- token ID, label, binding, and revocation state;
- MCP endpoint and transport;
- verification outcomes and timestamps; and
- links to the agent, squad, access, and operations pages.

Immutable receipt columns preserve the issuance-time snapshot. The page labels
separately joined current facts—agent status, token revocation, and current
access—as **current state**, so later administrative changes do not rewrite
history.

It never contains a raw token, token hash, session cookie, OAuth credential,
signing private key, verification challenge plaintext, generated configuration,
or message body.

## Error Handling

The flow returns stable, actionable errors:

- `agent_not_found`;
- `agent_slug_ambiguous`;
- `agent_identity_ambiguous`;
- `agent_identity_conflict`;
- `agent_identity_unminted`;
- `agent_inactive`;
- `home_squad_immutable`;
- `home_capability_ceiling`;
- `squad_not_found`;
- `public_origin_unconfigured`;
- `forbidden`;
- `cannot_grant_above_own_rank`;
- `request_id_conflict`;
- `agent_setup_in_progress`;
- `agent_already_connected`;
- `credential_already_issued`;
- `receipt_failed`; and
- `verification_incomplete`.

Errors before commit produce no mutation. Errors after credential issuance
never cause an implicit second mint.

## Test Strategy

### Service tests

Use SQLite/D1-backed tests for:

- new agent creation with home membership, capability, identity, and weld;
- existing unminted agent connection;
- existing minted agent connection reusing one member identity;
- additional squad synchronization across `memberships` and `capabilities`;
- home-squad `lead`, `admin`, and `owner` refusal through provisioning,
  `setAgentSquadAccess`, `grant_agent_capability`, and direct mint;
- idempotent retry and conflicting retry;
- same request string from different actors and tenants without collision;
- two different request IDs racing for one unminted agent;
- two different actors racing for one target without leaking request metadata;
- concurrent `issue_if_missing`, explicit `add`, and explicit `replace`
  semantics;
- database refusal of an agent token whose member differs from the canonical
  binding;
- partial-write rollback;
- ambiguous identity refusal;
- unminted `grant_agent_capability`, `register_agent_key`, and REST membership
  refusal without identity creation;
- grant-above-caller refusal;
- inactive, revoked, and cross-tenant refusal; and
- explicit credential replacement after a lost show-once response.

### Surface parity

Prove dashboard, MCP, and compatibility REST routes call the same service and
produce equivalent committed state and receipt shapes.

### Credential behavior

Using the issued agent-bound token, integration tests call:

- `boot_context` and assert the expected bound agent;
- `orient` without an explicit agent;
- `send` with a unique setup correlation;
- `inbox { peek: true }` and assert the matching message;
- `verify_agent_connection` and assert that its authenticated token, member,
  agent, and tenant match the receipt;
- cleanup of only the exact setup message; and
- a human/workspace token negative matrix returning `not_agent_bound`.

The verification matrix also covers wrong/expired challenge, wrong issued
token for the same agent, wrong agent, cross-tenant receipt ID, callback replay,
poll authorization, and a Worker failure after issuance but before the raw
credential response.

Generated-configuration tests set a malicious request `Host` while pinning a
different `PUBLIC_ORIGIN` and require every snippet plus `receipt.endpoint` to
use only the pinned origin. Missing, malformed, and non-loopback HTTP
`PUBLIC_ORIGIN` cases must fail before any request, binding, token, or receipt
write; pinned loopback HTTP remains valid for Wrangler local tests.

### Browser coverage

Cover:

- create-new-agent journey;
- connect-existing-agent journey;
- additional squad selection;
- show-once behavior;
- generated Codex, Claude Code, and Cursor configurations;
- safe refresh/retry after completion; and
- receipt verification states.

## Rollout

1. Run the legacy-weld preflight and add migration
   `0071_agent_connections.sql` with canonical bindings, token guards, request
   storage, receipt storage, and the pending-target unique index.
2. Add the orchestration and synchronized squad-access services.
3. Route existing MCP and REST primitives through the shared services.
4. Add the dashboard wizard and generated configurations.
5. Add connection verification and the durable receipt page.
6. Deprecate independent UI entry points after parity evidence is green.

### Implementation PR acceptance checklist

- The migration and service enforce the permanent `observer|member`
  home-squad capability ceiling at every entry point.
- All generated configurations and `receipt.endpoint` use the #88
  `canonicalOrigin()` path with a valid pinned `PUBLIC_ORIGIN`—HTTPS except for
  explicit loopback HTTP; no Host-derived fallback reaches durable or
  copy-paste output.
- `POST /api/org/agents/:id/memberships` moves from `lead` to `admin` on the
  target squad when it delegates to `setAgentSquadAccess`.
- The wizard is not enabled until the migration/service and rollout step 3's
  sole synchronized-writer routing are landed and green.

No production deployment, credential mint, agent mutation, or existing-token
revocation is authorized by this design.

## Non-Goals

- replacing the entire member/agent schema in this slice;
- moving an existing agent's home squad;
- weakening agent-bound enforcement for messaging;
- storing recoverable raw credentials;
- automatically granting owner/admin authority to a new agent;
- requiring an Ed25519 runtime key before basic MCP messaging; or
- silently repairing ambiguous identities.
