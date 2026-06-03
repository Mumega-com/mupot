# mupot

> **The pot, not the plant.** mupot is an installable, Cloudflare-native substrate for running a
> sovereign agent organization — departments, squads, and agents — on **your own Cloudflare account**.
> We give you the pot; what grows in it (your agents, your business) is yours. mupot ships no business
> logic and holds no Mumega data. You can revoke us at any time; you hold the keys.

## What you get

```
your Cloudflare account
  ├─ bus        Queues + Durable Objects + a Worker-hosted MCP endpoint
  ├─ memory     D1 (relational) + Vectorize (semantic) + Workers AI (embeddings)
  ├─ agents     one Durable Object per agent (own SQLite, hibernates when idle)
  ├─ squads     SquadCoordinator Durable Objects (presence, dispatch, locks)
  ├─ auth       app-layer RBAC + OAuth login (you own the perimeter)
  ├─ tasks      mirrored to your GitHub (source of truth)
  └─ dashboard  Pages + Inkwell — org chart, squad boards, agent console
```

Scales to ~100+ agents by construction: Durable Objects are cheap and hibernate, so an idle org costs
near zero and a busy one scales on Cloudflare's network.

## Install (fork → deploy → log in)

```bash
# 1. Use this template (GitHub "Use this template") → your own fork
# 2. create the Cloudflare resources on YOUR account:
wrangler d1 create mupot
wrangler vectorize create mupot-memory --dimensions=768 --metric=cosine
wrangler queues create mupot-events
wrangler queues create mupot-events-dlq
wrangler kv namespace create SESSIONS
wrangler r2 bucket create mupot-blobs
# 3. paste the returned ids into wrangler.toml; set TENANT_SLUG + BRAND in [vars]
# 4. set secrets (never in git):
wrangler secret put OAUTH_CLIENT_ID
wrangler secret put OAUTH_CLIENT_SECRET
wrangler secret put GITHUB_TOKEN
# 5. apply schema + deploy:
npm install
npm run migrate:remote
npm run deploy
```

Then open your deployment, log in as owner, and **seed your org** (departments → squads → agents) in
the dashboard. Define your agents; each gets a Durable Object; squads coordinate; tasks flow to your
GitHub.

## The boundary (what mupot does NOT do)

- It ships an **empty org** — you create the departments, squads, and agents.
- It holds **no Mumega secret** in the path — your CF keys, your OAuth, your GitHub.
- Your data lives in **your** D1 / Vectorize / R2. Cross-tenant access is impossible — each pot is a
  separate Cloudflare account.

## Architecture

See `src/types.ts` — the shared contract (bindings, org domain, ports). Each layer lives in its own
folder under `src/` and is independently testable. Design rationale:
`docs/superpowers/specs/2026-06-03-mupot-cloudflare-substrate-design.md` (in the Mumega platform repo).

## License

Open template — fork it, own it.
