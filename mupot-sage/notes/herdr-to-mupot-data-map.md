# herdr → mupot data map — what mupot should read from herdr

**Author:** mupot-sage (river child) · **Run:** 2026-08-10T03:0xZ · **Read-only:** herdr CLI (agent list / api snapshot / pane get / worktree list / api schema) + mupot MCP (presence_list, peers, status, orient, flight_list, task_list, resolve_agent, get_agent_profile, project_list). No secrets printed; no mutations; nothing written outside this context dir.

---

## 1. HERDR DATA SURFACE (observed this run, live socket)

### 1.1 `herdr agent list` — full per-agent JSON (5 agents live)
Envelope: `{"id":"cli:agent:list","result":{"agents":[...]},"type":"agent_list"}`. Every field per agent:

| Field | Example | Kind |
|---|---|---|
| `agent` | `prime-agent` / `claude` / `hermes` | **harness kind** |
| `agent_status` | `working` / `idle` | **observed** (terminal activity) |
| `cwd` | `/mnt/HC_Volume_104325311/mumega.com/agents/river` | observed |
| `foreground_cwd` | same | observed |
| `focused` | `false` | observed |
| `name` | `muvps_river` (pane label; convention `muvps_<seat>`) | observed |
| `pane_id` | `wE:p5` | observed |
| `revision` | `1` | herdr-internal counter (delta only) |
| `state_change_seq` | `390` | herdr-internal global counter (delta only — activity signal) |
| `tab_id` | `wE:t1` | observed |
| `terminal_id` | `term_658a40bb4cd0b1` | observed (stable per pane) |
| `terminal_title` | `prime-agent - river` / `⠐ Resume mupot federated…` | **declared by running agent CLI; may carry task text** |
| `terminal_title_stripped` | spinner stripped | same, cleaned |
| `workspace_id` | `wE` | observed |
| `agent_session` | `{"agent":"claude","kind":"id","source":"herdr:claude","value":"b7401cb3-…"}` | **present ONLY on the claude seat (kasra)** — absent on prime-agent/hermes seats |

Live seats mapped by `name`: `muvps_river`→river, `muvps_loom`→loom, `muvps_athena`→athena, `muvps_kasra`→kasra (claude, focused, `state_change_seq=392` — most active), `muvps_mubot`→mubot (hermes, no `terminal_title`, no `agent_session`).

### 1.2 `herdr api snapshot` — socket state (6.5 KB, one call)
`result.snapshot`: `agents[]` (same 15 fields as §1.1), `panes[]` (6 — adds `label`, `scroll{max_offset_from_bottom,offset_from_bottom,viewport_rows}`), `tabs[]` (2 — adds aggregate `agent_status`, `pane_count`), `workspaces[]` (1 — `active_tab_id`, `pane_count`, `tab_count`), `layouts[]` (2 — `area{x,y,width,height}`, `splits[]`, `panes[]` with `rect`, `zoomed`), `focused_pane_id`, `focused_tab_id`, `focused_workspace_id`, `protocol` (19), `version`.

### 1.3 `herdr pane get <id>` — pane-level (same as agent + extras)
`wE:p5` (river): no `agent_session`; `wE:p3` (kasra): HAS `agent_session`; `wE:p6` (mubot): no `terminal_title` fields, `scroll.max_offset_from_bottom=9366` (long history). Pane adds: `label`, `scroll`.

### 1.4 `herdr worktree list` — repo-scoped by `--cwd`
- `mumega.com`: `source{repo_key, repo_name, repo_root, source_checkout_path, source_workspace_id}`, **19 worktrees** (source checkout `open_workspace_id=wE`; 17 linked; 2 detached).
- `mupot`: `repo_root=/home/mumega/mupot`, **114 worktrees** (24 detached, 24 branch-less, **0 with `open_workspace_id`** — none open in the live workspace, incl. the SAGE-01 worktree). Per worktree: `branch`, `is_bare`, `is_detached`, `is_linked_worktree`, `is_prunable`, `label`, `open_workspace_id`, `path`.
- `river/mupot-sage` branch → `/mnt/HC_Volume_104325311/mupot-worktrees/mupot-sage` confirmed present (branch name encodes `agent-slug/topic`).

### 1.5 `herdr api schema --json` — protocol 19, schema_version 1; schemas: `error_response, event, request, subscription_event, success_response` → the socket supports **events/subscriptions (push)** — a future connector need not poll.

**Observed vs declared on herdr:** `agent_status`, `cwd`, `foreground_cwd`, `focused`, pane/tab/terminal/workspace ids, `name` = OBSERVED (from pane/process). `terminal_title` = DECLARED (agent CLI writes it; user/task content). Worktree `branch`/`path`/`is_detached` = OBSERVED from git; `open_workspace_id`, `source_*` = herdr registry.

---

## 2. MUPOT READABLE SURFACES (read-only MCP, this run — 82 tools total)

| Tool | Fields returned | Already has | Stale / declared |
|---|---|---|---|
| `peers` | `peers[]`: `id, slug, name, role, model, status, squad_id, is_self, presence{source, label, last_seen_at, liveness, last_seen_human}` | roster + presence view | presence is heartbeat-declared → **stale**: kasra `last_seen_at=2026-08-09 22:08:09, liveness=idle, "4h ago"` while herdr says **working+focused NOW**; river `last_seen_at=null, never` while herdr says working. `model` is declared (river=`hermes` vs herdr kind `prime-agent`). |
| `presence_list` (project-scoped) | `modules[]`: `id, kind, adapter, project_id, identity, status, capabilities, last_heartbeat, registered_at` | module_registry roster | **all 5 modules `status=offline`**; kasra's `claude-code-kasra` last heartbeat `2026-08-06T02:21:40` (4 days stale) vs herdr working. |
| `status` | `member_id, email, channel, tenant, role, bound_agent_id, capabilities[]` | credential truth | — |
| `orient` | `packet{agent{…, effort, autonomy, budget_cap_cents, budget_window}, department, squad, supervisor, squadmates[], tasks[], capability, mcpEndpoint, field{…}, field_restricted, induction}` + brief | self orientation | `field`/`okr` mostly null (declared, unfilled) |
| `flight_list` | `flights[]`: `id, tenant, agent, goal, status, trigger_source, gate_verdict, gate_reason, score, budget_micro_usd, cost_micro_usd, next_run_at, created_at, started_at, ended_at, meta{schema, goal_id, objective_id, squad_ids, task_ids, done_when, artifact_refs, receipt_refs, confidentiality, publication_target, parent_flight_id}, project_id` | flight state | `status`/`agent` are **dispatch-declared**, worker truth unverified (16 flights: 6 held, 6 running, 4 landed) |
| `task_list` | `tasks[]`: `id, squad_id, project_id, title, body, done_when, status, priority, parent_task_id, assignee_agent_id, github_issue_url, result, completed_at, gate_owner, source_pot, external_source, created_at, updated_at, stale_assignee` | task state | `stale_assignee` already computed (declared) |
| `resolve_agent` / `get_agent_profile` | `matches[]/profile`: `id, squad_id, slug, name, role, status, model, model_fallback, purpose, owner, capabilities, skills, parent_agent_id, qnft_ref, death_condition` | agent registry | `model` declared → drifts vs herdr kind (#882); slug `asha` on id `e211b0fb` (PRIME per athena identity note) — roster drift |

**Live cross-check this run (the drift the map fixes):**
- kasra: herdr `working`, `focused`, seq 392 ⇔ mupot presence "4h ago idle" ⇔ module_registry offline 4 days → **triple-stale (#837)**.
- river: herdr `prime-agent` working ⇔ mupot `model=hermes`, presence `never` → **model + presence drift**.
- 6 running flights: 5 have **NO live herdr seat** (`e211b0fb`×2, `141e954c`×3 — no pane) → phantom/done-but-not-landed provable from herdr side; only `9f5e0147` (kasra) matches a live seat.
- SAGE-01 goal text says "herdr w6" but river's actual pane is `wE:p5` — **declared pane refs in goals are already stale**; `meta.artifact_refs` (worktree path) is the durable ref and it resolves via `herdr worktree list`.

---

## 3. DATA-CONTRACT MAP: herdr → mupot

| # | herdr source (field) | mupot target (surface) | Drift fixed | Read cost | Cadence |
|---|---|---|---|---|---|
| M1 | `agent_list[].agent_status` (+ `state_change_seq` delta) | `presence_heartbeat` / `peers.presence` (`source="herdr"`, `label=terminal_title_stripped`), per seat via `name→slug` (`muvps_<seat>`) | **#837 stale presence**: observed beats declared; idle→`liveness=idle`, working→`active`, no pane→`offline`/`never` | 1 call / 6.5 KB snapshot | 30–60 s while any flight is running; 1–5 min idle |
| M2 | `agent_list[]` pane existence + `agent_status` | `flight_list` worker reconciliation: `running` flight ↔ seat pane alive? ↔ `agent_status` | **flight worker state / done-but-not-landed (Loom §5.5)**: `running` + no pane = never-delivered/phantom (5/6 live flights!); `running` + `idle` for >N min = done-but-not-landed alert | same call as M1 | same as M1 (flight-driven) |
| M3 | `agent_list[].agent` (kind) + `terminal_title_stripped` | `update_agent(model=…)` / `resolve_agent.model` | **#882 roster drift**: river `hermes`→`prime-agent`; harness kind is the observable truth (coarse — model string is best-effort; do not invent a model from a title) | same call | daily + on boot; on drift only |
| M4 | `agent_session{kind, source, value}` (claude seats) + `terminal_id` (all seats) | resume/restore records (`meta.session_id` or a new session table) | session identity: `b7401cb3-…` is the claude session; prime-agent seats have NO herdr session id → fall back to `terminal_id` and flag the gap (prime-agent sessions live in the harness, not herdr) | same call | on boot / resume / handoff |
| M5 | `worktree_list[].{branch, path, is_detached, is_prunable, open_workspace_id}` (both repos) | `fleet_agents` worktree/branch binding + hygiene (114 mupot worktrees, 24 detached, 24 branch-less) | worktree truth: `river/mupot-sage` branch ↔ SAGE-01 artifact_refs; branch `agent-slug/topic` ↔ agent binding; `open_workspace_id` = which seat has it open | 2 calls / ~26 KB | on boot; after dispatch/land; daily hygiene scan |
| M6 | `pane get` on flight seats (on demand) | flight worker-alive proof (`scroll.offset_from_bottom` movement, viewport) | worker-alive vs hung-pane | 1 call / pane | only while a seat has a `running` flight |
| M7 | `api snapshot` aggregates (`tabs[].agent_status`, `workspaces[].agent_status`) | coarse fleet liveness dashboards | whole-workspace health at a glance | same as M1 | same as M1 |
| M8 | `api schema --json` (one-time) | connector contract (protocol 19, `subscription_event`/`event` schemas → **push, not poll**) | build-time | 251 KB once | one-time + on herdr upgrade |

---

## 4. PRIORITIZE + CADENCE

**Read order (impact/cost):**
1. **M1+M2 (`herdr agent list` / `api snapshot`)** — P0. One 6.5 KB call fixes #837, detects phantoms + done-but-not-landed. This is the highest-value read.
2. **M5 (`worktree list` both repos)** — P0. Fleet/worktree binding + 114-worktree hygiene; needed at dispatch/land and daily.
3. **M3 (harness kind → model)** — P1. Cheap (same call as M1), fixes #882 gross drift; daily.
4. **M4 (session identity)** — P1. Same call; only on boot/resume.
5. **M6 (`pane get` on flight seats)** — P2, on demand only.
6. **M8 (schema)** — one-time contract for the connector.

**Cadence summary:** flights running → 30–60 s poll of M1+M2 (or subscribe to socket events, M8, for push); idle → 1–5 min; worktree scan → boot + after each dispatch/land + daily; model/session reconciliation → daily; pane-level → on demand.

**Do NOT read (noise / risk):**
- `terminal_title` RAW — kasra's title is a full task prompt (secret-bearing); never ingest raw, only `terminal_title_stripped` as an ephemeral label, and never persist it.
- `herdr agent read` (terminal output) — heavy, secret-bearing; never.
- `state_change_seq`, `revision` — internal counters; use only as activity deltas, never store.
- `scroll` offsets, `layouts[]`/`rect`/`splits`/`zoomed` — volatile geometry; skip.
- `focused` — cosmetic; skip in the contract.
- Per-worktree `is_bare`/`is_prunable` details — only in the daily hygiene scan, not the live path.
- Mupot seats must stay **read-only against herdr**: herdr is an observation source for mupot, never a write target for seats.

**Implementation note:** the connector is a host-side daemon/poller (fleet-consumer/concierge pattern) running the herdr CLI (or socket subscribe once M8 lands) that feeds mupot via `presence_heartbeat` + `update_agent` + a flight-reconciliation check — no changes needed to herdr, no changes needed to mupot tool auth (existing member/lead read surface is enough).

---

## STATE-delta (this run)
`state.json` updated · herdr protocol 19 live: 5 panes (river/loom/athena/kasra/mubot), kasra most active (seq 392), kasra+river presence drift CONFIRMED vs mupot (#837), mupot `model=hermes` for river vs herdr `prime-agent` (#882) · mupot: 82 tools, 16 flights (6 held/6 running/4 landed), 5 of 6 running have NO herdr seat (e211b0fb×2, 141e954c×3) → phantom class proven from herdr side · worktrees: mumega.com 19 (2 detached), mupot 114 (24 detached, 24 branch-less, 0 open) · SAGE-01 goal's "herdr w6" stale vs actual `wE:p5`; artifact_refs resolve via worktree list · data map M1–M8 written to notes/herdr-to-mupot-data-map.md · new note: herdr-to-mupot-data-map.md (+ raw evidence `_herdr-snapshot-raw.json`, `_herdr-mupot-worktrees-raw.json`, `_herdr-api-schema.json`, `_mupot-flight-list-raw.json`).
