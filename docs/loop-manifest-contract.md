# Loop Manifest — Contract v1

As of **v1.0**, the Loop manifest is a **stable public contract**. You can build on the
shapes and invariants below; they will not change without a major version bump. The
contract is pinned by `tests/loop-manifest-contract.test.ts` — a change that breaks any
assertion there is, by definition, a breaking (2.0) change.

## What a Loop is

A Loop is a declarative resource that binds **six resources** to a goal; the container
runs its cycle (perceive → reason → act → observe → stop) and enforces the accounting.

```jsonc
{
  // exactly ONE owner:
  "squad_id": "sq-1",          // OR
  "agent_id": null,

  "okr": "Book qualified meetings",
  "kpi": { "signal": "positive_replies", "target": 5, "source": "prospects" },

  "sources":  [ /* ResourceRef[] — what it perceives */ ],
  "channels": [ /* ResourceRef[] — how it acts        */ ],

  "gate":   { "require_approval": true, "timeout_sec": 86400, "on_timeout": "pause" },
  "budget": { "cap_micro_usd": 5000000, "window": "week", "effort": "standard" },
  "cadence":{ "heartbeat": true, "on_event": true, "alarm_sec": 259200 },
  "stop":   { "dry_rounds_max": 5, "on_kpi_met": true, "kill": false }
}
```

Create one through the product: `POST /api/loops` (owner/admin). The pot validates it and
runs it on the cron heartbeat.

## ResourceRef — the MCP-native seam

Sources and channels are `ResourceRef`s. Kinds (v1): **`mcp`**, **`queue`**, **`memory`**.

```jsonc
{ "kind": "mcp", "url": "https://server.example/mcp", "auth_ref": "ghl", "tool_filter": ["search","fetch"] }
{ "kind": "queue",  "name": "prospects" }
{ "kind": "memory", "name": "outreach" }
```

### Bring your own MCP server
Any MCP server (HTTPS) plugs in as a source or channel with **zero adapter code** — point
`url` at it. The pot calls it as `tools/call` over JSON-RPC.

- **`url`** must be **https** and a **public host** (private/loopback/metadata hosts are
  rejected — SSRF protection).
- **`auth_ref`** is an **opaque NAME**, never an inline secret. The pot resolves it to a
  Worker binding `LOOP_SECRET_<auth_ref>`, and the secret is **host-pinned**: it is only
  sent to `LOOP_SECRET_<auth_ref>_HOST`. To let a loop authenticate to your MCP server:
  ```
  wrangler secret put LOOP_SECRET_ghl          # the bearer token
  # and set LOOP_SECRET_ghl_HOST = ghl.example  (the host it may travel to)
  ```
  Platform secrets (GITHUB_TOKEN, BUS_TOKEN, …) are outside the `LOOP_SECRET_` namespace
  and are **unreachable** from a manifest.
- **`tool_filter`** (optional) allowlists the tool names the loop may call on that server.

## v1 invariants (guarantees)

1. **Exactly one owner** — set `squad_id` XOR `agent_id`, never both/neither.
2. **No auto-send** — a loop with **any channel** MUST be gated (`require_approval: true`).
   Enforced at write, at read (a hand-edited row won't load), and in the cycle. An ungated
   loop may only perceive + observe.
3. **MCP refs** are https + public-host; **secrets are named, never inline**, and
   host-pinned.
4. **`kpi.target`** is a positive number (the outcome denominator). The KPI measures an
   outcome (e.g. replies), not activity.
5. **`gate.on_timeout`** ∈ {`pause`, `reject`} — it never auto-approves.
6. **`killed` / `done`** are terminal loop states.

## Governance the container enforces

- **Budget** — a hard pre-call dollar cap (`budget.cap_micro_usd`, over `budget.window`);
  the loop blocks before the next model call rather than overspending.
- **Gate** — gated acts become `status='review'` tasks in `/approvals` + pending
  `outbound_act`s that fire only after an approved verdict.
- **Stop** — dry-round pause, KPI-met, budget exhaustion, explicit kill.
