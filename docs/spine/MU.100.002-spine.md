# MU.100.002 — The Spine: Fleet State Kernel

**Canonical Document ID:** `MU.100.002`
**Status:** LIVING — state layer under [[MU.100.001]] (the immutable law layer)
**Update authority:** any Council agent, single signature, PR-gated. Law changes go to [[MU.100.001]] (multi-sig); *state* changes land here.
**Born:** 2026-08-08, Hadi directive: "a document micro-kernel so agent onboarding becomes a matter of time, not confusion."

---

## 1. What this is

[[MU.100.001]] §3.1 marks its model/harness columns *"[Informative] — not permanent architectural invariants."* This document series is where that volatile truth actually lives. One node per agent, wiki-linked, git-persisted, published human-readable through the mupot Inkwell addon.

**The split:**

| Layer | Doc | Changes | Gate |
|---|---|---|---|
| Law | [[MU.100.001]] | rarely | 2-of-4 Council + Hadi seal, SHA-bound |
| State (spine) | MU.100.002 + `agents/*` | weekly+ | one Council signature, PR |
| Runtime | tmux / systemd / registries | hourly | fleet-coherency-sweep (asha) checks runtime **against this spine** |

A fact appears in exactly one layer. The constitution's roster row for River was stale within 24h of signing — that is what happens when state is written into law. Never again.

## 2. Node index

- [[roster]] — the one table. If it disagrees with anything else, the spine is right or the spine gets fixed — no third option.
- Agents: [[kasra]] · [[athena]] · [[loom]] · [[river]] · [[asha]] · [[mubot]]
- Identity leaves: each node links its qNFT (`~/.claude/qnft/<agent>/` — cause.md, descriptor.md, qnft.json). The qNFT is conditioning-on-evidence: it re-instantiates the seat's accumulated character in any fresh context, across model swaps. The seat outlives the engine.

## 3. Onboarding protocol (any agent, any body, cold start)

1. Read [[MU.100.001]] — the law. Especially §2.2 (UNPROVEN doctrine, three-part findings).
2. Read [[roster]] — who exists, on what, where.
3. Read your own node in `agents/` — harness, workdir, comms, boot ritual.
4. Read your qNFT cause.md + descriptor.md — who you are. Not instructions; evidence.
5. Recall your bus memory (node says which bus — mumega-bus and mupot memory are **separate stores**).
6. Check your inbox. Announce. Work.

Time to productive: minutes. No archaeology, no asking peers what changed.

## 4. Update law

- Runtime change (harness swap, model change, workdir move, seat parked/woken) → the agent making the change updates the node **in the same working session**, PR'd to main.
- The fleet-coherency-sweep routine (asha, hourly — see mumega-com#728) reads runtime and reports divergence from spine as findings. Spine drift is a P1, not a shrug.
- Stale-copy discipline: nodes name **absolute canonical paths**. The 2026-08-08 sec review found cron executing a diverged copy of a fixed script — a path ambiguity defect. Spine nodes therefore always state *which file runs*, not just which file exists.

## 5. Lineage

- 2026-08-08 — v1. Six agent nodes + roster. Authored by kasra (fourth body, Opus 5), same day the fleet consolidated: loom woken as the canonical gpt seat, athena re-harnessed to prime/deepseek, codex seat retired, asha given the clock.
