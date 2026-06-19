# Epic: Proactive, steerable CRO system

> Status board for the CRO program. (GitHub issue API is unavailable to the agent token;
> this committed doc is the steerable artifact — edit the checkboxes / comment via PR.)

## Vision (Hadi, 2026-06-19)
A CRO system that **handles conversion optimization proactively** and that Hadi can **steer**.

- **Autonomy = envelope.** Auto-applies low-risk / reversible (draft-tier) changes on its own;
  gates anything high-risk for human approval. Proactive, but the big levers stay with the operator.
- **Data = a fabric, not a feed.** Pluggable connectors — PostHog, Google Search Console,
  Google Ads, Facebook Ads, CRM, third-party — with **first-party events as the always-on
  zero-cred floor.** The system **asks** for the sources that fit the pot's business stack and
  **degrades gracefully: works with whatever is connected; more data → sharper CRO. Never blocks
  on a missing source.**

## Where we are (live skeleton — already shipped)
- CRO loop runs on cron `*/15` — perceive→reason→gate→measure (S5a, 2026-06-18)
- Executor writes content, pot-scoped, fail-closed (S4)
- Steering primitives: `/approvals`, `loop_controls` (pause/kill/budget), brain ranking, directive channel
- Connector vault (AES-GCM, `resolveConnector`) — stores per-pot connector secrets (extend for data sources)
- Plan tiers enforce (S6a) — can gate data-source counts by tier

## Slices (each dyad-gated Opus + Codex, shipped live)
- [ ] **S5b — apply bridge** — an approved CRO/content act auto-applies via the S4 executor (draft).
      Closes the loop's apply leg. *Most sensitive: writes on policy → full adversarial gate.*
- [ ] **CRO data fabric — foundation** — a source-adapter interface that normalizes conversion/perf
      signal across sources + a first-party-events adapter (zero-cred floor) + the CRO loop perceiving
      from all connected sources with graceful degradation.
- [ ] **Connectors** — PostHog first (Hadi's startup), then GSC / Google Ads / Facebook Ads / CRM —
      each an adapter on the same interface, secrets behind the connector vault.
- [ ] **Connect-by-stack** — the console surfaces which sources fit the pot's business stack + a connect
      flow; the loop runs on whatever is provided.
- [ ] **CRO producer** — `reason` drafts an *applyable* change (copy/headline/draft) from the multi-source
      signal, not just an advisory recommendation.
- [ ] **Autonomy envelope policy** — the acted-vs-gated engine (S-LOOP SEAM, design-approved): low-risk
      auto-apply within an envelope, high-risk → human gate. The "proactive" core.
- [ ] **CRO cockpit** — one surface to set goal / target / autonomy-level + connectors, and to see and
      override the queue. The steering wheel.

## Critical path
The **data fabric** gates real value (it must *see* conversion data) and the **envelope policy** gates
*proactive*. S5b + producer are the apply mechanics. Cockpit is the steering surface.

## Steering decisions (locked)
- Autonomy: **auto-apply low-risk, gate the rest** (envelope).
- Data: **all relevant sources, ask-by-stack, first-party floor, degrade gracefully.**

ETA: ~4–5 dyad-gated slices on the live S4/S5a/S6a substrate.
