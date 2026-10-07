# Digid: setup in a saved ChatGPT cloud environment

Start at [Add an agent](add-an-agent.md) and keep the
[common setup record](harness-setups.md) beside this example.

**Snapshot: 2026-10-07. Status: one task completed using the existing cloud
agent's own token was approved by an independent gate at 04:06 UTC and is done; its flight landed
at 04:33:46 UTC with `cost_metered: false` (cost unknown, not zero). The full
46,157-byte UTF-8 project-memory record was reported read back 7/7 with SHA256
`e75bcf23cbb894bf5d8ee99898fe5f3e9c08fb65c56aa222634b7829ad8a3e5e`. The
navigation change remains a stored proposal, not merged. See "Current evidence"
below; the 00:38 UTC troubleshooting table is kept as history.**
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
- an older `claude` registry label did not establish the actual runtime/model;
- a later finite receive test registered poll presence and verified the inbox
  route, without establishing an unattended or permanently live worker.

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

The actual launch observed so far was parent-initiated. A finite, explicitly
started receive window was subsequently tested; this does not install a daemon
or establish autonomous cloud wake. Use the actual server-returned cadence and
handle both process shutdown and routing registration at the approved boundary.
Stopping the process alone does not withdraw the poll route; see the shutdown
limitations below.

## Current evidence (2026-10-07)

| Stage | Observation | What this does not establish |
|---|---|---|
| Bounded external execution | On the **mumega** pot under the Digid project (no separate Digid tenant). The existing cloud agent, using its own token, received one authorized task over the inbox route, submitted runtime receipts that the server recorded (intake and an accepted `completed`), and delivered an artifact whose digest matched on independent readback. | Autonomous cloud wake (the cycle was started by an active session), a fresh-instance replay, or which runtime carried the work: receipts are agent-submitted, so the carrying runtime is agent/session-reported. |
| Review and rework | The independent gate first rejected the artifact for rework, because required items existed only in the executor workspace. After an inbox redispatch it approved the task at 04:06 UTC; the task is done. | That any other task or the original #1723 task was re-verified. |
| Memory readback | The full 46,157-byte UTF-8 project-memory record was reported read back 7/7 by id (operating-session report; bytes and hash recomputed independently) with SHA256 `e75bcf23cbb894bf5d8ee99898fe5f3e9c08fb65c56aa222634b7829ad8a3e5e`. | Semantic recall of large records, which embeds only a prefix. |
| Flight and cost | The flight landed at 04:33:46 UTC with `cost_metered: false` and cost `null`. | Any cost figure: unmetered means unknown, not zero. |
| Navigation | The navigation change is stored as a proposed integration package. | A merged navigation change. |

Private task, flight, dispatch and verdict identifiers stay in the project
evidence record, not this public guide.

## Earlier troubleshooting snapshot: 00:38 UTC

This table is history, preserved as recorded at 00:38 UTC. It is not current
status; see "Current evidence" above.

| Stage | Observation | What this does not establish |
|---|---|---|
| Own-token messaging | [#1715](https://github.com/Mumega-com/mupot/issues/1715) reports an October 6 Rava-to-Digid-cloud request/reply round trip with matching SHA256. | Autonomous cloud wake, task execution, review or an executed flight. |
| Identity and source context | October 7 session reported own-token identity verification and successful retrieval of the selected pinned project sources. | A fresh-environment replay by another operator. |
| Project/module presence | October 7 session reported online during the turn, then offline afterward. | Fleet registration or dispatch eligibility. |
| Seat check-in | The seat remained active at the later readback. | A still-running worker; this signal differed from project presence. |
| Fleet runtime | Initial plain check-in left fleet readback empty, with null runtime/report timestamp and `live: false`. Later poll-mode check-in produced `presence_mode: poll`, `status: running`, `live: true`, verified by the cloud session and Kasra. | Perpetual liveness, autonomous wake or actual task consumption. The later state is a time-bounded readback. |
| Original dispatch | The synchronous dispatch response reported `delivery_forced_predicted: no_delivery_mode`: the requested forced inbox route was not accepted because no delivery surface was registered. The dispatch itself still proceeded; this was a prediction before the queue consumer selected the actual route. A later read showed a consumed dispatch with `delivered_via: null`. [#1721](https://github.com/Mumega-com/mupot/issues/1721) records Kasra's diagnosis: the built-in AgentDO `in_worker` path ran; there was no external consumer. | Consumption by this exact cloud runtime. The historical receipt's null delivery mode is tracked on #1721; in-Worker settles since #1725 stamp `in_worker`. |
| Task/artifact | The task showed `artifact_verification_failed:no_artifact_claimed`. #1721 attributes this to the built-in AgentDO execution cycle; the cloud worker reported no task mutations. | A valid artifact claim or completion by the external cloud worker. Do not describe this as no execution anywhere. |
| Execution and gate receipts | External runtime/gate timelines were empty. An `execution_receipt_get` lookup used a dispatch-receipt ID and returned `404 receipt_not_found`. These are different receipt kinds; the 404 was a lookup mismatch, not a second observability defect. | A correlated external runtime-consumed/completed receipt or independent verdict. |
| Finite receive test | A requested 30-second interval was returned by the server as 60 seconds, with TTL 180 seconds. The first window made five peeks at 30-second spacing over two minutes and found no delivery because the task was blocked; that receiver then stopped. A later recovery window used the actual 60-second cadence. Process evidence at the pre-cycle checkpoint confirmed that receiver stopped, despite persisted poll/live fleet state. This did not deregister its inbox route; TTL expiry alone would not do so either. | Delivery in either window, unattended receiving, or an ongoing receiver. Fleet state is not a process check. |
| Recovery and flight | An initial flight was held at readiness `0.418` against threshold `0.5`. A later replacement flight was reported preflight-go at `0.942`. [#1723](https://github.com/Mumega-com/mupot/issues/1723) records that task redispatch still failed with `task_not_dispatchable`: the original consumed in-worker dispatch receipt was unsettled, and its no-message shape also blocked lease-reset repair (historical; fixed by #1725, issue #1723 closed). | External cloud task delivery/execution, artifact completion, verdict or departure proved by runtime receipts. Preflight-go is not execution evidence or permission to bypass recovery gates. |
| Budget and cost | Session report at the earlier checkpoint: initial flight budget allocation `500000 microUSD` ($0.50); original built-in in-worker cost `30720 microUSD` ($0.03072). | External cloud flight cost, total reconciled spend or cost efficiency. Allocation is not spend, and the original built-in cost is not this held flight's consumption. |

**Evidence provenance:** the October 6 messaging/wake summary is published in
#1715. October 7 presence/runtime observations are Rava's operating-session
report; a sanitized machine-verifiable external-runtime receipt is still absent.
The in-worker diagnosis and null delivery-mode defect are published in #1721;
the unsettled-receipt recovery blocker is published in #1723. Later poll-route,
receiver-process, flight-readiness and budget observations are reported by the
cloud session and Kasra. Live D1 findings were not independently re-tested by
this documentation pass. Private identifiers and credentials are excluded.

## Dispatch, recovery and review

Check-in, project presence, fleet registration, message delivery, runtime
consumption, artifact completion and review are independent facts. The initial
registration gap was resolved for the tested active session. Readiness held the
first flight, and a later replacement was reported preflight-go. The unsettled
in-worker receipt in #1723 was fixed in source (#1725; not re-verified on the
original task). The bounded execution above, a different task, then completed
through the inbox route. The cloud
receiver's current process state must be read fresh; retained fleet poll/live
state does not make it a running process.

The [routing source at cd2d4060](https://github.com/Mumega-com/mupot/blob/cd2d4060b7d0d56a8cb9915db55849872ccf1050/src/bus/consumer.ts)
was inspected for this guide: natural inbox routing requires poll presence, or a
nonempty runtime that is live. A forced inbox route still needs a registered
delivery surface. Otherwise the built-in `in_worker` path is selected. This
agrees with Kasra's diagnosis in #1721.

For an actual scheduled/polling non-resident worker, the existing
[runner playbook](../playbooks/runner-onboarding.md) uses
`check_in({ presence_mode: "poll", poll_interval_sec: <actual cadence> })`.
The [poll upsert](https://github.com/Mumega-com/mupot/blob/cd2d4060b7d0d56a8cb9915db55849872ccf1050/src/fleet/registry.ts)
inserts the caller's own fleet row with `presence_mode: "poll"`, an empty runtime
and `lifecycle: "on_demand"`. On conflict, it refreshes poll fields but preserves
the existing runtime and lifecycle; it does not normalize an older lifecycle. Read that fleet value back to verify the
registration. This step was performed in the finite receive test above. Use the
server-returned 60-second cadence for this observed configuration, not the
initial requested 30 seconds; read back the actual values again in a new setup.
A parent-launched one-off without a real polling loop must not invent an interval
or declare an always-on lifecycle just to obtain routing. A poll check-in's
180-second TTL governs displayed liveness, not poll-route removal. The consumer
selects inbox for an active poll registration even when `live` is false.

Keep the delivery-mode fix on #1721, the unsettled-receipt history on #1723, and
the documentation on #1719. This guide starts no parallel implementation. The
lease-reset path described for #1723 is historical; use the current runtime
dispatch contract for recovery. Current recovery semantics:

- [#1734](https://github.com/Mumega-com/mupot/pull/1734): a newer dispatch may
  take over an old execution pointer only when the pointed run is finished
  (dispatch settled, or a terminal runtime receipt recorded) and the incoming
  dispatch is newer; a live run with no terminal receipt still blocks.
- [#1735](https://github.com/Mumega-com/mupot/pull/1735): `project_memory_get`
  returns a record's full text, byte length and hash, under project-scope access.
- [#1737](https://github.com/Mumega-com/mupot/pull/1737): a flight may land
  unmetered; unmetered cost is unknown, not zero.

Keep operator approval, preflight, dispatch, external consumption and review as
separate steps. A reported approval does not replace the recorded authorization required by the
applicable gate. Do not start a second receiver or bypass the gate
to make the board look settled. #1723 also records proposed system-derived
neutral priors for executors with no history; do not present that proposal as
current implemented behavior.

When an authorized dispatch does reach this runtime, use its actual leased
message/attempt and the contract's runtime receipt stages. Ordinary task
dispatch does not establish Flight-3's additional signed-delivery guarantees.
A restart must preserve durable intake and idempotency; model prose is not a
substitute for a consumption receipt. Apply the
[harness safety contract](../architecture/agent-harness-contract.md) before
describing any unattended receiver as conformant.

An independent gate reviews the exact artifact and digest. Messaging success,
transport consumption, and the author's own assessment do not complete that gate.

## Shutdown limitations: process, route and work are separate

Source-checked at `bf68e83c`; these are existing control semantics, not a
verified end-to-end shutdown recipe:

- Stopping the local receiver or waiting out its TTL leaves an active poll
  registration eligible for inbox routing. New work can accumulate unread.
- The caller's `check_in({ presence_mode: "resident" })` clears the poll
  registration; it is not an explicit stop. [The handler](../../src/mcp/index.ts) calls
  `clearPollFleetPresence` and returns `poll_registration_cleared: true`.
  [The update](../../src/fleet/registry.ts) clears mode/TTL but leaves
  status, runtime and lifecycle unchanged. It does not start a resident process.
- The authenticated [detach routes](../../src/fleet/attach-routes.ts) mark the
  owned fleet row `stopped` and clear poll mode/TTL; they do not stop the host
  process themselves. A later poll check-in does not resurrect a stopped row.
- Since #1739 and #1743 (deployed; prod `/health` `bf68e83c`), a **stopped**
  fleet row is a dispatch fence. Dispatch to a stopped receiver is refused with
  409 `receiver_not_live` before any receipt is minted. For queue-dispatched
  work, the same stopped-row check also sits inside the inbox envelope INSERT
  and the in-Worker claim UPDATE, so a detach that commits before delivery or
  claim refuses it, and the existing receipt settles `failed` /
  `receiver_not_live`. Direct in-Worker callers are unfenced, and a detach after
  the claim does not stop an in-flight run. A merely stale poll registration
  (not stopped) keeps the mailbox and returns a warning; that policy is pending
  (#1740). The AgentDO wake call can precede the refusal. Nothing kills
  already-claimed work or recalls an existing envelope. No end-to-end
  stop/restart run has verified this ([#1743](https://github.com/Mumega-com/mupot/pull/1743)).
- `flight_cancel` is not verified quiescence. Effects of a routine action that is
  already running can still commit after a cancel
  ([#1746 review, P1](https://github.com/Mumega-com/mupot/pull/1746#discussion_r4204375480)).
- A resident check-in alone (no stopped row) is not a no-execution fence. With no eligible external
  surface, normal dispatch can fall back to `in_worker`. If a nonempty runtime
  remains, a forced inbox request can still pass the registered-surface test
  even while that row is not live. Existing inbox deliveries and in-flight work
  are not canceled by these presence changes.

An authorized operator must account for new dispatches, queued/in-flight work,
local process state and the post-change route before using either control as
part of shutdown. Read back mode, status, runtime and route separately.
**Unresolved:** the stopped-row fence above covers new dispatch, but this example
still has no verified end-to-end quiesce/dispatch-hold procedure that
prevents both unread inbox accumulation and unintended in-worker execution
through the whole stop/restart boundary. Do not run deregistration or detach as
an automatic "safe stop" based on this guide. Keep the receiver's observed
process stop distinct from a secure system-wide stop.

## Remaining setup checklist

- [x] Bounded external execution: the existing cloud agent's own token received,
      completed and passed independent review on one authorized task (receipts in
      the project evidence record; carrying runtime agent/session-reported).
- [ ] Attach sanitized evidence of which runtime carried the work; retain #1721's in-worker attribution.
- [x] Retain artifact digest, completion receipt and independent verdict.
- [x] Read back the full project-memory record by id (reported 7/7; bytes and hash recomputed).
- [x] Confirm receiver stopped from process evidence (pre-cycle checkpoint; read current process state fresh); retain the finite-window limit.
- [ ] Run a second end-to-end task.
- [ ] Verify cold wake (a stopped agent starting on its own) separately if implemented.
- [ ] Verify a full stop/restart: routing cleanup, dispatch hold, replay and
      disable/removal. Process stop and TTL expiry are not completion of this step.
- [ ] Fence routine-action effects on cancel (#1746 review P1).
- [ ] Merge the navigation integration (currently a stored proposal).
- [ ] Verify #1723's recovery on its original task (fixed in source, #1725; not retried).
- [ ] Re-run the documented setup in a fresh instance and pin runtime/version.

These are evidence gaps, not instructions to execute the actions now.
Maintain this example under [#1719](https://github.com/Mumega-com/mupot/issues/1719).
The [#1590 adapter lifecycle proposal](https://github.com/Mumega-com/mupot/issues/1590)
remains a separate implementation direction.
