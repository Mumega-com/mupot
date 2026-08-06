# SOS coordination compat shim (ADR gh #473)

> Status: active policy as of 2026-07-22. Fleet coordination runs on **mupot
> CF-native** primitives. The SOS Redis bus is retired from every active
> send / inbox / presence path in this repo.

## Decision

| Layer | Substrate |
|---|---|
| send / inbox | D1 `agent_messages` (`sendAgentMessage` / MCP `send`+`inbox`) |
| presence / roster | D1 `presence` + `fleet_agents` + `module_registry` |
| async fan-out / wake | CF Queue `mupot-events` (`agent.wake`, …) |
| host process control | Durable Objects + signed control-requests (`emitControlRequest`) |

**Not** the SOS Redis bus (`bus.mumega.com` / `bus-send.py` / `mcp.mumega.com` SSE streams).
**Not** Cloudflare Pub/Sub (MQTT — never GA).

## What remains (compat only)

| Artifact | Role |
|---|---|
| `Env.BUS_URL` / `Env.BUS_TOKEN` | Optional leftovers. `busConfigured()` reports them for ops visibility. **No fleet route calls them.** |
| `FLEET_PROJECT` / `FLEET_OPS_AGENT` | Still used — but as pot-scoped CF-native messaging identity, not SOS project pins. |
| External host scripts outside this repo that still invoke `~/scripts/bus-send.py` | Out of band; migrate those callers to MCP `send` independently. |

## Operator rules

1. Do **not** add new coordination dependencies on SOS Redis / `bus-send.py`.
2. Arms / brain / relays notify via MCP `send` (or pot HTTP inbox), and register presence via `presence_register` / check-in.
3. Real-time push, if needed later → Durable Object + WebSocket fan-out — never CF Pub/Sub MQTT.

## References

- ADR: GitHub issue [#473](https://github.com/Mumega-com/mupot/issues/473)
- Cutover runbook (historical): [squad-mupot-cutover.md](../squad-mupot-cutover.md)
- Module kernel / Port 1 presence: [mupot-module-kernel.md](./mupot-module-kernel.md)
