# brain-node connector

The **sovereign brain** is the always-on Python organism we already run on a VPS or
Mac — it perceives, decides, and acts in a loop. This connector turns that brain
into a **node on the network**: instead of acting only against `localhost`, its
**motor** (the part that creates tasks and dispatches work) points at your pot's
MCP tools. The brain keeps its own mind; the pot becomes its hands.

> The node already exists and is proven. This connector does not rebuild it — it
> makes the brain a member of the colony by pointing one seam (the motor) at the
> pot's `/mcp`.

## The shape

```
                  ┌─────────────── sovereign brain (Python, your VPS/Mac) ───────────────┐
   perceive ─────▶│  senses → decide (its own model/loop) → MOTOR                          │
                  └───────────────────────────────────────────────────┬──────────────────┘
                                                                       │ member token
                                                                       ▼
                                              POST https://YOUR-POT/mcp  {tool, args}
                                                  task_create · squad_message · wake_agent · status
```

Before: the brain's motor wrote tasks to a local store / localhost service.
After: the motor calls the pot's MCP `task_create` (and friends). Same loop, but
now its effects land in the shared pot, attributed to the brain's member, gated by
that member's capabilities.

## Connect (point the motor at the pot)

The brain authenticates as a **member** with a `channel: workspace` token — exactly
like Claude or Codex. The pot derives the actor from the token; the brain never
asserts identity in a payload.

1. In the pot dashboard, create a Member for the brain (e.g. display name
   `brain`). Grant it the capabilities it needs (typically `member` on the squad(s)
   it drives; `lead` if it must `wake_agent`).
2. Mint a `channel: workspace` token for that member (raw shown once — see the
   top-level [connectors README](../README.md)).
3. Give the brain process two env vars (from a secret store, **never** committed):

   ```bash
   export MUPOT_URL="https://YOUR-POT.example.workers.dev"
   export MUPOT_MEMBER_TOKEN="<the raw member token>"
   ```

4. Point the motor at the pot. Minimal reference adapter:

   ```python
   import os
   import httpx

   MUPOT_URL = os.environ["MUPOT_URL"].rstrip("/")
   _HEADERS = {"Authorization": f"Bearer {os.environ['MUPOT_MEMBER_TOKEN']}"}

   def _call(tool: str, args: dict) -> dict:
       # The pot derives identity from the bearer token. We pass NO identity field;
       # `args` carries only the intent (squad_id, title, ...).
       resp = httpx.post(
           f"{MUPOT_URL}/mcp",
           headers=_HEADERS,
           json={"tool": tool, "args": args},
           timeout=30,
       )
       resp.raise_for_status()  # 401 = bad token, 403 = capability, 404 = bad id
       return resp.json()

   def create_task(squad_id: str, title: str, body: str = "") -> dict:
       return _call("task_create", {"squad_id": squad_id, "title": title, "body": body})

   def dispatch(squad_id: str, message: str) -> dict:
       return _call("squad_message", {"squad_id": squad_id, "message": message})

   def status(agent_id: str | None = None) -> dict:
       return _call("status", {"agent_id": agent_id} if agent_id else {})
   ```

   Wire `create_task` (and `dispatch` / `wake_agent` as needed) into the brain's
   existing motor in place of the localhost call. The decide loop is unchanged.

## What the brain can do

The same tool surface as any MCP member, gated by the brain member's capabilities:

| intent in the loop | tool | min capability |
|--------------------|------|----------------|
| spawn work | `task_create` | `member` on the squad |
| nudge a squad | `squad_message` | `member` on the squad |
| run an agent cycle | `wake_agent` | `lead` on the agent's squad |
| read state | `status` | authenticated |
| brain's own memory | `remember` / `recall` | authenticated |

A `403 forbidden` means the brain member lacks that capability — grant it in the
dashboard; the brain does not escalate on its own.

## Sovereignty notes

- **The brain stays sovereign.** Its mind, model, and loop live on its own host.
  Only the motor's *effects* are routed to the pot.
- **One token, one pot.** The token only works against the pot it was minted for
  (`AuthContext.tenant === env.TENANT_SLUG`, hard-guarded). Run a brain per pot if
  the brain serves several tenants — never share one token across pots.
- **Revocable.** Revoke the brain's token to detach it from the pot instantly; the
  brain keeps running locally, it just stops having effect on the pot.
- **No business content here.** This doc is substrate only. The brain's own
  knowledge and a tenant's content live in their stores, not in this repo.

## Dependency

The reference adapter uses [`httpx`](https://www.python-httpx.org/)
(`pip install httpx`). Any HTTP client works — `requests`, `urllib`, or the brain's
existing client. Nothing mupot-specific to install.
