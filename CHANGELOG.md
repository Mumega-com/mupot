# Changelog

All notable changes to mupot. Semver; pre-1.0 minor bumps may break.

**What ships next:** see [ROADMAP.md](ROADMAP.md). The roadmap (planned, by version) and
this changelog (shipped, dated) share version numbers and feed each other — a roadmap
block collapses into a changelog entry when it ships.

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
