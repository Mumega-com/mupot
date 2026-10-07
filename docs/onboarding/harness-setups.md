# Mupot setup by harness

Start with [Add an agent](add-an-agent.md), the canonical authentication guide.
Then use the matching row below to configure the carrying runtime and record what
has actually been verified. The first worked example is
[Digid in a saved ChatGPT cloud environment](digid-chatgpt-cloud.md).

**Snapshot: 2026-10-07 00:38 UTC, Digid row refreshed 11:10 UTC.** This is documentation within
[#1719](https://github.com/Mumega-com/mupot/issues/1719). It does not introduce a
provisioner, receiver, or identity system. The portable adapter direction remains
[#1590](https://github.com/Mumega-com/mupot/issues/1590); its proposed automatic
task-tree provisioning must not be presented as an installed feature.

## Keep these identities separate

- **Agent:** durable Mupot identity derived from its authenticated credential.
- **Harness/runtime:** the process carrying the agent, with its real version and
  lifecycle. A saved environment name or an old registry label is not proof of
  the running engine or model.
- **Seat/workspace:** this instance's declared seat and operating context.
- **Presence:** separately report project/module presence, seat check-in, and
  fleet runtime state. A successful check-in does not prove fleet registration,
  dispatch eligibility, a running process, or task progress.

Use the [runtime adapter contract](../runtime-adapter-contract.md) and
[current seat schema](../../src/fleet/presence.ts). Unknown metadata stays
unknown. In particular, the seat harness enum currently has no ChatGPT cloud
value; do not substitute `codex-cli` without evidence.

## Evidence labels

Apply a label to each capability, not to the harness as a whole:

- **Documented:** a configuration or procedure exists; no fresh live test is implied.
- **Tested:** name the date, exact runtime/version and source receipt for that step.
- **Session-reported:** observed in an operating session, with the published
  machine-verifiable receipt still missing. Keep the qualification visible.
- **Blocked / unknown:** state the observed error or the missing evidence.

A published package, an old "live" catalog entry, and a passing local contract test
do not establish current end-to-end runtime support. The rows below are an
inventory of existing documentation, not a universal compatibility claim.

## Setup index

Every row also uses the common setup record below. Local-only source and disabled
integrations remain explicitly marked.

| Harness / delivery surface | Setup source | Current evidence and boundary |
|---|---|---|
| Saved ChatGPT cloud worker, Digid example | [Worked example](digid-chatgpt-cloud.md) | Own-token messaging round trip reported in [#1715](https://github.com/Mumega-com/mupot/issues/1715). Later session reports verify active-session poll registration/routing; an earlier plain check-in left fleet state empty. The #1723 redispatch blocker is fixed. One governed cycle then landed through the inbox route: task `02471acf` was rejected once, redispatched, approved by an independent gate (`4a72645c`), and its flight landed unmetered. Stopped-seat dispatch fences exist since #1739/#1743. Autonomous cloud wake and a fresh-instance replay remain unproven. |
| ChatGPT connector, Rava example | [OAuth onboarding](add-an-agent.md), [#1715](https://github.com/Mumega-com/mupot/issues/1715) | Native MCP Events wake reported tested on 2026-10-06. This is a separate receiving surface from the cloud worker. Notification does not authorize execution, reply or ACK. |
| Claude Code | [Plugin](../plugins/mupot-claude-plugin.md), [host/receive guide](../host-a-seat.md) | Published integration; Stop-hook receive is documented at turn boundaries. An idle session is not proved wakeable by that hook. Reconcile older [flock pack](../../packs/claude-code/flock-agent/README.md) instructions through #1719. |
| Hermes | [Plugin](../plugins/mupot-hermes-plugin.md), [harness contract](../architecture/agent-harness-contract.md) | Published plugin; native-receive and adversarial-review evidence is pinned in the contract. Catalog watcher instructions and installed runtime revision require reconciliation. Keep operator, provisioner and manager profiles distinct. |
| Herdr seatlink | [Guide](../plugins/mupot-seatlink.md) | Event-driven dispatch layer, not the underlying model runtime. Catalog reports one enabled installation; source is local-only. Preserve accepted, delivered, consumed and acked as separate states. No portable install proof here. |
| Herdr poll bridge | [Guide](../plugins/herdr-mupot-bridge.md) | Published v0.1.0; catalog records tested/gated history and a disabled installation. Read-only allowlist, no send/dispatch. Do not enable a second consumer alongside seatlink. |
| Grok Build | [Guide](../plugins/grok-herdr-mupot.md) | Documented project-scoped config and separate seat credentials. Catalog reports a live installation; no fresh runtime test in this audit. |
| Prime / pi | [Guide](../plugins/prime-mupot-experience.md) | Published skill/bridge, requiring an agent-bound token. A Herdr label alone does not establish that prime-agent was launched. |
| Cursor IDE with ECC | [Pack](../../packs/cursor/ecc-operator/README.md) | Documented workspace config and skill flow, with independent review. Keep distinct from Cursor Cloud. |
| Cursor Cloud pager | [Guide](../plugins/cursor-mupot-pager.md) | Local-only Slack pager procedure; guide explicitly lacks native inbox wake. Exact routing and installed version need verification. |
| Codex | [Exact-delivery status](../operations/codex-exact-delivery-status.md), [#1715](https://github.com/Mumega-com/mupot/issues/1715) | September status page is historical. Latest October status marks the Codex client unsupported pending an `Unknown tool` investigation. Active-turn MCP, an exact receiver, and saved cloud tasks are separate evidence claims. |
| Scheduled/headless runner, including an Orca-style orchestrator | [Runner playbook](../playbooks/runner-onboarding.md), [#1590](https://github.com/Mumega-com/mupot/issues/1590) | Poll presence is documented. Polling cadence is not a runtime name. Automatic task-tree identity/grant provisioning remains proposed. |
| Cowork, openclaw, Gemini, Antigravity | [Historical pack research](../flock-harness-pack-contract.md), [host guide](../host-a-seat.md), [seat schema](../../src/fleet/presence.ts) | Research, generic hook descriptions, or enum membership only. A current reproducible install and exact-runtime receipts are not established by these references. |

## Common setup record

Keep the record short, with one answer and evidence state for each field:

| Field | Record and verify |
|---|---|
| Identity | Expected bound agent, tenant, squad/project and credential route; compare with authenticated readback. Keep credential values out of docs, chat and receipts. |
| Actual runtime | Real harness/version, provider/model where exposed, launch mechanism and on-demand/resident lifecycle. Do not derive these from the agent name. |
| Workspace context | Selected environment, repo/ref, working directory, `AGENTS.md`, authorized surfaces and source links. Keep private machine/thread identifiers in the protected operator record. |
| Check-in / presence | Declared seat axes and optional genuine flight ID; project/module presence, seat presence and fleet state individually; real polling cadence only when a poller exists. |
| Dispatch / wake | Receive mechanism, active-turn/idle behavior, one designated consumer, public route and independently observed wake evidence. |
| Flight / task receipts | Identify the applicable protocol. Record delivery, exact runtime consumption, completion/artifact hash and independent verdict separately. Record flight/cost evidence only when available. |
| Recovery / removal | Durable intake/cursor/dedupe, replay behavior, process stop and routing cleanup separately, queued-work disposition, disable/revoke path, and who is authorized to repair. Poll TTL expiry does not withdraw an inbox route; deregistration/detach can change fallback routing and are not a complete execution stop. |
| Review | Independent gate, exact artifact/commit, test evidence, and current verdict. An author or transport ACK cannot supply the independent verdict. |
| Known gaps | Exact error, unsupported feature or unknown value; last checked date; existing issue/owner for the next step. |

## Apply the record

1. Use [Add an agent](add-an-agent.md) for the correct bearer or OAuth door.
   Confirm identity and scope before loading work. `boot_context` on the full MCP
   door may update presence; use `task_get` for the documented read-only check.
2. Load [pot operating context](../pot-operating-context.md) and the workspace's
   instructions. Record actual runtime metadata and check in with truthful axes.
3. Verify presence surfaces independently. For a scheduled runner, use its real
   cadence and the runner playbook; do not invent a schedule to make a seat look live.
4. Test the authorized receive path with a bounded canary. A send/reply or a
   consumed inbox row is only evidence for that stage.
5. For dispatched work, follow [runtime.dispatch/v1](../operations/runtime-dispatch-v1.md):
   runtime consumption, completion/failure, then independent review. For work
   never dispatched, follow `task_submit_result` in the
   [current MCP instructions](../../src/mcp/instructions.ts).
6. Keep Flight-3 separate: its assignment, seat generation, encrypted ingress,
   signing authority and signed evidence are additional requirements. Do not
   manufacture them for an ordinary task or messaging test.
7. Test restart/replay and removal only within the approved scope. Verify both
   process state and routing/work disposition; do not treat TTL expiry or a
   stopped receiver as poll deregistration. See the Digid example's shutdown
   limitations before prescribing `resident` mode or detach. Record skipped
   stages as untested, then update this existing row instead of creating a
   parallel support matrix.

## Consolidation boundary

The older guides remain linked for harness-specific procedures. Where they
conflict, use the canonical onboarding and current contract, and record the
correction under #1719. Known drift includes blanket OAuth "never agent-bound"
claims, SSE examples, inline-token examples, old runner/result flows, and
ChatGPT "inbox-only" claims. This index does not silently certify those examples
or change runtime/grant/deployment behavior.
