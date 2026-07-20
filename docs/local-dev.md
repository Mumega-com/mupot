# Local development — what works offline vs. what needs Cloudflare

You can run a pot on your machine with **no Cloudflare account and no login**.
`wrangler dev` boots the Worker under Miniflare/workerd (Cloudflare's own OSS
runtime), emulating most bindings locally. The **control plane** runs fully
offline. Two bindings — **Vectorize** and **Workers AI** — have no local
emulator, so the **memory and model-inference features** need a real Cloudflare
account (`remote: true`).

Knowing this split up front saves the confusing `internal_error` you'd otherwise
hit the first time you call `remember`/`recall` offline.

## Start it

```bash
npm run migrate:local        # apply D1 migrations to the local sqlite
npm run dev                  # wrangler dev — Worker + local bindings, no login
```

First run downloads the `workerd` binary once; after that it's offline-capable.
Open the printed `http://localhost:8787` for `/health` and the dashboard.

## Binding-by-binding

| Binding | Resource | Local (`wrangler dev`) | Notes |
|---------|----------|------------------------|-------|
| `DB` | D1 | ✅ emulated (sqlite) | `migrate:local` seeds the schema |
| `SESSIONS` | KV | ✅ emulated | dashboard sessions, cache |
| `OAUTH_KV` | KV | ✅ emulated | OAuth provider state |
| `BLOBS` | R2 | ✅ emulated | blobs/files |
| `BUS` | Queues (+ DLQ) | ✅ emulated | internal event bus |
| `AGENT`, `SQUAD` | Durable Objects | ✅ emulated | per-unit state + alarms |
| `TASK_WORKFLOW` | Workflows | ✅ emulated | durable task pipeline |
| `VEC` | Vectorize | ❌ **needs `remote: true`** | semantic memory / recall |
| `AI` | Workers AI | ❌ **needs `remote: true`** | default model inference |

## What runs fully offline

The entire **control plane**:

- `/health`, org / squads / agents, tasks and the task lifecycle
- the fleet runtime-adapter (conformance suite passes locally)
- the MCP tool surface (`POST /mcp` — see [connect-mcp-client.md](./connect-mcp-client.md))
- the dashboard and OAuth/session flows

## What needs a Cloudflare account

Anything backed by `VEC` or `AI`:

- **Semantic memory** — `remember` / `recall` (Vectorize embeddings + index)
- **In-pot model calls** — any tool that invokes Workers AI

Miniflare reports `env.VEC → not supported` and `env.AI → not supported`, so
calling these offline returns `internal_error`. **This is expected**, not a bug.

To exercise them locally, mark those bindings `remote: true` in your dev config
so `wrangler dev` proxies just those two to your real Cloudflare account (the
rest stay local). This requires `npx wrangler login` and incurs normal usage on
your account.

```toml
[[vectorize]]
binding = "VEC"
index_name = "<your-index>"
remote = true

[ai]
binding = "AI"
remote = true
```

A fully-offline local vector/embeddings fallback (so `remember`/`recall` work
with no account at all) is tracked as a DX improvement — see the repo issues.

## See also

- [SELF-HOST.md](./SELF-HOST.md) — deploy a pot to your own Cloudflare account.
- [connect-mcp-client.md](./connect-mcp-client.md) — point an MCP client at it.
