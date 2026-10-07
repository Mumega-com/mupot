# Digid: setup in a saved ChatGPT cloud environment

Start at [Add an agent](add-an-agent.md) and keep the
[common setup record](harness-setups.md) beside this example.

**Snapshot: 2026-10-07 UTC. Status: partially verified; external cloud execution unproven.**
This records one existing setup and its evidence limits. It is not an autonomous
cloud-worker install claim, a new receiver design, or approval to provision a
tenant, mint credentials, launch work, repair dispatch state, or deploy anything.

## Identity and actual runtime

The Digid cloud worker uses its **own agent-bound workspace token**. Rava's
ChatGPT OAuth connector is a separate identity/receiving surface. Never copy
Rava's credential into the worker or infer the worker's agent from a saved
environment name, token filename or old registry label.

The October 7 operating session reported:

- authenticated own-agent identity checks succeeded;
- provider metadata was `OpenAI`, model family `GPT-6`; the exact variant was
  not exposed and remains unknown;
- `check_in` used `harness: "unknown"`, reflecting the current enum rather
  than inventing a `codex-cli` identity;
- an older `claude` registry label did not establish the actual runtime/model.

These are session-reported observations, not independently attested model
measurements. Retain the actual engine/version if the platform exposes it later.

## Reproduce the setup within approved scope

1. Select the existing saved Digid cloud environment. Verify its repository,
   pinned ref, working directory and runtime capabilities in that environment.
   Keep private environment, machine and thread identifiers in the protected
   operator record, not this public guide.
2. Use the already-approved agent-bound credential through the environment's
   protected secret mechanism. If it is missing or revoked, stop for the
   authorized credential flow in [Add an agent](add-an-agent.md); never paste a
   bearer into a prompt, source file or receipt.
3. Read the selected workspace's `AGENTS.md` and pinned project sources.
   Confirm authenticated agent, tenant, squad/project and capability floor
   before accepting work. A historical Digid context example is a map, not
   proof that a separate Digid tenant has been provisioned.
4. Declare a distinct seat with actual known runtime axes. Use `unknown` where
   the [current harness enum](../../src/fleet/presence.ts) cannot represent the
   platform. Omit unavailable model detail rather than guessing. Do not attach
   a flight ID unless a real flight exists.
5. Read back project/module presence, seat check-in and fleet runtime state
   separately. Record the resulting values even when they disagree.
6. For work already assigned and authorized, inspect the task and dispatch
   evidence before execution. Follow the existing
   [runtime dispatch contract](../operations/runtime-dispatch-v1.md). An external
   message or a changed task status is not fresh authority.
7. Record an artifact path and digest, applicable runtime receipts and an
   independent verdict only if those stages actually occurred. Do not mark this
   setup operational merely because messaging or check-in succeeded.

This example does not prescribe a new poller, heartbeat daemon, adapter, or
background wake mechanism. The actual launch observed so far was parent-initiated.

## Evidence by stage

| Stage | Observation | What remains unproven |
|---|---|---|
| Own-token messaging | [#1715](https://github.com/Mumega-com/mupot/issues/1715) reports an October 6 Rava-to-Digid-cloud request/reply round trip with matching SHA256. | Autonomous cloud wake, task execution, review and a flight. |
| Identity and source context | October 7 session reported own-token identity verification and successful retrieval of the selected pinned project sources. | A fresh-environment replay by another operator. |
| Project/module presence | October 7 session reported online during the turn, then offline afterward. | Fleet registration or dispatch eligibility. |
| Seat check-in | The seat remained active at the later readback. | A still-running worker; this signal differed from project presence. |
| Fleet runtime | Fleet readback remained empty, with null runtime/report timestamp and `live: false`. | A registered, reachable execution runtime. |
| Dispatch | The session first reported `no_delivery_mode`, then a consumed dispatch with `delivered_via: null`. [#1721](https://github.com/Mumega-com/mupot/issues/1721) records Kasra's diagnosis: the built-in AgentDO `in_worker` path ran; there was no external consumer. | Consumption by this exact cloud runtime. The missing delivery-mode stamp is the tracked observability defect. |
| Task/artifact | The task showed `artifact_verification_failed:no_artifact_claimed`. #1721 attributes this to the built-in AgentDO execution cycle; the cloud worker reported no task mutations. | A valid artifact claim or completion by the external cloud worker. Do not describe this as no execution anywhere. |
| Execution and gate receipts | External runtime/gate timelines were empty. An `execution_receipt_get` lookup used a dispatch-receipt ID and returned `404 receipt_not_found`. These are different receipt kinds; the 404 was a lookup mismatch, not a second observability defect. | A correlated external runtime-consumed/completed receipt or independent verdict. |
| Flight and cost | No flight or cost telemetry was established. | Any flight execution, measured spend or cost-efficiency claim. |

**Evidence provenance:** the October 6 messaging/wake summary is published in
#1715. October 7 presence/runtime observations are Rava's operating-session
report; a sanitized machine-verifiable external-runtime receipt is still absent.
The in-worker diagnosis and null delivery-mode defect are published in #1721.
Live D1 findings are attributed to Kasra's report, not independently re-tested
by this documentation pass. Private identifiers and credentials are excluded.

## Dispatch, recovery and review

Check-in, project presence, fleet registration, message delivery, runtime
consumption, artifact completion and review are independent facts. The observed
mismatch is precisely why this example is not marked fully operational.

The [routing source at cd2d4060](https://github.com/Mumega-com/mupot/blob/cd2d4060b7d0d56a8cb9915db55849872ccf1050/src/bus/consumer.ts)
was inspected for this guide: natural inbox routing requires poll presence, or a
nonempty runtime that is live. A forced inbox route still needs a registered
delivery surface. Otherwise the built-in `in_worker` path is selected. This
agrees with Kasra's diagnosis in #1721.

For an actual scheduled/polling non-resident worker, the existing
[runner playbook](../playbooks/runner-onboarding.md) uses
`check_in({ presence_mode: "poll", poll_interval_sec: <actual cadence> })`.
The [poll upsert](https://github.com/Mumega-com/mupot/blob/cd2d4060b7d0d56a8cb9915db55849872ccf1050/src/fleet/registry.ts)
writes the caller's own fleet row with `presence_mode: "poll"` and an on-demand
lifecycle; runtime may remain empty. Read that fleet value back to verify the
registration. This is the documented contract, not a step already performed in
this example. A parent-launched one-off without a real polling cadence must not
invent an interval or declare an always-on lifecycle just to obtain routing.

Keep the delivery-mode fix on #1721 and the documentation on #1719. Do not start
a second receiver or infer that re-dispatch will repair the existing task. Do not
ACK, reset, terminate, reassign or redispatch merely to make the board look settled.

When an authorized dispatch does reach this runtime, use its actual leased
message/attempt and the contract's runtime receipt stages. Ordinary task
dispatch does not establish Flight-3's additional signed-delivery guarantees.
A restart must preserve durable intake and idempotency; model prose is not a
substitute for a consumption receipt. Apply the
[harness safety contract](../architecture/agent-harness-contract.md) before
describing any unattended receiver as conformant.

An independent gate reviews the exact artifact and digest. Messaging success,
transport consumption, and the author's own assessment do not complete that gate.

## Remaining setup checklist

- [ ] Attach sanitized external-runtime consumption evidence; retain #1721's in-worker attribution.
- [ ] Demonstrate the intended runtime consuming one authorized task.
- [ ] Retain artifact/digest, completion receipt and independent verdict.
- [ ] Verify restart/replay and disable/removal behavior within approved scope.
- [ ] Verify autonomous cloud wake separately if that capability is implemented.
- [ ] Record flight and cost telemetry only for a real flight.
- [ ] Re-run the documented setup in a fresh instance and pin runtime/version.

These are evidence gaps, not instructions to execute the actions now.
Maintain this example under [#1719](https://github.com/Mumega-com/mupot/issues/1719).
The [#1590 adapter lifecycle proposal](https://github.com/Mumega-com/mupot/issues/1590)
remains a separate implementation direction.
