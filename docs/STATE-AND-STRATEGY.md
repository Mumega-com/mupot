# mupot — state & strategy (2026-06-19)

> The through-line, so it isn't scattered across CLAUDE.md + the epic + the playbooks. Trust
> the code over this doc; this is the map, not the territory.

## The thesis (positioning)
**mupot is the AI operations layer** — the governed runtime an AI team needs to touch a real
business safely. Not an agent builder, not a chatbot, not a dashboard. The product answers:
*who can do what · what context they know · which tools · what needs approval · what changed ·
what failed · what we learned · who owns the next step.*

The strategy is **commoditized** — every capable model (ChatGPT/Codex/Gemini), asked to design
safe agent operation, re-derives the same operating layer. So the plan is free; the **moat is
the governed runtime that executes it** — permissions, roles, validation, memory, the review
gate, receipts. Showcase: `/blog/you-are-describing-mupot` (send it to AI/builders who are
re-deriving it). Discipline: don't build the OS into a tool (MCPWP stays a *tool*; the runtime
governs). Cross-vendor dyad-gate (Opus + Codex) is part of the moat — everyone's single model
shares blind spots.

## The 8 operations-layer pillars (5 built, 3 = the wedge)
1. Agent squads — ✅ departments + squads + tentacles
2. Business memory — ✅ RBAC-tiered pot memory
3. Tool governance — ✅ connector vault (encrypted, per-scope) + capability gates
4. Approval gates — ✅ `/approvals` + content-bound gated-ACT executor (S4)
5. Receipts — ✅ write-verified, executor artifact URLs, audit, no-fake-green
6. Validation — ⚠ the `qa` squad (web-ops)
7. Reusable playbooks — ⚠ named playbooks (web-ops/README)
8. Cross-tool orchestration — ⚠ one squad across MCPWP + GHL (web-ops)
The three ⚠ are exactly the **wedge**: *AI website operations with approval* (`web-ops`, Digid as proof).

## Reseller program (GTM)
Like mumega resells PECB: agencies/experts resell our engine to **their** networks, white-label.
- **Sellers:** Maryam/DME (AEO+marketing), aionboard, eztek (IT), Gavin (PEI), Noor (YSpace), printshops.
- **Brand:** white-label on the reseller's own domain (their brand; mupot+Inkwell invisible).
- **Money:** **Stripe Connect platform-fee %** — reseller sells at their price; mumega takes a % of each client subscription. Subscription/retainer model. (Freemius in stack for WP-plugin/licensing.)
- **Channel:** GHL — build one master setup → **snapshot** → deploy per reseller. Gavin & Noor work in **digid's GHL** now; Maryam gets a new snapshot on demand. *Near-term focus: the digid GHL until first demand.*
- **Deploy:** sovereign — **each tenant = own Cloudflare + own GH repo + own mupot deploy** (like digid/viamar; mupot is single-tenant-per-deploy — no `tenants` table, fixed `TENANT_SLUG`). Customer mints/deploys are **Hadi-go**.
- **Sell-glue (to build):** `provisionResellerTenant()` orchestrator + Stripe-Connect-% + white-label Inkwell storefront. See `docs/playbooks/agency-onboarding-and-automation.md`.

## Reusable department modules (the microkernel — config, not code)
- `growth` — Marketing & Sales (demand-gen, pipeline). Live.
- `agency` — AEO/SEO/Ads/Content (the marketing-agency template). Live (PR #216). 4 squads → tier ≥ pro.
- `web-ops` — AI website operations: site-operator/qa/content-seo/brand-assets/funnel-ghl/strategy.
  Live (PR #218). 6 squads → tier ≥ pro. The wedge. Connect-and-activate + the 6 tentacle agent-defs
  + playbooks in `docs/web-ops/README.md`.
- **Service catalog** (`src/services/catalog.ts`, PR #217) — the priced basket (AEO/SEO/Ads/Content/
  Fast-MVP × Starter/Pro/Premium, integer-cents DRAFT prices editable in config) + `/services` console view.

## CRO data fabric (the loop's eyes — see cro-system-epic.md)
- ✅ Foundation (PR #214): pluggable `CroSource` adapters → `metric_points`, graceful degradation, capped.
- ✅ Event grain (PR #215): `cro_events` (idempotent via `event_key`) for attribution/segmentation.
- Next: PostHog connector (key secured) → autonomy envelope (G1–G8) → CRO producer → cockpit.

## Open / gated / discipline
- **Hadi-go:** customer-pot mints/deploys, Stripe Connect keys, token mints, RBAC, secrets.
- **Ops (not repo code):** the master digid-GHL + snapshot; Gavin/Noor access.
- **Open:** mupot multi-tenancy (if we outgrow per-tenant deploys); the reseller sell-glue; web-ops
  materialization (console renderer, narrow agent-def tools, MCPWP/GHL connectors); tier-set the mumega
  pot to scale; flip the dyad-gate ON (branch protection + `DYAD_GATE_REVIEWERS`).
- **Infra note:** recall/remember (Postgres) backend down — async `kasra-review` freezes on it; run gate
  reviews **sync with recall skipped**.
