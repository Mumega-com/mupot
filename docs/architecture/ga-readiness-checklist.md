# mupot GA-Readiness Checklist (Well-Architected, CF-adapted)

> Adapted from Microsoft's *"Publishing and Releasing Your AI Agent Solution"* readiness checklist
> (5 Azure Well-Architected pillars), re-mapped to mupot's CF-native + sovereign-pot model.
> Use as the "is a pot ready to sell" gate. Status: ✅ ahead · 🟢 aligned · 🔨 gap.

## The headline
The Microsoft rubric validates our architecture: their best-practice "tenant isolation via logical separation" is *weaker* than our **per-pot Worker + D1 + KV** (physical isolation). Their **Container offer** (deploy into the customer's own subscription, data never leaves their env) is *literally our sovereign-fork model*. We're ahead on the hard part. The gaps are commercial, not architectural.

## Security
- ✅ **Multi-tenancy & data isolation** — per-pot Worker/D1/KV/R2; no shared tenant_id tables. Stronger than the rubric's bar.
- 🟢 **SSO / identity** — pot OAuth + the #262 Ed25519 SSO handoff seam.
- 🟢 **Secure onboarding** — `/setup` wizard + provisioning (owner-gated).
- 🔨 **License enforcement + subscription webhooks** — no entitlement/billing webhook layer. *(see Billing gap — the #1 GA item.)*
- 🔨 **Compliance docs** — SOC 2 / ISO 27001 / GDPR posture not documented. Needed for enterprise + regulated tenants (mining/contractors).

## Reliability
- 🟢 **IaC + CI/CD** — wrangler + GitHub Actions auto-deploy on merge.
- 🟢 **Fulfillment resilience** — provisioning-workflow (idempotent, retries) (#293).
- 🟢 **Health + autoscale + graceful degrade** — `/health` endpoints; Workers autoscale; fail-soft probes (the #294 body-read fix).
- 🔨 **Staging/preview env** — we deploy straight to prod; no mirrored preview/staging for release rehearsal.
- 🟢 **End-to-end provision testing** — the dock/provision E2E (viamar).

## Performance efficiency
- ✅ **Multi-tenant resource isolation** — per-pot Workers; one pot can't degrade another by construction.
- ✅ **Per-tenant dynamic config WITH guardrails** — the substrate contract: config-not-code, sealed versioned ports, role-based admin overlay. (Exactly the rubric's "admin UI + guardrails so configs can't break the system.")
- ✅ **Modular packaging for scale** — LEGO ports + child overlay; stateless Workers.
- 🔨 **Load testing** — no pre-launch load test of a pot under concurrent tenant load.

## Cost optimization
- 🟢 **Usage-priced compute** — CF Workers/D1/Queues are consumption-billed; no idle "Always On" tax.
- 🔨 **Unit economics per tier** — need cost-per-pot (Workers + D1 + Workers-AI tokens) vs price, margin > 0 per tier. The model cost is tracked (`agents/cost.ts`); the per-pot rollup + tier pricing is not.
- 🔨 **Metered billing / high-cost feature add-ons** — ties to the Billing gap.
- 🟢 **Budgets/alerts** — per-agent budget meter (`budget_cap_cents`); `BrainContext.budgetRemainingMicroUsd`.

## Operational excellence
- 🟢 **Safe rollout / feature flags** — versioned ports (`mupotPortVersion`) + `mupot update` (upstream merge); child overlay isolates tenant changes.
- 🔨 **Per-pot observability + alerts** — beyond the Brain page: "alert if a sub activates but the pot didn't provision," per-pot error/latency.
- 🟢 **Validation/certification** — the diverse Codex gate + tests on every sensitive surface.
- 🔨 **Launch runbook / support / FAQ** — formalize (= the recap doc, #301).

## The GA gap list (ranked)
1. **🔴 Billing / entitlement layer** — license enforcement, subscription lifecycle, metered billing, unit economics. *Keeps surfacing (Stripe-menu, cost-per-pot). The single clearest GA blocker — and the marketplace unlock (below).*
2. **Compliance docs** (SOC 2 / ISO / GDPR) — enterprise + regulated-vertical sales.
3. **Staging/preview env + load testing**.
4. **Launch runbook / support / FAQ** (#301).
5. **Per-pot ops observability + alerts**.

## Multi-cloud + marketplaces (Azure / AWS / GCP)
**Not out of reach — it's the whole point of the microkernel/ports model (#19, #167).** CF is the *default adapter*, not a lock. Three paths, by effort:

1. **Marketplace SaaS LISTING (cheapest, highest near-term value).** mupot stays CF-hosted; we *list* on Azure/AWS/GCP marketplaces as a SaaS offer (customer transacts + SSOs through the marketplace; the app runs on our CF). Gets **distribution + co-sell + enterprise procurement WITHOUT porting clouds.** Requires: the **billing/entitlement layer** (gap #1) + each marketplace's fulfillment/SSO integration. → *The billing layer we need for GA is the same unlock for marketplace listing.*
2. **BYOC sovereign deploy (medium).** Package mupot to deploy into the customer's OWN Azure/AWS/GCP subscription (the "Container offer" = their cloud, their data). Requires the **portability adapters** behind every port (pub/sub → Service Bus/SQS/PubSub; storage → SQL/Cosmos/DynamoDB; compute → Container Apps/Lambda/Cloud Run; memory → AI Search/etc; model → already gateway-able). = the full microkernel extraction.
3. **Native pot per cloud (heaviest).** Full Azure/AWS/GCP adapter sets. Only if demand justifies.

**Recommendation:** build the **billing/entitlement layer once** → it serves our own billing AND opens the cheapest marketplace path (#1, list-where-it-runs). Defer BYOC/native (#2/#3) until a real enterprise deal demands their-cloud sovereignty — and when it comes, the ports model makes it adapter work, not a rewrite.
