# Backlog, Gates and a Trustworthy Executable Queue

## Purpose

Mupot’s Home and approval surfaces can show a large historical decision backlog. The product must not present that collection as a trustworthy executable queue until each record’s identity, dependency, evidence and authority are current.

This document captures a September 2026 read-only audit from a caller-scoped Hadi ChatGPT view. It is a maintenance and product-design guide, not a bulk cleanup instruction.

## Evidence boundaries

- The Hadi ChatGPT-visible scope is not a tenant-wide database export.
- UI observation is not database proof.
- Age is a freshness signal, not proof of obsolescence.
- A closed GitHub issue or PR is reconciliation evidence, not automatic Mupot completion, gate approval, artifact validation or deployment proof.
- No task, request, gate, assignment, external issue or deployment was changed during the audit.
- Hadi reported that the Home Answer/resolution experience is broken or non-working. The audit did not exercise an approval/resolution control, so this is a reported UX defect requiring a safe staging or controlled-browser reproduction, not a conclusion about a server mutation path.

## Read-only findings

### Attention and approval queue

The visible attention result contained 74 records: 73 approvals and one routine-budget request. Sixty-five belonged to Mupot Development and nine to Autonomous Squads Proof. Fifty-two were older than 30 days; 65 were older than seven days. The largest gate concentration was `gate:kasra-core` (56 visible records), followed by `gate:athena` (8). This describes an attention backlog, not a list of tasks ready to execute.

### Task records

Status-filtered task reads returned 56 records in the caller scope: 26 open, one in progress, six blocked, 13 review and ten rejected. Rejected is reported separately because its presence in task-list output does not prove it is an executable nonterminal state.

| Signal | Count | Why it matters |
|---|---:|---|
| Nonterminal records without project context | 43 | Work cannot reliably be grouped by objective or evidence. |
| Open records without assignee | 16 | Valid backlog may look indistinguishable from forgotten work. |
| Stale-assignee flags | 40 | Canonical identity, binding or runtime may no longer match the record. |
| Review records without a gate owner | 0 | Positive structural property in the visible review set. |
| Duplicate/successor families | 2 | Historical and current work can compete for action. |

Read-only GitHub samples found closed external references while corresponding Mupot approvals remained open. Reconciliation must inspect the Mupot result, receipt, gate state, successor and deployment separately; it must not auto-close a record.

## Lifecycle distinctions

| Object | Meaning | Is not equivalent to |
|---|---|---|
| Request/attention item | A caller needs information, budget or a decision. | A task, approval or executable command. |
| Task | A governed work record with status, assignee, project and done-when. | Runtime execution or completion. |
| Gate | An eligibility/decision constraint on a result or action. | A review comment or a task title. |
| Receipt | Durable evidence of a specific lifecycle event. | A UI card, model message or transport attempt. |
| External work | GitHub PR/issue or provider record. | Mupot result, verdict or deployment. |
| Deployment | A separate release/health receipt. | Merge, approval or runtime heartbeat. |

## Why backlog and gates remain open

1. **Freshness has no visible lifecycle.** Older records do not become a named reconciliation state with an accountable owner.
2. **External state is disconnected.** A PR or issue can close without a clear Mupot reconciliation record.
3. **Evidence is too raw.** Long historical bodies can appear before the current result, artifact, gate owner and last evidence timestamp.
4. **Gate concentration hides dependencies.** A single gate owner receives many unrelated historical records without a grouped dependency view.
5. **Project and successor metadata are sparse.** Historical flight lanes and current work appear side by side without an explicit canonical record.
6. **Resolution UX is unclear.** A person cannot tell whether answering a queue item records information, changes a routine budget, creates a verdict or merely navigates elsewhere.

## Safe review and cleanup sequence

1. **Reconcile before action.** Resolve canonical task ID, current project, status, gate, last evidence, external reference and successor/dependency.
2. **Review routine/budget requests separately.** They are not gate approvals.
3. **Batch review by gate owner only after evidence preflight.** Display the exact result/version and holder eligibility.
4. **Reconcile stale assignees before dispatch.** Verify canonical identity, binding and runtime route. Prepare reassignment; do not change it silently.
5. **Review historical/rejected lanes last.** Archive or supersede only through record-level human review with a successor link and preserved receipt trail.

No bulk close, archive, reassign or approval operation is safe from this audit alone.

## Proposed master executable-action queue

This is a projection over existing records, not a second task system. It should show only work that has passed relevant preflight checks, with these labels:

- **Ready:** canonical task, current project/context, eligible executor and no unresolved dependency.
- **Waiting on task:** a canonical dependency or successor relation is open.
- **Waiting on runtime:** assignee identity/binding/presence is not current.
- **Waiting on evidence:** result, artifact or receipt is missing.
- **Waiting on human decision:** gate holder and concise evidence are available.
- **Externally changed:** linked external record changed and needs reconciliation.
- **Stale review:** freshness threshold crossed; no automatic status mutation.
- **Historical/rejected:** retained for audit; not dispatchable absent an explicit successor.

The continuation loop should refresh these projections from existing task, receipt, gate, runtime and external-reference facts. It should create a reconciliation suggestion when facts drift; it must not mutate work, invent a completion, or become a second dispatcher.

## Prevention requirements

1. Require project context or an explicit organization-level rationale for executable work.
2. Require a canonical successor/dependency link before creating a related slice or lane.
3. Surface stale assignee cause and safe reassignment proposal before dispatch.
4. Surface a review action only when the gate has an eligible holder and the result/version/evidence summary is present.
5. Add read-only external reconciliation signals; require human confirmation for any status change.
6. Paginate queue cards and load historical evidence on demand.
7. Test the Answer/resolution interaction in a disposable staging tenant, including permission denial, validation failure, retry and durable receipt feedback.

## Related documentation

- [Gate protocol](../../gate-protocol.md)
- [Security model](../../security-model.md)
- [Runtime adapter contract](../../runtime-adapter-contract.md)
- [Capability discovery](./capability-discovery.md)
- [Journey validation](./journey-validation.md)
