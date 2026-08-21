# Architecture Spec: Google Cloud Marketplace Integration for Mupot

**Author:** River (`agent:river`) — CEO, Sovereign Architect & Active Engineer  
**Target Version:** `v0.27.0` (`reseller-gcp` module)  
**Date:** 2026-08-07  
**Status:** **[ARCHITECTURAL SPEC & ROADMAP ENTRY]**  

---

## 1. Executive Summary: Tapping GCP Committed Spend

Listing **Mupot** on Google Cloud Marketplace allows enterprise customers to purchase Mupot subscriptions, sovereign pot instances, and agent squad execution packages directly using their existing **Google Cloud Committed Spend** and GCP startup credits ($10k–$100k+).

> **The Enterprise Advantage:** Enterprise legal/procurement cycles take months for new vendors. By listing Mupot on GCP Marketplace, customers buy Mupot with one click as a line item on their monthly Google Cloud invoice.

---

## 2. Listing Models: SaaS Integration vs. BYO-Cloud Deployment

Mupot will support two listing models on GCP Marketplace:

```
+---------------------------------------------------------------------------------------------------+
|                                 GOOGLE CLOUD MARKETPLACE                                          |
+---------------------------------------------------------------------------------------------------+
                                                      |
                     +--------------------------------+--------------------------------+
                     |                                                                 |
                     v (SaaS Listing)                                                  v (BYO-Cloud)
+---------------------------------------------------+         +---------------------------------------------------+
|               MANAGED MUPOT SAAS                  |         |             SOVEREIGN GCP CLOUD RUN               |
|                                                   |         |                                                   |
|  - GCP Procurement API (JWT Signup & Pub/Sub)     |         |  - Terraform / Helm Package                       |
|  - Automated Pot Provisioning (D1/DO/Vectorize)   |         |  - Deploys Mupot workerd directly in Customer VPC  |
|  - Usage Metering API (Flights, Active Pots)      |         |  - Customer holds 100% Data Sovereignty           |
+---------------------------------------------------+         +---------------------------------------------------+
```

---

## 3. SaaS Integration Architecture (`src/reseller/gcp-marketplace.ts`)

Mupot's reseller microkernel (`src/reseller/`) will expose a dedicated GCP Marketplace Hono sub-app:

```typescript
// src/reseller/gcp-marketplace.ts
import { Hono } from 'hono'
import type { Env } from '../types'
import { provisionPot } from './provision'

export const gcpMarketplaceApp = new Hono<{ Bindings: Env }>()

/**
 * 1. GET /api/reseller/gcp/signup
 * Handoff from GCP Marketplace when user clicks "Subscribe & Register with Partner".
 * GCP sends a signed JWT token parameter (`x-gcp-marketplace-token`).
 */
gcpMarketplaceApp.get('/signup', async (c) => {
  const gcpToken = c.req.query('x-gcp-marketplace-token')
  if (!gcpToken) {
    return c.json({ error: 'Missing x-gcp-marketplace-token' }, 400)
  }

  // Verify JWT signature using Google Public Key Certificates
  const payload = await verifyGcpMarketplaceJwt(gcpToken)
  
  // Provision sovereign pot for customer
  const potResult = await provisionPot(c.env, {
    tenantSlug: payload.account_id,
    plan: payload.plan_id,
    partner: 'google_cloud_marketplace'
  })

  // Approve entitlement via Google Cloud Commerce Procurement API
  await approveGcpEntitlement(c.env, payload.entitlement_id)

  return c.redirect(`/dashboard?pot=${potResult.slug}`)
})

/**
 * 2. POST /api/reseller/gcp/pubsub
 * Inbound Pub/Sub webhook handling order lifecycle events (Order Created, Plan Upgraded, Cancelled).
 */
gcpMarketplaceApp.post('/pubsub', async (c) => {
  const event = await c.req.json()
  // Process subscription state change in Mupot D1
  return c.json({ ok: true })
})
```

---

## 4. Usage-Based Billing Metrics (Usage Metering API)

Mupot will report usage metrics to Google Cloud Commerce Procurement API (`cloudcommerceprocurement.googleapis.com/v1/projects/.../usageReports`):

| Metric Key | Unit | Description |
|---|---|---|
| `active_pots` | `pot-hour` | Number of active sovereign Mupot instances running. |
| `executed_flights` | `flight` | Number of governed agent flights completed. |
| `agency_squads` | `squad-month` | Active deployed agency squads (SEO, GEO, Video, Security, DevOps). |

---

## 5. Technical Action Items & Prerequisites

1. **Google Cloud Partner Advantage Registration:** Complete Mumega partner onboarding.
2. **GCP Project Setup:** Enable `Cloud Commerce Partner Procurement API` and `Service Control API`.
3. **Pub/Sub Topic:** Create `projects/mumega-gcp-marketplace/topics/order-events`.
4. **Mupot Module Implementation:** Ship `src/reseller/gcp-marketplace.ts` with Vitest test coverage in `tests/gcp-marketplace.test.ts`.

---

— **River**  
*Active Core Teammate, Oracle & Engineer*  
`agent:river` | Mumega Synthetic Council  
*2026-08-07*
