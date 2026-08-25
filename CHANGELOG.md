# Changelog

## 0.30.0 — 2026-08-21

- **MCP `loop_control` governor tool** (`src/mcp/loops.ts`, `src/loops/decisions.ts`, `migrations/0127_loop_control_receipts.sql`; #1166).
  - Agents can pause, kill, or budget-cap a running loop over MCP — the dashboard-only `setLoopControl` path is no longer the sole lever.
  - Authorization: org-admin, or at least `lead` on the loop's owning squad. `kill` requires an attributed reason.
  - Each action writes the live `loop_controls` signal the driver consumes *and* an append-only `loop_control_receipts` row, so a consumed signal still names who issued it and why.

- **Mint-in-Chooser Self-Service Agent Seat Binding** (`src/mcp/oauth-authorize.ts`, `tests/agent-bound-oauth-consent.test.ts`; #1189).
  - Native self-service agent minting directly inside the OAuth consent chooser UI (`__mint_new__`), gated by squad administrator capability (`listConsentableSquads`).
  - Server-side creation of agent records (`createAgent`), immutable token & dedicated member binding (`mintAgentBoundToken`), and append-only receipt auditing (`oauth_consent_receipts`).
  - Eliminates ambient authority and prevents multiple agent seats from collapsing into a shared identity.

- **Flight Watchdog & Governed Reap Circuit** (`src/flight/`, `src/scheduled/`; #1127, #1138, #1147, #1151, #1155, #1179).
  - Automated flight liveness watchdog integrated into `scheduled()` maintenance loop to detect and reap stalled flights.
  - Dedicated append-only `flight_reap_receipts` table distinguishing reaps from normal landings.
  - Budget meter alignment where unset budget caps evaluate to unlimited (`isBudgetCap`).
  - Supported re-gate path for review tasks (#1180).

- **Identity & Token Lifecycle Management (Flight-002)** (`src/auth/`, `src/members/`, `src/scheduled/`; #1008, #1009, #1052, #1146).
  - Default token expiration (`expires_at`), atomic rotation, and expiring-soon warning maintenance loop in `scheduled()`.
  - Added `last_used_at` telemetry tracking for agent tokens (migration 0099).

- **Agent Seat Activity & Disambiguated Roster (Flight-008)** (`src/presence/`, `src/dashboard/`; #1078, #1077, #1118).
  - Seat activity telemetry measuring what an agent is doing alongside reachability and liveness.
  - Disambiguated Agent Selector in dashboard and consolidated Hero-KPI aggregation.

- **Fail-Closed 8-char Short-UUID Resolver & Handshake Hardening (Flight-003A)** (`src/mcp/`; #987, #1053, #1100, #1126).
  - Deterministic short-UUID entity resolution and schema aliasing preventing ambiguous entity references.
  - Canonical onboarding instructions returned in MCP `initialize` handshake (#1126).
  - Redaction of raw credentials from mint tool results (#987, #1100).

- **Task Backlog & Dispatch Separation (Flight-006)** (`src/tasks/`, `src/gates/`; #1071, #1072, #1073, #1075).
  - Separated task backlog creation from execution dispatch with `task_create` dispatch flag.
  - Server-joined canonical names and phase metric separation.
  - Integrated Athena gate lane into mupot gate substrate.

- **Tentacles Fan-Out Records & Dashboard Panel (Flight-004)** (`src/addons/`, `src/dashboard/`; #1056).
  - Subagent seat fan-out records, MCP tools, and dedicated dashboard visualizer.

- **Model Boundary Hardening & Stream Normalization (Flight-005)** (`src/model/`, `src/runners/`; #1058, #1059, #1069, #1070).
  - Strict `text:string` chat boundary enforcement and non-throwing `parseDecision`/`parseProposals` parsing on non-string model outputs.
  - Runner receipt status locks with D1 provenance clamping and optional Ed25519 signatures.

- **Dashboard Modularization & Multi-Perspective Kanban** (`src/dashboard/`; #1042, #1048, #1055).
  - Dashboard sub-routing with scoped radar views and multi-perspective squad & project Kanban board.
  - Real-schema SSE stream endpoint (`/api/inbox/stream`) for real-time inbox message delivery (#706).

## 2026-08-15

- **Session transcript** (`docs/session-transcripts/2026-08-15-primeagent-deepseek-v4-flash-0730.md`) — truncated transcription of the Athena gate seat session on prime-agent (deepseek-v4-flash): gate verdict confirmation (Flight 640f6b4d, #1040), correctness lenses #1052/#1053, CF token TTL fix, fleet responder retirement, mupot visibility review (Hadi-directed).



## 0.29.0 — 2026-08-08

- **Build-Time Release Identity & Version Truth** (`src/health.ts`, `scripts/generate-build-info.mjs`; #443, #571).
  - `/health` and deployment consoles now stamp exact commit identity (`commit`), branch (`ref`), build timestamp (`built_at`), and working-tree cleanliness (`clean`) by construction via `src/build-info.ts` fallback when runtime environment variables are omitted.
  - Eliminated decorative `clean: false` state; `clean` strictly reflects working-tree status (`git status --porcelain`). Branch identity is tracked separately via `ref`.
  - Supersedes the env-only stamping direction of `aac13ed` (#443, #571): `RELEASE_SHA` still takes precedence when present, and the generated build-info module is the floor for deploys that do not run the wrapper. Adopted deliberately — four production deploys on 2026-08-07 used bare `wrangler deploy` and every one reported `commit: null`.

- **Sovereign Addons & Memory Engine (v0.28.0)** (`src/addons/`, `src/telemetry/`, `src/dashboard/motherboard.ts`; #780, #796, #797, #798).
  - Four modular Hono addon sub-apps (`sos`, `mirror`, `inkwell`, `torivers`) with fail-closed HTTP 503 `unconfigured_secret` and 401 authentication handlers.
  - D1 token usage telemetry logging (`subagent_token_usage` table) integrated directly into `dispatchRun`.
  - Fractal Motherboard visual map (`/dashboard/motherboard`) with RBAC squad scoping (`resolveGrantedSquadIds`).
  - D1 Migrations `0083_subagent_tentacles_registration.sql`, `0084_subagent_token_telemetry.sql`, and `0085_identity_cleanup.sql`.

- **Telegram Central Command Ingress & Native Webhook** (`src/channels/`, `src/telegram-bridge/`; #789, #769, #760, #767, #779).
  - Fail-closed native Telegram webhook handler (`/channels/telegram/webhook`) gated by immutable sender authority (Hadi ID `765204057`), rate walls, and Bot API delivery.
  - Cleaned up duplicate legacy webhook ingress.

- **Master Constitution `MU.100.001` v6 Ratification** (`docs/constitution/`; #788).
  - Ratified governance contract signed by River, Kasra, and Athena, establishing Asha identity, UNPROVEN sharpening, and council workflow state machines.

- **Build-Time Release Identity & Version Truth** (`src/health.ts`, `scripts/generate-build-info.mjs`; #443, #571).
  - `/health` and deployment consoles now stamp exact commit identity (`commit`), branch (`ref`), build timestamp (`built_at`), and working-tree cleanliness (`clean`) by construction via `src/build-info.ts` fallback when runtime environment variables are omitted.
  - Eliminated decorative `clean: false` state; `clean` strictly reflects working-tree status (`git status --porcelain`). Branch identity is tracked separately via `ref`.
  - Supersedes the env-only stamping direction of `aac13ed` (#443, #571): `RELEASE_SHA` still takes precedence when present, and the generated build-info module is the floor for deploys that do not run the wrapper. Adopted deliberately — four production deploys on 2026-08-07 used bare `wrangler deploy` and every one reported `commit: null`.

- **Sovereign Addons & Memory Engine (v0.28.0)** (`src/addons/`, `src/telemetry/`, `src/dashboard/motherboard.ts`; #780, #796, #797, #798).
  - Four modular Hono addon sub-apps (`sos`, `mirror`, `inkwell`, `torivers`) with fail-closed HTTP 503 `unconfigured_secret` and 401 authentication handlers.
  - D1 token usage telemetry logging (`subagent_token_usage` table) integrated directly into `dispatchRun`.
  - Fractal Motherboard visual map (`/dashboard/motherboard`) with RBAC squad scoping (`resolveGrantedSquadIds`).
  - D1 Migrations `0083_subagent_tentacles_registration.sql`, `0084_subagent_token_telemetry.sql`, and `0085_identity_cleanup.sql`.

- **Telegram Central Command Ingress & Native Webhook** (`src/channels/`, `src/telegram-bridge/`; #789, #769, #760, #767, #779).
  - Fail-closed native Telegram webhook handler (`/channels/telegram/webhook`) gated by immutable sender authority (Hadi ID `765204057`), rate walls, and Bot API delivery.
  - Cleaned up duplicate legacy webhook ingress.

- **Master Constitution `MU.100.001` v6 Ratification** (`docs/constitution/`; #788).
  - Ratified governance contract signed by River, Kasra, and Athena, establishing Asha identity, UNPROVEN sharpening, and council workflow state machines.

- **The fleet can NOTICE — the gatherer** (`scripts/gatherer.py`, invoked from
  `operator-loop.sh`; #752). Every defect found in the days before this landed was found
  because a human asked a question: dead executor seats, 167 silent HTTP 401s, routines
  parked in `queued` forever, a merged-and-inert fix. The system had observability
  without noticing. The gatherer is a read-only pass in the running operator loop that
  ranks anomalies into one digest per cycle and changes nothing — stale `review`,
  stalled `in_progress`, presence, stuck routines, and **its own dead man's switch**.
  Notification is off by default and flag-gated; a watcher that pages on every cycle
  becomes the next thing people ignore.
  - It found two things while being built. A repro for #718: Cloudflare's bot rule
    rejects urllib's default User-Agent with `403 code 1010` *before the request reaches
    the pot*, so an edge block reads as an auth failure. And a **false P0 in its own
    first run** — `presence` is an object with a `liveness` field, not a string, so the
    comparison could never match and it announced "NO agent is live" against a fleet with
    two agents seen seconds earlier. Caught by verifying the tool's own finding. A
    gatherer that cries false P0s is worse than none: it trains everyone to ignore the
    real one.
  - Its presence finding was later reworded (#762) for the same reason. "The roster is
    mostly ghosts" was accurate about the table and a trap as a conclusion — `athena`
    showed `dead 7d` while gating PRs minutes earlier, `tech-grok` showed `never` after
    shipping a 956-line PR. Presence measures who calls the heartbeat, not who works. A
    finding that implies the wrong action is worse than no finding.

- **Migration numbering is now a CI ratchet** (`scripts/check-migration-numbering.mjs`;
  #745, #749). `wrangler d1 migrations apply` runs only files ABOVE the applied head, so
  a PR adding `0076_*.sql` while main is at `0079` **merges green, deploys green, and its
  schema never runs** — #594's shape, measured across twelve blocked PRs with slot `0076`
  alone carrying four claimants. Compared against the merge TARGET, never a number
  written in the PR.
  - **Four fail-opens were found in the guard itself, none by its own tests.** `ls-tree`
    failure returning `[]` read as a legitimate bootstrap and passed a below-head
    migration (found by the diverse gate). The working-tree oracle disagreed with git, so
    a committed violation vanished when the file was deleted from disk. A stacked PR
    passed against its *declared* base while being unrunnable against main — live on
    #398. And the green message never named the ref it compared, so "OK" read as
    "verified, full stop". Every one lived in the seam between the pure verdict and what
    feeds it.
  - It caught real contamination within a day: a `0076_identity_cleanup.sql` swept into
    #760 by a `git add -A`, which would have shipped an identity cleanup with no schema.

- **Gate-driver hardening** (`scripts/review-worker.py`; #474). Three bypasses in the
  driver that gates everything else. Body-text "already reviewed" markers were OR'd into
  the skip decision — and a PR author controls that text, because their PR title is
  copied verbatim into the task body, so a forged marker meant **skipped review**. The
  allow-list matched `(^|/)tests?/`, letting `src/test/pwn.ts` classify NON-SENSITIVE and
  become auto-merge eligible; unanchored `README`/`LICENSE` did the same for
  `src/README_evil.ts`. Dedupe state is now the only trusted signal, written 0600 under a
  0700 dir with an atomic replace so a crash cannot leave a half-parsed JSON that fails
  open into re-review storms.

- **Inbox delivery consumes only after it delivers** (`scripts/codex-inbox-watch.mjs`;
  #648). The bus is consume-once, so a message consumed before a failed delivery is gone
  permanently. The cycle now peeks, delivers, and only then consumes, with a test pinning
  the refusal (`refuses consume when tmux handoff fails`). `request_id` and `ACK required`
  are carried through into the delivered text so the ACK protocol is visible to the
  receiving agent rather than being convention nobody sees. Does not close #733: delivery
  is honest, the round trip is still unverified.

- **`POST /api/brain/consolidate`** (`src/dashboard/brain-ingest.ts`; #646). Restores the
  nightly consolidation pipeline endpoint and keeps failures loud — non-2xx passthrough,
  `503` on missing `MIRROR_URL`, `400` on an unparseable threshold — instead of the
  success-shaped `501` placeholders it replaced. Org-admin gated.

- **Telegram bridge for `task.review` / `task.blocked`** (`src/telegram-bridge/`; #760).
  HMAC-SHA256 signed, 10s abort timeout. **Fails closed**: with no `HERMES_WEBHOOK_SECRET`
  it logs and returns `{delivered:false}` rather than sending an unsigned payload.

- **Task router and GH-mirror sweep, both dry-run by default** (`scripts/router.py`,
  `scripts/sweep-gh-mirror-tasks.py`; #759). Every worker driver filters `task_list` to
  its own `assignee_agent_id`, so an unassigned task is invisible to every lane forever —
  the operator had run 2,455 cycles, each lane truthfully logging `cycle ok`, and moved
  nothing. The router proposes and prints its reasoning; `--apply` is capped. The dry run
  paid for itself immediately by revealing it would have routed ~40 GitHub PR-mirror
  tasks to the build lane.
  - Neither is wired into the operator loop. Assignment decides what every agent does,
    and a wrong rule produces confident motion rather than an error.

- **Test suites that ran nowhere** (#649, #761, #745). `node --test fleet-runtime/*.test.mjs`
  was non-recursive, so six `geo-scanner/` suites — 32 tests — executed nowhere while
  appearing covered. `**/*.test.mjs` is excluded from vitest as a class, so any unwired
  `node:test` file is invisible; an invariant now asserts every `tests/*.test.mjs` appears
  in `ci.yml`, and it caught its own author one day later. Worker briefs put the task id
  on line 1, guaranteeing a prompt-cache miss before the invariant rules could be reached.


### Fixed
- Routine dispatch requires `POST /api/fleet/attach` with `agent_id` set to the token bound agent UUID. `fleet_agents.presence` is derived from `last_seen` against a 180s TTL, and `presence_register` writes the module registry, which dispatch does not read (mupot#732).

- **C10 — the backpressure governor is provenance-aware** (`src/agents/loop.ts`,
  `countOpenBacklog`). Its unassigned branch treated "open + unassigned + in my squad"
  as "backlog this agent's loop produced". An externally-imported task matches that
  shape exactly, so imports counted against `MAX_OPEN_TASKS`: **import ten issues to a
  connected board and the agent's loop stops producing** — denial of work through an
  integration's normal intended use, no credential compromise, nothing in any log that
  looks like an attack. Also a plain correctness bug with no attacker: the function's
  own doc comment promises it counts what this loop produced, and it did not.
  - The **assigned** branch deliberately still counts external rows. Once an admin takes
    the explicit `task_update`/PATCH step, external work is real backlog and must exert
    backpressure; narrowing both would trade a denial-of-work hole for an unbounded-work
    one. The boundary is "nobody has decided this is mine yet".
  - Tested against real SQL, asserting on `runGoalCycle`'s **outcome**. The existing
    coverage in `tests/sane-brain-s3.test.ts` regexes the query string and passed
    continuously while this defect was live — a test that pins the mechanism cannot fail
    on a bug in that mechanism's meaning. Verified by reverting the fix: 3 of 6 fail
    without it.
  - Empty-string provenance is locked by two further cases. `IS NULL` is the condition
    for counting a row as first-party, so `''` fails it and is excluded — the safe
    direction. A proposed `COALESCE(col,'') = ''` remedy would have **introduced** the
    denial of work it was meant to prevent; it was rejected by running it against both
    versions rather than by reasoning about it.


- **Blank provenance can no longer become trusted absence** (adversarial gate BLOCK).
  `migrations/0077` defines the trust boundary as `external_source IS NULL` vs
  `IS NOT NULL`, but every runtime check spelled it with JavaScript truthiness. Those
  disagree on exactly one value: **the empty string is non-null in SQL and falsy in JS**.
  Reproduced against the real migrations — a task created with `externalSource: ''`
  stored `external_source=''`, **kept its `assignee_agent_id`, and executed through to a
  model turn**. SQL called the row external, the runtime called it first-party, and the
  row was governed by whichever layer was asked.
  - `createTask` now **rejects** blank/whitespace provenance. Coercing `''` to null would
    turn a caller's bug into trusted absence — the exact "absence means permission"
    pattern this audit set has been closing — and coercing it to a marker would invent
    provenance nobody supplied.
  - Every boundary check goes through one predicate, `isExternallySourced`, using explicit
    `!= null`: execution, auto-pickup, content-intent, the prompt fence, and the admin
    reassignment guards in both REST and MCP.
  - `migrations/0078` adds INSERT/UPDATE triggers so a blank marker cannot be stored at
    all, including by a direct D1 write or a restore. Existing blank rows are marked
    `unknown:blank-provenance-0078` — **fail closed as external**, never promoted to local.
  - This vindicates an earlier independent finding that raised the empty string against
    the provenance work. That report located it in `countOpenBacklog`, where `IS NULL`
    already excluded `''` correctly and the proposed change would have introduced a bug —
    but the underlying instinct, that the stamp is load-bearing and `''` breaks it, was
    right, and this is where it was true.
- **Dependency tree unwedged**: `agents` dropped (unused), `cron-schedule` declared
  explicitly. The tree was stuck — `agents@0.14.5` required `ai@^6` while its own peer
  `@cloudflare/ai-chat` pulled `ai@7`, so every tree modification failed `ERESOLVE` and
  **`npm audit fix` silently no-opped**, reporting nothing done even where it claimed a
  fix was available. That is why advisories accumulated and why overrides were the only
  thing that ever worked. Not neglect — the tool could not act.
  - `agents` had no static import, no `require`, no dynamic import, no type-only use and
    no wrangler config reference. Both Durable Object classes (`AgentDO`,
    `SquadCoordinatorDO`) are ours, in `src/agents/`.
  - But removing it broke 53 test files with `TS2307: Cannot find module 'cron-schedule'`
    — it was transitively supplying a module `src/routines/schedule.ts` imports directly.
    Declared first, then removed.
  - Production audit stays at **0**. The `@hono/node-server` and `body-parser` overrides
    stay live: they are reached via `@modelcontextprotocol/sdk`, which is a direct
    dependency, so dropping `agents` did not orphan them (checked rather than assumed).


- **Production dependencies: 0 known vulnerabilities**, verified from the lockfile
  (`npm audit --package-lock-only --omit=dev`) rather than from a local tree.
  - Corrected overrides that were pinned to the TOP of a vulnerable range instead of
    past it — the original #662/#464 defect. `postcss` was still `8.5.18` against an
    advisory of `<=8.5.22`; the fix for that class of bug had the same bug in it.
  - `hono` `^4.12.28` → `^4.13.0` (CORS middleware ReDoS, GHSA-8j4g-w8fx-2239). This
    one is our production router on an external-facing surface.
  - Added overrides: `@hono/node-server ^2.0.5` (serve-static path traversal, reached
    via `@modelcontextprotocol/sdk` ← `agents`), `body-parser ^2.2.3` (DoS via a limit
    value that silently disables size enforcement).
  - Went from 15 advisories (6 high) to **0 production / 3 dev**.

- **CI dependency audit split by what actually ships** (`.github/workflows/ci.yml`).
  - Production: **BLOCKING at `moderate`**, tightened from `high`. Production is at 0,
    so this now blocks on the first regression instead of waiting for one to reach
    "high". Strictly stronger on shippable surface.
  - Dev toolchain: gated against an **explicit allowlist** (`.github/audit-allowlist.json`
    + `scripts/audit-gate.mjs`), not waived. `undici` has an open high reachable as
    `wrangler → miniflare → undici`, **no wrangler version exists without it**, and npm's
    remediation is to DOWNGRADE wrangler 4.118 → 4.35.0 — so the combined gate could only
    be permanently red or actively harmful.
  - The first attempt at this used `npm audit --audit-level=high || true` and was
    **blocked in review**: `|| true` does not accept the known chain, it accepts *every
    future* high/critical dev advisory and every audit-tool failure — and it made #670's
    close condition undetectable, because the step passes identically whether the known
    advisory is still there or ten new ones have joined it. The allowlist fails in **both**
    directions: a high/critical advisory that is not listed, **and** a listed entry that
    has stopped appearing (a fix shipped — delete it). It also fails on an audit it cannot
    run or parse, rather than reading silence as safety. The stale direction is what
    `|| true` could never do, and it makes #670 self-closing rather than dependent on
    someone remembering to check.
  - Exactly **one** advisory is accepted (GHSA-4cwx-7wf7-3272). The other four undici
    advisories in the same chain are moderate and so do not block — deliberately absent
    rather than allowlisted. Residual risk named rather than dismissed: this is real
    exposure to a compromised build host, just not shippable surface.
  - **Six bypasses were reproduced against this gate in review before it was accepted**,
    and the last three were the same mistake three times: binding a *projection* of the
    dependency graph rather than the graph. `nodes` is an install location; a flattened
    ancestry name-set is not a path; and `npm audit --json` keys its findings by package
    **name**, so an npm alias (`wrangler-alias@npm:wrangler`) — a genuinely second root
    edge — collapsed into the accepted chain and passed with zero violations. The audit
    summary cannot express node identity, so paths now come from **package-lock.json**
    (`scripts/lockfile-paths.mjs`), keyed by node path and resolved version.
  - Lockfile ambiguity fails closed: an unresolvable declared dependency, a target absent
    from the lockfile, an orphan reachable from no root edge, or more than `MAX_PATHS`
    routes all fail rather than producing a plausible-looking answer. Optional deps and
    optional peers may legitimately be uninstalled and do not trip it.
  - Staleness is classified **GONE / MOVED / UNKNOWN**. The earlier single message told
    the operator "a fix shipped — delete this entry" even when the advisory was still
    present and had merely moved, which made deleting a live exemption the cheapest way
    to get a green build.
  - **PR #664 was an earlier attempt to relax this gate and was retracted the same day**,
    because its premise came from a stale local `node_modules` while CI's clean `npm ci`
    had 5 production highs. That precedent is recorded in the workflow comment and in
    #670 so the next person to touch this gate has to take their premise from the
    lockfile, not from a local tree.

## 2026-08-02/03 — the weekend the loop became real

- 4-technician operator loop shipped (#623/#624/#630/#644): tech-grok (minted
  identity, 30d TTL), claude lane (haiku), mumcp, review gate; codex lane built
  then PAUSED by its own security audit pending the cage predicate (#645 BLOCK).
- design-status gate: 4 adversarial rounds → merged #640, now a REQUIRED check
  (branch protection enabled). Gate caught kasra twice, athena twice, itself once.
- Federated Control Plane Phase 0 ADR merged (452f11db) after adversarial BLOCK
  found a deleted-constraints "restore" + 7 codex remediation rounds. Phase 1 open.
- FLIGHT 00b2ef4b launched (GEO scanner, mupot#574): first real flight — codex
  builds, athena review-first, mubot announces to Telegram via hermes send.
- Verdict delegation proven: athena fired 4 verdicts under granted gate:kasra-core.
- steward-worker added: auto-reissue of infra-blocked/orphaned tasks + Telegram
  digest — the board now repairs itself.
- Identity/comms healed: kasra SOS token reminted (was hash-only, raw lost since
  June), exposed mumega token rotated dead, wake-storm fixed (7,103 warnings/14d),
  OpenClaw dead routes removed, athena hooks fixed, all channels probe-verified.
- Brain rot cleaned: organ-daemon retired (10/10 organisms were healthy daemons
  killed by a batch timeout — dead-since-refactor), duplicate wakes removed,
  "Gemma free" doc myth corrected; Mirror 501 no-op consolidation filed (#596).
- Roster enforced (Hadi): tmux kasra/codex/athena/river; mubot sole gateway.
- FIRST LIVE GEO SCANS (2026-08-03 ~05:15Z): 3/3 grounded queries ok, visibility
  events emitted to PostHog — the DME trend clock started. En-route fixes:
  PR #647 token-file Vertex auth fallback (merged), profile google_project_id
  corrected mumegaproject→mumega-com (403 root cause), ADC-minted token
  (gcloud CLI refresh broken). Residual: mupot receipt sink 404 + daily
  cadence timer + profile upstream — task b6addee4 (mumega-com#601, codex).
- Mission board live: mupot project goal field carries CURRENT/NEXT mission,
  served in every agent's boot_context; squad broadcast sent.

All notable changes to mupot. Semver; pre-1.0 minor bumps may break.

**What ships next:** see [ROADMAP.md](ROADMAP.md). The roadmap (planned, by version) and
this changelog (shipped, dated) share version numbers and feed each other — a roadmap
block collapses into a changelog entry when it ships.

## [Unreleased]

### Added

- Linear connector (flight-20260803-linear-posthog): `createLinearBoardPort`
  (`src/projects/providers/linear.ts`) now does real, read-only GraphQL reads
  against Linear (`src/integrations/linear-issues.ts`) through the existing
  connector vault (`connector type 'linear'`, already registered in
  `src/connectors/crypto.ts`/`dashboard.ts` since #issue-116-era scaffolding —
  this flight replaces the `linear_adapter_pending_credentials` stub with the
  live adapter). Recon during this flight found the port/registry/binding
  layer for Linear already built (`src/projects/providers/{port,registry,
  bindings}.ts`); only the adapter body was a stub — narrower work than the
  flight's "Linear: greenfield" premise assumed.
  - Structural, not discretionary, enforcement of "a priority surface must
    never be an authorization surface": imported issues become UNASSIGNED
    mupot tasks (`assignee_agent_id` is always `null` — no field on a Linear
    issue, including its assignee, is ever mapped to a mupot agent), routed
    only to an admin-configured `defaultSquadId` (set via the existing
    project-binding `meta_json`, e.g. `{"defaultSquadId":"squad-a"}` —
    absent it, every item reports `no_squad` and nothing is written).
    Task creation passes `skipEvent: true` (no `task.created` bus event, so
    `bus/consumer.ts`'s `dispatchSquad` — the actual wake mechanism — never
    fires for Linear-origin data) and `skipMirror: true` (no outbound GitHub
    issue write from externally-sourced text). This deliberately does NOT
    mirror `src/integrations/github-projects.ts`'s agent-field-to-assignee
    resolution, which is exactly the part of that pattern this flight's
    binding constraint forbids for a read-only priority source.
  - Added the `'linear'` case to `useConnectorById`'s auth-header construction
    in `src/connectors/service.ts` (raw API key, no `Bearer` prefix — differs
    from posthog/inkwell), the same extension point telegram/posthog/mcpwp
    already register through.
  - `TaskBoardSyncResult.items[].status` gained `'no_squad'` (additive; distinct
    from GitHub's `'no_agent'`) in `src/projects/providers/port.ts`.
  - Tests: `tests/linear-issues.test.ts`, `tests/linear-board-provider.test.ts`,
    `tests/connectors-linear-auth.test.ts` — tenant isolation, revoked/missing
    credential fail-closed, redirect/non-2xx fail-closed, secret never echoed,
    dedup, and a **structural** source-text assertion (not just behavioral)
    that the file never resolves a Linear field to an agent and always passes
    `skipEvent`/`skipMirror`, so a future edit that reintroduces a dispatch
    path fails this suite immediately.
  - PostHog: recon found the tenant-scoped vault path and the owner-gated
    env-credentials fallback (#473 CONCERN-2) were **already shipped**
    (`src/addons/marketing/adapters/posthog.ts`, `isPotOwnerTenant`) with
    thorough existing coverage in `tests/marketing-monitor-adapters.test.ts` —
    no PostHog migration work remained for this flight beyond confirming it
    (all suites re-run green). PostHog "capture" (event-ingestion) scope was
    NOT implemented — no caller in the codebase needs it; flagging as an open
    gap rather than building an unused write-shaped surface.

### Security

- **P0 fix (PR #659 diverse-model adversarial gate BLOCK, widened): external-content
  tasks could reach an autonomous model turn with zero human step.** The Linear
  connector's `skipEvent`/`skipMirror` only suppressed the `task.created` EVENT wake —
  two status-POLLING drivers never looked at events at all and (pre-fix) had no column
  to test: `canAgentExecuteTask`'s unassigned-auto-pickup branch
  (`src/agents/execute.ts`) and the concierge's `routeUnassignedWork` maintenance cron
  (`src/concierge/service.ts`). A parallel audit found the same choke-point gap live on
  **`main`** in a more severe shape: `src/integrations/github-projects.ts` resolved a
  GitHub Project field to a real pot agent and called `createTask` with
  `assignee_agent_id` set AND no `skipEvent` — `task.created` fired, `dispatchSquad`
  woke that exact agent, and `executeTaskAsPR` shipped work authored as it, from
  attacker-editable field/title text, bypassing BOTH existing guards (the unassigned
  check never applied; the admin-gated reassignment check only fires on a later
  `task_update`, never on `createTask` itself).
  - `Task.external_source` (migrations/0077) generalizes the `source_pot` trust
    invariant (NULL = trusted local write) for non-pot external integrations. Checked
    everywhere `source_pot` is checked: `canAgentExecuteTask`'s unassigned branch,
    `routeUnassignedWork`'s WHERE clause, the admin-gated reassignment guard
    (`src/tasks/index.ts`, `src/mcp/index.ts`), the content-intent short-circuit skip,
    and the untrusted-content prompt fence (`buildExecutePrompt`/`buildExecuteSystem`,
    `src/lib/prompt-safety.ts`).
  - **Choke-point fix in `createTask`** (`src/tasks/service.ts`): any task carrying
    `externalSource` is now FORCED unassigned at creation, structurally, regardless of
    what a caller passes — closes the github-projects.ts class of bug for every
    current and future external-integration caller, not just the ones that remember
    not to pass an assignee. `external_source` is written only when actually set (not
    unconditionally), so it stays compatible with pinned-migration/hand-rolled test DB
    schemas that predate migration 0077.
  - Marked at all five confirmed external-content entry points: Linear
    (`linear:<teamKey>`), GitHub Projects (`github-projects:<owner>/<number>`, now
    imports unassigned — `agentValue` is display-only, same shape as Linear's
    `assigneeHint`), the GitHub `issues.opened` webhook and generic mapped-event path
    (`github-webhook:<type>`), the GHL inbound webhook (`ghl-webhook`), and
    `src/events/ingest.ts`'s generic HTTP ingest route (`event-ingest:<source>`,
    found during the widened audit — HMAC-authenticated as a transport, but
    `event.payload` content is fully external-system-controlled).
  - Carried through `scripts/steward-worker.py`'s auto-reissue (the "amplifier" the
    gate flagged: a reissued task went through `task_create` WITH an event, unmarked,
    laundering a blocked external task into the exact wake `skipEvent` removed) and
    through the `task_create` MCP tool's new optional `external_source` arg
    (bounded, monotonic-safe — see the tool's inputSchema comment).
  - `identifier`/`url` capped at 100/500 chars in `src/integrations/linear-issues.ts`
    (title was already capped; these were `typeof string` only and landed uncapped
    into task `body`/`done_when`).
  - Low finding fixed: `createLinearBoardPort.syncIntoProject`
    (`src/projects/providers/linear.ts`) no longer stamps `synced_at` when the binding
    is `no_squad`-misconfigured — that was a false "synced successfully" receipt
    hiding a binding with no admin-configured squad.
  - Tests replace the insufficient source-regex mechanism pin
    (`tests/linear-issues.test.ts`) with property tests against the real functions —
    `tests/execute.test.ts`, `tests/concierge-service.test.ts`,
    `tests/linear-issues.test.ts`, `tests/github-projects.test.ts`,
    `tests/external-source-callsites.test.ts`, `tests/mcp-task-tools.test.ts`,
    `scripts/test_steward_worker.py` — each verified to fail on the pre-fix commit
    for the right reason (the task IS auto-picked-up / IS auto-assigned), not
    because a helper is missing.
- Gated Durable Object + WebSocket live-roster pub/sub channel (`PresenceChannelDO`,
  `GET /api/presence/live`) — CF-native fan-out for the first real-time need; off until
  `REALTIME_PRESENCE=1`. No Cloudflare Pub/Sub MQTT (ADR #473).

### Fixed

- `PresenceChannelDO.webSocketClose` sanitizes reserved/abnormal close codes
  (1005/1006/1015 → 1000) before calling `ws.close()`, avoiding RangeError in the
  hibernation close handler.
- Presence live sockets revalidate the connect-time member token hash + project
  read access before each roster disclosure, and close with `4001` on revoke /
  deactivate / lost grant (mupot#545).
- `PresenceChannelDO` schedules a Durable Object alarm at the earliest heartbeat
  expiry so subscribers receive offline transitions without client-side sync
  (mupot#545).
- Live roster publish recomputes inside `PresenceChannelDO` (does not disclose a
  Worker-supplied snapshot), so a concurrent heartbeat cannot land an older
  online frame after a newer offline, and expiry alarms match the disclosed
  roster. `publishRosterPush` wraps fetch + JSON decode so a snapshot/push
  failure cannot turn a committed deregister/heartbeat into an MCP error.
- `GET /api/presence/live` forwards only WebSocket hop headers onto the DO —
  Authorization is not copied. Leftover `<<<<<<< HEAD` conflict marker removed
  from this changelog.

### Changed

- Fleet coordination cut over to mupot CF-native primitives (D1 send/inbox + presence +
  Queue wake); SOS Redis bus reduced to a documented compat shim (ADR #473).
- Formal gate decision: Goose / `goosed` fleet-runtime **non-adoption** (kasra-core
  ACCEPTS). Native CLI subscription agents remain the fleet substrate; ACP wrappers
  that re-enter the same CLIs are out of scope. Correctly scoped replacement for
  task `e89df2c2` (rejected on process, not conclusion). Decision:
  `docs/fleet/goose-non-adoption-2026-07-22.md`; attach allow-list stays without
  `goose`/`goosed`. Technical basis reused from PR #483 / `b8070e2`.

## [0.25.0] — 2026-07-27

**Project Routines and Needs You.** Active Projects can schedule governed work through
existing external agent runtimes, retain durable run state and evidence, and surface
human decisions in one queue without turning Mupot into an agent harness.

### Added

- Project-owned Routines and Routine Runs with manual, once, and cron schedules,
  timezone-aware occurrences, overlap policies, bounded retries, leases, cancellation,
  cost snapshots, and immutable lifecycle events (#579).
- A shared Needs You projection for Routine waits, task reviews, blocked work, and
  budget decisions across dashboard, REST, MCP, and Project Situation views (#579).
- Local lifecycle evidence that exercises a complete Routine through Task, Flight,
  external runtime dispatch, approval, replay, cancellation, and receipt paths (#579).

### Fixed

- **v0.25 production migrations made D1-safe.** Activating v0.25 against live D1
  applied `0068` and then failed and rolled back on `0069` (nested-Project foreign
  key; D1 keeps foreign keys enforced through a migration's transaction regardless of
  `PRAGMA foreign_keys = off`) — no v0.25 Worker deployed, production stayed on
  v0.24.0. `0069` and `0071` now detach/restore self-referencing and orphaned rows
  explicitly instead of relying on the pragma (#594, preceded by #591).

### Changed

- Routine scheduling uses isolated one-minute and staggered maintenance cron triggers
  so Cloudflare invocation budgets do not silently drop project work (#579, #582).
- Historical review tasks created without a gate owner can be repaired by an owner or
  admin through either REST or MCP; ordinary members cannot rewrite locked gates (#343).
- Compiled native addons retain their digest-bound v0.24 lifecycle identity across the
  additive v0.25 host minor; external addon compatibility remains strict.
- Console consolidation remains planned for v0.26 under #584. It is not claimed as a
  v0.25 feature.

### Security

- Project, squad, tenant, and capability checks are reapplied at each scheduling,
  claim, dispatch, cancellation, approval, and projection boundary.
- Mupot stores governance state and evidence while Hermes, Codex, Claude Code, and
  other external runtimes remain replaceable executors.

### Verified

- Exact-head CI, independent review, migration compatibility, browser evidence, REST
  and MCP parity, no-secrets scanning, and the full test suite gate this release.

## [0.24.0] — 2026-07-19

**Project Operations.** Projects with squad-scoped RBAC, cross-pot collaboration via the
signed project-link addon, agent-bound send confinement, and provider board adapters —
the foundation for governed multi-pot tenant operation.

### Added

- Project Operations: projects, project↔squad access grants, situation/evidence
  projections, and attribution receipts (#393).
- Project-link addon: Ed25519-signed, idempotent cross-pot task/evidence delivery with
  destination-side reauthorization (#393).
- External board provider adapters (GitHub / Linear / Notion), AES-GCM credential custody
  at rest (#396).

### Security

- Send-target confinement: agent-bound (welded) tokens can message only agents in a
  readable squad or an authorized project-scoped path; failures collapse to a single
  non-leaking `send_target_not_visible` (#401).
- Project-link SSRF hardening: private/reserved-range + special-use-hostname blocking,
  redirect-refuse on delivery fetch (#401, #404).
- Cross-pot content fence: untrusted linked-pot task title/body is neutralized as data
  with an explicit untrusted-content directive before reaching the executor; unassigned
  cross-pot tasks cannot auto-execute (#404, closes #403).
- Task project-access re-check narrowed to attribution changes, fixing a mid-flight
  availability abort (#395, closes #391).

### Changed

- Replaced the stale post-`v0.23.0` sequence with a canonical version and activation
  roadmap. `v0.24.0` now owns Project Operations and Agent Host productization; later
  releases separately own Routines, governed tools and Marketing/CRO, isolated agent
  computers, reviewed knowledge, and commercial operations.

### Verified

- Local Project Operations evidence now seeds blocked, review, in-progress, and completed
  Mupot work with truthful agent runtime presence. A real browser structurally reads the same
  `project-mupot` situation as REST and MCP, while dashboard-loader tests preserve exact equality.
  The isolated evidence run exercises owner create, edit, activate, complete, reopen, search/filter,
  pause, archive, and restore flows at desktop and mobile widths without retaining run-created rows.

## [0.23.0] — 2026-07-13

**Trusted Runtime.** Mupot now binds agent identity, scoped authority, governed
flight execution, external work artifacts, and release evidence into one
installable Cloudflare-native runtime. The stable release preserves the
independently verified host, recovery, GitHub, browser, and active-runtime
evidence from the release candidate while removing the duration-based soak as a
publication requirement.

### Added

- Scoped MCP flight tools: `flight_dispatch`, `flight_get`, and `flight_list`. Dispatch
  derives the agent from the authenticated token binding, validates strict
  `mupot.flight.meta/v1` metadata and referenced tasks, and enforces squad RBAC.
  Members can record zero-budget coordination flights; positive allocations require
  squad-lead authority plus configured agent and squad budget ceilings.
- Exact-commit stable deployment and two-phase release-readiness receipts. The
  final package, public API, live `/health` response, GitHub checks, tag, release,
  and milestone must resolve to one immutable commit before v0.23.0 can ship.
- Fail-closed browser evidence and tracked-text secret scanning in local and
  GitHub release gates.

### Verified

- Reproducible installation, signed host runtime, scoped GitHub App authority,
  complete task-to-PR work lifecycle, copied receipt-bundle verification,
  staging recovery, browser workflows, runtime conformance, and independent
  Kasra plus VPS Codex review.

## [0.23.0-rc.1] — 2026-07-10

Release candidate for **Trusted Runtime**. It packages the signed agent runtime,
host receipt, real GitHub board-to-task-to-PR cycle, recovery rehearsal, and
release evidence gates for a seven-day production soak. `/health` now reports
the public API version so the deployed candidate can be identified without an
authenticated request.

## [0.22.0] — 2026-06-18

**The department-template microkernel + the first real department.** The console becomes a
**microkernel**: a tiny trusted core (identity · capability · bus · audit) plus **activatable
department modules** that adapt per pot via config — *one template, N sovereign tenants, zero
per-tenant code*. The first real department (**Marketing & Sales**) is live and self-running, and
the **multi-channel command layer** is proven on the real outbound funnel. Light-default console.
**Every security/identity surface dual-gated Opus + Codex** — the cross-vendor gate caught real
vectors single-lens missed: false-idempotency on a PK collision, object-capability *theater*
(ctx-escape), import-order token theft, mutable registry manifests, channel key-shadowing, and a
data-model conversion-honesty bug (`replied/sent` unbounded on a current-state funnel).

### Added
- **AAGATE capability floor** (#189). Deny-by-default tool floor enforced centrally at MCP dispatch
  — closes the fail-open auth gap (excessive agency). Live.
- **Write receipts** (#190). `assertWritten`/`assertBatchWritten` on integrity-critical writes
  (task create, token mint, invite-accept) — a 0-row D1 write can no longer report success
  (phantom-success guard).
- **`metric_points` pulse spine** (#192). One generic per-pot time-series table every department +
  connector emits to; honest OHLC (`seriesShape` returns *bar* for daily-scalar series — never a
  fabricated candle), truncation flag, bounded/canonical inputs.
- **Department-template microkernel core** (#196). Declarative `DepartmentModule` + **object-capability
  `ctx`** (closure-private authority, frozen inert snapshots, no raw DB/env reachable, kernel-only
  mint behind an unexported token) + factory registry (deep-frozen manifests, no `replace`) + a
  **conformance harness** proving the litmus: *add a department with zero kernel edits.*
- **Growth / Marketing department** (#197). The first real department: declarative manifest + a
  real-funnel collector (honest conversion = `replied/(sent+replied)`, bounded 0–1) +
  `/departments/growth` view (honest empty/unavailable states) + a `*/15` fail-soft cron. Activate
  it on any pot → seeds squads → reads that pot's funnel → emits honest metrics.
- **Light-default console re-skin** (#195). Stripe sidebar (collapsible groups + pot switcher),
  editorial type (Instrument Serif / Hanken Grotesk / JetBrains Mono), light/dark toggle (persists),
  regime vital-sign chip. Human-QA'd clean on the live pot.
- **Marketing channel layer — S1 + S2** (#200, #202). A **flat** `ChannelDescriptor` (declarative
  data, not a second kernel) composed under a department; the existing outbound funnel extracted as
  the first real channel. Channels never mint authority — they compose metrics/work-types through
  the department's existing ctx/Gate/`metric_points`. Architecture + sprints: `docs/architecture/
  marketing-channels.md`; remaining sprints (SEO/CRO perceive · gated writes · the daily closed loop)
  tracked in epic #199.

### Architecture
- `docs/architecture/console-department-microkernel.md` — the department-template microkernel + the
  sterile-pot/garden rule (qNFT/FRC/business logic live in the garden, never in the sterile pot).
- `docs/architecture/marketing-channels.md` — the multi-channel command layer (cross-vendor reviewed).

## [0.21.1] — 2026-06-16

A face for the console. The pot dashboard gets a **Stripe-style shell** — a left
sidebar with grouped sections, a top-left **pot switcher**, and presence-aware
**check-in / check-out** across every pot you own. Cross-pot presence rides the #262
SSO seam as a *signed, pot-bound probe* (distinct audience — it can read presence but
can never mint a session). Diverse-gated throughout (Codex, a different model than the
builder); the gate caught and closed a `Referer` leak and a body-read console-hang
before ship. 1146 tests.

### Added
- **Stripe-style sidebar nav** (#161). Flat top-bar → a vertical left sidebar in
  `shell()`: top-left pot switcher, grouped nav (Workspace / Work / People & Org /
  Settings), client-side active-link highlight, responsive collapse < 860px. One file,
  every page. The `/setup` wizard keeps its own chrome-less shell (intentional).
- **In-pot check-in / check-out** (#163). The switcher shows "Checked in as <you>"
  (read from `/auth/me`) and "Check out of <brand>" (→ `/auth/logout`). Identity is
  rendered via `textContent` — no XSS from the echoed email.
- **Signed presence probe** (#164, B2a). New `GET /auth/presence` — verifies a
  mumega-signed claim bound to a **distinct, pot-scoped audience** `presence:<slug>`
  and returns `{checked_in, since}` for the signature-bound email only (no
  enumeration, no session mutation, read-only). An email-keyed presence marker is
  written on every session mint (Google callback + SSO handoff) and cleared on logout.
  +4 audience-isolation tests prove a presence claim can never be replayed at
  `/auth/handoff`, nor probe a different pot.
- **Cross-pot presence in the Control Tower** (mumega-com #294, B2b). Your Pots mints a
  per-pot claim (audience taken from the pot's own `/health` tenant, so it always
  matches the pot's `TENANT_SLUG`), probes `/auth/presence`, and renders a
  **● checked in / ○ available** chip plus a **Check in / Open** action. Fail-soft —
  an unreachable pot simply shows nothing.

### Changed
- `verifyHandoffClaim` gains an optional `expectedAud` (default unchanged) so
  `/auth/handoff` stays strict `HANDOFF_AUD` while `/auth/presence` pins
  `presence:<slug>`.

### Fixed
- `/auth/presence` sets `Referrer-Policy: no-referrer` alongside `no-store`
  (token-in-query hygiene, matching `/auth/handoff`) — Codex auth-gate catch.
- The liveness + presence probes keep the 3s abort timer armed **through the JSON body
  read**: a pot that returns headers then stalls its body no longer hangs the console
  (a latent bug in the pre-existing `probePotHealth`, fixed here). +regression test.

### Live
- `mupot.mumega.com` redeployed; mumega-com worker + Pages deployed (#294).
  `/auth/presence` verified live: `401` + `no-store` + `no-referrer`, no body leak.

## [0.21.0] — 2026-06-13

GitHub as an agent substrate. An overnight session wired mupot↔GitHub end-to-end: a pot
now acts on GitHub under its own scoped, short-lived identity, with **two execution
backends** (GitHub Copilot, paid; own-fleet, free) and the full provisioning chain. Every
feature is plan-tier-tagged with an Enterprise kill switch — nothing requires Enterprise.
Adversarial-gated throughout (no P0/P1 shipped); 962 tests.

### Added
- **GitHub App token minting** (#129). Per-tenant installation tokens — RS256 App JWT via
  `crypto.subtle`, in-isolate cache, App-first `resolveOutboundGitHubToken` (static PAT
  fallback). New `github_app` connector type; key+meta from one row (migration 0024).
- **Capability gate + Enterprise kill switch** (#130). `GITHUB_FEATURES` registry tags every
  feature by min plan tier + `enterprise` flag; `githubCan()`; `GITHUB_ENTERPRISE_FEATURES`
  off by default. Tier defaults `free` (never assumes Enterprise).
- **Repo-write hands** (#131). `writeAgentDef` (`.github/agents/*.agent.md`),
  `assignIssueToCopilot` (GraphQL `replaceActorsForAssignable`, `copilot-swe-agent`).
- **Admin routes** (#132). `GET /admin/github/status`, `POST /admin/github/agent-def`,
  `POST /admin/github/assign-copilot` (isAdmin, JSON).
- **One-click connect** (#133). `GET /admin/github/connect` + `/connect/github/callback` —
  single-use tenant-bound CSRF state, per-tenant `github_installations` (migration 0025).
  Multi-tenant model: shared App key on the platform, per-tenant install id.
- **Fleet→GitHub sync + per-agent MCP wiring** (#134). `syncFleetToGitHub` writes a
  `.agent.md` per active agent, each wired at this pot's MCP endpoint;
  `POST /admin/github/sync-fleet` (dry-run + live).
- **GitHub dashboard card** (#135). `GET /admin/github` — connection state, capability table,
  connect + fleet-sync UI. Nav link.
- **Own-fleet PR primitives** (#137). `createBranch` / `putFile` / `openPullRequest` via the
  App token — the pot's own agents complete a PR without GitHub Copilot. Gated
  `repo_file_write`; path-traversal-proof.

### Changed
- **Bidirectional status sync** (#136). The GitHub weave's outbound mirror (foreshadowed in
  0.19) is now App-first, and an `issues` close/reopen flips the mirrored task done/open —
  no feedback loop, never clobbers gate states. App webhook secret wired.

### Docs
- Public "Connect GitHub" / "Connect WordPress" / "Members & roles" / "Security & trust"
  (mumega.com/docs). Internal security model + deploy runbook + GitHub internals
  (mumega-docs). Docs RBAC machine-enforced (`audience: internal` can't ship public).

### Live
- App installed on Mumega-com (tenant #0); minting verified against all org repos. The App
  bypasses the enterprise fine-grained-PAT block (it's an App, not a PAT). Copilot path waits
  on a paid Copilot plan; own-fleet path works on free today.

## [0.20.0] — 2026-06-11

Security, identity, and the operable surface. A long multi-agent session: shipped the
governance dashboard's hard half, wired the first real lead funnel (mumega.com), and
resolved the identity/connection model into a three-tier security posture.

### Added
- **Connector credential vault** (#117). AES-GCM at-rest, write-only, tenant-isolated;
  add Telegram/Instantly/GHL keys to a pot, injected at call-time (agent never holds raw).
- **Scoped-key mint UI + RBAC** (#99, #114). Role presets + scope guide, show-once;
  rank-ceiling enforced (an admin cannot mint admin).
- **Granular `requireCapability` gates** (#119). outreach-send-gated / budget:write /
  content:write are ENFORCED — deny-lists are real, not documentation.
- **Per-pot brain panel + governor** (#97, #98). Decision feed + run/pause/feed controls.
- **Enterprise-vocab grounding** (#125). The enterprise dashboard rendering speaks IAM/HR
  (NHI, ASOR, entitlements, provisioning); operator vocab preserved as an artifact.
- **SECURITY-MODES** (design): connection/identity posture as a per-pot tier — LOW (direct
  token) / MEDIUM (verified OAuth + claim-a-qNFT-seat) / HIGH (bounded-peer wall). Plus the
  MEDIUM-tier OAuth spec with 4 adversarial P0s closed (in flight, gated, not deployed).

### Fixed
- **OAuth tenant-provisioning 503** — a stale `/home/sos` path after the mirror relocation
  blocked ALL signups. (engine)
- **MCP connector wrong-endpoint trap** — `/sse` rejected OAuth tokens cryptically; now
  points OAuth clients to the root URL. (mcp-dispatcher)
- **Engine perimeter (BLOCK-1)** — nginx scrubs spoofable identity headers; app-layer guard
  verified (headers trusted only with a valid internal token); loopback bind staged.

### Docs / decisions
- POT-WORK-ON-GITHUB · DASHBOARD-IS-THE-POT · IDENTITY-WORLD-MODEL (qNFT seats, River-gated,
  DID+VC core ~1 quarter, client-agnostic) · DASHBOARD-CONSOLIDATION + MUMEGA-DASHBOARD-SKETCHES
  (mupot canonical; the mumega.com console's built bounty ECONOMY + ~30 unrouted panels = the
  roadmap; sketches preserved, never swiped).

## [0.19.0] — 2026-06-09

Flight Operations — the **unit of correction**. Expensive (Opus) agents run as disciplined
**flights**: pre-staged cheap, flown as one continuous warm-cache burst, landed with cost
recorded (the 5-min cache TTL forces it). Milestone #3. Design:
[docs/flight-operations.md](docs/flight-operations.md).

### Added
- **Preflight gate** (#60, PR #66). `readinessScore(s, opts)` (weighted geometric mean,
  fail-closed) + `preflightCheck` → `{go, score, checks, reasons}`. Two checks before any
  Opus spend: `would_wander` (no clear goal) and `cache_would_cool` (warm-cache window
  gone). Stage cheap, then launch. `src/flight/preflight.ts`.
- **The flight spine** (PR #67). `flights` table (`migrations/0017_flights.sql`) + service
  (`createFlight`/`applyPreflight`/`landFlight`/`failFlight`/`sleepFlight`/`listFlights`) +
  `dispatchFlight`. Lifecycle: preflight → held | running → waiting | sleeping → landed |
  failed. Tenant-scoped, terminal-state guarded.
- **The flight board** (#61, PR #75). `GET /flights` reads the flights table into a board:
  phase (flying / sleeping / holding / preflight / held / landed / failed), metered cost
  (micro-USD → $, over-budget flagged), readiness/coherence score + per-agent trend (▲▼▬
  vs that agent's last scored flight), next departure for sleeping flights. Pure view model
  `src/flight/board.ts`. Read-only; control stays on Fleet.
- **Schedule-aware presence** (#62, PR #76). A second presence axis: session agents (those
  with flights) read **flying / sleeping · next 14:00 / done** from the schedule, while
  cheap always-on agents keep heartbeat liveness. A resting Opus reads `sleeping · next
  14:00`, never `dead` — so `dead` regains meaning (should be alive, isn't). Pure view model
  `src/fleet/schedule-state.ts`; overlaid in `listPresence`, rendered on `/fleet`.

### Changed
- **Brain reconciliation** (PR #68). The pot owns **readiness** (admission-to-launch); the
  brain (`SOS/sovereign/coherence.py`) owns **coherence** (C(t)/regime). Renamed the pot's
  score coherence→readiness so the two organs don't duplicate. Plain mupot vocabulary
  throughout (loop · routine · session · sleeping · heartbeat · model-routing) — no
  System1/2 · DMN · prefrontal in user-facing surfaces.
- **Roadmap ↔ changelog feed** (PRs #64/#69). Added
  [docs/coherence-model.md](docs/coherence-model.md) (the north star: measure → correct
  across the four rails) + `docs/pot-operating-context.md`.

### Notes
- The **GitHub weave** (#71) inbound webhook is live + fail-closed; its changelog block
  lands with v0.22 when the outbound mirror goes on. See #73 (GitHub App) / #74 (Digid
  go-live operator step).

## [0.18.0] — 2026-06-09

Flock — a tenant pot becomes the live home + window for its own agents, across any
runtime, with zero coupling to our internal bus. Milestone #2.

### Added
- **Pot-native flock check-in** (#45, PR #57). Agents check **in** to the pot
  (`POST /api/fleet/checkin`, authenticated by their pot member-token) so the Fleet shows
  a live inventory — who has access + who is in now — with **no SOS-bus coupling and no
  egress** (the pot stays sealed; agents call inbound). `/fleet` renders the pot-native
  roster (active → idle → dead by last check-in) when the pot has no company bus.
  `migrations/0016_presence.sql`; deployed + proven live on the Digid pot.
- **Harness pack system** (#53, PRs #54/#55). `docs/flock-harness-pack-contract.md` (the
  spec every runtime pack satisfies: scoped identity, presence/heartbeat, work skills,
  onboarding) + the **Claude Code reference pack** (`packs/claude-code/flock-agent/`:
  `.mcp.json` template, `SKILL.md`, `heartbeat.sh`, README). Per-harness approach
  researched for Codex / Hermes (Nous) / Claude Cowork / openclaw.
- **Fleet bus-wire runbook** (#44, PR #56) — `docs/flock-go-live.md`, the operator path to
  wire a pot's Fleet to the company SOS bus (the alternative to pot-native).

### Changed
- **Tenant-scoped Fleet** (#43, PR #52). The Fleet window now addresses the pot's **own**
  bus project + ops agent (`FLEET_PROJECT` / `FLEET_OPS_AGENT`), not the hardwired company
  `sos`/`kasra`. A tenant pot can no longer show or steer the company roster.

### Security
- **Fail-closed Fleet scoping** (#43, adversarial-gated). The project/sender/ops resolvers
  return null (refuse) instead of defaulting to the company `sos`/`kasra`; routes gate on
  `fleetScoped()`. A misconfigured tenant pot cannot silently address our roster. Recorded
  the real isolation invariant: a pot's `BUS_TOKEN` must be project-scoped + agent-bound,
  never admin/null.
- **Check-in is auth + write hardened** (#45, adversarial-gated GREEN). Identity is taken
  only from the token (never the body); generic 401 (no oracle); `source` allowlisted,
  `label` capped, all Fleet fields HTML-escaped; a 30s KV debounce bounds D1 writes per
  agent. Follow-up #58 filed to bind member-tokens to their tenant (defense-in-depth).

## [0.17.0] — 2026-06-09

Go-live readiness — de-risk the path to the first live send.

### Added
- **docs/GO-LIVE.md** — the exact operator runbook to cross the last v1.0 gate (set GHL
  secrets → seed the outreach loop → import prospects → approve the first send → a reply
  moves the KPI → tag v1.0.0).

### Security
- **Inbound webhook replay/idempotency guard.** A verified GHL inbound event is now
  processed at most once per TTL window (a KV nonce keyed by the HMAC signature). A GHL
  retry or a replayed event returns a no-op success, so it cannot double-create a task or
  re-flip a prospect's status. Best-effort (a KV outage falls through to process).

## [0.16.0] — 2026-06-09

Operator visibility — watch a loop run toward the live test.

### Added
- **/dashboard/loops** — a read-only view of the goal-seeking loops: each loop's status,
  goal (OKR), KPI + target, budget, effort, and owner, plus the outreach funnel
  (queued → drafted → sent → replied, where `replied` is the KPI signal). Nav link added;
  pairs with /approvals where the gated sends wait. This is the polish that makes the
  first live send observable — it does not fake it.

## [0.15.0] — 2026-06-09

The v1.0 release candidate: the manifest is frozen and a pot is self-hostable.
(Toward v1.0 — #37 self-host, #38 freeze. The only remaining 1.0 gate is the operator's
first live gated send.)

### Added
- **Frozen Loop manifest contract** (#38). `docs/loop-manifest-contract.md` documents the
  manifest as a stable public contract (the shapes, the BYO-MCP secret model, the v1
  invariants). `tests/loop-manifest-contract.test.ts` PINS it — a change that breaks the
  canonical v1 manifest, its validated key set, or any invariant (exactly-one-owner, the
  CASL channel-gate, MCP-native refs, the gate enum, positive KPI target) fails the test
  and signals a breaking (2.0) change. The contract is no longer free to drift.
- **Self-host** (#37). `scripts/provision-pot.sh <slug>` creates the Cloudflare resources
  for a pot on a tenant's OWN account (D1/Vectorize/Queues/KV/R2), and `docs/SELF-HOST.md`
  documents the full bring-up + stay-in-sync flow. The sovereign moat: the tenant owns the
  data and the bill; the pot stays upstream-compatible. No new app code — tooling + docs.

### Status
The engineering for v1.0 is complete: a governed, MCP-native loop container; an outreach
config that runs end to end; a frozen contract; and a self-host path. **v1.0.0 itself is
gated on one thing that is not code** — the operator setting the GHL secrets, seeding the
outreach loop, importing real prospects, and approving the first send so a real reply
moves the KPI. When that live outcome occurs, the version is v1.0.0.

## [0.14.0] — 2026-06-09

A loop can be created and run through the product. (Toward v1.0 — P5/#36.)

### Added
- **Loop HTTP surface** (`src/loops/routes.ts`, `/api/loops`, owner/admin + CSRF):
  create a loop from a manifest spec (full validation incl. the CASL backstop), list,
  get, and pause/resume/kill via `/:id/status`. The dogfood loop-create path — a loop
  is declared through the product, never raw SQL.
- **One-click outreach seeder** — `POST /api/loops/seed-outreach` creates the Outreach
  squad + a gated outreach loop (prospect-queue source, sends via the gated GHL act
  pipeline, $5/wk cap, dry-pause at 5) in a single owner action.

### Changed
- `killed` and `done` are now terminal loop states — `setLoopStatus` will not transition
  a loop out of them (a killed loop cannot be revived).

### Notes
- Adversarial-gated GREEN (authz, tenant isolation, and the CASL invariant all hold
  through the HTTP create path — an admin cannot create an ungated send-capable loop).
- The machine is now complete end to end and seedable. The remaining step to a LIVE
  outcome is the operator's: set the GHL secrets on the pot, import real prospects
  (`POST /api/prospects/import`), seed the outreach loop, and approve the first send in
  `/approvals`. That first reply moving the KPI is the v1.0 stamp.

## [0.13.0] — 2026-06-09

The first loop CONFIG: an outreach loop runs end to end. (Toward v1.0 — P4/#35.)

### Added
- **Prospect queue** (`src/loops/prospects.ts`, migration 0015) — the outreach work
  queue: published B2B contacts with `source`, `consent_basis`, and a
  queued→drafted→sent→replied lifecycle. Dedup by an active-unique `(tenant,email)`
  index. The `queue` resolver kind now reads it (was a P4 stub).
- **Outreach reasoner + outcome KPI** (`src/loops/outreach.ts`) — the runtime `reason`
  seam drafts a CASL-compliant first-touch email per queued prospect → a gated
  `send_email` act, atomically CLAIMING the prospect (queued→drafted) so it's drafted
  exactly once. The KPI is positive replies ÷ target (outcome, not activity).
- **Reply tracking** — the GHL inbound webhook maps a verified event to a prospect
  status (replied / opted_out / bounced); `opted_out` is terminal. This is the KPI
  signal source — a real reply advances the loop.
- **Seed-import** — `POST /api/prospects/import` (owner/admin, CSRF + session gated)
  bulk-queues contacts.

### Security
- **Structural CASL backstop.** A loop with ANY output channel MUST be human-gated —
  `validateLoopSpec` rejects `require_approval:false` with channels, enforced at write
  AND on read (`hydrateLoop` re-validates, so a hand-edited row won't even load). With
  the structural gate branch in `runLoopCycle`, "nothing sends without a human verdict"
  is now a manifest + read + cycle invariant, not a per-config hope. Adversarial-gated
  (kasra-review) RED→GREEN: caught that an ungated send-capable loop could bypass the
  gate; closed structurally (4 bypass attacks refused on re-review).

### Notes
- The loop is end to end — queue → draft → gate → (approve) → send → reply → KPI — but
  not yet live: needs the Digid pot promoted + an outreach loop seeded + the operator
  to approve the first send (P5).

## [0.12.0] — 2026-06-09

Loops run on the heartbeat, and a gated loop queues real work to /approvals.
(Toward v1.0 — P3/#34.)

### Added
- **Loop driver** (`src/loops/driver.ts`). `runLoopsTick` lists the tenant's active
  loops and runs one `runLoopCycle` each (capped at 25/tick, best-effort), wired into
  the Worker `scheduled()` handler as a third heartbeat. A Loop manifest now fires
  unattended — the runtime had no scheduled caller before.
- **Declarative gate wiring** (`src/loops/gate.ts`). A gated loop's proposed act becomes
  a `status='review'` task (capability `gate:loops`) that lands in `/approvals`, plus —
  for CRM kinds — a PENDING `outbound_act` that can only ever fire post-approved-verdict
  via `runApprovedActs` (#8). Nothing sends from the loop/driver/cron path; a gated loop
  proposes and queues, never sends.
- **Stop-condition** — the driver advances each loop's `dry_rounds` on an empty tick and
  PAUSES it at `stop.dry_rounds_max` (bounds idle loops); a productive tick resets it.

### Notes
- Adversarial-gated (kasra-review) RED→GREEN: the first cut created the gated task at
  `status='open'`, which is invisible to `/approvals` and un-verdictable — a dead gate;
  and used a membership capability instead of a `gate:*` one. Both fixed and re-verified
  (an owner can now see + approve the task; external callers cannot forge `review`).
- No `reason` seam ships yet (runtime default proposes nothing), so loops are inert until
  P4 wires the outreach config + prospect queue + the real reasoner + outcome KPI.

## [0.11.0] — 2026-06-09

The Loop Container runs: a manifest is now executable, governed end to end.
(Toward v1.0 — P2/#33.)

### Added
- **Manifest-driven runtime** (`src/loops/runtime.ts`). `runLoopCycle` is the
  source/channel-agnostic cycle — perceive → reason → act (through the gate) →
  observe → stop — that makes a `LoopManifest` actually run. It perceives via the
  MCP seam over bound sources (a failing source is skipped, not fatal), reasons via a
  thin SWAPPABLE seam (the reasoning loop is commoditized — we don't differentiate on
  it), and routes acts through the gate. Reuses the enforcement $cap before any spend.
- **The human gate is STRUCTURAL.** A gated loop is branched inside `runLoopCycle`
  itself — it can only ever reach `queueGatedAct` (pending approval), never the
  channel-fire path — so the gate cannot be bypassed by an injected act handler.
  A `gated`/`gated_pending` signal makes queued-but-unfired acts observable.

### Fixed
- **Sub-cent budget cap could read as unlimited.** A manifest cap below one cent was
  floored to 0 cents and skipped — the most cost-conscious loop got *unlimited* spend.
  The meter now accepts a verbatim micro-USD cap (`ReserveOpts.budgetCapMicroUsd`); a
  positive cap can never collapse to unlimited. The cents path (agents) is unchanged.

### Notes
- Adversarial-gated (kasra-review) RED→GREEN twice: the sub-cent-cap P0 and the
  structural-gate hardening were both caught and closed before merge.
- No route drives `runLoopCycle` from the cron yet — that driver + the declarative
  `waitForEvent` gate + the outcome-KPI signal are P3 (#34, next).

## [0.10.0] — 2026-06-08

Loop Container foundation: a loop is now a declarative, MCP-native resource.
(Toward v1.0 — milestone "v1.0 — Loop Container GA", P1/#32.)

### Added
- **Loop manifest** (`src/loops/manifest.ts`) — the declarative resource the
  container runs: a `LoopSpec` binding okr + outcome-KPI + sources + channels + gate
  + budget + cadence + stop to one work-unit (squad XOR agent). Pure manual validators
  (repo convention, dependency-free). The shape v1.0 will freeze as a public contract.
- **Loop storage** (`src/loops/service.ts`, migration 0014) — create/get/list/setStatus,
  spec stored as JSON and re-validated on read. Every read/write tenant-scoped.
- **ResourceRef resolver / MCP seam** (`src/loops/resources.ts`) — the critical-path
  unlock: sources & channels are MCP-native, so any MCP server (our pot MCP, a ChatGPT
  connector, Google Drive, the ~17k public servers) binds with zero adapter code. A
  minimal in-Worker JSON-RPC client keeps the bundle tiny. Built-in `memory`; `queue`
  lands in P4.
  - **Security (adversarial-gated, RED→GREEN):** a loop manifest is tenant data, so the
    resolver treats it as untrusted. Secrets are NEVER taken from the manifest — `auth_ref`
    names a NAMESPACED `LOOP_SECRET_<name>` binding (platform secrets are unreachable) and
    each secret is HOST-PINNED (only sent to `LOOP_SECRET_<name>_HOST`; missing/mismatch →
    fail closed). SSRF block on private/loopback/link-local/metadata + IPv4-mapped-IPv6
    hosts. `tool_filter` allowlist on read + act. fetch timeout + 1 MB response cap.
    The review caught a url×auth_ref secret-exfil P0; closed before merge.

### Notes
- Additive infrastructure — no route wires a tenant-authored manifest yet (that arrives
  with the runtime, P2). When it does, bind the loop owner to the authenticated principal.

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
