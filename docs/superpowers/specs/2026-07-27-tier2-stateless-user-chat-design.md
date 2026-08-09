# Tier-2 Stateless Per-User Chat → Board Dispatch

**Status:** Design, drafted 2026-07-27. Design + contract only — no route, no
migration, no UI, no persistent process. Awaiting dyad-gate (Kasra-core
correctness + diverse second-eye) before any build slice starts. Unassigned =
backlog, not active.

**Thesis owner:** Hadi, 2026-07-23 owner-experience session — *"a chat interface
per user must NOT be a Hermes-server-per-user (#505's pattern). Tier-2 =
stateless turns + board dispatch = dormant-when-idle = ~free per user, scales
to thousands. Cost tracks work, not idle seats."*

**Builds on:** owner-experience artifact (2026-07-23),
[project lifecycle](./2026-07-23-project-lifecycle-control-loop-design.md) (PR #500),
[BYOA harness matrix](./2026-07-23-byoa-harness-support-matrix-design.md) (PR #503),
[per-project docs RBAC](./2026-07-23-per-project-docs-rbac-design.md) (PR #507),
[module kernel concierge](../../architecture/mupot-module-kernel.md),
[dispatchable technicians](../../architecture/dispatchable-technicians.md),
execution meter (`src/agents/meter.ts`), pot entitlement
(`src/billing/plans.ts` `monthlyModelBudgetMicroUsd`), `task_create` MCP /
`createTask` board path.

**Machine contract:** [`docs/tier2-user-chat-v1.json`](../../tier2-user-chat-v1.json)
+ pure TS [`src/chat/tier2-contract.ts`](../../../src/chat/tier2-contract.ts).

## 0. Problem

Every connected human on a pot needs a chat that can turn intent into governed
work. If that chat is implemented as a **persistent Hermes (or similar) process
per user**, cost scales with *seats*, not *work*:

- idle users still hold a live agent process / session server
- thousands of connected members ⇒ thousands of always-on runtimes
- economics collapse before product value lands

#505 (`/agents/kayhermes` Sessions API proxy) is the **right** pattern for a
**few rich mubots** (kayhermes, dme_mubot) — Tier-1. It is the **wrong** pattern
for every member chat.

## 1. Two tiers (non-negotiable contrast)

| | **Tier-1 — persistent mubot** | **Tier-2 — stateless user chat** |
|---|---|---|
| Who | Few rich mubots (kayhermes, dme_mubot, future named PMs) | Every connected human member |
| Runtime | Persistent upstream (Hermes Sessions API / always-on harness) | **No persistent process.** One Worker request per turn |
| Continuity | Upstream session server | **D1 session history** only |
| Idle cost | Non-zero (process / tunnel / session) | **Zero** — dormant when nobody types |
| Cognition | Long-lived agent loop | Stateless per-turn: Worker → frontier model + pot context from D1 + mupot MCP tools |
| Work execution | May reason deeply in-process | **Must not build.** Emits **board tasks**; technicians + gate execute |
| Scale target | Tens | Thousands |
| Reference | PR #505 kayhermes panel | This design |

Tier-1 stays. Tier-2 is additive. A pot may run both: one kayhermes mubot *and*
N Tier-2 member chats. They share the board, gate, and budget ledger — they do
not share a process model.

## 2. Thesis (one line)

**Chat decides and dispatches; the board executes; the gate verifies; D1
remembers; idle costs nothing.**

```
 member types
      │
      ▼
 ┌─────────────────────────────────────────────┐
 │  Worker turn (stateless, request-scoped)    │
 │  1. auth member                             │
 │  2. load D1 session history + pot context   │
 │  3. tenant token-budget gate (pre-call)     │
 │  4. frontier model turn + mupot MCP tools   │
 │  5. tool calls → createTask (board only)    │
 │  6. persist messages + task links in D1     │
 │  7. return chat reply                       │
 └─────────────────────────────────────────────┘
      │                         │
      │ idle = no request       │ board tasks
      ▼                         ▼
   $0 residual          technicians (cursor/claude/…)
                               │
                               ▼
                            gate + receipt
                               │
                               ▼
                     result message → same D1 session
```

## 3. What already exists (reuse, do not rebuild)

| Piece | Where | Role in Tier-2 |
|---|---|---|
| Board + `done_when` | `src/tasks/service.ts` `createTask` | Sole execution surface the chat may write |
| MCP `task_create` | `src/mcp/index.ts` | Tool the turn model is allowed to call |
| Concierge / work-router | `src/concierge/service.ts` | Ranks + assigns open board work (unchanged) |
| Technicians + gate | dispatchable-technicians + gate-driver | Execute and verify — chat never self-closes |
| Model port | `src/model/index.ts` | Frontier / Workers-AI call for the **one** turn |
| Agent meter | `src/agents/meter.ts` | Pattern for pre-call token/dollar gate |
| Pot monthly budget | `src/billing/plans.ts` `monthlyModelBudgetMicroUsd` | Tenant ceiling Tier-2 must enforce |
| Member auth | member bearer / dashboard session | Chat identity = human member, not an agent process |
| Project memory / docs | `project_recall` + PR #507 surface | Pot context injected into the turn prompt |

## 4. Key design decisions

1. **No persistent agent process per user — ever.** A Tier-2 chat identity is a
   D1 row (`user_chat_sessions`), not a systemd unit, not a Hermes session, not
   a Durable Object that stays warm between turns. Between requests the cost is
   D1 storage only.
2. **One request = one cognition burst.** The Worker loads history, calls the
   model at most once (plus bounded tool round-trips inside that request),
   persists, returns. No background loop, no heartbeat, no "keep the chat
   agent online."
3. **Chat never executes build work.** Allowed tools are read + **board
   dispatch** (`task_create` / equivalent). Forbidden: merge, deploy, publish,
   self-verdict, direct code mutation, spawning a Tier-1 Hermes. Work lands on
   the board with a provenance marker and goes through technicians + gate.
4. **Session history lives in D1**, scoped `(tenant, member_id, session_id)`.
   History is the continuity layer (same role Digid orient plays for agents).
5. **Results return to chat via the board**, not via a side channel: when a
   chat-originated task reaches a terminal gated state, a result message is
   appended to the same session (idempotent on `task_id` + terminal status).
6. **Per-tenant token budget is a hard pre-call gate.** Before any model spend,
   the turn checks the pot's remaining `monthlyModelBudgetMicroUsd` (and a
   chat-specific daily soft cap). Breach ⇒ no model call, durable denial
   message in session, HTTP 402/429 shape — never silent spend.
7. **Idle ⇒ dormant ⇒ zero model cost.** No cron wakes Tier-2 chats. Concierge
   and drivers keep running for *board* work; that cost is work-attributed, not
   seat-attributed.

## 5. Data model (draft — validate in dyad-gate)

No migration in this design commit. Schema shape for slice 1:

```
user_chat_sessions (
  id            TEXT PRIMARY KEY,
  member_id     TEXT NOT NULL REFERENCES members(id),
  project_id    TEXT NULL REFERENCES projects(id),  -- optional project scope
  title         TEXT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
)

user_chat_messages (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES user_chat_sessions(id),
  role          TEXT NOT NULL,          -- 'user' | 'assistant' | 'system' | 'result'
  content       TEXT NOT NULL,
  token_in      INTEGER NOT NULL DEFAULT 0,
  token_out     INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
)

user_chat_task_links (
  session_id    TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (session_id, task_id)
)
```

Provenance on tasks: body (or structured origin field when one exists) carries
`[tier2-chat:<session_id>]` — same sentinel pattern as
`CONCIERGE_STARTER_MARKER`. Result fan-in keys on that marker + `task_id`.

Tenant isolation: every query binds `env.TENANT_SLUG` / member from the auth
token — body fields never trusted for tenant/member identity (same rule as
`runtime-adapter/v1`).

## 6. Turn pipeline (pure contract)

Encoded in `src/chat/tier2-contract.ts` and
`docs/tier2-user-chat-v1.json`:

1. `authorize` — member bearer; refuse agent-process impersonation of a human chat.
2. `loadContext` — D1 history (bounded window) + project/pot memory snapshot.
3. `budgetGate` — if remaining tenant budget < conservative estimate →
   `deny_budget` (no model call).
4. `modelTurn` — single frontier call with tool allowlist =
   `TIER2_ALLOWED_TOOLS`.
5. `dispatchTools` — only board creates; each create must include verifiable
   `done_when` and the Tier-2 provenance marker.
6. `persist` — messages + links + meter debit.
7. `respond` — assistant text; list of spawned `task_id`s.
8. **end** — Worker returns; nothing left running for that user.

Illegal transitions (must fail closed): `modelTurn` without passing `budgetGate`;
tool outside allowlist; task create without `done_when`; any path that starts a
persistent upstream session for Tier-2.

## 7. Tool allowlist (v1)

**Allowed:** `task_create`, `task_list`, `task_get` / read equivalents,
`project_recall` / `project_context` (read), `project_remember` only when the
member has write on the project (same RBAC as docs surface).

**Forbidden:** gate verdict tools, merge/deploy/publish, fleet control
start/stop, Hermes Sessions API, minting agent tokens for the chat itself,
anything that keeps a process warm.

The model’s job on a work request is: clarify → emit one or more board tasks →
tell the member what is on the board and how they will see results. Not: do the
work.

## 8. Budget

- **Tenant ceiling:** reuse `PLAN_LIMITS[*].monthlyModelBudgetMicroUsd` via the
  entitlement resolver. Chat turns debit the same pot ledger as other model
  spend (one economic truth).
- **Chat soft daily cap:** optional env/`org_settings` knob (pattern from
  `EXEC_MAX_TOKENS_DAY`) so a single chatty member cannot burn the whole pot
  day in one session — still subordinate to the tenant monthly ceiling.
- **Accounting:** every assistant turn writes `token_in` / `token_out` /
  `cost_micro_usd` on the message row **and** increments the pot meter. No
  spend without a row.

## 9. Result return path

When a task whose body/origin carries `[tier2-chat:<session_id>]` reaches a
**gated terminal** status (`done` after PASS, or `rejected` with receipt):

1. Append one `role='result'` message to that session (idempotent on
   `(session_id, task_id, terminal_status)`).
2. Content cites task title, verdict, evidence URL / PR — never raw hidden
   chain-of-thought.
3. Optional: SSE/WS or poll endpoint for the open chat UI — transport only;
   truth remains D1.

No second inbox. The chat session *is* the member-facing inbox for Tier-2 work
they spawned.

## 10. Boundaries / non-negotiables

- Tier-2 must not open or proxy a Hermes Sessions API (that is Tier-1 / #505).
- Tier-2 must not register a per-user module that heartbeats forever.
- Tier-2 must not complete, merge, deploy, or self-gate tasks.
- Tier-2 must not spend model tokens when the tenant budget gate fails.
- Tier-2 must not run cognition on a cron for idle sessions.
- Tier-1 mubots remain available for the few seats that need them; this design
  does not deprecate #505.

## 11. Acceptance criteria (design locked when)

1. Spec + `tier2-user-chat-v1` contract distinguish Tier-1 vs Tier-2 with the
   table in §1 and forbid persistent per-user process.
2. Pure contract module encodes: dormant-when-idle, budget-before-model,
   board-only tools, provenance marker, result fan-in idempotency key shape.
3. Focused vitest covers those invariants; `tsc --noEmit` clean.
4. Build slices below are listed and dyad-gate tagged; none implemented in this
   commit.
5. Explicit non-goals: no kayhermes replacement, no UI, no migration applied.

## 12. Build slices (backlog — dyad-gate each)

1. **Schema + provenance** — D1 tables above + `[tier2-chat:]` marker helper;
   no HTTP yet.
2. **Budget gate** — pot monthly ledger debit + chat daily soft cap, wired like
   `checkAndReserve` (pre-call, fail closed).
3. **Turn pipeline** — Worker route `POST /api/chat/turns` implementing §6 with
   tool allowlist; persist messages; no UI.
4. **Board dispatch** — `task_create` from the turn with `done_when` + marker;
   refuse non-board tools.
5. **Result fan-in** — on gated terminal task, idempotent `result` message into
   the originating session.
6. **Chat UI surface** — member dashboard panel (third owner surface beside
   docs + board); poll/SSE over D1 truth.

Each slice: Kasra-core + diverse second-eye before merge. Branch-only builds;
no deploy without gate + Hadi-go. Unassigned until pulled from backlog.

## 13. Open questions (for dyad-gate)

1. Should Tier-2 share `execution_meter` rows (agent-shaped) or a new
   `chat_meter` keyed by `member_id`? Lean: new member-keyed meter, same pot
   monthly ceiling.
2. Multi-project chats: one session per project (strict) vs pot-wide session
   with per-message project tags?
3. Cap on tool round-trips inside one HTTP request (suggest: 3) to bound
   Worker CPU/time.
4. Whether free-tier pots get Tier-2 at all, or chat is `starter+` — product
   call; mechanism must work either way.

## 14. Related arc

Owner-experience 2026-07-23: chat · docs · board. This spec is the **chat**
scaling half for the many; #505 is the **mubot** half for the few; #507 is
docs; #500/#503 are lifecycle + BYOA labor behind the board the chat feeds.
