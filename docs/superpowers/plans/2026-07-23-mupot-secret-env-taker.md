# Secret Environment Taker Implementation Plan

**Status:** Plan executed (2026-07-23)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let agents request pot-level env bindings for MCP/API adapt; admins paste inside mupot; values land only as Cloudflare Worker secrets on the tenant account; D1 stores metadata + audit names only.

**Architecture:** New `src/secret-env/` module owns name validation, CF Secrets API client, request/bind/reject/status/resolve. MCP tools `secret_env_request` / `secret_env_status` create and inspect grants. Dashboard adds an admin paste/reject surface on `/approvals` (parallel to the existing task gate queue — paste cannot ride `task_verdict`). Connector vault is untouched.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, D1, Vitest, MCP JSON tools (`ToolSpec` in `src/mcp/`).

**Spec:** `docs/superpowers/specs/2026-07-23-mupot-secret-env-taker-design.md`

## Global Constraints

- Third-party secret **values** never written to D1, R2, KV, receipts, bus, logs, or HTML responses.
- Values exist in Worker memory only for the CF Secrets API call on Approve, then discard.
- Fail-closed when CF ops bootstrap (`SECRET_ENV_CF_API_TOKEN`, `SECRET_ENV_CF_ACCOUNT_ID`, `SECRET_ENV_CF_SCRIPT_NAME`) is incomplete — no silent vault fallback.
- Binding names: `^[A-Z][A-Z0-9_]{0,63}$`; explicit deny-list for reserved pot bindings.
- Agent proposes schema; human (org owner/admin) is the allowlist via gate.
- Pot-level only; do not dual-write to connector vault.
- Confirmation UI lists binding **names only** (no last-4 of third-party secrets).
- TDD: failing test → implement → pass → commit per task.
- Follow existing MCP tool module pattern (`src/mcp/loops.ts` + spread into `TOOLS` in `src/mcp/index.ts`).

## File map

| Path | Role |
|---|---|
| `migrations/0071_secret_env.sql` | `secret_env_requests`, `secret_env_bindings`, `secret_env_audit` |
| `src/secret-env/names.ts` | Binding name validate + deny-list (pure) |
| `src/secret-env/cf-secrets.ts` | CF Workers Secrets PUT / bulk / delete client |
| `src/secret-env/service.ts` | request, status, bind, reject, resolve, listPending |
| `src/secret-env/types.ts` | Public row / result types |
| `src/mcp/secret-env.ts` | `secret_env_request`, `secret_env_status` tools |
| `src/mcp/index.ts` | Register `SECRET_ENV_TOOLS` |
| `src/types.ts` | Optional `SECRET_ENV_CF_*` on `Env` |
| `src/dashboard/secret-env.ts` | HTML cards + bind/reject route handlers helpers |
| `src/dashboard/index.ts` | Mount routes; render pending grants on `/approvals` |
| `tests/secret-env-names.test.ts` | Name validation |
| `tests/secret-env-cf.test.ts` | CF client with mocked fetch |
| `tests/secret-env-service.test.ts` | Service + custody invariants |
| `tests/secret-env-mcp.test.ts` | MCP tool wiring |
| `wrangler.toml` (and digid/alpha as needed) | Comment block for bootstrap secrets / vars |

---

### Task 1: Migration + binding name rules

**Files:**
- Create: `migrations/0071_secret_env.sql`
- Create: `src/secret-env/names.ts`
- Create: `src/secret-env/types.ts`
- Test: `tests/secret-env-names.test.ts`

**Interfaces:**
- Produces: `isValidBindingName(name: string): boolean`
- Produces: `assertBindingName(name: string): void` (throws `Error` with code message `invalid_binding_name` or `reserved_binding_name`)
- Produces: `RESERVED_BINDING_NAMES: ReadonlySet<string>`
- Produces: types `SecretEnvRequestStatus`, `SecretEnvBindingStatus`, `SecretEnvKeySpec`

- [ ] **Step 1: Write the failing name tests**

```ts
// tests/secret-env-names.test.ts
import { describe, it, expect } from 'vitest'
import { isValidBindingName, assertBindingName, RESERVED_BINDING_NAMES } from '../src/secret-env/names'

describe('secret-env binding names', () => {
  it('accepts uppercase env-style names', () => {
    expect(isValidBindingName('NOTION_API_KEY')).toBe(true)
    expect(isValidBindingName('A')).toBe(true)
  })
  it('rejects lowercase, empty, too long, and illegal chars', () => {
    expect(isValidBindingName('notion_api_key')).toBe(false)
    expect(isValidBindingName('')).toBe(false)
    expect(isValidBindingName('1ABC')).toBe(false)
    expect(isValidBindingName('A'.repeat(65))).toBe(false)
  })
  it('rejects reserved pot bindings', () => {
    expect(RESERVED_BINDING_NAMES.has('DB')).toBe(true)
    expect(RESERVED_BINDING_NAMES.has('CONNECTOR_MASTER_KEY')).toBe(true)
    expect(() => assertBindingName('DB')).toThrow(/reserved_binding_name/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/secret-env-names.test.ts`

Expected: FAIL (module not found)

- [ ] **Step 3: Add migration + names + types**

`migrations/0071_secret_env.sql`:

```sql
-- 0071_secret_env.sql — pot-level secret env grants (CF Worker secret custody)
-- Values NEVER stored here — metadata + audit names only.

CREATE TABLE IF NOT EXISTS secret_env_requests (
  id            TEXT PRIMARY KEY,
  tenant        TEXT NOT NULL,
  reason        TEXT NOT NULL,
  schema_json   TEXT NOT NULL,
  status        TEXT NOT NULL, -- pending | approved | rejected
  requested_by  TEXT NOT NULL,
  decided_by    TEXT,
  created_at    TEXT NOT NULL,
  decided_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_secret_env_requests_pending
  ON secret_env_requests (tenant, status, created_at);

CREATE TABLE IF NOT EXISTS secret_env_bindings (
  id            TEXT PRIMARY KEY,
  tenant        TEXT NOT NULL,
  binding_name  TEXT NOT NULL,
  purpose       TEXT NOT NULL,
  adapter_hint  TEXT,
  status        TEXT NOT NULL, -- pending | bound | revoked
  requested_by  TEXT NOT NULL,
  bound_by      TEXT,
  request_id    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  bound_at      TEXT,
  revoked_at    TEXT,
  UNIQUE (tenant, binding_name)
);

CREATE INDEX IF NOT EXISTS idx_secret_env_bindings_request
  ON secret_env_bindings (tenant, request_id);

CREATE TABLE IF NOT EXISTS secret_env_audit (
  id           TEXT PRIMARY KEY,
  tenant       TEXT NOT NULL,
  request_id   TEXT,
  binding_name TEXT,
  action       TEXT NOT NULL, -- request | bind | reject | rotate | revoke
  actor_id     TEXT NOT NULL,
  detail       TEXT,
  recorded_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_secret_env_audit_tenant
  ON secret_env_audit (tenant, recorded_at DESC);
```

`src/secret-env/names.ts` — implement regex `^[A-Z][A-Z0-9_]{0,63}$` and deny-list at least:

`DB`, `AI`, `QUEUE`, `TENANT_SLUG`, `CONNECTOR_MASTER_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SECRET_ENV_CF_API_TOKEN`, `SECRET_ENV_CF_ACCOUNT_ID`, `SECRET_ENV_CF_SCRIPT_NAME`, `FLEET_PANEL_SK`, `BILLING_PLAN_SECRET`, `CC_SPEND_SECRET`, `GHL_API_KEY`, `GHL_WEBHOOK_SECRET`, `POSTHOG_PERSONAL_API_KEY`.

`src/secret-env/types.ts`:

```ts
export type SecretEnvRequestStatus = 'pending' | 'approved' | 'rejected'
export type SecretEnvBindingStatus = 'pending' | 'bound' | 'revoked'

export interface SecretEnvKeySpec {
  name: string
  purpose: string
}

export interface PublicSecretEnvRequest {
  id: string
  reason: string
  keys: SecretEnvKeySpec[]
  adapter_hint: string | null
  status: SecretEnvRequestStatus
  requested_by: string
  created_at: string
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run tests/secret-env-names.test.ts`

- [ ] **Step 5: Commit**

```bash
git add migrations/0071_secret_env.sql src/secret-env/names.ts src/secret-env/types.ts tests/secret-env-names.test.ts
git commit -m "$(printf 'feat: secret-env binding names and D1 migration\n\n- Add 0071_secret_env metadata tables (no secret columns)\n- Validate Worker binding names + reserved deny-list')"
```

---

### Task 2: Cloudflare Secrets client + Env bootstrap fields

**Files:**
- Create: `src/secret-env/cf-secrets.ts`
- Modify: `src/types.ts` (add optional `SECRET_ENV_CF_API_TOKEN?`, `SECRET_ENV_CF_ACCOUNT_ID?`, `SECRET_ENV_CF_SCRIPT_NAME?`)
- Modify: `wrangler.toml` — comment block documenting `wrangler secret put SECRET_ENV_CF_API_TOKEN` and vars for account id / script name (or all three as secrets)
- Test: `tests/secret-env-cf.test.ts`

**Interfaces:**
- Produces: `getSecretEnvCfConfig(env: Env): { accountId: string; scriptName: string; apiToken: string } | null`
- Produces: `putScriptSecrets(config, secrets: ReadonlyArray<{ name: string; text: string }>, fetchImpl?: typeof fetch): Promise<{ ok: true } | { ok: false; error: string; status?: number }>`
- Produces: `deleteScriptSecret(config, name: string, fetchImpl?: typeof fetch): Promise<{ ok: true } | { ok: false; error: string }>`
- Consumes: `Env` fields above

- [ ] **Step 1: Write failing CF client tests**

```ts
// tests/secret-env-cf.test.ts
import { describe, it, expect, vi } from 'vitest'
import { getSecretEnvCfConfig, putScriptSecrets } from '../src/secret-env/cf-secrets'
import type { Env } from '../src/types'

describe('secret-env CF client', () => {
  it('returns null when bootstrap incomplete', () => {
    expect(getSecretEnvCfConfig({ TENANT_SLUG: 't' } as Env)).toBeNull()
  })

  it('PUTs secret_text bindings and never returns values', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }))
    const config = {
      accountId: 'acct',
      scriptName: 'mupot-t',
      apiToken: 'tok',
    }
    const result = await putScriptSecrets(
      config,
      [{ name: 'NOTION_API_KEY', text: 'super-secret' }],
      fetchImpl as unknown as typeof fetch,
    )
    expect(result).toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toContain('/accounts/acct/workers/scripts/mupot-t/secrets')
    expect(init?.method).toBe('PUT')
    const body = JSON.parse(String(init?.body))
    expect(body).toEqual({ name: 'NOTION_API_KEY', text: 'super-secret', type: 'secret_text' })
    expect(JSON.stringify(result)).not.toContain('super-secret')
  })

  it('surfaces CF failure without echoing secret', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ success: false, errors: [{ message: 'nope' }] }), { status: 403 }),
    )
    const result = await putScriptSecrets(
      { accountId: 'a', scriptName: 's', apiToken: 't' },
      [{ name: 'X_KEY', text: 'leak-me' }],
      fetchImpl as unknown as typeof fetch,
    )
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('leak-me')
  })
})
```

For multi-key: loop sequential `PUT` (simpler than bulk for v1) or one `PATCH …/secrets-bulk` — prefer sequential PUT in v1 for clearer partial-failure handling.

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run tests/secret-env-cf.test.ts`

- [ ] **Step 3: Implement client + Env fields**

```ts
// src/secret-env/cf-secrets.ts (core shape)
export function getSecretEnvCfConfig(env: Env): {
  accountId: string
  scriptName: string
  apiToken: string
} | null {
  const accountId = env.SECRET_ENV_CF_ACCOUNT_ID?.trim() ?? ''
  const scriptName = env.SECRET_ENV_CF_SCRIPT_NAME?.trim() ?? ''
  const apiToken = env.SECRET_ENV_CF_API_TOKEN?.trim() ?? ''
  if (!accountId || !scriptName || !apiToken) return null
  return { accountId, scriptName, apiToken }
}

export async function putScriptSecrets(
  config: { accountId: string; scriptName: string; apiToken: string },
  secrets: ReadonlyArray<{ name: string; text: string }>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  for (const secret of secrets) {
    const url =
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}` +
      `/workers/scripts/${encodeURIComponent(config.scriptName)}/secrets`
    const res = await fetchImpl(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: secret.name, text: secret.text, type: 'secret_text' }),
    })
    if (!res.ok) {
      return { ok: false, error: 'cf_secrets_put_failed', status: res.status }
    }
  }
  return { ok: true }
}
```

Add the three optional fields to `Env` in `src/types.ts` with comments: account id + script name may be `[vars]`; API token **must** be `wrangler secret put`.

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run tests/secret-env-cf.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/secret-env/cf-secrets.ts src/types.ts tests/secret-env-cf.test.ts wrangler.toml
git commit -m "$(printf 'feat: Cloudflare Worker secrets client for secret-env\n\n- PUT secret_text bindings via tenant CF API\n- Fail-closed bootstrap config helper')"
```

---

### Task 3: Secret-env service (request / status / bind / reject / resolve)

**Files:**
- Create: `src/secret-env/service.ts`
- Test: `tests/secret-env-service.test.ts`

**Interfaces:**
- Consumes: `assertBindingName`, `getSecretEnvCfConfig`, `putScriptSecrets`, D1 tables from 0071
- Produces:
  - `requestSecretEnv(env, params: { keys: SecretEnvKeySpec[]; reason: string; adapterHint: string | null; requestedBy: string }): Promise<{ ok: true; request: PublicSecretEnvRequest } | { ok: false; error: string }>`
  - `listPendingSecretEnvRequests(env): Promise<PublicSecretEnvRequest[]>`
  - `getSecretEnvStatus(env, names: readonly string[]): Promise<Record<string, 'bound' | 'unbound' | 'pending' | 'revoked' | 'unknown'>>`
  - `bindSecretEnv(env, params: { requestId: string; values: Record<string, string>; actorId: string; fetchImpl?: typeof fetch }): Promise<{ ok: true; bound: string[] } | { ok: false; error: string }>`
  - `rejectSecretEnv(env, params: { requestId: string; actorId: string }): Promise<{ ok: true } | { ok: false; error: string }>`
  - `resolveSecretEnv(env: Env, bindingName: string): string | null` — reads `(env as Record<string, unknown>)[bindingName]` only if binding row status is `bound`

**Custody test invariant:** after `bindSecretEnv`, every D1 `INSERT`/`UPDATE` bind argument array and every audit `detail` string must not contain the pasted plaintext (assert by scanning mock call binds).

- [ ] **Step 1: Write failing service tests** (in-memory D1 mock patterned on `tests/connectors.test.ts`)

Cover:
1. `requestSecretEnv` rejects invalid/reserved names and empty reason; inserts request + pending bindings + audit `request`.
2. `getSecretEnvStatus` returns `pending` then `bound` after successful bind.
3. `bindSecretEnv` fails with `secret_env_ops_unconfigured` when CF config null (no fetch).
4. `bindSecretEnv` with mocked CF success marks bindings bound; **no bind arg equals pasted secret**.
5. Partial CF failure: first key put ok, second fails → first may be bound in CF but service returns error and does not mark the failed key bound; request stays `pending` for retry.
6. `rejectSecretEnv` sets request rejected; no CF calls.
7. `resolveSecretEnv` returns env value only when binding status is `bound`; otherwise null.

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run tests/secret-env-service.test.ts`

- [ ] **Step 3: Implement `src/secret-env/service.ts`**

Caps: max 20 keys per request; purpose max 280 chars; reason max 500 chars; adapterHint max 64 chars or null.

`bindSecretEnv` algorithm:
1. Load request by id+tenant; must be `pending`.
2. `getSecretEnvCfConfig` or return `secret_env_ops_unconfigured`.
3. For each pending binding on request: require non-empty `values[binding_name]`.
4. Call `putScriptSecrets` with all pairs.
5. On success: update bindings → `bound`, request → `approved`, audit `bind` with detail JSON `{ names: string[] }` only.
6. Never pass secret strings into SQL.

`resolveSecretEnv`:
```ts
export function resolveSecretEnv(env: Env, bindingName: string): string | null {
  // Caller must have verified binding is bound via D1 first (async helper preferred).
}
```

Prefer async `resolveSecretEnvBinding(env, name): Promise<string | null>` that SELECTs status (no secret column) then reads `env` binding.

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run tests/secret-env-service.test.ts tests/secret-env-names.test.ts tests/secret-env-cf.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/secret-env/service.ts tests/secret-env-service.test.ts
git commit -m "$(printf 'feat: secret-env request/bind/reject/status service\n\n- CF custody on approve; D1 metadata only\n- Custody tests assert plaintext never hits SQL')"
```

---

### Task 4: MCP tools

**Files:**
- Create: `src/mcp/secret-env.ts`
- Modify: `src/mcp/index.ts` — `import { SECRET_ENV_TOOLS } from './secret-env'` and spread into `TOOLS`
- Test: `tests/secret-env-mcp.test.ts`

**Interfaces:**
- Consumes: `requestSecretEnv`, `getSecretEnvStatus` from service; `ToolSpec`, `fail`, `done`, `str` from `./index`
- Produces: `SECRET_ENV_TOOLS: ToolSpec[]` with tools:
  - `secret_env_request` — any authenticated caller (member or agent); args `{ keys: [{ name, purpose }], reason: string, adapter_hint?: string }`
  - `secret_env_status` — any authenticated caller; args `{ names: string[] }` → map of statuses, never values

- [ ] **Step 1: Write failing MCP tests**

Mirror `tests/mcp-loop-tools.test.ts` style: invoke `run` with a fake `AuthContext` + mocked env/service if needed, or call tools against the in-memory service mock.

Assert:
- `secret_env_request` returns `{ request_id, keys: names[] }` without values
- invalid name → 400
- `secret_env_status` never includes a `value` field

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run tests/secret-env-mcp.test.ts`

- [ ] **Step 3: Implement tools + register**

```ts
// src/mcp/secret-env.ts — sketch
export const SECRET_ENV_TOOLS: ToolSpec[] = [
  {
    name: 'secret_env_request',
    scope: 'org (any authenticated principal proposes env bindings)',
    min: 'member',
    args: '{ keys: [{ name, purpose }], reason: string, adapter_hint?: string }',
    inputSchema: { /* object with keys array, reason, optional adapter_hint */ },
    async run(auth, env, args) {
      const requestedBy = auth.memberId ?? auth.userId
      if (!requestedBy) return fail(401, 'unauthenticated')
      // parse keys/reason → requestSecretEnv(...)
    },
  },
  {
    name: 'secret_env_status',
    // ...
  },
]
```

In `src/mcp/index.ts` add `...SECRET_ENV_TOOLS` next to `...LOOP_TOOLS`.

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run tests/secret-env-mcp.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/mcp/secret-env.ts src/mcp/index.ts tests/secret-env-mcp.test.ts
git commit -m "$(printf 'feat: MCP secret_env_request and secret_env_status tools\n\n- Agents propose env schema; status is boolean-ish only')"
```

---

### Task 5: Dashboard approve/reject (paste stays in mupot)

**Files:**
- Create: `src/dashboard/secret-env.ts` — `secretEnvApprovalsSection(requests)`, bind/reject HTML helpers
- Modify: `src/dashboard/index.ts` — on `GET /approvals`, if org admin, also `listPendingSecretEnvRequests` and append section; add:
  - `POST /admin/secret-env/:requestId/bind`
  - `POST /admin/secret-env/:requestId/reject`
- Test: `tests/secret-env-dashboard.test.ts` (RBAC + custody: response body must not contain pasted secret)

**Interfaces:**
- Consumes: `listPendingSecretEnvRequests`, `bindSecretEnv`, `rejectSecretEnv`, `isOrgAdmin` (existing dashboard helper)
- Produces: HTML section + routes

**UX note:** Existing `/approvals` is task-`review` only. Secret-env cards are an **additional admin-only section** on the same page (not `task_verdict`), because paste fields cannot go through the verdict endpoint.

- [ ] **Step 1: Write failing route/RBAC tests**

Using the dashboard test patterns in repo (or a focused hono app mount of the two POSTs):
1. Non-admin POST bind → 403
2. Admin bind with mocked CF → 200 HTML confirmation listing **names only**; response text must not include paste value
3. Admin reject → request rejected

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run tests/secret-env-dashboard.test.ts`

- [ ] **Step 3: Implement UI + routes**

Bind handler:
```ts
dashboardApp.post('/admin/secret-env/:requestId/bind', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) return c.json({ error: 'forbidden', need: 'admin' }, 403)
  const form = await c.req.parseBody()
  // Collect values keyed by binding name from form fields secret__BINDING_NAME
  const values: Record<string, string> = {}
  for (const [k, v] of Object.entries(form)) {
    if (k.startsWith('secret__') && typeof v === 'string') {
      values[k.slice('secret__'.length)] = v
    }
  }
  const result = await bindSecretEnv(c.env, {
    requestId: c.req.param('requestId'),
    values,
    actorId: auth.memberId ?? auth.userId,
  })
  // clear values reference; return names-only confirmation or error page
})
```

Card: one password input per pending key labeled with name + purpose; Approve submits bind; Reject posts reject.

- [ ] **Step 4: Run full secret-env suite**

Run:

```bash
npx vitest run tests/secret-env-names.test.ts tests/secret-env-cf.test.ts tests/secret-env-service.test.ts tests/secret-env-mcp.test.ts tests/secret-env-dashboard.test.ts
```

Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/secret-env.ts src/dashboard/index.ts tests/secret-env-dashboard.test.ts
git commit -m "$(printf 'feat: secret-env approval paste UI on /approvals\n\n- Admin bind writes CF Worker secrets; reject is metadata-only')"
```

---

### Task 6: Docs + operator bootstrap note

**Files:**
- Modify: `docs/superpowers/specs/2026-07-23-mupot-secret-env-taker-design.md` — set Status to `Implemented (v1)` only after code is merged; during this task set Status to `Plan ready`
- Create or modify short operator note in `docs/GO-LIVE.md` or `scripts/README.md` — bootstrap:

```bash
npx wrangler secret put SECRET_ENV_CF_API_TOKEN
# vars (or secrets): SECRET_ENV_CF_ACCOUNT_ID, SECRET_ENV_CF_SCRIPT_NAME
# Token needs Workers Scripts:Edit (secrets) on the pot account
```

- [ ] **Step 1: Add bootstrap docs only (no new behavior)**
- [ ] **Step 2: Commit**

```bash
git add docs/GO-LIVE.md docs/superpowers/specs/2026-07-23-mupot-secret-env-taker-design.md
git commit -m "$(printf 'docs: secret-env CF ops bootstrap for pot Worker secrets')"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|---|---|
| Agent proposes env schema | Task 4 (`secret_env_request`) |
| Gated paste in mupot | Task 5 |
| CF Worker secret custody | Tasks 2–3 |
| D1 metadata only | Tasks 1, 3 |
| `secret_env.status` boolean-ish | Task 4 |
| Resolve from `env[BINDING]` | Task 3 |
| Receipt/audit names only | Task 3 (`secret_env_audit`) |
| Fail-closed without CF ops | Task 3 |
| Deny-list reserved names | Task 1 |
| Vault coexistence / no dual-write | Global constraint (no vault calls in service) |
| Out of scope OAuth / squad scope | Not scheduled |

## Self-review notes

- No TBD placeholders in task steps.
- Types aligned: `SecretEnvKeySpec`, `PublicSecretEnvRequest`, CF config field names match across tasks.
- `/approvals` extension is explicit (not overloaded onto `task_verdict`) because paste fields require a dedicated bind route.
