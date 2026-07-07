# Mupot control-plane roadmap

## Goal

Mupot is a self-hosted agent control plane for running trusted AI workers,
workflows, and integrations on Cloudflare.

In practical terms, a team should be able to install one pot, connect agents
such as Hermes, Codex, Claude Code, or a custom runtime, grant scoped
capabilities, observe their work, and let them operate against real tools with
approval gates and an audit trail.

The product is not trying to be another chat UI or model wrapper. It is the
governed operating layer around agent work:

- who the worker is
- what runtime currently carries it
- what it is allowed to do
- what context and tools it can access
- what needs approval
- what changed
- what failed
- who owns the next step

## Product Requirements

Mupot is on track only when these requirements become visibly true in the repo
and the running product.

| Requirement | What must be true | Current evidence |
|---|---|---|
| Self-hosted install | A new operator can deploy a pot into their own Cloudflare account and keep data in their account. | `docs/SELF-HOST.md`, `scripts/setup.sh`, `wrangler.example.toml` |
| Agent identity | Each agent has a durable identity separate from its runtime shell. | `docs/agent-running-on-mupot.md`, `fleet_agents`, `agent_keys`, member/capability tests |
| Runtime adapters | Hermes, Codex, Claude Code, and custom workers can attach through a stable contract. | `docs/runtime-adapter-contract.md`, `docs/runtime-adapter-v1.json`, `connectors/`, signed attach flow |
| Scoped authority | Every sensitive action is guarded by role and capability checks. | `docs/security-model.md`, `src/auth/`, `tests/*capability*`, `tests/*gate*` |
| Work lifecycle | Work has a predictable state path from request to claim to result to verification. | task, gate, loop, workflow, and GitHub integration tests |
| Approval gates | Customer-facing or high-risk actions wait for accountable approval. | `/approvals`, gated loops, gate protocol docs |
| Observability | Operators can see agent liveness, tasks, gates, errors, and audit events. | dashboard modules, fleet presence, audit routes |
| Browser confidence | Core dashboard and Hermes flows are exercised in a local browser harness. | `scripts/local-browser-smoke.mjs` |
| Commercial boundary | Non-commercial source availability is clear, and commercial use has a separate path. | `LICENSE`, README license section |

## Roadmap

### Phase 1: Trust the Core

Goal: make the current substrate reliable enough that an operator can believe
what it reports.

- Keep dependency alerts at zero on `main`.
- Preserve typecheck, unit tests, migration checks, browser smoke tests, and
  GitHub Actions as merge gates.
- Keep the security model documentation current for workspaces, member tokens,
  agent keys, role presets, capabilities, webhooks, and approval gates.
- Make Hermes behavior explicit: payload format, authentication, task creation,
  retry/idempotency rules, and failure states.
- Promote local browser smoke testing from a developer helper into documented
  release evidence.

Exit criteria:

- `npm audit` is clean on `main`.
- A fresh clone can run the local browser harness from documented steps.
- The agent/security docs explain every trust boundary used by the dashboard,
  MCP endpoint, IM routes, webhooks, and fleet runtime.

### Phase 2: Make It Usable

Goal: make the dashboard operate like a real control console instead of a set
of disconnected admin pages.

- Add a first-run path that ends with a working owner login, connected runtime,
  and a visible test task.
- Show health for agents, webhooks, integrations, queues, migrations, and cron.
- Add admin views for role/capability grants, active runtime bindings, recent
  gates, and audit events.
- Replace ambiguous failures with operator-readable reasons and next actions.
- Expand browser tests to cover login, navigation, forms, RBAC-gated views,
  webhook-triggered updates, and approval flows.

Exit criteria:

- An operator can manage agents and approvals from the UI without touching SQL.
- Browser tests cover the primary operator workflow from login through a
  verified agent result.

### Phase 3: Stabilize the Agent Platform

Goal: make adding a new worker boring and predictable.

- Freeze an agent runtime adapter contract. The current documented contract is
  `runtime-adapter/v1` in `docs/runtime-adapter-contract.md`.
- Standardize agent message envelopes, task lifecycle states, result receipts,
  retries, idempotency keys, and error codes.
- Add conformance tests for runtime adapters and webhooks.
- Add templates for common worker roles: builder, reviewer, operator, brain,
  channel worker, and integration worker.
- Make event replay/debug views available for failed or disputed work.

Exit criteria:

- A new runtime can pass conformance tests before being trusted.
- Operators can inspect why an agent did or did not act.

### Phase 4: Harden Production Operations

Goal: make a self-hosted pot safe to operate for serious teams.

- Add a deployment checklist that covers required Cloudflare resources,
  secrets, D1 migrations, OAuth, rollback, backups, and health checks.
- Add backup and restore guidance for D1, R2, and configuration state.
- Add rate limits and abuse protection for public or semi-public endpoints.
- Add structured logs and audit export.
- Document incident response for leaked secrets, compromised runtime hosts,
  failed migrations, broken webhooks, and bad agent output.

Exit criteria:

- A production operator has a runbook for deploy, upgrade, rollback, backup,
  incident response, and audit export.

### Phase 5: Commercialize Without Blurring the License

Goal: keep non-commercial source availability clear while giving serious users
an obvious commercial path.

- Add a commercial licensing contact/process.
- Split docs for non-commercial self-hosting, evaluation, and commercial
  deployment.
- Define enterprise features such as SSO, audit retention, policy controls,
  advanced RBAC, and managed support.
- Keep the public roadmap mapped to GitHub issues and milestones.

Exit criteria:

- Users can tell what is allowed for free, what needs permission, and what
  proof they should expect before trusting the system.

## Near-Term Issue Buckets

These buckets should map to GitHub labels and milestones:

- `security`: trust boundaries, token handling, webhook auth, audit export
- `agent-runtime`: adapter contract, Hermes, Codex, Claude Code, conformance
- `dashboard`: first-run flow, health, admin controls, approval UX
- `self-host`: provisioning, migration, backup, rollback, docs
- `testing`: browser workflows, local smoke harness, adapter conformance
- `docs`: README, operator runbooks, architecture, commercial licensing
- `integrations`: GitHub, GHL, channels, future CRM/content systems

## Definition of Done for the North Star

The goal is achieved only when current evidence proves that a fresh operator can:

1. Deploy Mupot into their own Cloudflare account.
2. Log in as owner.
3. Connect at least one runtime worker through a documented adapter.
4. Grant that worker scoped capabilities.
5. Send it a task through the product.
6. See the task, result, approval, audit trail, and runtime status in the UI.
7. Verify the work against an external tool of record such as GitHub.
8. Upgrade the pot without losing state or bypassing migration checks.

Until that is true, every roadmap item should be judged by whether it makes
this operating loop more real, safer, or easier to prove.
