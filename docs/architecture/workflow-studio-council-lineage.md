# Workflow, Studio, Council, and Discovery Lineage

**Status snapshot:** 2026-09-05. This is a technical-history and evidence guide,
not a deployment record or an implementation authorization.

## Reading status correctly

The terms in this document deliberately do not collapse:

| Label | Evidence required |
|---|---|
| **Merged** | A pull request merged to the repository default branch. |
| **Deployed** | A matching deployment receipt or independently verified running version. |
| **Local-only** | A worktree or commit was inspected, but no reviewable PR/merge was found. |
| **Plan-only** | A design exists without a runnable implementation or production evidence. |
| **Live-proven** | An exact runtime, input, receipt chain, and terminal result were observed. |

Do not infer a later label from an earlier one.

## What is merged in Mupot

### Workflow foundations

| Surface | Evidence | What it provides | What it does not provide |
|---|---|---|---|
| Workflow Circuits | [PR #607](https://github.com/Mumega-com/mupot/pull/607), merged 2026-07-29 | Deterministic graph definitions, typed dependency/gate/trigger/fallback edges, structural validation, and explicit gate transitions. | A customer-facing graph editor or a generic external workflow runner. |
| Project Routines | [PR #579](https://github.com/Mumega-com/mupot/pull/579), merged 2026-07-27 | Durable routine/routine-run state, schedule and policy controls. | A general DAG, a free-form agent loop, or proof of desktop runtime consumption. |
| Routine cron dispatch | [PR #1229](https://github.com/Mumega-com/mupot/pull/1229), merged 2026-08-26 | Due-routine scheduling and governed task-dispatch support. | Verified end-to-end execution on an external desktop harness. |
| Durable task workflow | [`2af1925`](https://github.com/Mumega-com/mupot/commit/2af1925a1cdb69ae4d94436063cac86fe21a7089) | Cloudflare task-lifecycle orchestration and gate waiting. | A visual workflow authoring product. |

The operational model is therefore layered:

```text
Circuit = rule graph
Routine = schedule, owner, policy, and run history
Task workflow = durable task lifecycle
Runtime adapter = exact host wake and consumption evidence
Gate = independent approval of a completed result
```

Keeping these layers separate prevents a visual canvas, schedule, or delivery
receipt from being misreported as completion or authorization.

### Visual workflow gap

[Issue #1032](https://github.com/Mumega-com/mupot/issues/1032) records the
missing circuit-canvas projection. The cited older dashboard path is no longer
current, so the first implementation should be a read-only projection from the
current `workflow_circuits`, routines, tasks, receipts, and gate records—not a
restoration of an obsolete placeholder.

[PR #482](https://github.com/Mumega-com/mupot/pull/482) proposed n8n, Zapier,
and Make workflow ports, but closed without merge. It is useful architecture
history only. The current ToRivers executor intentionally returns `501` rather
than fabricating execution steps or receipts; see
[issue #1017](https://github.com/Mumega-com/mupot/issues/1017). No external
adapter is a production executor until it reports real, correlated evidence.

## Studio is not a durable council

### Merged Studio slice

[PR #1228](https://github.com/Mumega-com/mupot/pull/1228), merged 2026-08-26,
added the Studio Canvas live Supabase Data Feed and Inspector. That is a
data-inspection canvas slice. It is not a multi-agent reflection product or a
general workflow editor.

### Recent Studio lineage reviewed locally

The recent `feat/studio-agentic-chat` line was inspected as local-only work;
no PR was found for its head. Its recorded additions include:

- agentic Studio chat and typed SSE events;
- Canvas tab synchronization for preview/database/log/diff views;
- custom MCP endpoint custody with SSRF/header/secret-collision hardening;
- starter recipes and interactive preview work; and
- an Automations & Workflows view backed by the canonical routine engine,
  with project/squad filtering and scoped agent selection.

The automation creation path is intentionally hard-set to `execution_mode:
propose`. It is not unrestricted internal execution.

Studio contains presentation labels such as “Synthetic Council Gate,” named
reviewers, and “Land / Deploy.” Those labels are not proof of a persisted
council. The inspected lineage has no evidence of all of the following in the
Studio implementation:

- immutable document/version binding;
- a durable participant roster with exact agent, harness, and model identity;
- independent per-participant reflections;
- a comparison/synthesis object tied to those reflections;
- a durable council-run ledger; or
- a council verdict that can authorize a release.

The provenance of a reported Hadi River/Gemini Studio result and the precise
reason it was rejected were not established by the inspected commit/PR history.
Do not infer authorship from model labels in fixtures or infer product intent
from UI copy.

## Topic Council is a distinct local-only lineage

Separate local Topic Council branches contain a materially richer private
advisory design. They model: request authorization, topic/context snapshots,
server-selected allowlisted crew, expert dispatch, quorum, contribution
validation, private synthesis, independent gate, and indexed private update.

Those branches were found stale against current `main`, without a reviewable PR
for their heads and without deployment or live-run evidence. They are therefore
useful as a design/reference source, not as a Studio feature or an operational
council service.

The historical SOS `SwarmCouncil` is a third, different artifact: an in-memory
proposal/vote prototype. It lacks version-bound reflections, durable participant
evidence, comparison/synthesis records, and independent release-gate semantics.
It must not be upgraded implicitly into the Topic Council or used as a
production approval mechanism.

## Inkwell discovery boundary

Inkwell is the strongest existing substrate for a future business-discovery and
knowledge map:

- [business discovery commit](https://github.com/Mumega-com/inkwell/commit/4e210e89d0339505d36902b5f163a8539b0c2210)
  provides questionnaire, readiness scoring, persisted business profiles, and
  staged 90-day plans;
- [Inkwell PR #28](https://github.com/Mumega-com/inkwell/pull/28) provides a
  graph/content/wikilink foundation; and
- onboarding presets provide useful starting shapes.

This is not yet a complete business operating map. Systems, repositories,
documents, integrations, evidence, ownership, credential state, and deployment
readiness are not yet first-class, linked discovery records. The smallest safe
direction is to extend the existing Inkwell profile/graph model with those node
types and explicit `observed`/`verified`/`stale`/`unknown`/`blocked` evidence
state—not to create a parallel wiki.

An advisory Reflection Session may later reuse Inkwell’s immutable content and
graph revision primitives. It must preserve individual views and remain
separate from Mupot authority, task gates, credential actions, merges, and
deployments.

## Recommended dependency order

1. Project existing Circuits/Routines/receipts as a read-only graph before
   adding a visual editor.
2. Keep the canvas, routine policy, durable task execution, external adapters,
   and independent gate as separate surfaces.
3. Define one receipt-bearing external-adapter contract before implementing an
   adapter. It must not manufacture outputs, costs, or completion.
4. Recover or write a fresh product brief before reviving the Topic Council
   work. Build a small advisory reflection session only after the required
   participant, evidence, synthesis, and gate boundaries are explicit.
5. Use the exact-delivery activation boundary in
   [Codex exact delivery status](../operations/codex-exact-delivery-status.md)
   before treating any desktop workflow as live.

## Claims deliberately left unverified

- a deployed visual workflow editor;
- live external automation through ToRivers, n8n, Make, or Zapier;
- automatic capability-keyword task routing;
- a durable Studio or Topic Council reflection session;
- Hadi River/Gemini authorship of the local Studio work; and
- the reason a prior Studio result did not meet user intent.

These are product/research questions, not facts supplied by the current source
history.
