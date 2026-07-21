# Cursor — ECC operator pack

Attach an **ECC-optimized Cursor agent** to a mupot pot as governed labor.

ECC (`ecc-universal`) stays on the client (skills / hooks / install profiles).
mupot owns tasks, gates, receipts, and loops. This pack only wires the **seam**.

See [ECC as the mupot agent-runtime adapter](../../../docs/architecture/ecc-as-agent-runtime.md)
and the [flock harness pack contract](../../../docs/flock-harness-pack-contract.md).

## Onboard (6 steps)

1. **Install ECC (client craft)** — from a durable pin (e.g. `/home/mumega/ecc`):

   ```bash
   npx --prefix /home/mumega/ecc ecc install --profile minimal --target cursor \
     --with capability:content \
     --with capability:social \
     --with capability:research
   ```

   Skills land under the agent workspace `.cursor/skills/` — do **not** copy them into mupot.

2. **Mint a scoped token.** Operator mints via `mint_agent_token` (MCP) or dashboard —
   agent-bound, member-capable on the target squad. Never an org-admin token in the agent.

3. **Drop MCP config.** Copy `.mcp.json.template` → `.mcp.json` (gitignored) and replace
   `<MUPOT_MEMBER_TOKEN>`. Point at this pot's MCP endpoint
   (`https://mupot.mumega.com/mcp` for Mumega; your deploy otherwise).

4. **Load the rails skill.** Copy `SKILL.md` into `.cursor/skills/mupot-ecc-operator/`
   (or keep this pack directory on the agent's skill path).

5. **Grant gate authority (if this agent is a gate).** Org-admin calls MCP
   `grant_gate_capability` with `capability: "gate:<owner>"`,
   `principal_type: "agent"|"member"`, `principal_id: <id>` — no SQL.

6. **Verify.** Start Cursor → `boot_context` → `orient` → claim a task → land at
   `review` with `gate_owner`. Never self-verdict (`task_verdict` blocks assignee).

## Promote marketing CRO loop (dogfood)

After `marketing-cro-monitor` activate, the `website-opportunity-review` loop is
**paused** until an org-admin promotes it:

```text
loop_list { status: "paused" }
loop_set_status { loop_id: "<id>", status: "active" }
```

Then wait for the next cron tick and confirm a recommendation appears.

## Remove

Delete `.mcp.json`, stop the agent, revoke the token / `revoke_gate_capability` if granted.
ECC uninstall is separate (`ecc` install-state) and does not touch the pot.
