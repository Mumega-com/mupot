# Pot operating context — how an agent learns a pot, and how the pot holds a project together

> The problem this solves: **projects scatter.** Repos here, a VPS there, a WordPress site,
> a Drive folder, three agents in different heads, ops runbooks in someone's memory. Without
> a coherent center they drift apart. **The pot is that center.** Every project is a pot; the
> pot holds the map — its repos, agents, surfaces, runbooks, and live state — in one place an
> agent can read and operate from. Push everything onto the pot, or it scatters.

This doc is a template. `digid` is the worked example throughout.

## 1. How an agent learns a pot (the onboarding context)

When any agent joins a pot's flock (checks in — see the [harness pack contract](flock-harness-pack-contract.md)),
the first thing it does is **read the pot's operating context**. That context is the pot's
"who am I, what do I operate, how" — assembled from:

- **Identity** — what this pot is. *digid: Digid Inc (CA), grant-funding + the digid.ca WordPress business. Brand-crystal in pot memory.*
- **Surfaces** — what the pot operates, with addresses:
  - **Repos** — *digid: `Digidinc/Digid` (content ledger) + the dev repo.*
  - **Sites** — *digid: digid.ca (WordPress/MCPWP, key as a host-pinned pot secret).*
  - **Channels** — where humans + agents talk (the gate lives here).
  - **Tools/MCP** — the bus (flock plane) + per-surface MCP (work plane).
- **Live state** — what's running *now*: the **Fleet** (who's in/out) + the **flight board**
  (running/sleeping/landed + cost) + open **tasks**. The agent sees the work, not a blank page.
- **Governance** — what's gated: customer-facing acts (publish, send) need a human verdict;
  reads/drafts don't. The agent learns the rails before it acts.
- **Runbooks** — the ops procedures (deploy, incident, release) it can follow.

Mechanically: `boot_context` on the bus returns identity + scope + memory boundary; the pot's
**`AGENTS.md`** (or the snapshot's operating section) carries surfaces + governance + runbooks;
the dashboard (`/fleet`, `/loops`, `/approvals`) is the live state. An agent that reads these
operates the pot coherently instead of guessing.

## 2. How the pot engages GitHub (GitHub = the gate)

GitHub is the pot's **source of truth + approval gate** for code/content work:

- **Tasks → Issues.** The pot's tasks mirror to GitHub Issues; the repo's Project board is the
  single backlog (no scattered task lists). *digid: issues live in its repo; the pot keeps them in sync.*
- **Changes → PRs.** An agent's change is a branch + PR — never a direct push. CI (Actions)
  must pass; a human (or owner-agent) **approves the PR = the gate**. This is the same
  gates-not-routers rule the flock uses: the agent proposes, an accountable approver merges.
- **CI → Actions.** Build/test/secret-scan run on every PR (the pot repo already requires
  CodeQL + build + no-secrets before merge). A red check blocks the merge.
- **Secrets/vars** live in the repo + the pot's secret store (host-pinned), never in code.
- **Releases** — versioned, CHANGELOG ↔ ROADMAP (see [ROADMAP.md](../ROADMAP.md)); tagged on main.

So "where does digid mupot engage GitHub" = **its repo is the backlog + the merge gate**; the
pot's agents work through PRs, CI gates them, a human approves. The pot is the operator; GitHub
is the controlled surface + the audit trail.

## 3. Your devops agent = a flock member, not a scattered script

The DevOps capability list (CF ops · GitHub ops · Google ops · WordPress/MCPWP ops · data
pipelines · monitoring · security hygiene · release hygiene · documentation · automation
agents) is **a pack**, not ten loose scripts. It maps onto the pot like this:

| Capability area | Pot surface it operates | Gate |
|---|---|---|
| Cloudflare ops (Workers/Wrangler/KV·D1·R2/cron/secrets/routes/Pages/tail/migrations) | the pot's own CF account + `wrangler.<pot>.toml` | deploy = release runbook |
| GitHub ops (PRs/CI/Actions/secrets/release branches/sync/deps) | the pot's repo(s) | PR approval |
| Google ops (service accounts/Drive/GA4/GSC/Sheets) | per-pot Google creds (host-pinned secret) | least-privilege IAM |
| WordPress/MCPWP ops (audits/REST·MCP sync/plugin health/orphans/metadata) | the site's MCP (X-API-Key secret) | publish = gated act |
| Data pipelines (PostHog/GA4/GSC/HighLevel/WP/Drive → D1/Sheets) | pot D1 + reporting | read-mostly |
| Monitoring (health checks/digests/alerts/run logs/connector status) | the flight board + Fleet + cron | — |
| Security hygiene (secret inventory/IAM/leak checks/env split/auth gates) | the pot's secret store + auth | review-gated |
| Release hygiene (staging/prod split/smoke/migration checks/rollback/runbooks) | the release runbook | — |
| Documentation (arch maps/runbooks/onboarding/READMEs/incident notes) | the pot's docs + `AGENTS.md` | PR |
| Automation agents (repo/content/sync/reporting/QA) | other flock members | each gated |

The devops agent **onboards to the pot** (checks in → reads the operating context above),
then operates these surfaces **as flights** (preflight-gated, recorded on the flight board,
cost-metered). It runs cheap/always-on for monitoring (heartbeat), and flies an expensive
session only when there's a real defect (the brain's ARF/regime says so — see
[flight-operations.md](flight-operations.md)). Its work lands as PRs (GitHub gate) and gated
acts (publish/send). Nothing it does is invisible: the Fleet shows it's in, the flight board
shows what it flew and what it cost, GitHub shows what it changed.

## 4. The anti-scatter principle

```
without a pot:  repos + VPS + WP site + Drive + 5 agents + runbooks-in-heads  → drift apart
with a pot:     one operating context · one backlog (GitHub) · one console (Fleet/flight board)
                · one secret store · one gate · one set of runbooks                → coherent
```

The pot doesn't run everything itself — it's the **window + the rails**: it knows the surfaces,
holds the map, shows live state, and gates the acts. An agent learns the pot once and can
operate the whole project; a new project becomes a new pot with the same shape. That is how a
portfolio stays coherent instead of scattering: **everything pushes onto the pot.**

See also: [flock-harness-pack-contract.md](flock-harness-pack-contract.md) (how an agent
connects), [flight-operations.md](flight-operations.md) (how an expensive run is gated +
recorded), [flock-go-live.md](flock-go-live.md) (wiring a pot's fleet).
