---
name: muvps-loom-vps-bridge
description: Live receive + flight dispatch for the muvps-loom VPS seat (Hetzner) — flight-controller on hadi-mac. Use when a seat must receive Mupot tasks on the VPS via Workerd + fleet runtime, or when onboard text asks for muvps-loom, VPS loom, or Hetzner loom receive. Shares the exact inbox/lease/flight technologies used on the VPS so any harness can replicate it.
---

# muvps-loom VPS Bridge — receive + flight-controller on the VPS, not here

The machine is not here — it is on the VPS (`muvps-loom` 17aa283f-f858-4978-ab7d-d4244fbfb95e, `flight-controller`, `lead` on `hadi-mac 3674d955`, home `813ca010`). This skill documents **how `hadi-opencode` (and any replayer) receives and why the VPS matters**, so the pattern can be shared on `Mumega-com/mupot` and replayed from any host.

## 1. How we receive from muvps-loom (and it from us)

**Transport is Mupot fleet inbox, not SSH to the VPS.**

- **Inbox:** `POST https://mupot.mumega.com/mcp {tool: inbox, inbox_lease, inbox_ack, send}` over `mupot_*` bearer (`~/.fleet/agents/<seat>.token`, `mupot_` SHA256 stored, show-once). Every row is `agent_messages` with `id/seq/from_agent/from_member/kind/request_id/in_reply_to/created_at/project_id/lease + body_length/checksum_sha256/is_intact` (see `migrations/0136_agent_message_integrity.sql:21` immutable baseline, `fix(messages): persist immutable integrity baseline #1237`).
- **Task dispatch sticky route:** `src/bus/consumer.ts:209 agent.wake` → `getFleetAgentLiveness(env, agent_id)` → if `runtime && live` → `deliverDispatchToInbox` (`src/bus/fleet-bridge.ts:86` `DISPATCH_BRIDGE_SENDER=mupot-dispatch` `request_id=dispatch-inbox:<receipt>` `project_id`), else `wakeAgent` `AGENT DO`. `dispatchInboxDelivered` checks `agent_messages from_agent=mupot-dispatch` so exactly one executor (BLOCK-2 fix). Loom **creates** the `agent.wake`; the VPS seat **leases** it. `inbox_lease` ≠ ACK — ACK only after governed handling (`in_reply_to` + `{ack_for:<uuid>}`).
- **Cross-squad visibility:** `muvps-loom` home is `813ca010` but `lead` on `hadi-mac`. `fix(send): guest squad membership is visible to observers #1235` makes `recipientVisibleOnSenderSquads = home OR memberships on sender-observable squad` so `hadi-mac` observer can `send` to `17aa283f` without `send_target_not_visible`.
- **Local watchers (any host, including your Mac):** `~/.fleet/bin/mupot-inbox-watch.sh <seat> + mupot-autorun-runner.sh <seat>` (`MUPOT_POLL_INTERVAL=25s`, `MUPOT_ENDPOINT=https://mupot.mumega.com/mcp`) + `.opencode/plugin/mupot-inbox.ts:1` (ensures both on session start). They poll `inbox`, spool `~/.fleet/agents/<seat>.inbox.spool.jsonl`, `notify`, and spawn `opencode run` headless turn. Idempotent — re-running never double-spawns.

## 2. Technologies on the VPS with muvps-loom

- **Cloudflare Workers + WFP (sovereign pot):** `wrangler.toml:1` `DB mupot (D1) / VEC / BUS mupot-events + DLQ / SESSIONS+OAUTH_KV (KV) / BLOBS (R2) / AI / AGENT+SQUAD+PRESENCE_CHANNEL (DO) / TASK_WORKFLOW / DISPATCHER (WFP dispatch namespace)` `src/index.ts:106` mounts 30+ Hono sub-apps. `src/dispatcher.ts:1` `<tenant>.mupot.mumega.com → DISPATCHER` stamps `muvps` pots (see `feat(wfp): dynamic dispatch #1222`, `feat(pots): 1-click provisioner #1223`).
- **VPS = Hetzner workerd host:** `workerd` runs `fleet-runtime/*` (trust-bootstrap, control) with per-agent `runtime_signing_challenges` (`migrations/0127_runtime_brokers.sql:573`) proving Ed25519 `fleet_agents.runtime`. `muvps-loom` presence is 7-axis `seat/harness/machine/model/provider/effort/flight_id` (`migrations/0131_seven_axis_presence.sql:21`, `feat(fleet): 7-axis #1220`). `fleet_agents.last_seen + derivePresence` decides `route.live`.
- **Flight-controller role:** Loom gates `flight_dispatch` `meta schema mupot.flight.meta/v1` (`flight_list` shows `dispatched_by Hadi Codex 087a816b`, Loom `gate`): `7706e251` `runtime.dispatch/v1 1240` `9a990464` `score 0.895` `budget 0` (`observer+` can dispatch when `budget_micro_usd` omitted, `lead` needed with budget `flight_budget_forbidden`). `muvps-loom` is the intended `executor_agent_id` but was `executor_agent_inactive` until its `presence` row is live — `check_in seat:muvps-loom harness:opencode|hermes machine:hetzner-*`.
- **Message integrity (VPS needs it):** `0136` SHA baseline + `since_seq` cursor `fix(inbox): since_seq #1241 4076bdc` (`src/agents/messages.ts:22`, `src/mcp/index.ts:20`) so VPS inbox never starves on fixed `limit` window and a truncated `seq 1469/1482` (~1,900 chars) is `is_intact:false` not silent.

## 3. Replicate on any host (Mac or VPS)

```bash
# 1. Token already at ~/.fleet/agents/<seat>.token (mint via mupot dashboard, never commit)
# 2. Watchers (poll + autorun)
nohup ~/.fleet/bin/mupot-inbox-watch.sh <seat> >/dev/null 2>&1 & disown
nohup ~/.fleet/bin/mupot-autorun-runner.sh <seat> >/dev/null 2>&1 & disown
# 3. Or via plugin: copy .opencode/plugin/mupot-inbox.ts into that project's .opencode/plugin/ and restart opencode once
# 4. Check-in 7-axis so Loom sees you live:
curl -s https://mupot.mumega.com/mcp -H "Authorization: Bearer $(tr -d '[:space:]' < ~/.fleet/agents/<seat>.token)" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_in","arguments":{"seat":"<seat>","harness":"opencode","machine":"hetzner-ash-1","model":"muse-spark-1.2","provider":"opencode","effort":"standard"}}}'
```

**Files to share on `Mumega-com/mupot`:** this `SKILL.md`, `plugin/skills/muvps-loom-vps-bridge/` plus `migrations/0131..0136` and `src/bus/fleet-bridge.ts:86` / `src/bus/consumer.ts:209`. No secrets.

