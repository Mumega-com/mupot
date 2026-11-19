# Mupot roadmap — 2026-11-15

Forward-looking queue for mupot. [CHANGELOG.md](CHANGELOG.md) is the record of what has
shipped. Live production is read from `/health` (version + deploy commit + `clean`). This
document does not pin a `main` or production commit.

## Direction

Mupot is the between layer: a customer's people stay on their own assistant (ChatGPT,
Claude, Grok, Muse). Safe before users, then the Bruno test. The active list of 20 is the
only promoted work; everything else in the icebox stays there until promoted. **ToRivers is
a partner's system, not ours to prune or redirect.**

Sources: `board-to-linear-20261111/active.md`, `survey-grid-lane-e-paperclip-20261110.md`.

## Release truth (tags exist; `main` did not wait)

- `package.json` and `src/version.ts` (`MUPOT_PUBLIC_API_VERSION`) read **`0.31.0`** on
  `main`.
- Newest semver tag: **`v0.31.0`** (annotated, `52299bab`, 2026-09-28). Prior tag:
  **`v0.30.0`** (`09ea48f6`, 2026-09-26). Also present: `v0.25.0`, `v0.30.0-rc.1`.
- **434** commits on `main` after `v0.31.0` as of this refresh (`git rev-list --count
  v0.31.0..origin/main`).
- Whether production runs a tagged commit is **unverified here** — read `/health`.

Do not schedule a retrospective `v0.30.0` stabilization train or a quiet `main` freeze; tags
already name stable cuts while defect flow continued on `main`.

## Now (this week)

- **Attached-seat authority, stage 1.** GitHub `#2430` is open: Helper/Full choice and
  expiry on the existing claim page (task `980005ac`). The human chooses. Harness, model,
  and directory name do not. Full is the agent's own authority capped at the confirming
  human's rank, for 7 days unless the human picks shorter. Money, keys, publish, and
  deletes stay behind their present gates. Do not add rows to `ATTACHED_SUDO_ACTIONS` one at
  a time. Stage 1 also includes the readable Connections list from `a1deab2a`. Receipt:
  `attached-seat-authority-stage1-excerpt-20261115.md`. **Hadi already decided the two
  levels and the still-refused list.**
- **Wake path, the part still open.** The 401-retry install is recorded in
  `install-seatlink-122f5aa3-20261114.md` (retry, alert after repeated auth failure,
  10-minute watchdog). Automatic pane re-find was cut from that install.
  `MUPOT_SEATLINK_ALERT_NOTIFY` is off until Hadi says seatlink alerts on. Task
  `178eab47` still wants a downed runtime to queue or alert, and a pane blocked for more
  than 10 minutes to alert Kasra. **Hadi decides when alerts turn on.**
- **Open P1s from the 14–15 November gate follow-ups.** Still open on GitHub at this read:
  `#2409`, `#2411`, `#2414`, `#2415`, `#2421`, `#2427`. `#2412`, `#2413`, `#2416`,
  `#2417`, `#2422`, `#2425` are merged. `#2414` remaining open after `#2416` merged is a
  tracker mismatch, not a second fix.
- **Loom on Grok ends today, 2026-11-15.** This refresh is that seat's last documentation
  job.

## Next (two to four weeks)

- **Attached seat, stages 2 and 3.** Not in the stage-1 build. Stage 2 is the automatic
  own-host route and self-test (`55d14f2d`: one next step at a time, check-in, then one
  proved wake). Stage 3 is Telegram cards for the protected effects. Rollback of stage 1
  keeps prior Helper behaviour.
- **Routines follow-ups.** `#2426` (success ordering, cancel-retry close, scheduler budget,
  unpinned guards, remaining close paths). `#2424` (auto-pause after repeated unclaimed
  runs, deferred from `#2407`). `#2427` (`kpi_progress` writes `agents.updated_at`, which
  the issue says does not exist, and the error is swallowed). `#2425` merged the
  close-only half.
- **Boundary proof.** `#2423`: burn down the 128 tools the proof rule still calls UNPROVEN,
  plus the `#2422` P2s. `#2411` is the parent that `#2422` was meant to close.
- **Route review, not a silent delete.** `web-route-inventory-20261114.md` counts 396
  handlers and flags 59 (35 alias or duplicate mounts, 12 superseded, 9 untested and
  unlinked HTML, 3 catch-alls). Usage is unknown until Cloudflare logs exist. Named
  candidates: `GET /pricing`, `/device*`. Keep the fleet redirects and the retired Inkwell
  gates. **Hadi decides which of the 59 go, after logs or an explicit "cut without logs."**
- **Refusal next step.** `#2415`: the scanner misses shapes, and it is not a required check.
  Active-list item `4213349b` is the same job.
- **Owner path after the shared pot is safe.** Active list: owner acts from their own
  assistant (`a5d090ee`), one command updates every customer pot (`31c11be9`). The
  stranger walk still needs a person with their own Claude or Codex login. **Hadi names
  that person.** This draft did not re-check whether invite-only sign-in is the door they
  would hit.

## Later

- **Split `src/mcp/index.ts` and `src/dashboard/index.ts`.** Both are still the mount
  points in the route inventory (62 `app.route` groups, dashboard shell in
  `dashboard/index.ts`). No open issue in `#2408`–`#2431` schedules the split. Treat the
  split as unnamed work, not as a commitment.
- **One path for flights and the routine scheduler.** `pipeline-map-20261111` records that
  a routine run waiting on an agent or on budget is not re-driven, and the flight watchdog
  fails it only when a flight is bound. A single unified path is unverified as a designed
  change.
- **Memory durability.** Vector writes done in `waitUntil` may drift. Unverified in this
  pass. An older ledger note on `#2085` says a vector-index failure can be swallowed with
  no log. That note is not evidence the November tree still does it.
- **Old numbered promises** (`v0.32` compounding knowledge, `v0.33` commercial operations)
  stay icebox. The version numbers in the September roadmap assumed `0.30.0` was still the
  source version; tags through `v0.31.0` now bound what shipped stable.

## Cut

- The `v0.30.0` ordered freeze table formerly in this file. The work it listed as landed
  stays history in CHANGELOG. It is not the forward queue.
- A retrospective `v0.29.0` tag. The September roadmap already dropped it. Nothing read
  here revives it.
- The old Mumega Linear workspace. Hadi, 2026-11-14: let it lapse (2026-11-17). Mupot rows
  in it are already superseded. Export is Hadi's click if descriptions are wanted. Receipt:
  `linear-mumega-export-20261114.md`.
- Planning a quiet `main` before any further fix. The September measurement still stands as
  history: defect flow outran both freeze attempts. Later tags did not require that quiet
  window.

## Hadi, in one list

1. Stage 1 stays the claim-page choice. No sudo-list widening.
2. Seatlink Telegram alerts: on or still off.
3. Which of the 59 routes are cut, and whether that waits for logs.
4. Who the stranger is for the Bruno walk.
5. Linear export before 2026-11-17, only if descriptions matter. The lapse itself is
   already decided.

## Sources (receipt names only)

`attached-seat-authority-stage1-excerpt-20261115.md`, `web-route-inventory-20261114.md`,
`linear-mumega-export-20261114.md`, `install-seatlink-122f5aa3-20261114.md`,
`deploy-2428-2429-20261115.md`, `board-to-linear-20261111/active.md`,
`survey-grid-lane-e-paperclip-20261110.md`, `pipeline-map-20261111/pipeline-map.md`.
GitHub issues `#2408`–`#2427`, `#2430`, `#2431` as `gh issue view` returned them on
2026-11-15. Deploy receipts named `deploy-*.md` are records of deploys, not a substitute for
`/health`.

## Release history (kept for the release-contract tests)

The blocks below are **historical release metadata** retained so CI release-contract receipts
keep stable anchors. They are not the forward queue above. Read live `/health` for
production; read `git rev-parse origin/main` for the moving preview line — nothing here pins
a current `main` or production commit.

## Current version

| State | Version | Meaning |
|---|---|---|
| Current source version | `0.31.0` | On `main`; preview. Read the commit with `git rev-parse origin/main` — this table does not pin it. Bumped from `0.30.0` in #1604. |
| Current production version | Read live `/health` | Version and deployed SHA move independently of `main` and tags; this roadmap does not pin current production. Historical observations remain in their release evidence records. |
| Last tagged stable release | `v0.31.0` | "Office", annotated tag at `52299bab` (tagged 2026-09-28) with a GitHub Release of the same name. Prior tag: `v0.30.0` (2026-09-26, `release/v0.30.0` at `09ea48f6`). Read the tag, not a SHA copied here as current production. |
| Next stable candidate | `v0.32.0` | "Agents as themselves and governed autonomy" — cut from a single frozen `main` SHA onto `release/v0.32.0`, per the release contract in the v0.32.0 section below. `release/v0.31.0` was never cut, so there is no `v0.31.x` patch path; `main` has moved far past the tag. |
| Following targets | `v0.33.0`, `v0.34.0` | `v0.33.0` "Compounding Project Knowledge"; `v0.34.0` "Distribution and Commercial Operations" (addon/package compatibility, marketplace distribution, and signed distribution receipts). |

### v0.23.0: Trusted Runtime - stable

**Promise:** A self-hosted pot can connect a bound runtime, grant scoped authority, run and
approve work, retain evidence, recover state, and prove the exact release.

Anything merged after the `v0.23.0` tag remains preview until a later release owns it.
Trusted Runtime release detail and evidence live in
[docs/releases/v0.23.0-trusted-runtime.md](docs/releases/v0.23.0-trusted-runtime.md).

Explicitly not in the v0.23-era release definition (historical exclusions, not current
queue): economy features, new departments, full SOS retirement, GCP portability,
autonomous-brain expansion, and marketplace-scale distribution work.

## v0.30.0 stabilization train — ordered (updates by PR only)

> Historical ordered release queue from the September 2026 contract. The forward queue is
> **Now / Next / Later** above; this table is kept as an integrity anchor only.

| Capability | Release state | Activation |
|---|---|---|
| Identity, squads, tasks, gates, flights, receipts | `v0.23.0` | Default-on |
| Console consolidation (project-centered nav) | `preview; post-v0.30 target required` | Default-on only after its own release gate |