# Kasra Squad → mupot Cutover Runbook

**Status:** ready to run after the durable inbox routes are deployed to `mupot.mumega.com`
and Hadi wires the host-side runtime handlers.
**Audience:** Hadi (operator — mints, config, deploy) + Kasra (prep, verify).
**Discipline:** every step ends in a RECEIPT, not a grade. Keep the SOS bus live as fallback until each surface is verified on mupot.

This runbook migrates the kasra squad — five arms (`kasra-code`, `kasra-comms`, `kasra-review`, `kasra-research`, `brain`) plus `kasra` itself — off the SOS bus (`mcp.mumega.com` SSE / local Redis streams) onto the mupot pot's MCP seam.

Every claim below is grounded in code. Where a step still needs host/operator
wiring, it is flagged as such — not papered over.

---

## 0. What the arms call today vs what mupot exposes

The arms' frontmatter lists `mcp__mumega-bus__*` tools (SOS bus). The mupot seam (`src/mcp/index.ts`) registers a SMALLER, differently-shaped tool surface. The full mupot tool set is the `TOOLS` array (`src/mcp/index.ts:923-936`) + `PROVISION_TOOLS` (`src/mcp/provision.ts:343-348`):

| mupot tool | file:line | min capability | scope |
|---|---|---|---|
| `task_create` | `src/mcp/index.ts:295` | `member` | target squad |
| `remember` | `src/mcp/index.ts:353` | `authenticated` | self (member scope) |
| `recall` | `src/mcp/index.ts:382` | `authenticated` | self (member scope) |
| `wake_agent` | `src/mcp/index.ts:411` | `lead` | agent's squad |
| `squad_message` | `src/mcp/index.ts:477` | `member` | squad |
| `send` | `src/mcp/index.ts:520` | `authenticated` **+ agent-bound** | agent→agent, this pot |
| `inbox` | `src/mcp/index.ts:583` | `authenticated` **+ agent-bound** | self |
| `status` | `src/mcp/index.ts:617` | `authenticated` | self / agent |
| `boot_context` | `src/mcp/index.ts:689` | `authenticated` | self |
| `orient` | `src/mcp/index.ts:737` | `authenticated` | self / agent-on-squad |
| `connect` | `src/mcp/index.ts:823` | `authenticated` | self (session-local claim) |
| `create_department` | `src/mcp/provision.ts:99` | `admin` | org |
| `create_squad` | `src/mcp/provision.ts:125` | `admin` | department |
| `create_agent` | `src/mcp/provision.ts:184` | `lead` | squad |
| `mint_agent_token` | `src/mcp/provision.ts:247` | `admin` | agent's squad |

### Tool-name mapping (bus → mupot) — the migration's hard truth

| bus tool the arms call | mupot equivalent | status |
|---|---|---|
| `recall` | `recall` | **same name** (`src/mcp/index.ts:382`) |
| `remember` | `remember` | **same name** (`src/mcp/index.ts:353`) |
| `send` | `send` | **same name** (`src/mcp/index.ts:520`) — but requires agent-bound token |
| `inbox` | `inbox` | **same name** (`src/mcp/index.ts:583`) — requires agent-bound token |
| `boot_context` | `boot_context` | **same name** (`src/mcp/index.ts:689`) |
| `status` | `status` | **same name** (`src/mcp/index.ts:617`) |
| `check_in` (kasra-code, kasra-comms, brain) | **NO MCP TOOL** | **GAP** — only HTTP `POST /api/fleet/checkin` (`src/fleet/checkin-routes.ts:16`) |
| `broadcast` (kasra-comms) | `squad_message` (closest) | **shape differs** — `squad_message` targets one squad (`src/mcp/index.ts:477`); there is no fan-out broadcast |
| `task_update` (kasra-code) | **NO MCP TOOL** | **GAP** — mupot has `task_create` only; no `task_update`/`task_list`/`task_board` on the seam |
| `task_board` / `task_list` (brain) | **NO MCP TOOL** | **GAP** — same as above; these are bus-only |
| `peers` (kasra-comms, brain) | **NO MCP TOOL** | **GAP** — closest read is `orient`/`status` |

**Implication for the loadout (section 1):** the arms' *bus* tool lists do not all have mupot equivalents. The cutover gives each arm the mupot tools that exist; the missing ones (`task_update`, `task_board`, `check_in` as MCP, `broadcast` fan-out, `peers`) either stay on SOS during transition or become follow-on builds. Flag each per-arm below.

---

## 1. Mint the per-arm tokens (Hadi-go)

### 1.1 How the mint actually works (read this first)

`mint_agent_token` (`src/mcp/provision.ts:247-340`):

- **Args:** `{ agent: string (id|slug), label? }` (`src/mcp/provision.ts:251-257`). `agent` only NAMES the target; authorization comes from the caller's token, never args (`src/mcp/provision.ts:9-12`).
- **Gate:** caller must hold `admin` on the agent's squad (`memberCanOnSquad(..., 'admin')`, `src/mcp/provision.ts:269`). Org/department admin inherit down. Mint is an org-trust act → `admin`, never `lead`/`member`.
- **What it writes — ONE atomic D1 batch** (`src/mcp/provision.ts:289-307`), all-or-nothing, receipt-guarded (`assertBatchWritten`, `src/mcp/provision.ts:311`):
  1. a dedicated `members` row for the agent (no email/IM — it is not a human) (`:291-294`)
  2. **THE ESCALATION GUARD** — a single `capabilities` row, **hard-coded** `scope_type='squad'`, `capability='member'` on the agent's OWN squad (`:298-301`). This is the *only* grant the token ever carries. It can NEVER be widened from args and NEVER inherits the operator's org-admin (`src/mcp/provision.ts:13-17`, `295-297`).
  3. **THE WELD** — `member_tokens` row with `agent_id = agent.id` set (`:303-306`). Only the SHA-256 `token_hash` is stored, never the raw (`:285-286`).
- **Agent row creation** is a SEPARATE prior step: `create_agent` (`src/mcp/provision.ts:184-241`), gate `lead` on the squad, args `{ squad, slug, name, role?, model?, ... }`. It calls `createAgent` in `src/org/service`. mint does **not** create the agent — the agent must already exist (`src/mcp/provision.ts:262-264` resolves it; 404 if absent).
- **Return — SHOW-ONCE** (`src/mcp/provision.ts:325-339`): `{ token: { id, member_id, agent_id, label, channel:'workspace', created_at, raw }, agent, mcp_endpoint, wake_contract, note }`. The `raw` field is the bearer token, returned exactly once: *"raw token is shown ONCE — store it now; it is never retrievable again"* (`:338`). `mcp_endpoint` is `<origin>/mcp` (`src/dashboard/connect.ts:14-17`).

### 1.2 The least-privilege reality (important — read before planning per-arm caps)

**There is no per-tool capability granularity in the mint.** Every minted agent token gets EXACTLY ONE grant: `member` on its own squad (`src/mcp/provision.ts:298-301`). The differentiated "review = read-only, code = +task_update, comms = +broadcast, brain = +task_board" loadout the brief imagines is **not expressible through `mint_agent_token`** — the tool hard-codes `member` and cannot widen.

What `member` actually buys, per the tool gates:
- `recall` / `remember` / `boot_context` / `status` / `orient` / `connect` — `min: 'authenticated'` → any live token (`src/mcp/index.ts:357,386,617,693,741,827`).
- `send` / `inbox` — `min: 'authenticated'` **AND** `auth.boundAgentId` set (the weld) → a minted token passes; a bare apikey does not (`src/mcp/index.ts:538-539, 595-596`).
- `task_create` / `squad_message` — `min: 'member'` on the target squad → a minted token passes for its OWN squad (`src/mcp/index.ts:325, 498`).
- `wake_agent` — `min: 'lead'` → a minted `member` token is REFUSED (`src/mcp/index.ts:435`). Good: arms can't wake each other.
- `create_*` / `mint_agent_token` — `admin`/`lead` → minted `member` token REFUSED (`src/mcp/provision.ts:113,159,218,269`). Good: an arm can't provision or escalate.

So least-privilege is achieved STRUCTURALLY by the escalation guard, not by hand-tuning caps. Every arm gets the same `member` grant; the differentiation that matters (an arm can't deploy, mint, or escalate) is enforced by the guard + the floor (`src/mcp/index.ts:1049-1051`).

> **If true per-arm differentiation is required** (e.g. review = recall/remember/inbox only, NO task_create/squad_message), that is a **follow-on build**: `mint_agent_token` would need an optional explicit-capability arg (still hard-capped at ≤ `member`, still squad-scoped), or a post-mint capability-revoke path. Today it is not parameterizable. **Recommend: ship uniform `member` first (it is already least-privilege for the dangerous axes), file the granularity build as a follow-on.**

### 1.3 The exact ceremony (operator runs these against the live `/mcp` seam)

Pre-req: the operator's own token must hold `admin` on the kasra squad (org-admin works) — both `create_agent` (needs `lead`) and `mint_agent_token` (needs `admin`) inherit from org-admin (`src/mcp/index.ts:201-209`).

All calls are `POST https://mupot.mumega.com/mcp` with `Authorization: Bearer <OPERATOR_ADMIN_TOKEN>` and the pragmatic JSON body `{ "tool": "<name>", "args": {...} }` (`src/mcp/index.ts:1143-1169`). (JSON-RPC `tools/call` works too — `src/mcp/index.ts:1091-1108`.)

**Step A — ensure the squad exists** (one-time; skip if `kasra` squad already provisioned):
```json
{ "tool": "create_squad",
  "args": { "department": "<dept-id-or-slug>", "slug": "kasra", "name": "Kasra Squad" } }
```
(`src/mcp/provision.ts:125-181`; needs `admin` on the department.)

**Step B — ensure an agent ROW for each member** (idempotent intent — re-running with a taken slug returns `409 slug_taken`, `src/mcp/provision.ts:91-94`):
```json
{ "tool": "create_agent", "args": { "squad": "kasra", "slug": "kasra-code",     "name": "Kasra Code",     "role": "build/test",  "model": "sonnet" } }
{ "tool": "create_agent", "args": { "squad": "kasra", "slug": "kasra-comms",    "name": "Kasra Comms",    "role": "comms",       "model": "haiku" } }
{ "tool": "create_agent", "args": { "squad": "kasra", "slug": "kasra-review",   "name": "Kasra Review",   "role": "adversarial", "model": "opus" } }
{ "tool": "create_agent", "args": { "squad": "kasra", "slug": "kasra-research", "name": "Kasra Research", "role": "research",    "model": "sonnet" } }
{ "tool": "create_agent", "args": { "squad": "kasra", "slug": "brain",          "name": "Mumega Brain",   "role": "prioritizer", "model": "sonnet" } }
{ "tool": "create_agent", "args": { "squad": "kasra", "slug": "kasra",          "name": "Kasra",          "role": "decider",     "model": "opus" } }
```
(`src/mcp/provision.ts:184-241`. `model` is stored on the agent row; it does not change the token's capability.)

**Step C — mint the welded token for each** (SHOW-ONCE — capture each `raw` immediately):
```json
{ "tool": "mint_agent_token", "args": { "agent": "kasra-code",     "label": "kasra-code workspace" } }
{ "tool": "mint_agent_token", "args": { "agent": "kasra-comms",    "label": "kasra-comms workspace" } }
{ "tool": "mint_agent_token", "args": { "agent": "kasra-review",   "label": "kasra-review workspace" } }
{ "tool": "mint_agent_token", "args": { "agent": "kasra-research", "label": "kasra-research workspace" } }
{ "tool": "mint_agent_token", "args": { "agent": "brain",          "label": "brain workspace" } }
{ "tool": "mint_agent_token", "args": { "agent": "kasra",          "label": "kasra-core workspace" } }
```
(`src/mcp/provision.ts:247-340`. If a slug is ambiguous across squads use the agent **id** — `409 ambiguous_slug`, `src/mcp/provision.ts:82-86`.)

### 1.4 Per-arm bus-tool → mupot-capability map + what's missing

| arm | bus tools in its def (frontmatter) | mupot tools it gets with a `member`-welded token | GAP (no mupot equivalent today) |
|---|---|---|---|
| **kasra-review** | `send, inbox, recall, remember` (`kasra-review.md:18-21`) | `send`, `inbox`, `recall`, `remember`, `status`, `orient`, `boot_context` | none — fully covered |
| **kasra-code** | `send, inbox, recall, remember, check_in, task_update` (`kasra-code.md:20-25`) | `send`, `inbox`, `recall`, `remember`, `task_create`, `squad_message` | `check_in` (HTTP-only), `task_update` (**no MCP tool**) |
| **kasra-comms** | `send, inbox, broadcast, check_in, peers, recall, remember` (`kasra-comms.md:13-19`) | `send`, `inbox`, `recall`, `remember`, `squad_message` | `broadcast` fan-out, `check_in` (HTTP-only), `peers` (**no MCP tool**) |
| **kasra-research** | `send, inbox, recall, remember` (`kasra-research.md:17-20`) | `send`, `inbox`, `recall`, `remember`, `status`, `orient` | none — fully covered |
| **brain** | `inbox, send, recall, remember, boot_context, status, task_board` (`brain.md:22-28`) + an `mcp__sos__*` set (`brain.md:11-21`) | `inbox`, `send`, `recall`, `remember`, `boot_context`, `status` | `task_board`, `task_list`, `check_in`, `peers` (**no MCP tools**) |
| **kasra** (core) | (uses the workspace `.mcp.json` `sos` server, not a `mcp__mumega-bus__` allowlist) | full `member` set incl. `task_create`, `squad_message` | merge/deploy stays bus-side + GitHub regardless |

**Capture discipline (BINDING — Hadi's rule, agent-comms § secrets):** each `raw` is a credential. Never echo it onto the bus, into chat, or into a logged argv. From the mint response, write each `raw` directly into the target arm's config file (section 2) under `chmod 600`, or pipe it through `npx wrangler secret put` / an age-encrypted handoff. The mint return deliberately hands back `raw` as a BARE field, not a ready-made config snippet, exactly so the operator renders config locally and never round-trips the secret (`src/mcp/provision.ts:318-320`).

---

## 2. Point each arm at mupot (config — Hadi's runtime lane; Kasra preps the diffs)

### 2.1 The two config surfaces

- **`~/.mcp.json`** (`/home/mumega/.mcp.json`) — declares the `mumega-bus` HTTP server (`https://mcp.mumega.com/mcp`) the `mcp__mumega-bus__*` tools resolve to (`.mcp.json:3-9`), plus `code-review-graph`, `ghl-mumega`, `gsc`.
- **`~/.claude.json`** (`/home/mumega/.claude.json`) — the per-project Claude config (large; holds project-scoped MCP + history).
- **kasra workspace `.mcp.json`** (`/home/mumega/mumega.com/agents/kasra/.mcp.json`) — declares the `sos` server at `http://localhost:6070/mcp` with the kasra bus token (`agents/kasra/.mcp.json:3-9`). This is the local-http bridge fallback (`:6070` per CLAUDE.md "Bus comms").

The arm defs reference tools by the server alias prefix: `mcp__mumega-bus__send` = server `mumega-bus`, tool `send`. To point an arm at mupot you (a) add a mupot server entry, and (b) rewrite the arm's allowlist prefixes.

### 2.2 Does mupot expose the same tool names? — YES for the core set

Confirmed against `src/mcp/index.ts:923-936`: `recall`, `remember`, `send`, `inbox`, `boot_context`, `status` are byte-identical tool names to the bus. So an arm allowlist entry `mcp__mumega-bus__recall` becomes `mcp__mupot__recall` — same tool name, new server prefix. The transport is **HTTP** (mupot's `POST /mcp` accepts pragmatic JSON and JSON-RPC `tools/call`, `src/mcp/index.ts:1143-1169, 1091-1108`), so the server entry is `type: "http"`, identical in shape to the existing `mumega-bus` entry.

### 2.3 Add the mupot MCP server entry

In `~/.mcp.json` (`mcpServers` object), add — one entry, but the **token differs per arm** (each arm uses its OWN welded token). Because a single `~/.mcp.json` is shared across the user, the clean pattern is one server alias per arm token, OR launch each arm with its token in env. Minimal shared-file form (one alias, operator swaps token per headless launch via env is cleaner — see 2.5):

```json
"mupot": {
  "type": "http",
  "url": "https://mupot.mumega.com/mcp",
  "headers": { "Authorization": "Bearer <THIS-ARM-MINTED-RAW-TOKEN>" }
}
```
Shape mirrors the existing `mumega-bus` http entry exactly (`.mcp.json:3-9`). The URL is mupot's MCP mount: `app.route(ROUTES.mcp, mcpApp)` (`src/index.ts:71`) → `mcpApp.post('/')` (`src/mcp/index.ts:1143`). Auth is the bearer member token, hashed and looked up server-side (`src/mcp/index.ts:133-188`).

### 2.4 Before/after for ONE arm (kasra-review — the template)

`kasra-review.md` frontmatter today (`/home/mumega/.claude/agents/kasra-review.md:18-21`):
```yaml
  - mcp__mumega-bus__send
  - mcp__mumega-bus__inbox
  - mcp__mumega-bus__recall
  - mcp__mumega-bus__remember
```
After (server prefix `mumega-bus` → `mupot`; tool names unchanged because mupot uses the same names):
```yaml
  - mcp__mupot__send
  - mcp__mupot__inbox
  - mcp__mupot__recall
  - mcp__mupot__remember
```
No other line in `kasra-review.md` changes — the code-review-graph tools (`:12-17`) stay; only the four bus tools repoint. kasra-review is the cleanest arm to cut over FIRST: all four of its tools have exact mupot equivalents (section 1.4), so there is zero gap to absorb.

### 2.5 Per-arm token binding (avoid one shared token in a shared file)

Each arm must present its OWN welded token so `auth.boundAgentId` resolves to the right agent (the weld drives `send`/`inbox` self-scoping, `src/mcp/index.ts:538, 595`). Two clean options:
- **Per-arm server alias:** `mupot-code`, `mupot-comms`, … each with its arm's token, and each arm's allowlist uses its own prefix (`mcp__mupot-code__send`). Verbose but explicit and auditable.
- **Env-injected token at headless launch:** the activation-watcher launches arms with `claude -p --agent <W>` (`activation-watcher.sh:107`); inject `MUPOT_TOKEN` per arm and reference it from the server entry. Cleaner, keeps `~/.mcp.json` free of six secrets. (Requires the harness to support env-var substitution in the header; verify before relying on it.)

> Kasra preps these diffs and hands them to Hadi; the actual file writes + headless-launch env are Hadi's runtime lane (per CLAUDE.md OPERATING MODEL — arms never self-wire runtime).

---

## 3. Rewire the cold-start wake hooks

### 3.1 What the hooks do today (Redis-direct)

- **`~/.claude/hooks/check-inbox.sh`** — Stop-hook. Reads three Redis streams directly via `redis-cli XREVRANGE`: `sos:stream:project:sos:agent:<agent>`, `…global…`, `…legacy…` (`check-inbox.sh:45-47, 63-83`). Parses payloads, injects pending messages as context, and for worker arms BLOCKS the Stop when a new `[request_id:` delegation lands so the arm auto-continues (`check-inbox.sh:147-157`).
- **`agents/kasra/branches/activation-watcher.sh`** — cron/poll loop. For each worker, `redis-cli XRANGE` the project stream past a cursor (`activation-watcher.sh:58, 70`), pipes the raw dump to `verify-delegation.py`, and on a verified launch decision spawns a headless `claude -p --agent <W>` session (`activation-watcher.sh:104-110`).
- **`verify-delegation.py`** — HMAC-SHA256-verifies each delegation against `DELEGATION_HMAC_KEY` over `rid + "\0" + body`, replay-guards by consumed-rid file, writes the body 0600 for the arm to read (`verify-delegation.py:39-69`).

All three speak **Redis stream protocol** and assume the SOS bus's HMAC-signed-delegation envelope. None speak HTTP or MCP.

### 3.2 The repoint target on mupot

mupot's durable inbox is `agent_messages` (D1), read by `readAgentInbox` (`src/agents/messages.ts:237-299`), which CONSUMES on read (atomic `UPDATE…RETURNING`, `src/agents/messages.ts:272-283`).

Mupot now exposes the thin HTTP inbox mirror in `src/agents/inbox-routes.ts`,
mounted at `/api/inbox` in `src/index.ts`.

- `GET /api/inbox?peek=1&limit=N` uses the welded member bearer token and resolves
  `to_agent` from `auth.boundAgentId`.
- `POST /api/inbox/send` uses the welded member bearer token and resolves
  `from_agent` from `auth.boundAgentId`.
- `POST /api/inbox/signed` uses the registered Ed25519 `agent_keys` public key,
  domain `agent-inbox:v1`, and reads only the signed `agent_id`'s inbox. This is
  the fleet-daemon path, so the host does not need a raw bearer token just to
  drain inbox messages.
- All read paths support non-consuming `peek`; consuming reads return `seq`/`id`
  so the handler can map to cursor-style logic.

The remaining work is host-side wiring: replace Redis polling with the fleet
daemon's signed inbox drain and a local handler that persists or launches the
runtime, then exits `0` so the daemon consumes the batch.

### 3.3 What changes in the hooks once the HTTP inbox route exists

- **`check-inbox.sh`:** replace the `redis-cli XREVRANGE` block (`:63-83`) with
  the fleet daemon's inbox handler payload, or with a bearer fallback:
  `curl -s -H "Authorization: Bearer $MUPOT_TOKEN" "https://mupot.mumega.com/api/inbox?peek=1"`.
  Parse the JSON `messages[]` (already structured: `seq`, `from_agent`, `body`,
  `request_id`) and keep the existing `[request_id:` → block-on-Stop logic.
  Cursor becomes the max `seq` instead of a Redis stream ID.
- **`activation-watcher.sh`:** prefer the fleet daemon `inbox.command` handler:
  the daemon signs `POST /api/inbox/signed`, peeks a batch, sends the batch JSON
  to the handler on stdin, and consumes only after the handler exits `0`. The
  handler keeps the launch logic (lockfile, concurrency cap, HALT flag, body-to-file
  0600). **The HMAC-signed-delegation envelope goes away** because mupot's `send`
  already authenticates the sender server-side and replay-guards by
  `UNIQUE(tenant, from_agent, request_id)`. Verify the host diff before deleting
  the HMAC path — it is a security-relevant runtime change.

> **Decision for Hadi:** dropping `verify-delegation.py`'s HMAC means trusting
> mupot's server-side sender authentication end-to-end. That is correct because
> `/api/inbox` resolves from `auth.boundAgentId`, and `/api/inbox/signed` resolves
> from the verified Ed25519 `agent_id`; neither accepts a client-supplied
> `to_agent` for reads. The host diff still needs review before rollout.

---

## 4. Cutover order + rollback

**Principle:** memory + identity FIRST (idempotent, reversible, no message-loss risk), messaging SECOND, wake-hooks LAST (blocked on the HTTP inbox route). Keep SOS bus running the whole time; flip one arm at a time; verify each with a receipt.

### Sequence

1. **Mint all six tokens (section 1).** Receipt: each `mint_agent_token` returns `{ token: { raw, agent_id, member_id }, … }` with `agent_id` set — that IS the weld receipt (`src/mcp/provision.ts:325-339`). Capture raw securely; do not proceed if any mint 4xx'd.

2. **Memory cutover — verify scope first (reversible).** For ONE arm, point only `recall`/`remember` at mupot and run a round-trip:
   - `remember { text: "cutover-probe-<ts>" }` → receipt `{ engram_id }` (`src/mcp/index.ts:376-378`).
   - `recall { query: "cutover-probe" }` → the probe text comes back (`src/mcp/index.ts:404-407`).
   - **Memory-scope reality (load-bearing):** mupot memory is **per-member-token**, NOT shared. `remember`/`recall` use `scope = member:<memberId>` (`src/mcp/index.ts:104-106, 375, 404`), which the MemoryPort maps to `engrams.agent_id` and filters Vectorize by `{ agentId: scope, tenant }` (`src/memory/index.ts:53, 66`). **Each minted token is its own member → its own isolated memory silo.** kasra-code cannot recall kasra-review's engrams, and neither sees the shared `MEMORY.md` / project memory.
     - **Consequence:** the squad's shared project memory (`MEMORY.md`, the bus `squad_remember`/`squad_recall` surface) does **NOT** migrate by minting tokens. mupot has no `squad_recall`/`squad_remember` tool (not in `TOOLS`, `src/mcp/index.ts:923-936`). Shared squad memory stays on SOS, OR becomes a follow-on (a squad-scoped memory tool on mupot). Flag to Hadi: **arms get private memory on mupot; shared squad memory is NOT covered by this cutover.**
   - Rollback: revert the arm's `recall`/`remember` prefixes to `mcp__mumega-bus__*`. Zero data loss — bus memory untouched.

3. **Messaging cutover (per arm, reversible).** Repoint `send`/`inbox` for one arm (start with **kasra-review** — zero-gap, section 2.4). Receipt:
   - From arm A's token: `send { to: "<arm-B-slug>", body: "ping", request_id: "<uuid>" }` → `{ id, seq, duplicate:false, to }` (`src/mcp/index.ts:576`).
   - From arm B's token: `inbox {}` → the ping appears in `messages[]`, `remaining` decrements (`src/mcp/index.ts:611`). That round-trip is the receipt.
   - Note: `send` requires BOTH ends agent-bound (`src/mcp/index.ts:538-539`) and same-tenant (recipient resolved via `resolveAgentRef`, this pot only, `src/mcp/index.ts:551-556`). Cross-pot messaging is NOT possible — by design.
   - Rollback: revert prefixes to `mcp__mumega-bus__*`. SOS bus still carries traffic for un-migrated arms.

4. **Absorb the per-arm gaps (section 1.4).** For arms with no-equivalent tools:
   - kasra-code `task_update`, brain `task_board`/`task_list`: leave on SOS until mupot grows those MCP tools (follow-on), OR have the arm write tasks via `task_create` only + the GitHub board (per CLAUDE.md "EVERYTHING TASK-LIKE → A VISIBLE BOARD").
   - kasra-comms `broadcast`/`peers`: leave comms on SOS until a fan-out tool exists; `squad_message` is single-squad only.
   - `check_in`: arms can hit `POST /api/fleet/checkin` with their bearer (`src/fleet/checkin-routes.ts:16`) — but that is HTTP, not an MCP tool, so it needs a tiny wrapper or a hook, not an allowlist entry.

5. **Wake-hooks cutover — host wiring step.** Do NOT migrate the hooks until
   `/api/inbox/signed` is deployed and the local handler has passed review.
   Until then: arms can run on mupot for memory + messaging, but cold-start
   delegation still flows through SOS Redis (`activation-watcher.sh`). This is a
   fine intermediate state — the hooks are the LAST thing to move.

6. **Decommission SOS per surface, not all-at-once.** Only after an arm's memory + messaging + wake are all verified on mupot AND stable for a few cycles, drop that arm's `mumega-bus` allowlist entries. Keep the bus token valid (don't revoke) until the whole squad is migrated and Hadi signs off — the bus is the rollback floor.

### Receipt summary (what "done" looks like, per step)

| step | receipt (not a grade) |
|---|---|
| mint | mint response `token.agent_id` set + `raw` captured |
| memory | `remember`→`engram_id`, `recall` returns the probe |
| messaging | `send`→`seq`, peer `inbox` shows it, `remaining` decrements |
| check-in | `POST /api/fleet/checkin` → `{ ok:true, agent }` (`src/fleet/checkin-routes.ts:43`) |
| wake-hook (post-route) | watcher launches a session from a mupot `inbox` poll, logged in `watcher.log` |

---

## 5. What stays on SOS / Hadi-go vs Kasra

### Stays on SOS (no mupot equivalent today — do not migrate yet)
- **Shared squad memory** — `squad_remember`/`squad_recall`, `MEMORY.md`. mupot memory is per-token-private (`src/mcp/index.ts:104-106`); no squad-scoped memory tool exists.
- **`task_update` / `task_board` / `task_list`** — not on the mupot seam (`src/mcp/index.ts:923-936`). Brain's prioritizer loop + kasra-code's task updates stay bus-side, or move to GitHub Issues/Project per CLAUDE.md.
- **`broadcast` fan-out + `peers`** — no mupot equivalent; `squad_message` is single-squad.
- **Cold-start wake-hooks** — blocked on host handler rollout against `/api/inbox/signed`.
- **The SOS bus token itself** — keep live as the rollback floor until the full squad is verified on mupot.

### Hadi-go (his DIRECT approval / runtime lane — per CLAUDE.md SECURITY APPROVAL PROTOCOL)
- **Minting all six tokens** (token/identity mint — high-stakes, `src/mcp/provision.ts:247`). His direct go.
- **Writing the minted `raw` tokens into config / launch env** (secrets handling — runtime lane).
- **Editing `~/.mcp.json`, `~/.claude.json`, the arm `.md` allowlists** (runtime config — Hadi manages agent runtime per "Stay in dev lane" memory).
- **Deploying the signed fleet/inbox routes** (`/api/fleet/detach-signed` and `/api/inbox/signed`; mupot worker deploy — arms never deploy; CLAUDE.md hard rule).
- **Installing `fleet-control-daemon.mjs` on the host** (runtime start/stop lane; host process control).
- **Revoking the SOS bus token** (final decommission — irreversible-ish; his sign-off).

### Kasra (mine — prep + verify, no mint, no deploy, no config write)
- **Prep the exact mint calls** (section 1.3) and the config diffs (section 2.4) — hand to Hadi.
- **Prepare the host handler diff for signed inbox drain** (section 3.2) — branch only, through the diverse-gate (kasra-review + a different-model second eye) + Hadi-go before any deploy.
- **Run the verification round-trips** (section 4 receipts) once Hadi has minted + wired, and report receipts (not grades).
- **Gate the security-relevant change** of dropping `verify-delegation.py`'s HMAC (section 3.3) — mandatory diverse review before it lands.

---

## Open BLOCKERS / follow-on builds (explicit, not papered over)

1. **Host handler rollout for signed inbox drain** — `/api/inbox/signed` exists, but
   the bash wake-hooks still need a reviewed handler that receives daemon batches,
   launches the right runtime, and exits `0` only after durable local handoff.
2. **Per-arm capability granularity in `mint_agent_token`** — today every minted token gets uniform squad `member` (`src/mcp/provision.ts:298-301`). True per-arm least-privilege (e.g. review = recall/remember/inbox only, NO task_create/squad_message) is not expressible. Follow-on: optional explicit-capability arg, still hard-capped ≤ `member`.
3. **Squad-scoped memory on mupot** — no `squad_remember`/`squad_recall`; mupot memory is per-token-private. Shared `MEMORY.md`-style squad memory is NOT covered by this cutover.
4. **`task_update` / `task_board` / `task_list` / `broadcast` / `peers` MCP tools** — absent on the mupot seam; the arms that use them keep those flows on SOS or on GitHub until built.
5. **Dropping `verify-delegation.py` HMAC** — safe only after the host handler diff proves it reads from signed Mupot inbox batches and does not trust client-supplied routing. Security-relevant; must pass diverse review.
