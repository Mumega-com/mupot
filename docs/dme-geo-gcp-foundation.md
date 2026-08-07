# DME GEO/SEO — GCP foundation and verified capability

| | |
|---|---|
| Status | Foundation verified live 2026-07-25. Baselines not yet running. |
| Owner | Kasra (substrate) · Cursor (DME cell) · Codex (gate) |
| Epic | [#567](https://github.com/Mumega-com/mupot/issues/567) |
| Principal | Hadi. Maryam / DME are the customer side, not team capacity. |

Everything in the "verified" sections below was executed against live
infrastructure and the output read back. Nothing here is inferred from
documentation or vendor marketing. Where something is unverified it says so.

---

## 1. Why DME is not a customer

DME is the **template instance** of the fractal. Each pot is a P&L unit: it
earns, reports its own costs, and the surplus splits. Mumega recovers cost plus
support; Digid × DME split what remains. Same cell, next partner, no new
architecture.

Consequence: what we get wrong here we get wrong N times. That is the argument
for spending the effort on the cost ledger and the isolation model now rather
than after the second partner.

---

## 2. Verified — GCP state

Project **`mumegaproject`** (number `542007742942`).

> ⚠️ `gcloud config` previously pointed at `mumega-com`, a project this account
> has **no access to**. Every command must target `mumegaproject` explicitly.

Billing: **enabled**, account `01FB5D-D3EFD8-6257B3`.
**Unverified:** whether that account is trial or paid. Trial expiry behaves
differently; confirm before relying on the credit window.

### APIs enabled

```
aiplatform              artifactregistry        analyticsdata
cloudbuild              cloudresourcemanager    cloudscheduler
compute                 container               generativelanguage
iam                     iamcredentials          logging
monitoring              pagespeedonline         run
searchconsole           secretmanager           storage
```

Seven of these were enabled by the agent itself, which confirms
`serviceusage` control is real rather than nominal — further APIs do not
require a human round-trip.

### Access — open issue

The agent currently operates as **`roles/owner` via Hadi's personal account**.
This works but is wrong in three ways: actions are indistinguishable from
Hadi's own, access dies with his session, and it is maximum privilege for
build-and-deploy work.

Intended shape — a scoped service account `mumega-agent`, reached by
impersonation rather than a downloaded key (no long-lived credential on disk,
tokens expire on their own):

```
roles/serviceusage.serviceUsageAdmin   roles/container.admin
roles/run.admin                        roles/artifactregistry.admin
roles/secretmanager.admin              roles/cloudbuild.builds.editor
roles/aiplatform.user                  roles/cloudscheduler.admin
roles/storage.admin                    roles/iam.serviceAccountUser
roles/logging.viewer                   roles/monitoring.viewer
```

Deliberately excluded: `roles/owner`, anything billing, and
`resourcemanager.projectIamAdmin` — so the account cannot raise its own
privileges or move money, and one binding removal cuts it off entirely.

**Not yet created.**

---

## 3. Verified — the GEO signal works

Vertex AI, `gemini-2.5-flash` with `tools: [{googleSearch: {}}]`, live call:

**Prompt:** *"Who are the best rated plumbers in Richmond Hill, Ontario?"*

```
Named:    TAT Plumbing & Drain (5.0 / 277 reviews)
          Cirton Plumbing & Drains (5.0 / 273 reviews)
          McPipe Plumbing ...

Searched: "best rated plumbers Richmond Hill Ontario"
          "top plumbers Richmond Hill Ontario reviews"

Cited:    aplusplumbing.ca · reliancehomecomfort.com · sureflow.ca
          yellowpages.ca · reddit.com
```

**This response is the report.** Three fields carry the value:

| field | what it tells the client |
|---|---|
| answer text | whether they are named at all, and who is |
| `webSearchQueries` | the query Google actually ran — not our guess |
| `groundingChunks` | the domains treated as authoritative — where GEO work must win |

For a local service business the finding writes itself: *you are not named,
these competitors are, and here are the five sources the model trusts.*

No vendor, no scraper, no subscription.

### Model availability

`gemini-2.5-flash` and `gemini-flash-latest` work. **`gemini-3-flash` is not
available on this project.**

This has a cost consequence. Published pricing gives Gemini 3.x a free tier of
5,000 grounded prompts/month and charges 2.x at a materially higher per-query
rate. Since only 2.5 is reachable here, **any earlier claim that grounding is
mostly free is unverified.** Measure real spend on the first batch rather than
reasoning from a pricing page.

---

## 4. Data architecture

```
Google (Vertex grounding · PSI · Search Console · GA4)  +  DataForSEO
        │
        ▼   scan results as events, one PostHog project per client
   PostHog  ──  storage · history · HogQL     (startup plan, 1 year)
        │
        ▼   query API
   seo-collector  ──▶  gated proposal  ──▶  receipt      (already built)
        │
        ▼
   Cloudflare dashboard, branded per client               (later)
```

### What already exists — do not rebuild

- **`src/departments/collectors/seo-collector.ts`** — built, and explicitly
  leaves "PostHog and GSC slots as honest *source not connected* seams for
  S4+". It refuses to fabricate: no signal means it proposes an audit rather
  than emitting a fake zero. The task is filling those slots, not writing a
  collector.
- **`src/cro/posthog.ts`** — HogQL Query API reader, SSRF-hardened against a
  hostile `POSTHOG_HOST`, fail-closed without a key, secret never logged.
- **`src/addons/marketing/adapters/posthog.ts`** — **per-tenant PostHog project
  IDs** already stored per connector. Tenant isolation therefore exists at the
  vendor boundary rather than depending on a `WHERE tenant = ?` being correct
  every time.

### PostHog

Startup plan, up to $50k credits over 12 months, includes the data warehouse.
Storage, history and aggregation are effectively free for the year, which means
GCP credit buys **only fresh data** — no infrastructure. Baseline history is
the one asset that cannot be backfilled later, so that is where the credit
should go.

Caveat: PostHog is **not white-label**. It is the engine, never the storefront.
The client-facing surface stays ours on Cloudflare. Also, DME's clients' data
would physically sit in PostHog (US region) — Maryam should know that before a
client asks, not after.

---

## 5. Data sources — legal position

Full review: `mumega.com/docs/geo-seo-vendor-tos-review-2026-07-25.md`.

| vendor | resale / white-label | note |
|---|---|---|
| **Google APIs** | no issue | used with the client's own consent |
| **DataForSEO** | ToS **silent** | only bars competing with search engines. $0.0006–0.002/SERP call, AI Overview +$0.0006 refunded if absent, GMB $0.0015–0.003/profile, $50 min, no contract |
| **Otterly.AI** | silent, but **no native white-label** | their support docs push static Looker Studio exports, not live dashboards. $189/mo for 2k req |
| **Peec AI** | **§1.1 explicitly prohibits** third-party/service use without written agreement | and the REST API is Enterprise-only — the ~$95 tier has no API at all |

**Lesson worth keeping: "the ToS is silent" is not legal permission.** Do not
ship customer-facing resale on vendor silence — get it in writing.

Position: Google-first (free, consented, no resale question), DataForSEO as the
paid gap-filler for AI Overviews and pre-approval GBP data. Peec is out.

---

## 6. Google Business Profile — the only real clock

GBP is the highest-value source for local service businesses, and it is gated
behind a **manual one-time access approval**. Until approved the project is
enabled-but-throttled-to-zero — enabling the API does nothing.

- Review takes **14 days minimum**, often weeks
- Requires a verified GBP active 60+ days, a valid website, a concrete use case
- Thin applications are rejected

```
mybusinessbusinessinformation.googleapis.com
mybusinessaccountmanagement.googleapis.com
businessprofileperformance.googleapis.com
```

**Apply now, ship without it.** DataForSEO's Business Data endpoint returns
GBP-style local data with no approval gate and bridges the wait. Waiting on
approval would cost two weeks for nothing.

---

## 7. Runtime

| workload | where | why |
|---|---|---|
| Pot, dashboard, scoring, storage | Cloudflare | startup plan; survives day 28 unchanged |
| Nightly scans | Cloud Run Jobs | scale-to-zero, per-second billing |
| Hermes / agent host | GKE Autopilot | control plane covered by GKE's **own** free-tier credit, which is separate from the $300 |

The rule that matters: **anything durable lives on Cloudflare.** If the scoring
engine were built inside GKE, credit expiry would hurt. Confined to Hermes, day
28 is a non-event (~$10–15 of pod compute over 27 days).

### Open design question

Two different things are called "Hermes":

1. a **stateless Telegram relay** — `deploy/hermes-gke/` ([#569](https://github.com/Mumega-com/mupot/pull/569)), built
2. a **fleet-runtime agent host** — issue #434, `deploy/kubernetes/agent-host/`:
   ECC-installed, PVC-backed, signing-key-bearing, intended to run DME's agents

"mupot, its agents on hermes" points at (2). That also settles the
Cloud-Run-instead-of-GKE question: Cloud Run cannot host a stateful,
PVC-backed, key-bearing runtime, so GKE is correct **if** the target is the
agent host. Resolve before provisioning either.

---

## 8. Known blockers

1. **The fractal has no instrument.** 50/50-after-costs needs a per-pot P&L —
   CF usage, data-API spend and token spend attributed per tenant. Does not
   exist. Without it the split is unauditable and the first partner
   disagreement is about money with no receipt. Product feature, not
   bookkeeping.
2. **Production is drifted and blind.** `mumega`, `viamar` and `digid` all
   report `commit: null`; CI has never had a real deploy step. Fix in
   [#571](https://github.com/Mumega-com/mupot/pull/571). Must land before any customer showcase — debugging a
   silent staleness ghost in front of a paying partner is the worst possible
   time to discover it.
3. **No CF deploy credential in CI.** `.github/workflows/` has no
   `CLOUDFLARE_API_TOKEN`, so CI cannot deploy at all. Minting one is a
   Hadi-go decision, which is why #571 ships a staleness *detector* rather
   than auto-deploy.
4. **Authorization points only Hadi can pass:** Gate B (welded token mint),
   Gate D (watched cross-pot flight), and the Maryam showcase.
5. **Grounding cost unmeasured** — see §3.

---

## 9. Timing — what actually constrains delivery

Build time is **agent-hours, not weeks**. Two things genuinely take wall-clock:

- **authorization latency** at the points above
- **trend-data accumulation** — a visibility trend needs several days of
  deltas. Baseline today, meaningful trend around day 4–5. This is physics,
  not effort, and it is the reason scans should start before the dashboard is
  pretty.

The 27-day credit window constrains **Hermes hosting only**, not delivery.
Estimating this work in human calendar days is a category error.
