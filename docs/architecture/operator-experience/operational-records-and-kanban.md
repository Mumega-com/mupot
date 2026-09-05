# Operational Records and Kanban Boundaries

## Purpose

Mupot contains several operational record families. They must not be added into
one misleading “open work” total: projects, tasks, attention requests, gates,
receipts, flights, routines, presence, runner records, connectors and external
references each answer a different question.

This document summarizes a September 2026 caller-scoped read-only audit. It
does not contain raw task bodies, credentials, customer data or machine-local
evidence, and it does not authorize cleanup.

## Scope limits

The audit used the Hadi ChatGPT caller scope. It could read two active projects
and 28 Hadi-Mac memberships. Tenant-wide presence, gate-grant and loop reads
were forbidden in that channel. Forbidden means unknown to this audit, not
empty, healthy or absent.

## Record-family rules

| Family | What it represents | Do not mistake it for |
|---|---|---|
| Project | Durable objective/context and lifecycle metadata. | Current runtime, route or deployment. |
| Membership/grant | Agent relationship and scoped authority. | Canonical identity, bound harness or fresh presence. |
| Presence/runner | Reported runtime/seat state. | Verified task execution or completion. |
| Flight | Governed multi-step execution record. | A task, artifact, gate verdict or cost proof. |
| Routine/loop | Defined/scheduled automation and run history. | A currently running or effective automation. |
| Gate | Required decision authority for a result/action. | A live eligible holder or verdict. |
| Receipt | Evidence of one lifecycle event. | A broad health claim. |
| External PR/issue | External work/reference state. | Mupot result, approval or deployment. |

## Observed maintenance signals

- Visible active projects can lack assigned squad, worker and live URL metadata.
- Membership and grant capability can differ; both need to be shown beside the
  canonical agent identity and runtime binding.
- The Hadi-Mac runner read returned no records, while other runtime/presence
  surfaces reported activity. Empty runner records therefore cannot mean no
  runtime exists.
- Routine definitions included enabled cron/manual work, archived probes and
  historical one-off evidence routines. Enabled does not mean running; one-off
  probes need a retention/end condition.
- Historical held/failed/rejected flight records should remain available as
  evidence, but should not compete with current executable work by default.

## Kanban audit

The current Kanban is a perspective-scoped task-like visualization. A
read-only owner view of the Core Platform perspective showed a very large card
list with an Open/P0 headline and a selector for organization, squad and
project perspectives.

It mixed active defects, GitHub-derived mirrors, release/review work, design
items, planning goals, historical probes, gate-labelled cards and unassigned
work. The observed top-level view did not make these fields primary:

- canonical successor or dependency;
- project/context completeness;
- assignee identity/binding/runtime freshness;
- result/artifact/receipt readiness;
- current gate-holder eligibility;
- external-reference freshness or reconciliation;
- clear backlog versus executable filtering.

**Conclusion:** Kanban is useful for browsing a squad/project perspective. It
is not the master executable-action queue.

## Master executable-action queue relationship

The master queue should be a read-only projection over existing records, not a
second task system and not a replacement for Kanban. It admits work only after
canonical task, project/context, dependency, assignee/runtime, evidence and
gate checks are current. It labels records as ready, waiting on task, waiting
on runtime, waiting on evidence, waiting on human decision, externally changed,
stale review or historical/rejected.

Kanban can remain a linked browse view from that projection. Continuation logic
may refresh evidence and create reconciliation suggestions, but it must not
dispatch, reassign, close, archive or infer completion automatically.

## Safe maintenance sequence

1. Reconcile canonical task/successor and external state before action.
2. Verify stale assignee identity, binding and runtime before dispatch.
3. Batch review by gate owner only after result/version/receipt preflight.
4. Retain historical probes, held/failed flights and rejected lanes as evidence;
   review archival only record by record with a successor link.
5. Present permission-limited reads as unavailable, not empty states.

See also [Backlog and gate hygiene](./backlog-and-gate-hygiene.md) and the
[Runtime adapter contract](../../runtime-adapter-contract.md).
