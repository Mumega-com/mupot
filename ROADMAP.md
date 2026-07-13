# Roadmap

Forward-looking plan, by version. This is the **planned** side; [CHANGELOG.md](CHANGELOG.md)
is the **shipped** side. They share version numbers and feed each other:

```
ROADMAP (planned, issue refs)  ──ships──▶  CHANGELOG (done, dated)
        ▲                                          │
        └──────── next version themes ◀────────────┘
```

When a version ships, its roadmap block collapses into a CHANGELOG entry (with date +
PRs) and the next version moves up. GitHub **milestones = versions**; issues live under
their target version. Pre-1.0, minor bumps may break.

---

## Product north star

Mupot is becoming a **self-hosted agent control plane for running trusted AI
workers, workflows, and integrations on Cloudflare**.

That means the project should prove one operating loop end to end: deploy a pot,
connect a runtime worker, grant scoped capabilities, send it work, gate risky
actions, observe status and failures, and verify the result against an external
tool of record such as GitHub.

The detailed product roadmap and acceptance criteria live in
[docs/control-plane-roadmap.md](docs/control-plane-roadmap.md). This file keeps
the version sequence; the control-plane roadmap defines what those versions must
make true.

---

Every milestone closes one part of the **coherence loop** (brain measures → detects a
defect → flies a gated flight → updates state → re-measures) on the four rails (one
backlog, one state, one gate, one memory). See [docs/coherence-model.md](docs/coherence-model.md).

## ✅ v0.18.0 — Flock *(shipped — see CHANGELOG)*
The **state rail**: tenant-scoped Fleet, pot-native check-in (live on Digid), harness pack
contract + Claude Code pack. Milestone #2.

## ✅ v0.19.0 — Flight Operations *(shipped — see CHANGELOG)*
The **unit of correction**: run expensive (Opus) agents as disciplined **flights** —
pre-stage cheap, fly one continuous warm-cache burst, land + record cost (the 5-min cache
TTL forces it). Design: [docs/flight-operations.md](docs/flight-operations.md). Milestone #3.
- **#60** preflight gate — readiness score + two checks. ✅
- the **flight spine** — flights table + service + dispatch. ✅
- **brain reconciliation** — pot owns readiness, brain owns coherence (C(t)/regime). ✅
- **#61** flight board — Fleet shows flying / sleeping / per-flight cost + readiness. ✅
- **#62** schedule-aware presence (sleeping ≠ dead) + vocab adoption. ✅

## v0.20.0 — Close the coherence loop  ← keystone
Make the brain + pot + flight ONE circuit instead of three good organs. The wire:
**brain detects a defect (ARF/regime) → dispatches a flight → pot records state → brain
re-measures.** Plus `docs/coherence-model.md` as the north star every agent reads.
- the brain→dispatch→state→brain wire (decide: CF-native port of `coherence.py` vs defer to a forked brain).
- coherence-model doc — the four rails + the loop.

## ✅ v0.21.0 — GitHub agent substrate *(shipped 2026-06-13 — see CHANGELOG)*
A pot acts on GitHub under its own scoped identity, two execution backends (Copilot + own
fleet), full provisioning chain, plan-tier-tagged with an Enterprise kill switch. PRs
#129–#137. Docs: public connect guides + internal security model. The pot's GitHub body.
This is the GitHub weave (#71/#73/#74) completed — foreshadowed in 0.19, shipped here.

## ✅ v0.22.0 — Department-template microkernel + Marketing department *(shipped 2026-06-18 — see CHANGELOG)*
Emerged ahead of plan (2026-06-17/18) and **landed the v0.23 marketing substrate early**, so it
took the 0.22 slot; "Flock complete" re-sequences below. The console became a **microkernel**:
activatable **department templates** (one template, N sovereign pots, config not code), the first
real department (**Marketing & Sales**) live + self-running, the **multi-channel command layer**
proven on the outbound funnel, light-default console. Diverse-gated Opus + Codex throughout.
Architecture: [docs/architecture/console-department-microkernel.md](docs/architecture/console-department-microkernel.md) ·
[docs/architecture/marketing-channels.md](docs/architecture/marketing-channels.md).

## v0.22.5 — Flock complete *(re-sequenced after the microkernel shipped as 0.22.0)*
Any runtime onboards + operates a pot, gated — including your DevOps agent.
- **#53** harness packs — Codex, Hermes (Nous), openclaw, Claude Cowork.
- **#46** Fleet wake / control (gated, ops-agent-executed) + the token-scope half of #44.
- **#47** ChatGPT Business into the flock (caller-client; depends #41).
- **#40** Fleet Layer-A polish.

## v0.23.0 — Trusted Runtime
Make one complete trusted-agent operating loop repeatable and recoverable. The
release target is narrower than the earlier marketing-pilot plan: prove a
self-hosted pot can deploy, connect a real runtime, grant limited authority,
run and approve work, verify the result in GitHub, and recover without losing
state. The detailed gate is
[docs/releases/v0.23.0-trusted-runtime.md](docs/releases/v0.23.0-trusted-runtime.md).

Required proof:
- Fresh self-host deployment and owner setup without manual database edits, with
  a passing `mupot-fresh-install/v1` evidence receipt.
- One real runtime attached through signed identity with heartbeat, signed
  inbox, and lifecycle control evidence.
- No unresolved P0/P1 security findings in the v0.23 Mupot Trusted Runtime
  scope across tenant, squad RBAC, GitHub, replay, webhook, and self-verdict
  surfaces, including GitHub App least-privilege proof for #151 with a passing
  `mupot-github-app-permissions/v1` evidence receipt. The SOS/MCP substrate
  hardening backlog (#182, #184, #185, #188) remains open and explicitly
  deferred with full SOS retirement.
- One task lifecycle through the product: create -> execute -> approve ->
  complete -> audit, with a passing `mupot-work-lifecycle/v1` evidence receipt.
- One external board -> Mupot task -> agent -> GitHub PR cycle with the PR
  linked back to the task and a passing `mupot-external-pr-cycle/v1`
  evidence receipt on #150.
- A real Hadi-host receipt bundle for #274 with passing `manifest.json`,
  `cutover-gate.json`, `export-receipt.json`, and `manifest-check.json`.
- A staging rehearsal for upgrade, backup, restore, rollback, Queue/DLQ
  behavior, and failure reporting.
- CI gates for typecheck, unit tests, fleet tests, plugin tests, migration
  tests, dependency/security checks, browser smoke, and runtime conformance.
- A named stable release PR merged to `main`, all required checks rerun on
  that exact merged SHA, and a passing `mupot-stable-deployment/v1` receipt
  proving public health serves the same final version and commit.
- A passing `mupot-v023-prepublication-readiness/v1` receipt bound to the
  merged PR, exact release SHA, stable deployment, objective receipts, and
  scoped GitHub App before the stable tag or Release is published.
- Release metadata aligned across package version, public API version,
  lockfile, changelog, roadmap, Git tag, milestone, and published GitHub
  Release, with a passing postpublication `mupot-release-integrity/v1`
  evidence receipt.
- Active-runtime evidence may be collected with `mupot-production-soak/v1`, but
  it is a non-blocking development tool rather than a duration-based release
  gate. Stable-release proof remains the signed host, lifecycle, external PR,
  recovery, release-candidate, integrity, and aggregate-readiness evidence.
- Final postpublication release readiness has a passing
  `mupot-v023-release-readiness/v1` aggregate receipt across all objective
  receipts, tracker issues, the named merged release PR, and required CI checks
  on the exact release SHA.

Deferred from this version: marketplace/economy expansion, new departments,
full SOS retirement, GCP portability, and autonomous-brain expansion.

The marketing pilot remains valuable, but it moves behind the trusted runtime
proof instead of defining the `v0.23.0` release gate.

## v0.24.0 — The breathing organism (brain = the board's prioritizer) *(proposed 2026-06-15, Chair to ratify)*
Redefine the brain's JOB: **prioritize the backlog, don't act.** perceive→decide→**act** was
the spam-loop; **rank** is idempotent (same state → same answer → no spam). Mechanical-first,
cheap. Research-validated vs GBrain (YC CEO brain) + the agent-loop field; extends the v0.20
coherence-loop. Operating model: *everything task-like → task system; brain prioritizes; Hadi
updates priority.*
- **brain-as-prioritizer** — reads board + pulses + goals → ranks what's next. Runs as a cheap
  **Hermes/qwen3.7-plus DMN** ($0.12/day, $20≈5mo); the Opus **dyad-gate** (Kasra+Codex) acts on
  hard calls. Retire the spamming VPS sovereign loop → a Hermes brain-scan/prioritize cron.
- **pulses (neurology)** — wire **PostHog** (provisioned on every project, ZERO events) as the
  afferent signal feeding the brain. Controlling pulse cadence = controlling metabolism.
- **minions** — cheap qwen workers (Hermes cron/kanban) for mechanical system-care; strong-model
  reserved for the gate. `no_agent` cron = free.
- **visible kanban/sprint board** (mumega + each pot) — the board the brain ranks + everyone sees;
  new priorities queue, **no reactive jumps** (priority-discipline; Chair overrides).
- **mechanical safeguards** — termination predicate, no-progress halt (3 identical fingerprints),
  per-action circuit breaker, `rest` as a valid output.

## v0.25.0 — True microkernel (substrate-portable, BYO) *(proposed 2026-06-15, Chair to ratify)*
The pot is the **microkernel** (the 14 ports), **not pure-Cloudflare**. CF stays the fast/free
**default adapter** — achieved *via* the kernel, so it's both fast AND portable.
- **CF as one adapter** — audit + fix any direct-CF coupling (D1/DO/Queues/R2) so it sits behind
  the ports; CF swappable, not baked in.
- **prove portability** — a 2nd adapter set (openclaw / non-CF reference); a kernel isn't real
  until two adapters exist. (Sharpens v0.22 #53 harness packs.)
- **BYOK** (tenant's own model keys) + **BYO-Hermes** (tenant's own runtime, BYO-host: VPS / Mac
  mini / their machine). Sovereign = portable across substrate + keys + runtime + host.

## v1.0.0 — GA *(was milestone #1; meaning evolved)*
The loop **closed** + ≥1 pot operating a real business **end-to-end**: brain measures →
flight corrects → gated act → state updates → re-measures, on a live business (digid),
self-hostable, frozen contracts. The old "one outreach send goes live" is now one gated
act *inside* this — see [docs/GO-LIVE.md](docs/GO-LIVE.md), [docs/SELF-HOST.md](docs/SELF-HOST.md).

## Future *(post-1.0, unscheduled)*
- **ATC / dispatch** — multi-flight sequencing + automatic departure scheduling (routines).
- **Cache-warm automation** — keep the cache hot for a flight's duration; abort/relaunch on expiry.
- **Cascade / model routing** — cheap router does the easy legs, escalates hard legs to the captain.
- **Crew provisioning automation** — spin a flight's specialist crew from its flight plan.
- **#44** company-bus Fleet path (alternative to pot-native).
- **#58** bind member-tokens to their tenant (defense-in-depth).
- **Shabrang tenant** — its own pot (parked defs in `mumega.com/agents/shabrang/`).
