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
- ⬜ **A3** `/connect/github` install flow — one-click connect, capture `installation_id` from
  the redirect, write the `github_app` connector automatically (client_secret already saved)
- ⬜ **A4** Connector dashboard surface — GitHub status card, capability snapshot, connect button
- ⬜ **A5** Plan-tier auto-detection — read the tenant's real GitHub plan via API instead of
  manual `GITHUB_PLAN_TIER`

### EPIC B — Work Sync (GitHub ⇄ pot tasks)
- ✅ **B1** Inbound webhook (GitHub events → pot tasks) — exists
- ✅ **B2** Outbound mirror (pot tasks → GitHub issues), now App-first (PR #129)
- 🔨 **B3** Bidirectional status sync (PR merged → task done; issue closed → task done) — harden
- ✅ **B4** App webhook secret (`GITHUB_WEBHOOK_SECRET`) set on the live `mupot` worker
- ⬜ **B5** Issue→task squad routing + label mapping

### EPIC C — Agent Provisioning (the pot AUTHORS GitHub agents)
- ✅ **C1** `writeAgentDef` — write `.github/agents/<name>.agent.md` (PR #131)
- ✅ **C2** `assignIssueToCopilot` — hand an issue to the Copilot coding agent (PR #131)
- ✅ **C3** Admin-gated JSON routes — `GET /admin/github/status`, `POST /admin/github/agent-def`,
  `POST /admin/github/assign-copilot` (isAdmin-gated, JSON so agents call them too)
- ⬜ **C4** Fleet→GitHub sync — each pot agent gets a `.agent.md`, kept in sync with the roster
- ⬜ **C5** Per-agent MCP wiring — `.agent.md` `mcp-servers` → tenant pot MCP endpoint, so the
  GitHub cloud agent reads that pot's bus/memory/tasks
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
- `mupot` worker (TENANT_SLUG=mumega) wired with 4 secrets, keystone + actions deployed.
- Minting verified live; reaches private repos the PAT was enterprise-blocked from.

## Build order (next)

1. **B4** wire webhook secret (trivial, activates verified inbound)
2. **C3** admin routes for writeAgentDef + assignIssueToCopilot + GitHub status (makes the
   hands usable from the dashboard)
3. **A3** `/connect/github` install callback (one-click connect)
4. **D1** stitch the end-to-end execution loop
5. **C4/C5** fleet→GitHub sync + per-agent MCP wiring (the network effect)
