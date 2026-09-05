# Mupot version roadmap

This is the canonical forward-looking product roadmap. [CHANGELOG.md](CHANGELOG.md)
is the canonical record of what has shipped.

**GitHub milestones do NOT currently match these version numbers** (verified 2026-09-04).
No `v0.30.0` milestone exists — the newest is `v0.29.0 - Distribution and Commercial
Operations` — and existing milestone titles still use the PRE-renumbering scheme this
document describes moving away from (`v0.26.0 - Governed Tools`, `v0.27.0 - Agent
Computers`). The v0.30.0 release contract's integrity gate requires a milestone that agrees
with the release, so that gate is currently unsatisfiable as written.

## Current version

| State | Version | Meaning |
|---|---|---|
| Current source version | `0.30.0` | Present on `main`; the commit is deliberately not pinned here, because any SHA in a versioned file is false once that file merges — read `git rev-parse origin/main`. Preview until the stabilization gate passes and `v0.30.0` is tagged. |
| Current production version | `0.30.0` | Last recorded deploy `4fd452eb`, `clean:true`, 2026-09-04 (authoritative: live `/health`). Further PRs merged after that deploy, so production trails `main`; the size of the gap is deliberately not counted here (a count rots on the next merge), compare the two sources. Still not a stable-release claim, which requires a tag. |
| Last tagged release | `v0.25.0` | Project Routines and Needs You. |
| Next stable candidate | `v0.30.0` | Stabilization-only: security train, messaging reliability, release proof, and backlog closure. **Scope is unsettled as of 2026-09-04** — #1246, #1247 and #1248 were excluded by the scope boundary and have since landed on `main`; see `docs/releases/next-flights.md`. |
| Future development target | `v0.31.0` | Canonical receiver, Agent Computers, and Recovery; held until `v0.30.0` is stable. |

### Release state as of 2026-09-04

A `v0.30.0-rc.1` prerelease tag exists at `0bb9c256` (2026-09-03). It is **superseded**:
`main` is 13 commits ahead of it, and release order step 7 in
[the v0.30.0 contract](./docs/releases/v0.30.0.md) states that a post-RC merge invalidates
prior RC evidence. No rc.1 receipt rolls forward to a different commit.

The 2026-09-04 landing sweep closed three live production defects (#1301/#1299 header-selected
tenant, #1307/#1305 unauthenticated preview dispatch, #1312/#1303 fail-open slug
availability) and cleared the open-PR backlog to two drafts. It also landed three PRs the
v0.30 scope boundary had routed to later releases, so the stable candidate's contents no
longer match its written scope. Resolving that is an owner decision: either re-cut v0.30.0
to include them, or take the candidate from a different commit.

Nothing here is a stable-release claim. `git tag` still tops out at `v0.25.0`.

`0.30.0` is the version the source currently reports. It is **not** yet a stable
release: no `v0.30.0` tag or GitHub release exists. Code on `main` remains preview
until one exact commit passes the release gate below and is tagged. Deployment alone
does not make a capability stable.

## Versioning truth — source cuts exist, release tags are still owed

[#805](https://github.com/Mumega-com/mupot/issues/805) is resolved. The blocker was
that the version constants were pinned by a published tenant receipt and the
native-addon compatibility grace was already spent, so the 69 deployed commits past
`v0.25.0` could not be named. #805 option c was taken — the historical receipt
assertions were decoupled from the live constants — and
[#806](https://github.com/Mumega-com/mupot/pull/806) landed the atomic cut:
`package.json`, `src/version.ts` (`MUPOT_PUBLIC_API_VERSION`), and `CHANGELOG.md`
(`## 0.29.0 — 2026-08-08`) all read `0.29.0`.

Three consequences this document now carries:

1. **`0.29.0` was renumbered out of the plan.** The cut went forward without shipping
   the promises of `v0.26.0`, `v0.27.0`, and `v0.28.0`, so those numbers can no longer
   sit below the cut version. All four unshipped releases moved up by four:
   Governed Tools `v0.26.0`→`v0.30.0`, Agent Computers `v0.27.0`→`v0.31.0`,
   Compounding Project Knowledge `v0.28.0`→`v0.32.0`, and Distribution and Commercial
   Operations `v0.29.0`→`v0.33.0`. **No promise was dropped, delivered, or reworded —
   only the number moved.** Anything from those scopes already on `main` is `preview`
   under the activation states below, not shipped.
2. **`0.29.0` was a source cut and was never tagged.** `git tag` still tops out at
   `v0.25.0`; current source has since advanced to `0.30.0`. The old source cut is
   historical evidence, not a current or supported release contract.
3. **The source advanced again to `0.30.0` on 2026-08-21 without a tag.** That makes
   `0.30.0` the current code version, not a released contract. The next stable tag is
   `v0.30.0`; no retrospective `v0.29.0` stable release is planned in this roadmap.

## v0.30.0 stabilization train — ordered (updates by PR only)

> This is the only active release queue. Hadi sets merge order; every candidate is
> independently gated at an exact head. Work outside this table is post-`v0.30.0`
> unless a new roadmap PR explicitly changes the release contract.

| # | Candidate | Purpose | State | Required next action |
|---|---|---|---|---|
| 0 | PR #1239 — CI foundation | Restore migration, typecheck, full-suite, schema, secrets, and local-evidence truth | **LANDED 2026-08-30** as `f3389d65`; post-merge CI 13/13 | Keep as the release baseline |
| 1 | PR #1243 — credential rotation | Org authorization before lookup; resumable, lease-fenced handoff recovery | **LANDED 2026-08-30** as `8be1cac7` | Retain exact-head gate receipt in the release bundle |
| 2 | PR #1242 — router/loop/meter authorization | Explicit squad authority, claim-time grant check, internal loop tick, server-owned meter caps | **LANDED 2026-08-30** as `fb10d79b` | Retain exact-head gate receipt in the release bundle |
| 3 | Message reliability — #1235/#1237/#1241 | Guest visibility, immutable integrity baseline, starvation-free inbox cursor | **LANDED** — #1237 `b980f565`, #1235 `4d41d9bd`, and #1241 `a3d46acb`; post-main CI/CodeQL green | Retain exact-head and landing receipts in the release bundle |
| 4 | PR hygiene — #1211/#1217/#1236/#1238 | Remove obsolete/conflicting work from the release surface | **COMPLETE** — all four closed with replacement/deferral evidence; branches preserved | Keep release-excluded work out of the freeze |
| 4a | PR #1249 — external runtime dispatch receipts | Exact external dispatch, gate, replay, cancellation, and public receipt paths | **LANDED OUTSIDE THE ORDERED TRAIN** as `16390d1e`; present in main as preview | Restack the release head on it, retain exact combined gates, and do not promote new stable claims without a separate scope decision |
| 5 | PR #1250 — versioned release contract | Version-aware release receipts, exact RC/stable identity, and metadata truth | **LANDED 2026-08-31** as `ccfdb4b3`; CI, CodeQL, independent review, and Athena green | Use its contract and checkers for the frozen release SHA |
| 6 | PR #1251 — neutral Host-Go evidence | Mupot/Herdr-neutral host cutover receipt with `no_live_sos_wiring` | **LANDED 2026-08-31** as `c6ef9876`; historical receipt parsing preserved | Produce fresh neutral host evidence for the release bundle |
| 7 | PR #1252 — exact Codex CLI harness | Accept exact `codex-cli` declarations across persistence, parser, schema, and instructions | **LANDED 2026-09-01** as `55c1c3ef`; post-main CI and CodeQL green; deployed since 2026-09-02 as an ancestor of prod `7d58d36b` | Keep as preview in v0.30, freeze `main`, and require a fresh seat check-in after any later deployment |
| 8 | `v0.30.0` release candidate | One exact main SHA, upgrade/fresh migration proof, browser/runtime/MCP smoke, release receipt | **READY TO FREEZE** — [release contract](docs/releases/v0.30.0.md) and [flight runway](docs/releases/next-flights.md) defined; evidence remains pending | Freeze one SHA, collect contract receipts, then request separate RC publication/deployment approvals |

The ordered release flights and post-stable receiver convergence are maintained in
[docs/releases/next-flights.md](docs/releases/next-flights.md). Open #1246–#1248 and
#1253–#1254 are outside the v0.30 freeze; none may silently move the release head.

**Board opinion policy:** priority ORDER is Hadi's alone — no vote, no ceremony. Board
input (asha first-pass, Athena architecture, River build feasibility) is requested per
flight when SCOPE is unclear, and is advisory. Ratification voting (MU.100.001 §1.3)
applies to constitution amendments only — never to sequencing work.

## Historical operating-loop snapshot — 2026-08-03

> Cross-cutting runtime plan; version-scoped features above own their releases.
> This section preserves the measured 2026-08-03 loop state; it is not the current
> release queue. Current release execution lives in
> [docs/releases/next-flights.md](docs/releases/next-flights.md). Shipped record:
> CHANGELOG.md.

**Ideal output** — a self-perpetuating loop, humans only at decision points:
`board task → caged lane builds (cheap model) → cross-vendor review → gate verdict
(delegable) → kasra merges → steward repairs → hermes-send announces to Hadi →
revenue data accumulates`. Measured in the steward digest: (1) GEO scan events/day
in PostHog, (2) tasks/day completing with no human in the execution path,
(3) verdicts+merges Hadi personally performs (target: merges only), (4) silent
failures found by steward that nothing else reported (target: 0).

**Roster (Hadi, enforced 2026-08-03):** tmux kasra · codex · athena · river; mubot
sole Hermes gateway. Lanes = ephemeral processes: tech-grok (build), claude lane
(haiku — docs/specs), mumcp (WordPress), codex lane (PAUSED pending #645 cage
predicate), review (cross-vendor gate), steward (self-repair). One codex: 1eb0e718.

**Workstreams:** W1 revenue — FLIGHT 00b2ef4b GEO scanner (#574): merged 49783032, FIRST LIVE SCANS OK 2026-08-03 (3/3, PostHog events); remaining = cadence timer + receipt-sink 404 + profile upstream (task b6addee4) then flight_land; next viamar/digid
baselines + DME operational flight (e1a02d39; code already in main). W2 caged
lanes — implement codex's acceptance predicate (#645), then Spark unpause + Hermes/
V4-Flash lane via iron-proxy. W3 self-perpetuation — steward round 2 (dead-man
pings with evidence), server-side requeue + task markers + max-rounds (#635),
codified gate delegation. W4 federation — Phase 1 registry (mumega-com#573) on the
merged Phase 0 ADR (452f11db); separate-ownership pilot + mints stay Hadi-direct.
W5 debt — 22-BLOCK backlog (#636), organisms redesign (#595), Mirror 501 (#596),
board hygiene, athena-inbox-watch (#594), mubot token rotation.

**Noticing (landed 2026-08-07):** the loop now has a read-only sensing pass —
`scripts/gatherer.py` runs inside `operator-loop.sh`, ranks anomalies into one digest
per cycle, and carries its own dead man's switch. It closes measure (4) above: silent
failures previously surfaced only when Hadi asked. Notification stays flag-gated and
off. NOT yet closed: assignment. `scripts/router.py` exists and is dry-run only — every
worker driver filters `task_list` to its own `assignee_agent_id`, so unassigned tasks
are invisible to every lane (2,455 operator cycles logged `cycle ok` and moved nothing).
Wiring the router into the loop is the next W3 step and needs a gate: a wrong assignment
rule produces confident motion, not an error.

**Standing rules:** branch+PR only · cross-vendor review every merge · server-
enforced no-self-verdict (delegation by explicit grant) · adversarial gate parallel
on sensitive surfaces · "restore" commits get diffed against their claim · rigor
budget scales with blast radius · consultations on GitHub artifacts, buses carry
pointers.

## Cloudflare: credential governance and platform roadmap

### Credential governance (policy, effective 2026-08-07)

**No broad-access Cloudflare credentials.** Every CF credential is fine-grained,
purpose-scoped, resource-scoped, and expiring. A token is minted for one named
consumer with the minimum permission groups that consumer provably needs, scoped to
specific zones/accounts — never "all zones" — and carries an `expires_on`. Requesting
one states: consumer, operations performed, permission groups, resource scope, expiry.

The registry of live tokens and their scopes lives in
[docs/security/cloudflare-key-registry.md](docs/security/cloudflare-key-registry.md)
and is surfaced in the mupot dashboard Docs so members can see what exists and at what
scope without holding a credential.

**Measured state at the time this policy was written, because the policy exists for a
reason:** the account carried **16 active account-owned tokens, 12 of them with
`expires_on: None`**, several issued before the 2026-07-29 sweep that was recorded as
ending standing admin access. A credential believed retired verified `active` with no
expiry. Retirement is not complete until an independent probe says so.

⚠ **Verify on the right endpoint.** An account-owned token FAILS the user-scoped
`/user/tokens/verify` with a plain `Invalid API Token`, which is indistinguishable from
a revoked token. The correct probe is `/accounts/<account_id>/tokens/verify`. A
known-good token returning "Invalid" on the wrong endpoint is the tell.

**Revocation order — never revoke first.** Inventory consumers → mint scoped
replacements → cut over → verify → revoke. Killing a credential a CI workflow or a
running agent depends on fails silently and is found later by a human noticing.

### Platform roadmap (Cloudflare for Startups)

⚠ **Confirm our credit tier in the dashboard before budgeting against any cap.** The
program is three-tiered, not a flat $10k, and the caps differ by an order of magnitude:

| Tier | Credit | Workers AI sub-cap |
|---|---|---|
| Tier 3 (our likely tier) | $10,000 | **$2,500** |
| Tier 2 | $100,000 | $10,000 |
| Tier 1 (accelerator partner) | $350,000 | $50,000 |

A prior internal note recorded the **$50k** Workers AI cap as ours. That figure is real
but belongs to Tier 1. If we are Tier 3 the real ceiling is **$2,500**, and any plan
that assumed 20× that is wrong. **AI Gateway remains excluded from credits.** R2 +
Cache Reserve alone is capped at $10k and could consume the entire grant. Credits
expire at one year or on exhaustion, whichever comes first, with no extensions and no
stated grace period before card billing resumes. Several products we care about
(Zero Trust/Access, Hyperdrive, Browser Run, Containers, AI Search, Turnstile, Logpush,
Analytics Engine) are not named on the program page at all — their credit status is
genuinely unknown, which is not the same as excluded.

**Adopt.** *Browser Run* (GA 2026-04-15, renamed from Browser Rendering) replaces the
GEO/SEO screenshot pipeline. *Analytics Engine + Workers Logpush* on our existing
Workers Paid plan — not the Enterprise-only zone Logpush — is the cheapest fix for thin
observability now that the gatherer gives us something worth logging. *Cloudflare
Tunnel* plus a narrow Access re-widen scoped strictly to the Hetzner box and internal
admin surfaces.

**Evaluate.** *Workflows* passes the gates-not-routers test — it is a durable-execution
primitive, not an orchestration framework, so it does not collide with our gate model
the way LangGraph/CrewAI would. *Queues* is a real upgrade over poll-based dispatch,
but Worker consumers cap at 15 minutes, so long-running host agents still pull over
HTTP rather than being pushed to. *Hyperdrive* for Mirror's Postgres, wired after
Tunnel — note it does not fix recall/remember reliability, only the connection path.

**Do not plan around.** *Containers* is GA (2026-04-13) but is wake-on-request /
sleep-when-idle with ephemeral disk. It is **not** a drop-in replacement for the
persistent Hetzner agent processes, and the VPS exit must not be scheduled against it
without a real re-architecture. *Agents SDK* — take the Durable Object state/WebSocket
primitives and MCP hosting; **reject its `waitForApproval()` / `runWorkflow()`
orchestration layer**, which duplicates mupot's gate system and is the same category of
dependency we already declined. *AI Search / AutoRAG* is a shallow wrapper over the
Vectorize pipeline we already operate.

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

## The Project pivot and its consequences

Making **Project** the organizing center (v0.24) is not a single feature — it
resets what the rest of the product should be. Two consequences are now scheduled:

- **Console consolidation (post-v0.30; version assignment held).** Much of the current navigation became
  redundant, duplicated, or orphaned the moment Project tabs existed. A 2026-07-20
  audit found duplicate menu destinations, a "Work" menu that is only a compose
  form, self-declared-dead stubs, and real pages with no nav entry.
  → [console-navigation-consolidation.md](docs/architecture/console-navigation-consolidation.md)
  and [#584](https://github.com/Mumega-com/mupot/issues/584).
- **Identity & Unified Access (post-v0.30; version assignment held).** The token/agent model predates Project and
  cannot express it: authority lives on the member not the token, agents are welded
  onto members, keys can't be fine-grained, and Project isn't a valid RBAC scope.
  → [identity-and-access-redesign.md](docs/architecture/identity-and-access-redesign.md).

These pair: the consolidated **Access** menu *is* the unified-identity "Create key"
surface. They also converge with the guest-presence work below — one scoped+TTL
token mechanism serves fine-grained keys, guest check-in/out, and governed tools.

## Commercial model — sovereign core, operated presence

We monetize **operation**, not the software. The core is open and free to
self-host (the sovereignty claim, kept true); the paid product is operating a pot
well. Three tiers:

| Tier | Gets | Support | Price |
|---|---|---|---|
| **OSS mupot** (self-host) | Open core + public update stream. Complete sovereign pot. | Self-serve | Free |
| **mupot.mumega.com** (SaaS) | Managed hosting, updates applied, SLA. | Full | $ |
| **Operated Presence** (agency) | Mumega team checks into the pot, sets it up, operates it. Metered. | Hands-on | $$ |

Open-core line: **core fully open; monetize the service, not features.** Support
is gated by payment regardless of where the pot runs; a non-paying self-hoster
gets public updates only. Portfolio-hub and presence-billing surfaces live on
mupot.mumega.com because that is where they are meaningful, not because they are
license-gated. Design detail:
[docs/architecture/sovereign-core-operated-presence.md](docs/architecture/sovereign-core-operated-presence.md).

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
Trusted Runtime release detail and evidence live in
[docs/releases/v0.23.0-trusted-runtime.md](docs/releases/v0.23.0-trusted-runtime.md).

### v0.24.0: Project Operations - stable

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
   - isolated local evidence structurally compares one seeded Project situation through the
     browser, REST, MCP, and dashboard loader, and proves persisted owner lifecycle transitions
     in a real desktop and mobile browser.
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
- economy features, new departments, full SOS retirement, GCP portability, and autonomous-brain expansion;
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

### v0.25.0: Project Routines and Needs You - stable

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
per-flight sandboxes, self-modifying skills, or console consolidation.

### v0.29.0: Release Truth and Sovereign Substrate - cut, untagged

**One promise:** A deployed pot can prove which commit it is running, and the version
it reports is the version its constants and CHANGELOG agree on.

This release exists because the previous three planned numbers were never cut. It was
taken as a forward cut over `v0.26.0`–`v0.28.0` rather than as delivery of them; see
"Versioning unblocked" above for the renumber that followed. Scope is what
[CHANGELOG.md](CHANGELOG.md) `## 0.29.0 — 2026-08-08` records, principally:

- build-time release identity — `/health` stamps the true `commit`, `ref`, `built_at`,
  and working-tree `clean` state by construction, including on the bare
  `wrangler deploy` path ([#443](https://github.com/Mumega-com/mupot/issues/443),
  [#571](https://github.com/Mumega-com/mupot/issues/571),
  [#801](https://github.com/Mumega-com/mupot/pull/801));
- the atomic version cut itself, with historical receipt assertions decoupled from live
  constants ([#805](https://github.com/Mumega-com/mupot/issues/805) option c,
  [#806](https://github.com/Mumega-com/mupot/pull/806));
- sovereign addon sub-apps, token-usage telemetry, and the motherboard map;
- Telegram central-command ingress and the `MU.100.001` v6 constitution ratification.

Activation: build-time stamping is default-on. Everything else follows the activation
label of the addon or channel that carries it.

Not in `v0.29.0`: any promise from `v0.30.0`–`v0.33.0`. Parts of those scopes are on
`main` and are `preview`, not shipped.

`v0.29.0` will not be retroactively tagged as stable. Its source-cut history remains
recorded here and in the changelog; the next supported contract is `v0.30.0`, whose
release record must explain the untagged `0.29.0` and `0.30.0` source interval.

### v0.30.0: Stabilization and Governed Operations - release candidate

**Release ruling (2026-08-30):** `v0.30.0` is a stabilization release. Features
already present on `main` may remain available as `preview` or `opt-in`, but broad new
product scope is not a release blocker and must not enter the stabilization train.

The stable contract requires:

1. land the credential-rotation and router/loop/meter authorization train in the
   exact order above, with fresh checks after every base change;
2. reconstruct and gate the message reliability invariants from #1235, #1237, and
   #1241 on current main, including migration renumbering and cross-surface reads;
3. close or defer every release-excluded open PR so the release surface is legible;
4. prove fresh install and upgrade migration paths, typecheck, complete tests, plugin,
   dependency audit, every repository guard, local browser/runtime evidence, and
   Mupot connect/send/inbox/ACK/task/gate/routine/flight smoke at one exact SHA;
5. obtain an Athena release Artifact+SHA verdict and Hadi's separate authorization for
   the `v0.30.0` tag, GitHub release, and any deployment.

Explicitly deferred until after stable `v0.30.0`: the #1236 omnibus, project-worker
sandbox expansion (#1217), device fleet, new onboarding journeys, unrestricted tool
catalogs, payments, and any feature that cannot be expressed as a bounded reviewed PR.

#### Deferred product direction (requires a new post-v0.30 version assignment)

**One promise:** A Project routine can use a real business system without exposing
its raw credential to the model, and Marketing/CRO proves the path end to end.

Original proposed scope (not committed to the `v0.30.0` stable contract):

- evolve the existing addon registry and encrypted connector vault into one governed
  tool path: definition, credential profile, grant, binding, action policy, and receipt;
- lazy MCP tool discovery with read, draft, write, publish, delete, and admin action
  classes; payment actions remain blocked in this release;
- immediate revocation and no model-selected tenant, Project, identity, or credential;
- Marketing & CRO addon as the first reference package;
- Mumega pilot first, then DME activation after the same conformance and permission gate;
- AI visibility collection, recommendation review, approved action, and outcome receipt;
- **guest-credential precursor:** the scoped, no-raw-secret credential path is the
  same governance family as the Operated Presence guest token (least-privilege,
  capability-ceiling, expiry) — prove it before v0.33 Operated Presence rides the primitive.

**Also proposed — Console consolidation.** Complete the Project pivot's navigation
consequence under [#584](https://github.com/Mumega-com/mupot/issues/584):

- collapse project-scoped work, team, activity, and evidence into Project tabs;
- keep only genuine workspace-level destinations in the primary navigation;
- remove duplicate and dead destinations, and give every retained page a nav home;
- redirect retired routes for one release before removal;
- require browser evidence that no sidebar item is a stub or duplicate and no retained
  page is reachable only by typing its URL.

**Also proposed — Identity & Unified Access (the token/agent model rework).** A
2026-07-20 three-lens deep audit (security / simplicity / durability, code + live
D1) found authorization lives on the *member* not the *token*; **three** disjoint
human-identity planes (`users` web-login + `members` token + `agents`); **six**
divergent mint paths; **three** parallel RBAC tables (`capabilities`, `gate_grants`,
`memberships`); no per-key fine-grain; and the minted key never carries its MCP
address. It also found live data damage (2 ambiguous agents, 2 escalation-guard
violations, 6 duplicate-member groups) and one live HIGH: the "scoped key" is
unscoped and writes standing principal grants that survive revocation. Full findings
+ ordered fix sequence + security non-negotiables:
[docs/architecture/identity-access-fix-map.md](docs/architecture/identity-access-fix-map.md).
Target model:
[docs/architecture/identity-and-access-redesign.md](docs/architecture/identity-and-access-redesign.md).

Security non-negotiables for any future identity/access release (from the adversarial gate):
`effective = intersect(principal, token_grants)` with **empty grants ⇒ zero, never
full**; mint **never** mutates the principal; one `buildAuthContext` chokepoint
enforcing ceiling + `expires_at` + intersection at every door; expiry server-clock
fail-closed; unknown `scope_type` ⇒ deny; `''` sentinel (not NULL) in the grant PK.

Prior-art design decisions (2026-07-20 research — AWS STS, GitHub PATs, SPIFFE, PAM):
the `intersect` math matches AWS STS AssumeRole (validated); grants stay **DB-side**
(instant revocation — no macaroons); **`expires_at` is mandatory at mint** (non-expiring
keys are an owner-gated exception); **session-admin = sudo for agents** (a TTL
`token_grant` at `capability='admin'`, never a principal write) and **admin-tier
elevation is approval-gated** (Zero-Standing-Privilege, per Teleport/CyberArk); add
**`owner_principal_id`** on agent principals (human-accountability lineage — SPIFFE/
Entra converge on agent-as-principal but keep the human owner). **Audience note: agents
are the primary operators, humans the exception** — setup runs through an admin agent
over MCP, so this identity/access model is the flagship and the console consolidation
(post-v0.30) is a thin bootstrap/oversight shell, not the main surface.

- **one principal** table with `kind ∈ human|agent` (People and Agents become
  `kind`-filtered views); stop minting agents into the members table; `members`/
  `agents` kept as compatibility views during migration;
- **token-scoped grants:** authority = intersect(principal capabilities, token
  grants); add a `project` scope type (RBAC cannot express Project today), an
  `expires_at` (enables the guest/TTL key), and an optional `resource`/action-class
  filter — the fine-grain a key lacks today;
- **one "Create access key" flow** (dashboard **Access** + MCP `create_key`): pick
  principal → pick scope (presets: Full / Read-only / This-project / Guest+TTL) →
  receive show-once token **plus** the MCP endpoint and paste-ready Claude Code /
  Cursor / Codex / curl config in one screen (reuse `connect.ts`); retire the four
  divergent mint paths;
- enforce the ceiling in `buildAuthContext` (generalize the directory-door zero-cap
  pattern); revocation of a token or grant takes effect immediately.

This was previously planned as the **Access** surface of console consolidation. If
rescheduled, the menu and identity model must still ship together; neither is implied
by the `v0.30.0` stabilization tag.

Activation:

- Tool governance: default enforcement for brokered tools.
- Connector profiles and Marketing/CRO addon: owner opt-in per Project.
- Customer-facing sends and publishing: gated by default.
- Identity migration: additive and flagged; existing tokens get an implicit
  full-ceiling grant so behavior is unchanged until a key is deliberately scoped.

Regardless of its future target, this scope excludes accounting, payments,
unrestricted tool catalogs, and silent credential fallback into runtime environments.

### v0.31.0: Canonical Receiver, Agent Computers, and Recovery - planned

**One promise:** Substantial flights run through one identity-bound receiver into
isolated, recoverable computers without making one Mac, pod, receiver, or agent harness
the system of record.

Must ship:

- one canonical Mupot-to-Codex receiver and host runner, reconciling the Hadi-admin
  operational implementation with the Hadi-dev contract and policy lane;
- bearer-derived agent identity plus a server-authorized seat/session context shared by
  `check_in`, inbox lease/ACK, send, and runtime receipts;
- a standardized cross-platform runner CLI/service with polling fallback and a governed
  push subscription path; push becomes default only after soak and replay gates pass;
- an exact receipt chain from dispatch through runtime consumption, correlated ACK,
  artifact hash, review, and independent verdict;
- explicit runtime Session and Execution Workspace lifecycle;
- ephemeral and approved persistent workspace modes;
- Kubernetes Job or compatible sandbox adapter for isolated flights;
- lease renewal, checkpoint/resume contract, reconciler, reaper, and teardown receipt;
- fresh credentials on resume and purge on teardown;
- compute, storage, connector, and model cost attribution;
- runtime adapter neutrality for Hermes, Codex, Claude Code, and later harnesses.

Activation:

- Existing trusted Agent Host remains the default executor.
- The canonical receiver and runner remain default-disabled until one bounded synthetic
  live canary passes identity, replay, artifact, rollback, and no-duplicate-work gates.
- Isolated computer mode starts opt-in by Project/Routine and becomes default only
  after recovery and cost gates pass.
- `reuse` and `pinned` sessions remain opt-in.

### v0.32.0: Compounding Project Knowledge - planned

**One promise:** Projects improve from measured outcomes without confusing generated
memory with evidence or allowing agents to widen their own authority.

Must ship:

- project resources and document/artifact index;
- a background memory-dreamer worker that produces reviewable, source-linked proposals
  rather than silently rewriting Project or agent memory;
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

### v0.33.0: Distribution and Commercial Operations - planned

**One promise:** A customer can install, operate, upgrade, and commercially license a
Mupot without Mumega performing hidden manual steps.

Must ship:

- guided self-host install and upgrade for Cloudflare plus supported Agent Hosts;
- deterministic backup, export, restore, rollback, and audit export;
- addon/package compatibility, marketplace distribution, and signed distribution receipts;
- clear non-commercial, evaluation, and commercial licensing paths;
- managed-support boundaries, entitlement hooks, and operator documentation;
- onboarding and billing proof for the first external design partner;
- **Operated Presence (metered check-in/out):** a customer pot mints a guest
  credential (least-privilege, capability-ceiling, expiry, customer-revocable); the
  Mumega team operates *inside* the customer pot with every action in the customer's
  own ledger; presence meters to a tamper-evident, Stripe-Connect-split invoice;
- **tier entitlements:** OSS (public updates only, no support), managed SaaS, and
  agency presence — support gated by payment regardless of where the pot runs;
- **public update channel** for the free self-host tier (release-stream delivery,
  no hidden manual steps).

Activation:

- Guest credential + presence metering: owner opt-in per visiting engagement,
  fail-closed, and revocable at any instant by the pot owner.
- Operated Presence guest trust boundary is a mandatory dual-vendor adversarial gate
  before any external customer engagement.

### v1.0.0: Governed Business Loop GA - planned

**Promise:** At least one real business operates a Project end to end through Mupot:
signals enter, Routines dispatch governed Flights, humans review risky decisions,
approved actions reach external systems, outcomes return, and the Project improves from
verified evidence.

GA requires frozen public contracts, supported upgrade compatibility, production SLOs,
security review, recovery evidence, legible costs, and one reproducible Mumega/DME case
study. Feature count alone cannot satisfy the GA gate.

## Capability ledger

| Capability | Release state | Activation |
|---|---|---|
| Identity, squads, tasks, gates, flights, receipts | `v0.23.0` | Default-on |
| Signed runtime and scoped MCP work | `v0.23.0` | Host enrollment required |
| Projects and nested project context | `v0.24.0` | Default-on after migration |
| Project Activity and Evidence | `v0.24.0` | Default-on |
| Project Link | `v0.24.0` | Opt-in per link |
| Mac/Kubernetes Agent Host | `v0.24.0` | Opt-in per host/profile |
| Routines and RoutineRun | `v0.25.0` | Each Routine explicitly enabled |
| Needs You review inbox | `v0.25.0` | Default-on projection |
| Console consolidation (project-centered nav) | `preview; post-v0.30 target required` | Default-on only after its own release gate |
| Governed connector actions | `preview; post-v0.30 target required` | Connector and grant required |
| Unified principals + token-scoped access | `planned; post-v0.30 target required` | Additive migration; fail-closed transition required |
| Marketing & CRO addon | `preview; post-v0.30 target required` | Opt-in per Project |
| Canonical Mupot-to-Codex receiver and runner | `v0.31.0` | Default-disabled until synthetic live canary passes |
| Governed realtime push subscription | `v0.31.0` | Polling fallback retained; default-on only after soak |
| Exact runtime consumption, ACK, and artifact receipts | `v0.31.0` | Enforced for the canonical receiver |
| Isolated Agent Computers | `v0.31.0` | Initially opt-in |
| Memory dreamer worker | `v0.32.0` | Proposal-only; promotion gated |
| Reviewed knowledge and coherence evaluation | `v0.32.0` | Promotion gated |
| Commercial installation and operations | `v0.33.0` | License/entitlement dependent |
| Operated Presence (metered guest check-in/out) | `v0.33.0` | Owner opt-in per engagement, fail-closed, revocable |
| Commercial tiers and support entitlements | `v0.33.0` | Payment-gated support; free = public updates only |
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
