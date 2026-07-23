# Mupot Secret Environment Taker — Design

**Status:** Implemented (v1)  
**Date:** 2026-07-23  
**Depends on:** connector vault (#116) for scoped/typed connectors; setup wizard “never store secret” pattern; tenant CF substrate  
**Non-goal for v1:** OAuth Connect buttons; squad/agent-scoped CF secrets; replacing the connector vault

## 1. Goal

Let an agent adapt any MCP or API **without the human leaving mupot**, while keeping
secret **custody on the tenant’s Cloudflare account** (Worker secrets), not in mupot D1.

mupot owns the grant loop (request → gate → bind → receipt). Cloudflare owns the value.

## 2. Current state

| Piece | Today |
|---|---|
| Connector vault | AES-GCM in D1 via `CONNECTOR_MASTER_KEY`; admin paste at `/admin/connectors`; resolve-only at call time |
| Setup wizard | Explicitly **never** stores gateway/IM tokens; tells owner `wrangler secret put …` (leave-mupot friction) |
| Substrate thesis | Tenant holds CF account; no Mumega-held third-party secret in the path |
| Approvals | `/approvals` gate queue for gated acts; not yet used for secret grants |
| CF Secrets API | `PUT /accounts/{account_id}/workers/scripts/{script_name}/secrets` with `{ name, text, type: "secret_text" }`; bulk via `PATCH …/secrets-bulk` |

Gap: agents can *use* vault connectors; humans still leave mupot to acquire/set env for arbitrary MCP/API bindings.

## 3. Final state (v1)

1. Agent calls `secret_env.request` with an env schema (key names, purposes, reason, optional adapter hint).
2. Request becomes a gated approval card on `/approvals`.
3. Admin pastes values **inside mupot**.
4. mupot writes each key to the pot Worker via the tenant CF Secrets API, then discards values from memory.
5. D1 stores only metadata: binding names, purposes, status, actors — **never ciphertext of third-party secrets**.
6. At call time, adapters resolve `env[BINDING]` (Worker secret). Agent may query bound/unbound (boolean), never values.
7. Receipt: `secret_env.bound` with key **names** + actors + CF script id — never values.

Vault remains for typed/scoped connectors (`mcpwp`, `notion`, squad/agent scope). This feature is the **pot-level env bag** path.

## 4. Architecture

```
Agent                    mupot gate                 Tenant Cloudflare
─────                    ──────────                 ─────────────────
secret_env.request  →    approval card
                         (schema only)
Human paste         →    CF Secrets PUT ──────────► Worker secret bindings
                         discard memory
                         D1 metadata + receipt
Adapter at runtime  ←──── env[BINDING] ◄─────────── CF Worker secrets
```

### 4.1 Components

| Component | Responsibility |
|---|---|
| `secret_env.request` (MCP tool) | Agent proposes `{ keys: [{ name, purpose }], reason, adapter_hint? }`. Creates pending grant. No values. |
| `secret_env.status` (MCP tool) | Returns bound/unbound per requested key name. Never values. |
| Approval card (`/approvals`) | Shows names + purposes + reason; paste fields; Approve / Reject. Admin-only. |
| `secretEnv.bind` (service) | Validates names; `PUT`/`secrets-bulk` to CF; writes D1 metadata; emits receipt; never logs values. |
| `secretEnv.resolve` (host) | Reads `env[name]` for adapter use only. Fail-closed if missing. |
| CF ops bootstrap | Pot must already have CF account id, script name, and a CF API token with Workers Scripts secrets edit (one bootstrap Worker secret, e.g. set at provision). |

### 4.2 Binding name rules

- Key names must be valid Worker binding identifiers: `^[A-Z][A-Z0-9_]{0,63}$`.
- Reject names that collide with reserved pot bindings (`DB`, `CONNECTOR_MASTER_KEY`, auth secrets, etc.) via an explicit deny-list.
- Agent may propose any non-reserved name; **human gate is the allowlist**.

### 4.3 Custody rules (load-bearing)

1. Third-party secret values are **never** written to D1, R2, KV, receipts, bus payloads, or chat.
2. Values exist in Worker memory only for the duration of the CF API call on Approve.
3. Rotate = new paste → CF PUT overwrite → receipt `secret_env.rotated` (names only).
4. Revoke = CF delete (or bulk `null`) + D1 status `revoked` + receipt `secret_env.revoked`.
5. If CF ops token / account / script is missing → fail-closed with actionable error (no silent vault fallback for this path).

### 4.4 Relationship to connector vault

| Concern | Secret env taker (this) | Connector vault |
|---|---|---|
| Custody | Tenant CF Worker secrets | D1 ciphertext + `CONNECTOR_MASTER_KEY` |
| Scope | Pot-level only (v1) | pot / squad / agent |
| Shape | Arbitrary env bag for MCP/API adapt | Typed connectors + `custom` |
| UX | Agent request → `/approvals` paste | Admin `/admin/connectors` |

Do **not** dual-write the same secret to both. Adapters pick one resolve path by design.

## 5. Data model (D1 metadata only)

```sql
-- illustrative; exact migration name TBD at plan time
CREATE TABLE secret_env_bindings (
  id            TEXT PRIMARY KEY,
  tenant        TEXT NOT NULL,
  binding_name  TEXT NOT NULL,      -- CF Worker secret binding
  purpose       TEXT NOT NULL,
  adapter_hint  TEXT,               -- optional, e.g. "mcp:notion"
  status        TEXT NOT NULL,      -- pending | bound | revoked
  requested_by  TEXT NOT NULL,      -- agent / member id
  bound_by      TEXT,               -- admin who pasted
  request_id    TEXT NOT NULL,      -- ties multi-key grant
  created_at    TEXT NOT NULL,
  bound_at      TEXT,
  revoked_at    TEXT,
  UNIQUE (tenant, binding_name)
);

CREATE TABLE secret_env_requests (
  id            TEXT PRIMARY KEY,
  tenant        TEXT NOT NULL,
  reason        TEXT NOT NULL,
  schema_json   TEXT NOT NULL,      -- keys[{name,purpose}] only
  status        TEXT NOT NULL,      -- pending | approved | rejected
  requested_by  TEXT NOT NULL,
  decided_by    TEXT,
  created_at    TEXT NOT NULL,
  decided_at    TEXT
);
```

No `encrypted_secret` column. Audit/receipts mirror existing connector_audit discipline (names + actions only).

## 6. Control flow

### Request (agent)

1. Validate schema (names, deny-list, size caps).
2. Insert `secret_env_requests` + per-key rows `status=pending`.
3. Surface on `/approvals` as kind `secret_env_grant`.
4. Return to agent: `request_id` + pending key names.

### Approve (admin)

1. RBAC: org admin/owner only (same bar as `/admin/connectors`).
2. For each key: require non-empty paste; `PUT` CF secret `{ name, text, type: "secret_text" }` (prefer `secrets-bulk` for multi-key).
3. On full success: mark bindings `bound`, request `approved`, emit receipt.
4. On partial CF failure: do not mark failed keys bound; return actionable error; already-written CF secrets stay (idempotent retry).
5. Never echo pasted values in HTML responses. Confirmation lists **binding names only** (no last-4 of third-party secrets — those never touch D1).

### Reject

Mark request `rejected`; pending bindings discarded; no CF calls.

### Runtime resolve

Adapter/host calls `secretEnv.resolve(env, bindingName)` → `string | null`. Null = fail-closed for that adapter call.

## 7. Error handling

| Condition | Behavior |
|---|---|
| Missing CF ops token / account / script | `503 secret_env_ops_unconfigured` + setup hint |
| CF API 4xx/5xx | Surface CF error code/message (redacted); leave request pending for retry |
| Invalid binding name / deny-list hit | `400` at request time |
| Non-admin paste attempt | `403` |
| Resolve missing binding | Adapter fails closed; agent `status` shows unbound |

## 8. Testing

- Unit: name validation, deny-list, schema caps, metadata transitions.
- Service: bind path with mocked CF Secrets API — assert values never appear in D1 writes or receipts.
- Route: approval Approve/Reject RBAC; paste discarded after bind.
- MCP: `request` creates pending; `status` boolean only.
- No-secrets CI gate: ensure fixtures never contain live-looking third-party keys in snapshots.

## 9. Out of scope (v1)

- OAuth / Connect buttons for Notion/GitHub/etc.
- Squad- or agent-scoped CF secrets (use vault or namespaced bindings later).
- Auto-inject into host CLI `.env` / non-Worker runtimes.
- Replacing typed connector vault flows.
- Member (non-admin) secret paste.

## 10. Files likely to change (implementation plan will refine)

- `src/secret-env/` — request/bind/resolve/status service + CF client
- D1 migration for `secret_env_*` tables
- `src/dashboard/` — approval card kind + paste UI
- MCP tool registration for `secret_env.request` / `secret_env.status`
- Tests under `tests/secret-env*.test.ts`
- Optional: provision docs for bootstrap CF ops token scope

## 11. Decision log

| Decision | Choice | Why |
|---|---|---|
| Custody | Tenant CF Worker secrets | Matches substrate; human can revoke in their CF |
| In-mupot paste | Yes, via CF API token on Approve | Closes leave-mupot gap without D1 custody |
| Agent schema | Agent proposes; human gates | mupot request→gate→act loop |
| Vault coexistence | Keep vault for typed/scoped | Different job; avoid dual-write |
| OAuth | Later | Convenience, not identity |
