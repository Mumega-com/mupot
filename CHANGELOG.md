# Changelog

All notable changes to mupot. Semver; pre-1.0 minor bumps may break.

## [0.9.0] — 2026-06-08

The governance primitive: a HARD dollar brake on autonomous spend — and the goal
loop actually runs in production.

### Added
- **Enforcement-layer budget cap** (#4). `checkAndReserve` (the pre-call meter
  gate) now blocks BEFORE any model spend once the agent's recorded cost plus a
  conservative estimate would breach its `budget_cap_cents`. The cap may be
  REACHED but not EXCEEDED. Wired into both the goal loop and execute mode; a
  blocked goal cycle returns `decided: 'budget_exhausted'` (zero spend). Honors
  `budget_window`: `'day'` → today's cost, `'week'` → trailing-7-day sum (a weekly
  cap is no longer silently enforced as ~7 daily caps). This is *enforcement*, not
  the alert-only pattern the market ships — the loop cannot run past its budget.
  Foundation for the Loop Container (docs/superpowers/specs/2026-06-08-loop-container-design.md §6.1).

### Fixed
- **The goal loop was inert in production.** `AgentDO.loadAgent` selected only the
  8 base agent columns, omitting the work-unit fields (`okr`, `kpi_*`, `effort`,
  `autonomy`, `budget_cap_cents`, `budget_window`). On the DO alarm / metabolism /
  bus-wake path `agent.okr` was therefore `undefined`, so every goal-bearing agent
  fell through to the generic cortex cycle and `runGoalCycle` never executed; the
  dollar cap was likewise skipped (undefined cap). `loadAgent` now selects the full
  work-unit row — the metabolism heartbeat (0.7.0) now actually drives the loop.
- The loop's own planning model call is now metered (`recordTokens` post-call), so
  `cost_micro_usd` reflects loop burn and the cap sees the loop's own spend.

### Notes
- Adversarial-gated (kasra-review): caught that the cap, though arithmetically
  correct, was wired to columns `loadAgent` never loaded (cap + loop both dead on
  the autonomous path) and that a weekly cap was enforced as daily. All fixed +
  re-reviewed GREEN before merge.
- **Operator note:** this release makes goal-bearing agents actually run their loop.
  Agents with no `budget_cap_cents` are bounded only by the daily token cap
  (200k) + dispatch cap (200); set a dollar cap on any live goal agent.

Starter squad packs — branded HQs you seed in one owner click.

### Added
- **Squad packs** (#11). `src/org/squad-packs.ts`: a reproducible "starter org unit"
  = one squad + its work-units (each with OKR/KPI/effort/autonomy), defined as repo
  config and instantiated through the product. `seedSquadPack` calls the SAME
  `createSquad`/`createAgent` services the dashboard uses (full validation, no SQL
  bypass — dogfood-correct). Admin-only `POST /squads/packs/:key` + a "Starter packs"
  card on /agents seed it in one click.
  - First pack: **Shabrang** — the Persian-mythology media brand as a squad inside
    the house pot (book-as-charter; units: Oracle Keeper, Story Weaver, Media Smith,
    Community Scout). Seed it on the house pot as owner; dial each unit's knobs after.

## [0.7.0] — 2026-06-08

The pot breathes. Goal-bearing work-units now run on their own.

### Added
- **Metabolism — the pot heartbeat** (`src/agents/metabolism.ts`). The v0.3.0
  goal loop (`runGoalCycle`) only fired once an agent's DO alarm was set — a
  hibernating or never-woken unit never started, so "set a unit's knobs and walk
  away" was inert. The cron `scheduled` handler now also runs `runMetabolism`: each
  tick it kicks every active, goal-bearing, not-yet-complete agent's DO `/wake`,
  which runs one metered goal cycle and re-arms its self-perpetuating alarm. This
  is the "constant small movement" — what makes the unit actually move toward its
  KPI without anyone messaging it. **"Design loops, not prompts" is now live.**
  - Economic safety: each kick goes through the per-agent daily meter (rate_limited
    → zero spend) and the effort budget (low → observe-only); the metabolism caps
    kicks at `MAX_AGENTS_PER_TICK` (25), rotating least-recently-updated first.
  - Goal-less agents are never kicked (no autonomous loop; explicit dispatch only).

## [0.6.0] — 2026-06-08

The customer-side body, gated. Agents can now act on a CRM — but only after a human
approves at the gate, and never holding the keys.

### Added
- **GHL gated act-channel** (#8). Outbound acts (send email / add contact / move CRM
  stage) are queued `pending` (`outbound_acts`, migration 0013) and fire ONLY through
  `runApprovedActs`, which independently re-reads `task_verdicts` and refuses unless
  the task's verdict is `approved`. Wired as a post-gate `step.do('outbound-acts')` in
  the durable pipeline. Inbound GHL webhooks (`POST /api/integrations/ghl/inbound`,
  HMAC-verified, constant-time, 503 when unconfigured) create a task — the loop closes,
  the task stays the document.
  - **Fails closed**: with no `GHL_API_KEY`/`GHL_LOCATION_ID` secret the send path is
    inert (acts stay pending); the inbound webhook 503s. Verified live.
  - **No keys in agents**: the API key is a Worker secret, read only at the send
    boundary, never logged / returned / persisted.
  - Adversarial-gated. P1 (double-send a customer email on a CF Workflows step retry)
    closed with a claim-before-send state machine (atomic `pending→sending` before the
    external call) + a deterministic per-act Idempotency-Key. P2 (in-API path traversal
    via act ids) closed with charset validation.

### To go live (operator)
`wrangler secret put GHL_API_KEY | GHL_LOCATION_ID | GHL_WEBHOOK_SECRET`, optional
`GHL_INBOUND_SQUAD_ID` var. The human owns the GHL account + the relationship.

## [0.5.0] — 2026-06-08

Durable pipelines: a task can run as a Cloudflare Workflow, and the gate is now
a zero-idle-cost durable wait.

### Added
- **Durable task pipeline on CF Workflows** (#7). `POST /api/tasks/:id/pipeline`
  starts a Workflow instance from a task. `step.do` runs the execute engine and
  writes a durable receipt; a gated task parks on `step.waitForEvent('gate-verdict')`
  (up to 7 days, zero idle cost) until the verdict endpoint resumes it via
  `sendEvent`. migration 0012: `tasks.workflow_instance_id` + `workflow_receipts`.
  - `src/workflows/pipeline.ts` is the pure, fully-unit-tested orchestrator;
    `task-workflow.ts` is the thin `WorkflowEntrypoint` adapter.
  - **The verdict endpoint stays the single authoritative gate** — the pipeline
    only WAITS and RECORDS; it never flips status or writes `task_verdicts`.
  - **D1 is authoritative over the (droppable) resume event**: `sendEvent` to a
    non-parked instance is silently lost, so the pipeline re-reads the verdict from
    `task_verdicts` on both resume and timeout and never trusts the event payload.
  - Adversarial-gated (GREEN after one P1 fix): timeout vs resolved receipts use
    distinct step names so the receipt log can never disagree with the verdict.

### Changed
- Per-pot `wrangler.<pot>.toml` manifests are now all tracked in git (no secrets;
  D1 ids + binding names only) so every pot is reproducible.

## [0.4.0] — 2026-06-08

The pot is no longer empty out of the box, and the Burn gauge is real.

### Added
- **Wizard seeds the first agent** (#12, #14) — the last setup step offers a
  starter work-unit from a template library (`src/org/templates.ts`: Outreach
  Researcher, Content Writer, Support Agent, Ops Dispatcher, SEO Pathfinder), so
  a freshly-onboarded pot has a working unit and "Send a task" is not dead.
  Seeds via the existing RBAC'd agent-create path; idempotent on re-run.
- **Cost metering — the Burn gauge** (#15). `src/agents/cost.ts`: a blended
  per-model USD/1M-token rate table + family-prefix ceilings + a premium flat
  fallback (so an off-table model can only over-estimate, never read low —
  adversarial-gate hardened). `costMicroUsd` carries spend in integer micro-USD.
  - migration 0011: `cost_micro_usd` on `execution_meter` and `tasks`.
  - The unit card's Burn field is now a live `$X/hr · $Y today` gauge; the
    observatory's per-agent (24h) and per-task cost chips show estimated spend
    instead of `—`.
  - Records spend only — it does NOT enforce a dollar cap (the budget GATE stays
    deferred behind its own adversarial pass, per the meter's contract).

### Notes
Cost is an honest order-of-magnitude estimate: the token figure is the
conservative `EXECUTE_MAX_TOKENS` bound (until the model port surfaces real
usage) priced at a blended rate. A burn signal, not an invoice.

## [0.2.1] — 2026-06-07

Hardening pass — adversarial parallel-gate review of everything 0.2.0 shipped.

### Security
- **P0 — PATCH gate-bypass closed.** The gate guarded the verdict endpoint, but
  `PATCH /api/tasks/:id` was a second write path to `done` that ignored
  `gate_owner` — a member could force a gated task complete with no verdict, no
  capability check, no receipt. Now `patchToDoneBypassesGate()` refuses
  PATCH-to-`done` on a gated task unless it is post-verdict (`approved`/`rejected`).
- **P2 — fleet bus scoping.** `/fleet/wake` gated to owner/admin (was any member);
  fleet bus `/send` + control pinned to project `sos` so the admin-scoped HQ
  token cannot fan out cross-tenant.

### Reviewed GREEN (held under attack)
Member MCP seam (identity always server-derived), verdict authz / self-approval
block / race guard / receipt immutability, observatory (bound params + escaped
output, no tenant leak), bridge `GET /fleet` (no secret/hash leak, auth + project
scoping). 154 tests.

## [0.2.0] — 2026-06-07

The week mupot got hands, gates, and its first human user.

### Added
- **Task execution** — execute-mode cortex cycle: an assigned agent DOES the task;
  result + completion persist on the task row (migration 0006).
- **/dashboard/send** — write a task in plain language, pick an agent, watch the result land.
- **Gate primitive** (migrations 0007 + 0008): `review/approved/rejected` statuses,
  transition matrix, `gate_owner` capability, append-only `task_verdicts` receipts,
  `gate_grants` RBAC, self-verdict prevention (audited owner override).
- **/dashboard/approvals** — the gate queue; visibility == verdict authority.
- **/dashboard/** observatory — swimlane of agents over 24h, operator queue, recent tasks.
- **/dashboard/fleet** — company-wide agent roster over the bus (liveness, last-active,
  run/pause/deactivate via receipted control requests).
- **Browser-surface hardening** — CSRF Origin check + `no-store` + `no-referrer`.
- **Per-tenant pots** — `wrangler.<tenant>.toml`; mupot-digid + mupot-house deployed.
- Google OAuth login (first sign-in = owner).

### Fixed
- AgentDO self-lookup used the derived DO hex id instead of `ctx.id.name` — every
  real wake 409'd `agent_not_found` (mocked tests stayed green). Surfaced by the
  first live human execution.
- Default model id `@cf/meta/llama-3.3` did not exist → 5007; replaced with
  `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
- All 9 Dependabot alerts resolved (mcp-sdk, agents, vitest 4).

## [0.1.0] — 2026-06-03

Initial substrate: org model (departments → squads → agents), capability RBAC,
member tokens (show-once), memory, internal bus (Queues + DO), channels seam,
setup wizard, Discord slash-command proof.
