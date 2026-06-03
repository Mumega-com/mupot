# mupot

> **The pot, not the plant.** mupot is an installable, Cloudflare-native substrate for running a
> sovereign **agent organization** — departments, squads, agents, and human members — on **your own
> Cloudflare account**. Fork it, deploy it, log in, run your org. We give you the soil; what grows in it
> (your agents, your business) is yours. mupot ships no business logic and holds no data of ours. You
> hold the keys; you can revoke us at any time.

Built in a single multi-agent session, deployed live, and proven end-to-end: a slash command in a
Discord channel created a capability-gated task in a squad. **The channel is the squad.**

## What you get

```
your Cloudflare account
  ├─ org        departments → squads → agents (D1)
  ├─ members    humans as first-class nodes: workspace (MCP) / IM / dashboard,
  │             one identity + per-scope capability RBAC (with a grant-ceiling)
  ├─ memory     D1 (relational) + Vectorize (semantic) + Workers AI (embeddings)
  ├─ bus        Queues + Durable Objects
  ├─ tasks      → your GitHub (source of truth)
  ├─ channels   microkernel ChannelAdapter — Discord / Google Chat / Telegram,
  │             where the platform's scoped channel IS a squad
  └─ dashboard  Pages + a first-run onboarding wizard
```

Edge-native and scale-to-zero: agents are Durable Objects that hibernate when idle, so an empty org
costs near nothing and a busy one scales on Cloudflare's network.

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
name your org → create departments + squads → invite your team → connect a model → connect a chat
platform. See [`connectors/`](./connectors) for wiring Discord / Google Chat / Telegram, and
[`scripts/README.md`](./scripts) for the deploy detail.

## Channels are squads

Bind a chat channel to a squad (`POST /api/channels/bindings`) and the platform's **scoped channel
becomes the squad**: its members are the squad's people, capability decides what each may do, and the
squad's agents post their work back into the channel. A Cloudflare Worker can't hold a persistent
gateway, so an always-on client (e.g. Hermes) relays free-text to `/channels/relay`; platforms that
speak HTTP interactions (Discord slash commands) hit mupot directly.

## The boundary (what mupot does NOT do)

- Ships an **empty org** — you create the departments, squads, agents, and invite the people.
- Holds **no secret of ours** in the path — your CF keys, your OAuth, your GitHub, your model key.
- Your data lives in **your** D1 / Vectorize / R2. Each pot is a separate Cloudflare account.

## Security

Every build round was closed by an adversarial review before anything was trusted — it caught and we
fixed a cross-tenant memory leak, a privilege-escalation path, an unauthenticated webhook, and an
impersonation hole. Identity is always derived server-side (never from message text); every mutation is
capability-gated with a grant-ceiling; per-platform webhooks verify fail-closed (Discord Ed25519,
Google signed-JWT, Telegram secret).

## Architecture

`src/types.ts` is the shared contract (bindings, org domain, ports, the `ChannelAdapter` interface).
Each layer lives in its own folder under `src/` — `org`, `members`, `auth`, `agents`, `bus`, `memory`,
`tasks`, `channels`, `dashboard` — and is independently testable. The channel layer is a microkernel:
the core depends only on the adapter interface + a registry; adding a platform is one file.

## License

Open template — fork it, own it.
