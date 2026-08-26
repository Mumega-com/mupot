# Visual UI/UX & Browser Inspection Audit — 2026-08-26

**Auditor:** hadi-grok-desktop (Visual QA Inspector & Flight Captain)  
**Production:** `https://mupot.mumega.com`  
**Production stamp:** `GET /health` → `version 0.30.0`, `commit 702593d24e273dd498c47dc2e5c9d6af4959a861`, `clean: false`, `ref: main`, `built_at: 2026-08-26T12:28:19.797Z`  
**Local checkout audited:** same SHA after fast-forward onto `origin/main`  
**Method:** live HTTP probes + source walkthrough of every listed surface + rendered HTML fixtures + targeted Vitest. Authenticated production clicks were blocked by Google OAuth (`GET /auth/login` → accounts.google.com). No credentials were invented.

Overall visual verdict: **WARN** — the five recent surfaces exist and are structurally sound, but several operator-facing polish bugs made the experience miss “mission-grade.” This PR lands the high-confidence fixes. Remaining gaps are auth-gated live SSE, stale Co-Pilot unit tests on main, and product-copy mismatches vs the brief.

---

## How this audit was run

| Check | Result |
|---|---|
| `GET /health` | **200** JSON, commit `702593d` |
| `GET /`, `/copilot`, `/flights`, `/projects`, `/verifications` | **302** → `/auth/login` |
| `GET /auth/login` | **302** → Google OAuth (`prompt=select_account`) |
| Unauthenticated console / network | No 5xx. Auth wall is the only 3xx. |
| Local fixtures | Rendered from the same view functions production uses (`reports/visual-audit-fixtures/`) |
| Unit tests added/updated | `tests/visual-ui-polish.test.ts` plus pins in flights / Athena / sandbox tests |

---

## Surface verdicts

### A. Co-Pilot Hub & Drawer — **WARN** (polish landed)

**Shipped surface:** `GET /copilot` + `#mupot-copilot-drawer` on every `shell()` page. `<deep-chat>` from `deep-chat@2.1.1` (unpkg ESM). Persona `<select>` for `@copilot`, `@loom`, `@kasra`, `@athena`, `@cursor-architect`, `@cursor-builder`. Voice (`speechToText` / `textToSpeech` webSpeech) and images (`maxNumberOfFiles: 3`) are wired.

**Verified in source / fixtures**

- Input box, send, microphone, and image affordances come from Deep Chat (`src/dashboard/copilot.ts` `DEEP_CHAT_IMAGES` / `DEEP_CHAT_SPEECH`).
- Persona select updates avatar letter + color and `X-Mupot-Recipient`.
- SSE stream is `text/event-stream` via `POST /api/studio/chat`.
- Full page hides the FAB (`body.copilot-fullpage`).

**Defects found**

| ID | Severity | Flaw | Where |
|---|---|---|---|
| A1 | FAIL | `[data-copilot-open]` / `Ask Co-Pilot` on the flight deck was dead — bootstrap never bound it. Tests on main still expect `window.mupotOpenCopilot`. | `src/dashboard/copilot.ts` bootstrap (was missing); `src/dashboard/flights-deck.ts:715` |
| A2 | WARN | Escape always called `setDrawerOpen(false)`, even when a `.modal` was open or the drawer was already closed. | copilot bootstrap keydown |
| A3 | WARN | Drawer `deep-chat` had `min-height: 420px` inside a `100vh` column — overflows landscape / short phones. | `copilot.ts` `COPILOT_CSS` |
| A4 | WARN | Drawer head is `1fr auto auto`. At 375px the 220px select + 34px close + title crush. No mobile CSS. | `COPILOT_CSS` `.mupot-copilot-drawer-head` |
| A5 | WARN | FAB label “Co-Pilot” + icon is wide on a 375px viewport and sits on top of page content. | `.mupot-copilot-fab` |
| A6 | FAIL (pre-existing) | `tests/copilot-drawer.test.ts` and `tests/copilot-recipient-routing.test.ts` still describe the **pre–Deep Chat** chrome (`#mupot-copilot-launcher`, `#mupot-copilot-page-input`, `copilotRoleBadge`, `copilotSseResponse`). They fail against shipped code. | tests vs `src/dashboard/copilot.ts` |

**Browser fixture (1200 / 375):** persona select, intro bubble, image + send + mic icons all render. Mic sits just outside the input (Deep Chat default). Full-page FAB still paints on the fixture URL (`/copilot.html`); production `/copilot` hides it via `body.copilot-fullpage`.

**Console (fixture + will fire on prod):** Deep Chat 2.1.1 logged `The request property is deprecated` / `The stream property has been moved to the connect object` on every chat host. Fixed in this PR by switching to `connect`.

**Could not verify live:** typing a message, SSE tokens, and markdown copy buttons — all require a dashboard session.

**Fixes in this PR:** wire `window.mupotOpenCopilot` + `[data-copilot-open]`; Escape only closes an open drawer and yields to `.modal`; drawer chat `min-height: 0`; 720px breakpoint stacks the header, full-width select, and icon-only FAB.

---

### B. Flight Operations Deck — **WARN** (polish landed)

**Shipped surface:** `GET /flights` → `flightsBody()` in `src/dashboard/flights-deck.ts`.

**Verified**

- KPI cards: Total Flights, Active In-Flight (`.fd-radar` pulse when `kpis.active > 0`), Landed / Merged, PR Landing Rate %.
- Filter tabs: All / 🟢 Flying / 🏁 Landed / ⏸️ Held / ❌ Failed with live counts.
- Instant search `#fd-search` filters `data-fd-search`.
- Pipeline: `Plan ➔ Sandbox ➔ Tests ➔ Gate ➔ PR ➔ Deploy` (`.fd-pipe`).
- Artifact buttons: `🌐 View PR`, `☁️ Cloud Sandbox`, `📄 Receipt` — only when `flights.meta` actually declared the URL (`extractFlightArtifacts`).

**Defects found**

| ID | Severity | Flaw | Where |
|---|---|---|---|
| B1 | WARN | Brief asked for **Vitest**; shipped label is **Tests**. Honest product copy, but not the requested badge string. | `FLIGHT_PIPELINE_STAGES` line 15 |
| B2 | WARN | KPI labels differ from the brief: “Active In-Flight” / “Landed / Merged” / “PR Landing Rate” vs “Active Flying” / “Landed” / “Success Rate %”. | `flightsBody` KPI block ~644–666 |
| B3 | FAIL | Pipeline column was `display: none` below 900px — a 13" laptop and every phone lost the stage badges. Horizontal scroll already exists on `.fd-board`. | `DECK_CSS` `@media (max-width: 900px)` |
| B4 | WARN | Dispatch drawer had no Escape handler. | `DECK_SCRIPT` |
| B5 | WARN | Dispatch z-index 41 sat **under** the Co-Pilot FAB (86). | `.fd-dispatch` |
| B6 | FAIL | Ask Co-Pilot button was unwired (A1). | line 715 |

**Fixes in this PR:** keep the pipeline visible (board already scrolls); Escape closes dispatch unless a modal is open; raise dispatch overlay to z-index 88/89.

---

### C. Project Worker Platform & 1-Click Provisioner — **WARN** (polish landed)

**Shipped surface:** `GET /projects` — worker cards + `[ + New Project Worker ]` modal (`newProjectWorkerModal()` in `src/dashboard/projects.ts`).

**Verified**

- Modal fields: Project Name, auto-slug, GitHub Repository URL, Template (`Custom Repo` / `Next.js / Vite` / `Cloudflare Worker Hono` / `Static Astro`), Worker Name, subdomain preview `https://<slug>.mupot.mumega.com`, Squad Assignment.
- Close: backdrop click and Cancel were wired; **Escape was not**.
- Cards: name, `🟢 Healthy` / Deploying / Failed / Idle, repo badge, live URL, squad, recent flights/PRs, `[ 🚀 Dispatch Feature Flight ]`.

**Defects found**

| ID | Severity | Flaw | Where |
|---|---|---|---|
| C1 | FAIL | `.modal` z-index was **20**. Co-Pilot FAB is 86 and drawer is 91 — the FAB floated on top of the provisioner dialog. | `src/dashboard/index.ts` `.modal` |
| C2 | FAIL | Escape did not close the provisioner modal (brief required it). | `projects.ts` modal script |
| C3 | WARN | `.modal-card` had no `max-height` / overflow — the form clips on 375×667. | `.modal-card` |
| C4 | INFO | “Create project” full-page form still sits next to the 1-click button — two create paths. Not broken, slightly noisy. | `projectsControls` |

**Fixes in this PR:** modal `z-index: 110`, card `max-height: calc(100vh - 40px); overflow-y: auto`, Escape closes the provisioner.

---

### D. Split-Screen Interactive Sandbox Studio — **WARN** (polish landed)

**Shipped surface:** project detail (`/projects/:id`), not `/studio`. Left: live preview iframe (`/preview/:id/`). Right: embedded `<deep-chat>` + Quick Prompts + flight/deploy stream + Code/Logs.

**Verified**

- Viewport toggles existed (Desktop / Tablet / Mobile) but had **no pressed style** — `aria-pressed` only.
- Tablet = `48rem` (768px). Mobile was `24.375rem` (**390px**), not the requested **375px**.
- Refresh existed, labelled “Refresh” not “Refresh Preview”.
- **No External Link** control.
- Quick Prompts: `Add contact form`, `Fix navbar layout`, `Audit SEO tags`.
- `/studio` is a separate dark canvas whose mobile frame is still 390px and has no Deep Chat, no refresh, no external link, no quick prompts.

**Defects found**

| ID | Severity | Flaw | Where |
|---|---|---|---|
| D1 | FAIL | Active viewport looked identical to idle — no `[aria-pressed="true"]` CSS. | `src/platform/routes.ts` style block |
| D2 | WARN | Mobile iframe was 390px (`24.375rem`) vs specified 375px. | same |
| D3 | WARN | Missing ↗ external-link control. | preview toolbar |
| D4 | INFO | Viewport labels lacked the 🖥️ 📟 📱 icons the brief named. | `VIEWPORTS` |
| D5 | INFO | `/studio` and `/projects/:id` are two different “studios.” Operators can land in the wrong one from Dispatch Feature Flight (`/studio?repo=`). | `studioDispatchPath` |

**Browser fixture:** iframe measured **375px** after Mobile toggle (PASS). Tablet toggle is a no-op when the left pane is already < 768px (measured 516px) — a size chip now states `Tablet · 768px` so it is not a silent miss. Preview iframe 404s on the static fixture (`/preview/project-worker-alpha/`); production would hit the platform dispatcher. Routines band showed `undefined enabled` on an incomplete fixture situation — `situationCount` now coerces missing numbers to `0`.

**Fixes in this PR:** pressed-state CSS; mobile `23.4375rem` (375px); `Refresh Preview`; ↗ external link; emoji viewport labels; viewport size chip; Deep Chat `connect` object.

---

### E. Athena Gate Receipts Deck — **WARN** (polish landed)

**Shipped surface:** `GET /verifications` composes `verificationsBody(items)` + `athenaGateReceiptsBody(receipts)`. Receipts persist from `POST /api/webhooks/github` (`migrations/0130_athena_gate_receipts.sql`).

**Verified**

- Task-verdict table: TASK / VERDICT (`approved`/`rejected`) / DECIDED BY / WHEN / NOTE.
- Athena panel: PR (`repo` + `#n @ sha7`) / VERDICT (`APPROVED`/`BLOCKED`/`CHANGES_REQUESTED`) / SUMMARY / WHEN.
- Empty Athena copy: “No Athena PR gate audits yet…”

**Defects found**

| ID | Severity | Flaw | Where |
|---|---|---|---|
| E1 | FAIL | `checks_json` was stored but **never rendered**. Brief required check badges. | `athenaGateReceiptsBody` |
| E2 | WARN | If there are zero task verdicts, the page still leads with a full empty-state card *above* a possibly-populated Athena table. | `verificationsBody` early return |
| E3 | INFO | Title is “Athena PR gate audits”, not “Athena Gate Receipts Deck.” Fine. | section title |

**Fixes in this PR:** CHECKS column with `✓`/`✗` pills from `parseAthenaGateChecks()`.

---

## Console / network catalog

### Production (unauthenticated)

| URL | Status | Notes |
|---|---|---|
| `GET /health` | 200 | Honest dirty-tree stamp (`clean: false`) |
| `GET /copilot` `/flights` `/projects` `/verifications` `/` | 302 | `/auth/login` |
| `GET /auth/login` | 302 | Google OAuth |

No 4xx/5xx on those probes. Authenticated XHR (`POST /api/studio/chat`, `/api/projects`, `/api/studio/dispatch`, live polling) was **not** exercised on production.

### Fixture browser (headless Chrome, 1200 / 375)

| Check | Result |
|---|---|
| New Project Worker auto-slug | `https://acme-storefront.mupot.mumega.com` after typing “Acme Storefront” |
| Modal Escape | closed |
| Dispatch Escape | closed |
| Sandbox Mobile iframe | **375px** |
| Sandbox Tablet iframe | 516px (pane-capped; max-width 768px) |
| Athena CHECKS | ✓ secrets/tests/RBAC/schema and ✗ secrets on BLOCKED row |
| Deep Chat console | `request`/`stream` deprecation — **fixed** via `connect` |
| Fixture-only 404s | `/auth/me`, `/approvals` (shell chrome); `/preview/:id/` (no dispatcher in static file) |

### Known remaining client risk

- Deep Chat still loads from unpkg. A CDN blip becomes a blank chat host.
- Flight deck poll (`12s`) does a full HTML refetch and `replaceWith` on `#fd-kpis` / `#fd-board` — can reset scroll and steal focus while typing in search.
- Deep Chat intro names the model “AI” even after `chat.names` is set — component default, not our CSS.

---

## Immediate polish still open (not in this PR)

1. **Rewrite stale Co-Pilot tests** (`tests/copilot-drawer.test.ts`, `tests/copilot-recipient-routing.test.ts`) to the Deep Chat surface. They fail on `main` today. Out of scope for a visual pass; called out as a CI honesty defect.
2. **Authenticated production SSE / modal / filter walkthrough** once a dashboard session exists on this host.
3. **Align `/studio` mobile frame to 375px** and decide whether Dispatch Feature Flight should open the project sandbox instead of `/studio`.
4. **Pipeline copy:** Tests vs Vitest; KPI “Success Rate %” vs “PR Landing Rate” — product call, not a CSS bug.
5. **`clean: false` on the live health stamp** — deploy wrapper refused a dirty tree in AGENTS.md; production currently reports dirty.

---

## Fixes landed in this PR

| Surface | Change |
|---|---|
| Co-Pilot | Open wiring, modal-aware Escape, drawer min-height, 375px header/FAB |
| Shell | Modal z-index 110 + scrollable card |
| Flights | Pipeline stays visible; Escape; overlay above FAB |
| Projects | Escape on provisioner modal |
| Sandbox | Pressed viewport, 375px mobile, Refresh Preview, external link, emoji labels |
| Athena | Check-badge column |
| Tests | `tests/visual-ui-polish.test.ts` + updated pins |

Verified locally: `vitest run tests/visual-ui-polish.test.ts tests/flights-deck.test.ts tests/athena-github-webhook.test.ts` → **36 passed**.

---

## Line index (post-fix)

- Co-Pilot chrome: `src/dashboard/copilot.ts` (`COPILOT_CSS`, bootstrap `window.mupotOpenCopilot`)
- Modal stack: `src/dashboard/index.ts` `.modal` / `.modal-card`
- Flight deck: `src/dashboard/flights-deck.ts` `DECK_CSS`, `DECK_SCRIPT`
- Provisioner modal: `src/dashboard/projects.ts` `newProjectWorkerModal()`
- Sandbox: `src/platform/routes.ts` `SANDBOX_VIEWPORTS`, `SANDBOX_MOBILE_MAX_WIDTH`
- Athena badges: `src/dashboard/verifications.ts` `parseAthenaGateChecks`, `athenaGateReceiptsBody`
