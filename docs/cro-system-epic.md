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
- [~] **S5b — apply bridge** — BUILT, PR open, not yet dyad-gated/merged/deployed.
      `kasra/cro-apply-bridge` (mupot) + `kasra/cro-apply-read-endpoint` (mumega.com,
      companion PR adding the missing internal read-by-slug endpoint). Closes the
      loop's apply leg with a FETCH-THEN-MERGE write (never full-replace) behind a
      change-type allowlist (`src/departments/change-types.ts`): meta_title/
      meta_description/cta_text/internal_links auto-proposable, body_copy/headline
      flagged for extra human review, layout/forms/offer/pricing/brand_voice + any
      unrecognized type hard-refused before a gate record exists. Still goes through
      the SAME S4 propose→approve→execute gate — no auto-publish. *Most sensitive:
      writes on policy → needs the full adversarial gate before merge, per the epic's
      own note below.* Open gap: this slice does not yet wire `src/loops/cro.ts`'s
      `reason()` output (a freeform `recommendation` string) into a structured
      `{changeType, value, findText}` intent — that mapping is a product/NLP decision
      left for the next slice, not fabricated here.
- [x] **CRO data fabric — foundation** ✅ (PR #214, live) — `src/cro/sources.ts` (`CroSource` adapter
      interface + `collectFromSources` graceful degradation + `MAX_POINTS_PER_SOURCE` cap) +
      `src/cro/first-party.ts` (zero-cred floor over `metric_points`) + connector types (posthog/gsc/
      google_ads/facebook_ads/crm). Both lenses green; Codex caught the missing per-source cap.
- [x] **CRO event grain** ✅ (PR #215, live) — `migrations/0031_cro_events.sql` + `src/cro/events.ts`
      (`recordCroEvents`/`readCroEvents` — tenant-bound, validated, capped, **idempotent** via
      `event_key` + unique index + INSERT OR IGNORE). The attribution/segmentation grain alongside
      `metric_points` (research-forced; Codex caught the retry-overcount + unbounded-fields holes).
- [x] **Connectors — PostHog** ✅ (PR #219, live) — `src/cro/posthog.ts` (`posthogCroSource`: a
      server-aggregated 24h conversion signal — event volume + unique users — via the PostHog
      Query API/HogQL) + `src/cro/collect.ts` (`runCroCollection`, the 6th cron heartbeat: collect
      external sources → persist via `emitMetric`, first-party write-amplification guard) +
      `src/lib/ssrf.ts` (shared hardened private-host blocker, extracted from the S4 executor).
      Dual-gate: **Codex RED→GREEN** (BLOCK-1 SSRF: https-only let internal hosts through — fixed
      by routing through the shared guard), Opus GREEN (2 WARNs fixed: body-read inside the abort
      window + the missing timeout test). Next connectors (GSC / Google Ads / Facebook Ads / CRM)
      = the same adapter shape; secrets move behind the connector vault when multi-pot.
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
