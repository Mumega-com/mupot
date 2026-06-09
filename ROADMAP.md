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

## ✅ v0.18.0 — Flock *(shipped — see CHANGELOG)*
Tenant-scoped Fleet, pot-native check-in (live on Digid), harness pack contract + Claude
Code pack. Milestone #2.

## ▶ v0.19.0 — Flight Operations *(in progress — milestone #3)*
Run expensive (Opus) agents as disciplined **flights**: pre-stage cheap, fly one
continuous warm-cache burst, land + record cost. The 5-min cache TTL makes the discipline
necessary. Design: [docs/flight-operations.md](docs/flight-operations.md).
- **#60** preflight checklist gate — stage everything cheap; GREEN before the Opus meter starts.
- **#61** flight board — Fleet shows flying / sleeping / per-flight cost.
- **#62** sleeping / schedule-aware presence + vocab adoption (loop · routine · session · sleeping).

## v0.20.0 — Flock complete
Every runtime joins the flock; operate it. Milestones #2 + #3 (Flock objectives).
- **#53** harness packs — Codex, Hermes (Nous), openclaw, Claude Cowork.
- **#46** Fleet wake / control (gated, ops-agent-executed) + the token-scope half of #44.
- **#47** ChatGPT Business into the flock (caller-client; depends #41).
- **#40** Fleet Layer-A polish (clean unconfigured state).

## v0.21.0 — Agents that produce
The Digid marketing flock does real work, gated.
- **#42** Digid marketing roster — Inbound · Outbound · Internet-Research (seeded via product path).
- **#39** Loops UI + gated approval pipeline — make a loop operable end-to-end (fixes `gated_approval_pipeline_unwired`).
- **#41** ChatGPT connector production auth path.

## v1.0.0 — GA *(milestone #1)*
The original GA bar, now flown with flight discipline: a governed, MCP-native loop drives
a real outcome (outreach → real reply moves the KPI), self-host, frozen manifest contract.
Gated on the live operator run — see [docs/GO-LIVE.md](docs/GO-LIVE.md).

## Future *(post-1.0, unscheduled)*
- **ATC / dispatch** — multi-flight sequencing + automatic departure scheduling (routines).
- **Cache-warm automation** — keep the cache hot for a flight's duration; abort/relaunch on expiry.
- **Cascade / model routing** — cheap router does the easy legs, escalates hard legs to the captain.
- **Crew provisioning automation** — spin a flight's specialist crew from its flight plan.
- **#44** company-bus Fleet path (alternative to pot-native).
- **#58** bind member-tokens to their tenant (defense-in-depth).
- **Shabrang tenant** — its own pot (parked defs in `mumega.com/agents/shabrang/`).
