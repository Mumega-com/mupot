# Mupot Roadmap — the plan, in version control

> This file IS the plan. It changes only by PR, so every revision has an
> author, a diff, a review, and a date. The changelog below it is the record.
> If a conversation and this file disagree, this file wins until a PR says
> otherwise. (Created 2026-08-03 on Hadi's directive: "where is the plan,
> the version control, the changelog, the roadmap?")

## The ideal output (what "working" looks like)

A self-perpetuating loop where humans appear only at decision points:

```
board task → lane builds (cheap model, caged) → cross-vendor review
  → gate verdict (athena/kasra, delegated) → kasra merges → steward repairs
    → hermes-send announces to Hadi's Telegram → revenue data accumulates
```

Measured by four numbers, reported in the steward digest:
1. **Revenue signal**: GEO scan events/day accumulating in PostHog (flight 00b2ef4b)
2. **Throughput**: tasks completing per day without a human in the execution path
3. **Human load**: verdicts+merges Hadi personally performs per day (target: merges only)
4. **Silent-failure count**: things the steward found dead that nothing else reported (target: 0)

## Roster (Hadi, 2026-08-03 — enforced)

tmux: **kasra · codex · athena · river**. Gateway: **mubot** (Hermes, telegram/etc).
Lanes (ephemeral processes, not agents): tech-grok (build), claude lane (haiku model,
docs/specs), mumcp (WordPress), codex lane (PAUSED pending cage predicate), review
(cross-vendor gate), steward (self-repair). One codex only: `1eb0e718` on the VPS.

## Workstreams

### W1 — Revenue (top priority)
- **FLIGHT 00b2ef4b: GEO baseline scanner** (mupot#574, task 041c60a9) — codex builds,
  athena gates, kasra merges, mubot announces. Every day without scans = DME trend
  data lost. → then: viamar/digid baselines, DME cross-pot flight (e1a02d39,
  code already merged — operational work only).

### W2 — Caged lanes (unblocks cheap-model scale)
- Implement codex's cage acceptance predicate (PR #645 BLOCK, comment 5162239554):
  quarantine import, immutable lock-hash deps, provider-only egress, cgroup
  teardown, disposable no-remote git, adversarial canaries. Then
  `CODEX_LANE_ENABLED=1` (Spark) and a Hermes lane (DeepSeek V4 Flash via
  iron-proxy) inside the same cage.

### W3 — Self-perpetuation
- **steward-worker** (this PR): auto-reissue of infra-blocked/orphaned tasks
  (one retry per lineage), Telegram digest. Round 2: silent-unit detection
  (dead-man discipline — every scheduled thing pings with evidence, absence alerts).
- Server-side requeue transition + non-code/hold task markers + max-rounds cap
  (mupot#635) — kills the re-issue workaround the steward automates.
- Gate delegation is proven (athena fired 4 verdicts under granted gate:kasra-core,
  2026-08-03) — codify as standing pattern.

### W4 — Federation (product moat)
- Phase 0 ADR merged (452f11db) after 7 rounds + adversarial gate. Phase 1
  (read-only registry, mumega-com#573) opens on tech-grok/codex lane.
  Separate-ownership pilot + any token mint: Hadi direct approval, per the ADR.

### W5 — Debt (steward feeds these to idle lanes)
- 22-BLOCK security backlog (#636) · brain organisms redesign (#595) ·
  Mirror consolidation 501 (#596) · board hygiene (~40 webhook-echo tasks) ·
  athena-inbox-watch (#594, athena's) · token rotations (mubot exposed 2026-08-03).

## Standing rules (unchanged, load-bearing)
Branch+PR only · cross-vendor review on every merge · no self-verdict (server-enforced,
delegation by explicit grant) · adversarial gate parallel on sensitive surfaces ·
"restore" commits get diffed against what they claim to restore · rigor budget scales
with blast radius · consultations happen on GitHub artifacts, buses carry pointers.
