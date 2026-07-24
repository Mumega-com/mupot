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
- A caller cannot grant above its own effective rank.
- Existing agent references resolve ID-first and refuse ambiguous slugs.
- Tenant boundaries come from the Worker environment, never request input.

The service checks every affected scope before making any write.

### Canonical agent authorization identity

The service resolves active `member_tokens` rows welded to the agent:

- no active identity: create one dedicated member envelope as part of this
  operation;
- exactly one active identity: reuse it;
- more than one active identity: fail closed with
  `agent_identity_ambiguous`.

Retries and additional token mints always reuse the canonical identity. They
never create another `members` row for the same logical agent.

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

The home squad access cannot be removed through this operation. Deactivating or
moving an agent remains a separate lifecycle action.

### Credential mint

The credential path preserves the existing security invariants:

- generate a cryptographically random `mupot_...` token;
- store only its SHA-256 hash;
- set `member_tokens.agent_id` to the selected agent;
- return the raw token exactly once;
- never log, persist, or place the raw token in a durable receipt; and
- default the home grant to `member`, with `observer` as the only lower preset.

The result includes:

- token ID, agent ID, canonical member ID, label, and created time;
- canonical `https://<pot>/mcp` endpoint;
- Claude Code `.mcp.json`;
- Codex `config.toml` plus environment-variable instruction;
- Cursor MCP JSON; and
- a warning that the raw token cannot be recovered.

Generated snippets use Streamable HTTP (`type: "http"` where required), never
SSE.

## Idempotency and Atomicity

### Request identity

Every setup submission carries a caller-generated `request_id` and a
server-computed fingerprint of the normalized request. Mupot stores a
non-secret request record with status and resulting resource IDs.

- same `request_id`, same fingerprint, still running: return `in_progress`;
- same `request_id`, same fingerprint, completed: return the non-secret receipt
  and `credential_already_issued`;
- same `request_id`, different fingerprint: return `request_id_conflict`.

A completed retry never mints another token implicitly. Because raw credentials
are intentionally not persisted, a lost show-once response requires an explicit
**Replace credential** action that revokes the lost token and mints a new one
under a new request ID.

### Write boundary

For a new agent, the service commits the agent, home membership, canonical
member identity, all capability grants, all additional memberships, welded
token hash, request record, and receipt in one D1 transactional batch.

For an existing agent, it commits missing synchronized access rows, the welded
token hash, request record, and receipt in one transactional batch after
canonical identity validation.

Unique constraints and conditional writes enforce idempotency at the database
boundary. If any required statement fails or reports no write receipt, the
batch fails and no raw credential is returned.

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
- submit once using the stable `request_id`.

### Step 4: Connect

The show-once page displays the raw credential separately from paste-ready
configuration. Copy buttons never place the token into logs, URLs, or durable
HTML history.

The page also displays a stable non-secret setup receipt URL.

### Step 5: Verify

The guided verification asks the newly configured client to perform:

1. `boot_context {}`;
2. `orient {}`;
3. a correlated loopback `send` to its own agent identity; and
4. `inbox { peek: true }`, confirming the same correlation without consuming
   unrelated messages.

Mupot records only the request ID, token ID, agent ID, tool outcomes, message
correlation ID, timestamps, and pass/fail status. It does not record the raw
credential or message body.

The loopback verification message uses a dedicated setup kind and correlation.
After proof is recorded, Mupot removes only that exact setup message by ID so
verification does not pollute the operational inbox.

The completion page distinguishes:

- `credential_issued`;
- `client_connected`;
- `messaging_verified`; and
- an exact blocking reason when verification is incomplete.

## MCP Contract

Add one high-level tool named `provision_agent_connection`, with the same input
and service as the dashboard. The name deliberately avoids collision with the
existing session-local `connect` tool.

Existing tools remain supported but delegate:

- `create_agent` delegates agent creation to the shared service primitive;
- `mint_agent_token` delegates canonical identity and credential minting;
- `grant_agent_capability` delegates synchronized squad access; and
- the REST membership route delegates synchronized squad access.

The session-local `connect` tool remains a read-only compatibility bridge. Its
response must state that it has not completed permanent setup and link callers
to `provision_agent_connection`.

Human/workspace tokens calling `send`, `broadcast`, or `inbox` continue to fail
closed with `not_agent_bound`, but the error includes the canonical next action
instead of only describing the missing weld.

## Completion Receipt

The receipt is derived from committed state and is safe to revisit. It contains:

- setup request ID and status;
- agent ID, slug, status, and whether it was created or reused;
- home squad;
- additional squad access and effective capability;
- canonical member ID;
- token ID, label, binding, and revocation state;
- MCP endpoint and transport;
- verification outcomes and timestamps; and
- links to the agent, squad, access, and operations pages.

It never contains a raw token, token hash, session cookie, OAuth credential,
signing private key, or message body.

## Error Handling

The flow returns stable, actionable errors:

- `agent_not_found`;
- `agent_slug_ambiguous`;
- `agent_identity_ambiguous`;
- `agent_inactive`;
- `home_squad_immutable`;
- `squad_not_found`;
- `forbidden`;
- `cannot_grant_above_own_rank`;
- `request_id_conflict`;
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
- idempotent retry and conflicting retry;
- partial-write rollback;
- ambiguous identity refusal;
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
- cleanup of only the exact setup message; and
- a human/workspace token negative matrix returning `not_agent_bound`.

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

1. Add idempotency and receipt storage.
2. Add the orchestration and synchronized squad-access services.
3. Route existing MCP and REST primitives through the shared services.
4. Add the dashboard wizard and generated configurations.
5. Add connection verification and the durable receipt page.
6. Deprecate independent UI entry points after parity evidence is green.

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
