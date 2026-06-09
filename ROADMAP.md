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

Every milestone closes one part of the **coherence loop** (brain measures → detects a
defect → flies a gated flight → updates state → re-measures) on the four rails (one
backlog, one state, one gate, one memory). See [docs/coherence-model.md](docs/coherence-model.md).

## ✅ v0.18.0 — Flock *(shipped — see CHANGELOG)*
The **state rail**: tenant-scoped Fleet, pot-native check-in (live on Digid), harness pack
contract + Claude Code pack. Milestone #2.

## ▶ v0.19.0 — Flight Operations *(in progress — milestone #3)*
The **unit of correction**: run expensive (Opus) agents as disciplined **flights** —
pre-stage cheap, fly one continuous warm-cache burst, land + record cost (the 5-min cache
TTL forces it). Design: [docs/flight-operations.md](docs/flight-operations.md).
- **#60** preflight gate — readiness score + two checks. ✅
- the **flight spine** — flights table + service + dispatch. ✅
- **brain reconciliation** — pot owns readiness, brain owns coherence (C(t)/regime). ✅
- **#61** flight board — Fleet shows flying / sleeping / per-flight cost + readiness.
- **#62** sleeping / schedule-aware presence + vocab adoption.

## v0.20.0 — Close the coherence loop  ← keystone
Make the brain + pot + flight ONE circuit instead of three good organs. The wire:
**brain detects a defect (ARF/regime) → dispatches a flight → pot records state → brain
re-measures.** Plus `docs/coherence-model.md` as the north star every agent reads.
- the brain→dispatch→state→brain wire (decide: CF-native port of `coherence.py` vs defer to a forked brain).
- coherence-model doc — the four rails + the loop.

## v0.21.0 — Flock complete
Any runtime onboards + operates a pot, gated — including your DevOps agent.
- **#53** harness packs — Codex, Hermes (Nous), openclaw, Claude Cowork.
- **#46** Fleet wake / control (gated, ops-agent-executed) + the token-scope half of #44.
- **#47** ChatGPT Business into the flock (caller-client; depends #41).
- **#40** Fleet Layer-A polish.

## v0.22.0 — digid operates live (the MCPWP pilot)
A pot runs a **real business** coherently through the rails — the proof.
- **#42** Digid marketing roster — Inbound · Outbound · Internet-Research (seeded via product path).
- the gated **MCPWP content loop** — read brand-crystal → draft a WP post via MCPWP → `/approvals` → publish.
- **#39** Loops UI + gated approval pipeline (fixes `gated_approval_pipeline_unwired`).
- **#41** ChatGPT connector production auth path.

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
