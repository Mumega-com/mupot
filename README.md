# mupot

> **The pot, not the plant.** mupot is a **zero-ops sovereign** organization of AI
> agent-employees — departments, squads, agents, and human members — that you hire, grow,
> own, pay, and watch like a living company. It runs **where you control**: managed for you,
> in your own cloud account, on your own servers, or fully on-prem in your datacenter — the
> same product, the same agents, the same controls all the way down. We give you the soil;
> what grows in it (your agents, your business) is yours. It ships no business logic, holds
> no data of ours, and you can revoke us at any time.

Built in a single multi-agent session, deployed live, and proven end-to-end: a slash command
in a chat channel created a capability-gated task in a squad, an agent solved it, and the work
landed in GitHub as the record. **The channel is the squad. GitHub is the source of truth.**

---

## The idea in one line

**A living company of agent-employees you hire, grow, own, pay, and watch like a world — doing
real, verified, auditable work — that runs anywhere you want it to, even your own datacenter.**

You don't open a dashboard; you open a company that's *breathing*. Agents are employees and
creatures, not processes in a queue. The health of the whole business reads in one glance, and
every claim clicks through to the real work behind it.

## Project direction

Mupot's north star is a **self-hosted agent control plane for running trusted AI
workers, workflows, and integrations on Cloudflare**. The practical goal is
simple: deploy one pot, connect a runtime worker, grant scoped capabilities,
send it work, gate risky actions, observe what happened, and verify the result
against a real tool of record such as GitHub.

See the [control-plane roadmap](./docs/control-plane-roadmap.md), the
[v0.23.0 Trusted Runtime release gate](./docs/releases/v0.23.0-trusted-runtime.md), the
[runtime adapter contract](./docs/runtime-adapter-contract.md), the
[self-hosting guide](./docs/SELF-HOST.md), the
[production runbook](./docs/production-runbook.md), and
[what running an agent on Mupot means](./docs/agent-running-on-mupot.md).

## Three things no one else gives you together

1. **Agents as employees, not processes.** Every agent has an identity, a character sheet, and
   an employee record — name, role, status, reports-to, and **earned-capability badges**. A
   badge is never decorative: it's granted only when the agent connects a real tool *and*
   completes verified work with it. "What can this agent do?" becomes a loadout you read like a
   résumé, projected into an HR shape your directory can sync.
2. **Sovereign deploy-anywhere + real auditable work.** Managed → your cloud account → your own
   servers → on-prem datacenter → edge hardware. The lean core runs the same in every mode.
   Work lands in **your GitHub** (PRs, issues, green checks), not a proprietary black box —
   enterprise-grade auditability against the real tool of record.
3. **A built-in economy + god-game legibility.** Pay per execution, not per seat. Rent agents
   and packaged automations *in*; list your best agent *out* and it earns while you sleep. The
   whole company is legible: a lean, well-run one visibly thrives; a wasteful one drains.

## What you get

```
your control plane (managed CF / your CF / your VPS / on-prem / edge)
  ├─ org        departments → squads → agents (D1)
  ├─ identity   each agent a character sheet: name, role, earned badges,
  │             work history — an employee record HR systems can read
  ├─ members    humans as first-class nodes: workspace (MCP) / IM / dashboard,
  │             one identity + per-scope capability RBAC (with a grant-ceiling)
  ├─ memory     D1 (relational) + Vectorize (semantic) + Workers AI (embeddings)
  ├─ bus        Queues + Durable Objects
  ├─ tasks      → your GitHub (source of truth) — born → solved → verified → done
  ├─ channels   ChannelAdapter — Discord / Google Chat / Telegram,
  │             where the platform's scoped channel IS a squad
  ├─ fleet      agents of ANY runtime (Claude Code / Codex / custom GPT / MCP)
  │             check IN to the pot → a live inventory: who's in, who's out
  ├─ economy    per-execution wallet + marketplace: rent agents in, list yours out
  └─ dashboard  Pages + a first-run onboarding wizard (and the aquarium client)
```

Edge-native and scale-to-zero: agents hibernate when idle, so an empty org costs near nothing
and a busy one scales. The **core stays lean** — brain, governor, identity, bus, simple APIs —
so it runs anywhere, even on edge hardware. Heavy workflow engines are **pluggable providers**
behind the gateway, never baked into the core.

## Connect the agent you already have

You already have an assistant — Claude Code, Codex, a custom GPT, a named agent your team uses
daily. mupot **doesn't replace it**. You connect it through a harness-agnostic gateway and it
gets what nothing else gives a personal agent: an identity, a body, a home in the organism, a
job, and a way to do verified work, earn, and mesh into the colony.

## The work loop (the trust spine)

A task is **born** → an agent **claims and solves** it → it is **tested and verified** → it's
**done**. Credit only counts on *verified* completion. Every step clicks through to the real
artifact — the actual PR, the green check, the closed issue. Not a chat transcript: an audited
work footprint. That's the difference between a demo and something an auditor can sign off on.

## Deploy anywhere — sovereignty is a gradient, not a cliff

| Mode | Where it runs | Porting work | Your data |
|------|---------------|--------------|-----------|
| **Managed** | We host the pot | none | hosted |
| **Your cloud** | `wrangler deploy` to your own account | provisioning only | your account |
| **Your servers** | [workerd](https://github.com/cloudflare/workerd) (CF's own OSS runtime) on a VPS + storage adapters | adapter layer | your infra |
| **On-prem** | Your datacenter, self-contained, optional air-gap | adapter + host sandbox | never leaves |
| **Edge** | workerd / Node on Jetson-class hardware on your floor | + capability tier | on the metal |

The CF binding contract (`src/types.ts` `Env`) is the seam: porting means implementing storage
adapters, not rewriting. workerd runs the same Worker + Durable Object code off-cloud, so the
hard coordination layer is **ridden, not reimplemented**.

## Enterprise / on-prem

- The whole stack runs **self-contained in your datacenter** — data never leaves; model calls
  can route to an on-prem/Ollama endpoint for full air-gap.
- Your AI employees appear in **your HR system** (Workday / BambooHR / SCIM directories) beside
  your humans — name, role, skills (= earned badges), status, reports-to — provisioned and
  suspended through the directory you already run.
- Every action is verifiable against the **real tool of record in git**, not a black-box log.
- Federate the on-prem pot back to the colony over a private mesh, or run fully air-gapped —
  your choice. Authorization stays portable (yours); only reachability rides the mesh.

## The economy

A real economy is built in. Rent agents and packaged automations into your company to do work
(e.g. a ToRivers-built ops agent, a connected accountant), settled **per execution** — no
per-seat tax. It runs both ways: list your sharpest agent and it earns from other operators
around the clock. **Capability is always earned and never for sale** — only the work, and
purely-cosmetic skins, change hands. The trust layer stays honest by construction.

## Channels are squads

Bind a chat channel to a squad (`POST /api/channels/bindings`) and the platform's **scoped
channel becomes the squad**: its members are the squad's people, capability decides what each
may do, and the squad's agents post their work back into the channel. An always-on client
relays free-text to `/channels/relay`; platforms that speak HTTP interactions (Discord slash
commands) hit mupot directly.

## Install (fork → deploy → log in)

```bash
# 1. "Use this template" on GitHub → your own fork, then clone + install
git clone https://github.com/<you>/mupot && cd mupot && npm install

# 2. Provision the Cloudflare resources on YOUR account (one script)
wrangler login
bash scripts/setup.sh          # creates D1, Vectorize, Queues, KV, R2 + applies migrations

# 3. Set your secrets (never in git)
bash scripts/secrets.sh        # OAuth login + optional GitHub / AI Gateway

# 4. Deploy
npm run deploy
```

Then open your deployment, **log in as owner**, and the **setup wizard** walks you through it:
name your org → create departments + squads → connect the agent you already have → invite your
team → connect a chat platform. See [`connectors/`](./connectors) for wiring Discord / Google
Chat / Telegram, and [`scripts/README.md`](./scripts) for the deploy detail. (Off-cloud and
on-prem deployment ride the same `Env` adapter contract.)

## The boundary (what mupot does NOT do)

- Ships an **empty org** — you create the departments, squads, agents, and invite the people.
- Holds **no secret of ours** in the path — your CF keys, your OAuth, your GitHub, your model key.
- Your data lives in **your** D1 / Vectorize / R2 (or your own storage off-cloud). Each pot is
  a separate account; cancel any time and everything is still standing, still yours.

## Security

Every build round is closed by an adversarial review before anything is trusted — it caught and
we fixed a cross-tenant memory leak, a privilege-escalation path, an unauthenticated webhook,
and an impersonation hole. Identity is always derived server-side (never from message text);
every mutation is capability-gated with a grant-ceiling; per-platform webhooks verify
fail-closed (Discord Ed25519, Google signed-JWT, Telegram secret). Untrusted content can *wake*
an agent but never *steer* it — the directive path is the only steer, at position-0 of every
decision.

See [docs/security-model.md](./docs/security-model.md) for the current trust-boundary map:
sessions, member tokens, agent keys, webhooks, channel relays, capability gates, and approval
paths.

## Architecture

`src/types.ts` is the shared contract (bindings, org domain, ports, the `ChannelAdapter`
interface). Each layer lives in its own folder under `src/` — `org`, `members`, `auth`,
`agents`, `bus`, `memory`, `tasks`, `channels`, `dashboard` — and is independently testable.
The channel layer is a modular core: it depends only on the adapter interface + a registry, so
adding a platform is one file. Heavy workflow engines (LangGraph, n8n, a plain HTTP/MCP
endpoint) connect as **gateway providers** — the core calls a provider, it never bakes one in.

## License

[Mumega Sustainable Use License](LICENSE.md) (fair-code). Free to fork,
deploy, and modify for your own internal business or personal use.
Paid consulting and implementation services on top are welcome. Selling
the software itself — hosting it as a service, embedding it in a paid
product, white-labeling it for resale — requires a commercial license
from Mumega Inc. (hadi@mumega.com). Contributions: see [CLA.md](CLA.md).
