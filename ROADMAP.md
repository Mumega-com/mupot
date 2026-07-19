# Mupot version roadmap

This is the canonical forward-looking product roadmap. [CHANGELOG.md](CHANGELOG.md)
is the canonical record of what has shipped. GitHub milestones use the same version
numbers.

## Current version

| State | Version | Meaning |
|---|---|---|
| Stable release | `v0.23.0` | Trusted Runtime. This is the latest tagged release and the version reported by `https://mupot.mumega.com/health` on 2026-07-19. |
| Development target | `v0.24.0` | Project Operations. Post-`v0.23.0` Project, addon, Project Link, and Agent Host work belongs to this release until its gate passes. |
| Next planned | `v0.25.0` | Project Routines and Needs You. |

Code merged or deployed after `v0.23.0` is not retroactively part of `v0.23.0`.
Until `v0.24.0` ships, those capabilities are preview behavior and must not be
described as stable `v0.23.0` features.

## Product hierarchy

Mupot uses one project-centered vocabulary:

```text
Pot
└── Project
    ├── Squads, agents, goals, context, addons, and links
    ├── Tasks, activity, evidence, and review items
    └── Routine Run
        └── Task + Flight
            └── Runtime Session + Execution Workspace
```

- A **Pot** is the sovereign tenant and policy boundary.
- A **Project** is the durable initiative and context boundary. Projects may have
  one level of child projects.
- A **Squad** owns responsibility and may work across projects.
- A **Routine** decides when saved project work should run.
- A **Loop** decides whether another outcome-seeking cycle is worthwhile.
- A **Flight** is one bounded, metered execution.
- An **Execution Workspace** is runtime filesystem/computer state, not another
  business hierarchy beside Project.

## Activation states

Every feature must use one of these labels in documentation, UI, and release notes:

| State | Promise |
|---|---|
| `stable` | Included in a tagged release, migration-tested, browser-tested where applicable, and supported. |
| `preview` | Present on `main` or a test pot, but not part of the latest stable contract. |
| `opt-in` | Shipped, but disabled until an owner activates the addon, routine, connector, or runtime. |
| `planned` | Assigned to a future version; no availability claim. |
| `exploratory` | Research only; no target version and no implementation commitment. |

## Release sequence

### v0.23.0: Trusted Runtime - stable

**Promise:** A self-hosted pot can connect a bound runtime, grant scoped authority,
run and approve work, retain evidence, recover state, and prove the exact release.

Stable features include:

- pot, organization, squad, member, agent, task, approval, flight, receipt, and audit;
- signed runtime identity, heartbeat, inbox, and lifecycle control;
- scoped MCP task and flight operations;
- GitHub-backed external work verification;
- release, recovery, browser, migration, and runtime conformance receipts.

Anything merged after the `v0.23.0` tag remains preview until a later release owns it.

### v0.24.0: Project Operations - current development target

**One promise:** A human or agent can open a Project and understand its current goal,
team, work, runtime activity, blockers, evidence, and next action without searching
across unrelated Mupot screens.

Must ship:

1. **Complete Project lifecycle**
   - create, edit, pause, complete, archive, and restore from dashboard and MCP;
   - bounded root/child hierarchy with explicit squad access;
   - project search, status filtering, and honest empty/error states.
2. **Project situation view**
   - goal, status, target, latest material activity, open work, blockers, reviews,
     active runtimes, linked projects, and next accountable action;
   - Project tabs become the primary workspace: Overview, Work, Team, Activity,
     Evidence, and Settings.
3. **Project attribution and proof**
   - tasks, flights, messages, verdicts, workflow receipts, dispatches, landings,
     and acknowledgements project correctly into Activity and Evidence;
   - pagination, RBAC, archive, and cross-tenant behavior fail closed.
4. **Project-linked collaboration**
   - Project Link addon supports narrow cross-pot task/evidence exchange;
   - Agent Hosts on Mac or Kubernetes appear as replaceable project executors;
   - Hermes and Codex can exchange correlated project messages without sharing
     owner credentials.
5. **Version honesty**
   - package, public API, health response, changelog, milestone, tag, release, and
     deployed commit all identify `v0.24.0` consistently;
   - local and production browser evidence covers the Project workflow.

Activation:

- Project core: default-on after migration.
- Project Link addon: owner opt-in per pot and explicit link grant.
- Agent Host: owner opt-in per host/profile.

Explicitly not in `v0.24.0`:

- generic scheduled Routines;
- reusable or pinned reasoning sessions;
- a new connector broker or accounting addon;
- per-flight sandbox provisioning;
- autonomous backlog prioritization or FRC-based learning;
- full document-authoring or knowledge-management replacement.

Release gate:

- one Project is created and managed entirely through the UI;
- an agent performs project-attributed work through MCP;
- Activity and Evidence show the same truth after restart and pagination;
- one Mac Agent Host and one Kubernetes Agent Host pass installation evidence;
- one authorized cross-pot Project Link flight succeeds and unauthorized variants fail;
- no unresolved P0/P1 finding in the release scope.

### v0.25.0: Project Routines and Needs You - planned

**One promise:** A Project can run saved work on schedule and place every human
decision in one understandable queue.

Must ship:

- first-class `Routine` and `RoutineRun`, owned by exactly one Project;
- `manual`, `once`, and `cron` triggers with timezone and overlap policy;
- fresh runtime sessions only in the first stable routine release;
- Cloudflare-owned schedule, leases, retries, idempotency, run history, and costs;
- every run dispatches through existing Task, Flight, inbox, gate, and receipt paths;
- Needs You projection over approvals, blocked questions, outputs, budget decisions,
  and reviewed changes;
- Project Activity and Evidence include routine fires, skips, failures, and outcomes.

Activation:

- Routine service and Needs You view: default-on.
- Each Routine: disabled until an authorized human enables it.
- External writes: approval required unless a narrow policy explicitly allows them.

Not in `v0.25.0`: event/webhook/alarm triggers, session reuse, model routing,
per-flight sandboxes, or self-modifying skills.

### v0.26.0: Governed Tools and Marketing/CRO Pilot - planned

**One promise:** A Project routine can use a real business system without exposing
its raw credential to the model, and Marketing/CRO proves the path end to end.

Must ship:

- evolve the existing addon registry and encrypted connector vault into one governed
  tool path: definition, credential profile, grant, binding, action policy, and receipt;
- lazy MCP tool discovery with read, draft, write, publish, delete, and admin action
  classes; payment actions remain blocked in this release;
- immediate revocation and no model-selected tenant, Project, identity, or credential;
- Marketing & CRO addon as the first reference package;
- Mumega pilot first, then DME activation after the same conformance and permission gate;
- AI visibility collection, recommendation review, approved action, and outcome receipt.

Activation:

- Tool governance: default enforcement for brokered tools.
- Connector profiles and Marketing/CRO addon: owner opt-in per Project.
- Customer-facing sends and publishing: gated by default.

Not in `v0.26.0`: accounting, payments, unrestricted tool catalogs, or silent
credential fallback into runtime environments.

### v0.27.0: Agent Computers and Recovery - planned

**One promise:** Substantial flights can run in isolated, recoverable computers without
making one Mac, pod, or agent harness the system of record.

Must ship:

- explicit runtime Session and Execution Workspace lifecycle;
- ephemeral and approved persistent workspace modes;
- Kubernetes Job or compatible sandbox adapter for isolated flights;
- lease renewal, checkpoint/resume contract, reconciler, reaper, and teardown receipt;
- fresh credentials on resume and purge on teardown;
- compute, storage, connector, and model cost attribution;
- runtime adapter neutrality for Hermes, Codex, Claude Code, and later harnesses.

Activation:

- Existing trusted Agent Host remains the default executor.
- Isolated computer mode starts opt-in by Project/Routine and becomes default only
  after recovery and cost gates pass.
- `reuse` and `pinned` sessions remain opt-in.

### v0.28.0: Compounding Project Knowledge - planned

**One promise:** Projects improve from measured outcomes without confusing generated
memory with evidence or allowing agents to widen their own authority.

Must ship:

- project resources and document/artifact index;
- explicit session, agent, Project, pot, and evidence memory scopes;
- proposed skill, routine, methodology, and memory changes through review;
- revision activation, rollback, evaluation cases, and activation receipts;
- operational coherence evaluation: declared boundary, baseline, observable KPI,
  intervention, outcome, cost, negative control, and kill condition;
- Project health and outcome history based on evidence, not activity volume.

Activation:

- Knowledge proposals: default-on.
- Promotion and policy changes: human approval required.
- Automated Project prioritization: opt-in only after held-out evaluation.

### v0.29.0: Distribution and Commercial Operations - planned

**One promise:** A customer can install, operate, upgrade, and commercially license a
Mupot without Mumega performing hidden manual steps.

Must ship:

- guided self-host install and upgrade for Cloudflare plus supported Agent Hosts;
- deterministic backup, export, restore, rollback, and audit export;
- addon/package compatibility and signed distribution receipts;
- clear non-commercial, evaluation, and commercial licensing paths;
- managed-support boundaries, entitlement hooks, and operator documentation;
- onboarding and billing proof for the first external design partner.

### v1.0.0: Governed Business Loop GA - planned

**Promise:** At least one real business operates a Project end to end through Mupot:
signals enter, Routines dispatch governed Flights, humans review risky decisions,
approved actions reach external systems, outcomes return, and the Project improves from
verified evidence.

GA requires frozen public contracts, supported upgrade compatibility, production SLOs,
security review, recovery evidence, legible costs, and one reproducible Mumega/DME case
study. Feature count alone cannot satisfy the GA gate.

## Capability ledger

| Capability | Stable version | Activation |
|---|---|---|
| Identity, squads, tasks, gates, flights, receipts | `v0.23.0` | Default-on |
| Signed runtime and scoped MCP work | `v0.23.0` | Host enrollment required |
| Projects and nested project context | `v0.24.0` | Default-on after migration |
| Project Activity and Evidence | `v0.24.0` | Default-on |
| Project Link | `v0.24.0` | Opt-in per link |
| Mac/Kubernetes Agent Host | `v0.24.0` | Opt-in per host/profile |
| Routines and RoutineRun | `v0.25.0` | Each Routine explicitly enabled |
| Needs You review inbox | `v0.25.0` | Default-on projection |
| Governed connector actions | `v0.26.0` | Connector and grant required |
| Marketing & CRO addon | `v0.26.0` | Opt-in per Project |
| Isolated Agent Computers | `v0.27.0` | Initially opt-in |
| Reviewed knowledge and coherence evaluation | `v0.28.0` | Promotion gated |
| Commercial installation and operations | `v0.29.0` | License/entitlement dependent |
| Governed business loop GA | `v1.0.0` | Stable supported product |

## Scope-control rules

1. **One release, one promise.** A feature enters a version only when it directly
   serves that version's promise.
2. **No unmilestoned implementation.** Every implementation issue must name one target
   version before work starts. Research may remain `exploratory` without a milestone.
3. **In means something leaves.** Adding a must-have after implementation begins requires
   removing another must-have, splitting the release, or changing the version.
4. **Patch releases do not add product surface.** `0.x.y` patches fix defects and security
   issues. New schemas, capabilities, pages, or public contracts require the next minor.
5. **Merged is not stable.** A feature becomes stable only after the named release gate,
   changelog, tag, GitHub Release, deployed version, and objective evidence agree.
6. **Preview is visible.** Preview UI must say Preview and must not silently imply stable
   support.
7. **Opt-in is fail-closed.** Addons, links, routines, connectors, and runtime profiles
   start disabled until an authorized actor activates them.
8. **Evidence closes the version.** Tests alone are insufficient for runtime, browser,
   external-action, migration, recovery, and release claims.
9. **The roadmap owns sequencing.** Subsystem specs may define how; they may not silently
   change which version owns the feature.

## GitHub milestone policy

- One open milestone per planned version from `v0.24.0` onward.
- Every milestone description copies its one-sentence promise and release gate.
- Issues not required for the next release stay in their later milestone or backlog.
- The milestone closes only after the tagged release and deployed health response match.
- Historical release detail lives in [CHANGELOG.md](CHANGELOG.md), not in this roadmap.
