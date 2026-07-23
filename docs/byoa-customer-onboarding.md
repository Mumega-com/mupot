# BYOA customer onboarding

**Bring any famous agent harness, governed on your pot.**

This is the reseller / customer entry for
[`project_tenant_interface_byoa`](../superpowers/specs/2026-07-23-byoa-harness-support-matrix-design.md):
add an agent → pick a harness → get the install pack + credential → attach →
work lands at `review` behind the gate.

Design matrix: [BYOA harness support](./superpowers/specs/2026-07-23-byoa-harness-support-matrix-design.md).
Research: [connection modes](./agent-harness-connection-modes-research-2026-07-23.md).
Pack contract: [flock harness pack](./flock-harness-pack-contract.md).
Runtime seam: [runtime-adapter/v1](./runtime-adapter-contract.md).

## Flow (dashboard + MCP)

| Step | Dashboard | MCP tool |
|------|-----------|----------|
| 1. Create | `/agents/onboard` form | `create_agent` |
| 2. Credential | show-once mint (and optional Ed25519 public `x` for topology C) | `mint_agent_token` then, for C, `register_agent_key` |
| 3. Least privilege | observer \| member on the agent's own squad (mint escalation guard) | `grant_agent_capability` for any *additional* squad |
| 4. Pack | success page + `GET /agents/onboard/packs/:harness` | `list_harness_packs` → `get_harness_pack` |

Hard rules from mint: the agent token is **squad-scoped observer/member only** —
never org/department, never above `member`. Topology C still mints first (welds
identity), then registers the host public key; the private key never leaves the host.

## Shipped packs (`packs/<harness>/`)

| Harness id | Topology | Pack path |
|------------|----------|-----------|
| `claude-code` | A | `packs/claude-code/flock-agent/` |
| `codex` | A | `packs/codex/byoa/` |
| `cursor` | A | `packs/cursor/ecc-operator/` |
| `cursor-background` | C | `packs/cursor-background/byoa/` |
| `claude-managed` | C | `packs/claude-managed/byoa/` |

**De-scoped**

- **Claude Desktop** — topology B, human Custom Connector only. See
  [byoa-claude-desktop.md](./byoa-claude-desktop.md). No install pack, no adapter.
- **Codex Cloud** — no public launch/poll API (OpenAI issue #24777). Omitted.

## MCP examples

```text
create_agent { squad: "growth", slug: "coder", name: "Coder" }
mint_agent_token { agent: "coder", capability: "member" }
# topology C only:
register_agent_key { agent: "coder", public_key: "<ed25519-jwk-x>" }
grant_agent_capability { agent: "coder", squad: "growth", capability: "member" }
list_harness_packs {}
get_harness_pack { harness: "codex" }
```

## Attach & govern

1. Drop the pack config into the harness (`.mcp.json`, `~/.codex/config.toml`,
   `~/.cursor/mcp.json`, or topology-C attach env).
2. Start / launch the harness. Call `boot_context` → `orient`.
3. Claim tasks; land at `review`. Never merge, deploy, publish, or self-verdict.

## Dashboard entry

Open **Agents → Bring your own agent** (`/agents/onboard`). Org admin only.
Pack JSON download: `GET /agents/onboard/packs/:harness`.
