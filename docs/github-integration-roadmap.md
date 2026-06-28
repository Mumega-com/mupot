# mupot ↔ GitHub — Full Goal & Objective Map

## North star

**Every mupot tenant connects their GitHub org in one click, and their pot gains a complete
GitHub-native agent workforce.** Issues become pot tasks; the pot assigns work to Copilot
coding agents *and* its own `.agent.md` agents; execution runs on GitHub's free runners;
everything is scoped per-tenant, governed by the pot, with nothing Enterprise *required* but
everything Enterprise *supported and killable*.

This serves the Mumega thesis: **the pot is the brain; GitHub is one of its bodies.** The pot
orchestrates, GitHub executes, the human stays in the review loop (PRs). We get a second agent
fleet that costs us nothing per-seat and reports back into the pot.

## Why it matters

- Most businesses already have GitHub → near-zero onboarding friction for an execution surface.
- Copilot coding agent = autonomous code execution on GitHub's infra, billed to the tenant's
  plan, not to us. The pot becomes a force multiplier without us provisioning compute.
- GitHub provides identity, RBAC, audit, and review gates for free — the sovereign-core
  principle (AuthZ ours, AuthN delegated) applied to a real external surface.

---

## The map — 6 epics

Legend: ✅ shipped · 🔨 in progress · ⬜ planned · 🏢 Enterprise-tagged (killable)

### EPIC A — Identity & Connection (the pot IS an actor on GitHub)
- ✅ **A1** App installation-token minting (PR #129)
- ✅ **A2** Capability tiers + Enterprise kill switch (PR #130)
- ✅ **A3** `/connect/github` one-click install flow — `GET /admin/github/connect` (CSRF state →
  redirect to App install) + `GET /connect/github/callback` (verify single-use tenant-bound
  state → capture `installation_id` → `github_installations` per-tenant). Multi-tenant model:
  shared App key on the platform, per-tenant install id. (migration 0025)
- ✅ **A4** Dashboard surface — `GET /admin/github` HTML card: connection state, capability table,
  connect button, fleet-sync form (dry-run + live). Nav link added.
- ⬜ **A5** Plan-tier auto-detection — read the tenant's real GitHub plan via API instead of
  manual `GITHUB_PLAN_TIER`

### EPIC B — Work Sync (GitHub ⇄ pot tasks)
- ✅ **B1** Inbound webhook *handler* (GitHub events → pot tasks) — `POST /api/integrations/github`
  (`src/integrations/github-routes.ts`), HMAC-verified. **Handler exists; delivery is per-repo
  classic webhooks — see B6.** (Originally marked ✅ "exists" but no webhook ever pointed at it.)
- ✅ **B2** Outbound mirror (pot tasks → GitHub issues), now App-first (PR #129)
- ✅ **B3** Bidirectional status sync — an `issues` close/reopen webhook flips the mirrored
  pot task (closed→done, reopened→open) via `syncTaskStatusFromIssue`; no mirror-back (no
  feedback loop), never clobbers review/approved/rejected gate states. **Code-ready; not active
  until an `issues`-subscribed webhook is wired (current webhooks are `pull_request`-only).**
- ✅ **B4** App webhook secret (`GITHUB_WEBHOOK_SECRET`) set on the live `mupot` worker
- ✅ **B6** Inbound delivery wired (2026-06-27) — **per-repo classic webhooks**, NOT the App
  webhook. The Mumega "mupot" App is **token-mint only**; its webhook is intentionally left
  unset (`GET /app/hook/config` url=None, events=[]) because an **org-wide App firehose into a
  single-tenant pot is wrong** — all 33 repos would flood this pot and inflate the KPI (the
  `github_prs` COUNT is `tenant_id`-scoped, not repo-scoped). Instead, scoped `pull_request`
  webhooks on the 3 pillar repos this squad ships: **Mumega-com/mupot (646865323) ·
  Mumega-com/sos (647355020) · Mumega-com/mumega-com (647355036)** → the same endpoint, same
  secret; each verified by ping → 200. Feeds the S4b `github_prs` KPI = real squad velocity.
- ⬜ **B5** Issue→task squad routing + label mapping
- ⬜ **B7** Repo-scope the `github_prs` KPI (the `repo` column is already stored) IF a future
  pot needs per-repo velocity instead of the tenant-wide aggregate.

### EPIC C — Agent Provisioning (the pot AUTHORS GitHub agents)
- ✅ **C1** `writeAgentDef` — write `.github/agents/<name>.agent.md` (PR #131)
- ✅ **C2** `assignIssueToCopilot` — hand an issue to the Copilot coding agent (PR #131)
- ✅ **C3** Admin-gated JSON routes — `GET /admin/github/status`, `POST /admin/github/agent-def`,
  `POST /admin/github/assign-copilot` (isAdmin-gated, JSON so agents call them too)
- ✅ **C4** Fleet→GitHub sync — `syncFleetToGitHub` writes a `.agent.md` per active agent
  (dry-run preview + live write via gated writeAgentDef); `POST /admin/github/sync-fleet`
- ✅ **C5** Per-agent MCP wiring — each generated `.agent.md` wires `mcp-servers.mupot` at this
  pot's MCP endpoint (`/mcp`), token `${COPILOT_MCP_MUPOT_TOKEN}`, so the GitHub cloud agent
  reads the pot's own bus/memory/tasks
- ⬜ **C6** Role templates (build / review / coordinate) generated from the pot's agent defs

### EPIC D — Execution Loop (the payoff: autonomous work)
- ⬜ **D1** End-to-end: pot task → assign Copilot → PR opened → review gate → merge
- ⬜ **D2** Pot review agent (kasra-review style) reviews the agent's PR before the human
- ⬜ **D3** CI status → pot task status feedback (workflow_run → task update)
- 🏢 **D4** Org MCP allowlist enforcement — lock GitHub cloud agents to the pot's MCP only

### EPIC E — Governance & Safety
- 🏢 **E1** Audit-log streaming (Enterprise)
- 🏢 **E2** Org MCP server allowlist (Enterprise)
- 🏢 **E3** SAML SSO enforcement (Enterprise)
- ⬜ **E4** Token scoping + revocation flow (rotate/revoke the install, kill switch per feature)
- ⬜ **E5** Adversarial review gate on agent-authored PRs (no agent PR merges unreviewed)

### EPIC F — Productization (every tenant, one click)
- 🔨 **F1** "Connect GitHub" step in the onboarding wizard
- ✅ **F2** Positioning content — GitHub-as-agent-substrate blog (mumega.com) + this doc
- ⬜ **F3** Multi-tenant publisher flow — other orgs install the shared mupot App
- ⬜ **F4** Plan-tier UX — show each tenant what their plan unlocks

---

## Current live state (Mumega tenant #0)

- App "mupot" (ID 4041094) installed on Mumega-com, all 33 repos, full write perms.
  **Token-mint only — App webhook deliberately unconfigured** (see B6).
- `mupot` worker (TENANT_SLUG=mumega) wired with secrets, keystone + actions deployed.
- Minting verified live; reaches private repos the PAT was enterprise-blocked from.
- **Inbound delivery (2026-06-27): per-repo `pull_request` webhooks on mupot · sos · mumega-com,
  feeding the live S4b `github_prs` KPI** (`kpi_target='10 [github_prs]'` on the Kasra agent).

## Note for multi-tenant (when other orgs connect)

A *tenant's own* org App install MAY use the App-level webhook (one org → one pot = no
cross-tenant flood). The "no org firehose" rule is specific to **our single shared App also
serving tenant #0**. For tenant pots, prefer the per-repo or per-tenant-org webhook so each
pot only sees its own org's events. If the App webhook is ever turned on, repo-scope the KPI
first (B7) and gate the issue→task fan-out (B5).

## Build order (next)

1. **C3** admin routes for writeAgentDef + assignIssueToCopilot + GitHub status (makes the
   hands usable from the dashboard)
2. **A3** `/connect/github` install callback (one-click connect)
3. **D1** stitch the end-to-end execution loop
4. **C4/C5** fleet→GitHub sync + per-agent MCP wiring (the network effect)
