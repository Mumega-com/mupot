# Console Reskin — "Mupot Console (Light)" implementation plan

Status: **plan, pending Codex acceptance** · 2026-06-18 · branch `feat/console-reskin-light`
Source design: claude.ai/design project `Mupot design system suggestion` → `Mupot Console (Light).dc.html`.

## 0. Key finding (de-risks the whole effort)

The design's tokens **already match the live console**: `--bg #f6f7f6`, `--surface #fff`, `--primary
#0e7a55`, `--text #171b19`, fonts Instrument Serif / Hanken Grotesk / JetBrains Mono — byte-identical
to `src/dashboard/index.ts` shell `:root`. Light+dark toggle already shipped (#195). So this is **layout
+ component + IA work, NOT re-theming.** No token churn, no theme regression risk.

## 1. Architecture

The console is server-rendered HTML strings (Hono `html`/`raw`), one module-private `shell(brand,
title, body)` at `index.ts:1428` (sidebar + topbar + the single inline `<style>`), and ~16 body
functions returning `HtmlEscapedString`. No build step, no React, no Tailwind.

**Approach — extract a component layer, reskin against it:**

1. **`src/dashboard/ui.ts` (NEW)** — pure design-system primitives returning `HtmlEscapedString`, the
   reusable pieces from the mock: `pageHeader`, `statCard` + `kpiRow`, `sectionPanel`, `dataTable`
   (mono headers, hover rows), `pill`/`badge`, `statusDot`, `gateModal` (the approval surface:
   `.gopt`/`.gconfirm`/`.gnote`/`.grange`), `emptyState` (honest "not connected"). Tokens stay in
   `shell()`; ui.ts only consumes the existing CSS vars. **No new authority, no data access — pure
   presentation.** Adding a class never adds a route or a query.

2. **`shell()` upgrade** — the global frame, done once, every page inherits it:
   - Sidebar IA to match the mock exactly: groups **Organization** (Departments/Squads/Agents) ·
     **Work** (Tasks/Pull requests/Verifications) · Approvals · Fleet · Loops · **Economy**
     (Wallet/Marketplace/Billing) · Members & access · Audit · **SOVEREIGNTY** divider ·
     Deployment/Directory/Keys. Pot switcher (header) + account menu (footer). Routes map to the
     EXISTING handlers per the inventory (e.g. Tasks→`/send`, PRs→`/flights`, Audit→`/brain`).
   - Topbar: breadcrumb + regime indicator (C(t)) + "YOUR CLOUD · CF" badge + range selector + Invite.
     Regime/C(t) read from the existing brain physics snapshot; honest "—" when absent.

3. **Per-surface reskin** — each body function rebuilt with ui.ts primitives, same data it already
   loads. No data-layer change for the "reskin only" surfaces.

## 2. Scope, triaged by current build-state (from the inventory)

**Reskin only (data already wired — just apply the new layout):**
Home/Observatory · Approvals (**The Gate** — the showcase, full gate-modal flow) · Agents
(`/agents` + `/agents/:id`) · Departments (`/admin/divisions` + `/departments/growth`) · Squads ·
Economy CC-spend (`/economy`) · Members (`/members` + `/admin/members`) · Loops · Fleet · Keys ·
Directory · Flights (PRs) · Wizard (light pass).

**Wire (cheap — table exists, no view):**
- **Verifications** → list `task_verdicts` (latest verdict per task, approved/rejected + decider +
  time) — new read in `src/dashboard/` + a body. Reuses the verdict store S4 just hardened.
- **Audit** → real audit trail over `connector_audit` (0023) + gate/verdict events, as a dedicated
  view (today `/brain` is physics, not an audit log). Read-only.
- **Billing** → render the tier from `org_settings.billing_state` (exists, no view today).

**Honest-empty (greenfield model — render the design layout + a truthful "not yet connected" state,
NO fabricated data):** Wallet · Marketplace · post-onboarding Deployment management · dynamic
multi-pot list in the switcher (today links out to mumega.com). These get the real chrome and an
`emptyState`, never invented balances/listings (no-fake-green applies to UI too).

## 3. Staging (one PR, committed in reviewable slices)

- **A. Foundation:** `ui.ts` primitives + `shell()` IA/topbar upgrade. Global frame.
- **B. Showcase surfaces:** Home · The Gate · Agents · Economy.
- **C. Remaining reskins:** Departments · Members · Loops · Fleet · Keys · Directory · Squads · Flights · Wizard.
- **D. New wires:** Verifications · Audit · Billing.
- **E. Honest-empty:** Wallet · Marketplace · Deployment · pot-list.

Build is **core-sequenced** (the bodies live in one `index.ts` — parallel arms would conflict);
isolated NEW files (ui.ts, the 3 new wired reads) may be drafted by `kasra-code` arms. Arms build on
branch only — never merge/deploy.

## 4. Invariants (gated on the implementation)

1. **No fabricated data** — every surface shows real data or an honest empty/"not connected" state.
   No placeholder balances, fake listings, mock audit rows.
2. **No new authority at the UI layer** — ui.ts is pure presentation; reskins call the SAME
   data/RBAC/tenant-guard paths. No route loses its `requireAuth` + `tenant === TENANT_SLUG` guard.
3. **The Gate honesty** — the approval modal posts to the EXISTING verdict route
   (`POST /api/tasks/:id/verdict`, RBAC-gated); the UI never approves client-side. Untrusted input
   wakes, never steers (the gate copy states this; the code enforces it).
4. **No secret exposure** — Keys/Connectors keep show-once/paste-only; never render stored secrets.
5. **Theme integrity** — light + dark both pass; tokens unchanged; no hardcoded colors (use vars).
6. **Diverse-gate** — Opus + Codex on the implementation; GREEN both → merge under the dual-GREEN
   delegation (Hadi 2026-06-18). Arms never merge/deploy.

## 4b. Codex acceptance conditions (BINDING — gated on implementation, 2026-06-18)

Codex ACCEPTED the architecture WITH CONDITIONS. All fold into the build:

1. **ui.ts purity enforceable** — no env/DB/fetch/auth imports, no route construction, no mutation
   helpers. Accepts already-loaded values only. Primitives escape string inputs (or accept
   `HtmlEscapedString` only where the caller already escaped). **No `raw()` around untrusted strings.**
2. **shell/topbar is not a hidden data layer** — C(t)/regime comes in as a small OPTIONAL topbar model
   passed into `shell()`, fail-soft to "—". No DB/KV reads inside generic presentation helpers.
3. **New wired reads declare explicit visibility** — not just the tenant guard:
   - **Verifications**: same task/approval visibility semantics (do NOT raw-list all `task_verdicts`
     to every member); admin-or-approval-scoped.
   - **Audit**: admin/owner by default (unless a documented narrower safe subset).
   - **Billing tier**: may be broader, but NO billing secrets/events.
4. **Audit gets its own `/audit` read-only route** — `/brain` STAYS Sovereignty/physics. (Supersedes
   the §1 "Audit→/brain" mapping: the sidebar Audit item points to the new `/audit`.)
5. **The Gate modal write path** — only `POST /api/tasks/:id/verdict`, same-origin credentialed. No
   client-side approve state is truth; optimistic UI is display-only and must revert/show endpoint errors.
6. **Honest-empty = visibly unavailable/not-connected** — never "coming soon" with fake KPIs. No mock
   wallet balances, listings, deployment state, or pot inventory.
7. **No secret-exposure regression** — Keys/Connectors keep list-safe/show-once; no
   `encrypted_secret`/raw-secret/hint resurrection in shared table primitives.
8. **Token/theme discipline literal** — CSS vars only for colors; light+dark smoke; no hardcoded
   one-off colors in bodies.

## 5. Out of scope tonight (explicit, not silently dropped)
Real Wallet/Marketplace economic models (ledger, listings, escrow) — these are product surfaces, not
a reskin; tonight they get honest-empty chrome. Flagged for a follow-up epic.
