// mupot — Agency department module: a reusable template for a marketing/AEO agency pot.
//
// DECLARATIVE MANIFEST — no runtime hooks, no lifecycle functions, no emit calls (same
// discipline as growth.ts). It seeds the service-delivery org an agency runs for its
// clients: SEO, AEO (Answer-Engine Optimization), Paid Ads, Content. Reusable config —
// NOT specific to any one agency; a tenant activates it and gets the four squads.
//
// Microkernel litmus (§3.5 of console-department-microkernel.md):
//   - Adding this file + ONE register() call is all that is required.
//   - Nav, metric selector, capability resolver, audit writer, bus, schema, and sibling
//     departments are NOT edited.
//   - Removing this file + its register() call leaves all other tests green.
//
// Metrics: none dept-owned at this version (metricsEmitted: []). An agency's real signal —
// organic clicks, AEO citations, ad ROAS, content shipped — flows through the CRO data
// fabric (src/cro/*: connectors → cro_events / metric_points), NOT a dept collector, so it
// is not declared here. Wiring a client's GSC / Google Ads / WordPress is per-tenant
// connector work (Hadi-go for secrets; the tenant supplies its own client credentials).
//
// Tier note: this module seeds FOUR squads, so activation needs a tier whose maxSquads ≥ 4
// (pro/scale). On free/starter the entitlement gate refuses activation (squad_limit_reached) —
// correct: an agency pot is a paid tier.

import type { DepartmentModule } from '../contract'
import { register } from '../registry'

export const AgencyModule: DepartmentModule = {
  key: 'agency',
  name: 'Agency Services',
  version: '0.1.0',

  // Seeded once on first activation; re-activation is idempotent (seed-receipt guard).
  defaultSquads: [
    {
      slug: 'seo',
      name: 'SEO',
      charter:
        'Technical, on-page, and content SEO to grow each client’s qualified organic search visibility.',
      okr: 'Lift each client’s qualified organic traffic and target-keyword rankings each cycle.',
    },
    {
      slug: 'aeo',
      name: 'AEO',
      charter:
        'Answer-Engine Optimization — make client content cited by AI answer engines (ChatGPT, Perplexity, Google AI Overviews).',
      okr: 'Increase each client’s citations/mentions across AI answer engines each cycle.',
    },
    {
      slug: 'ads',
      name: 'Paid Ads',
      charter: 'Plan, run, and optimize paid campaigns (Google/Meta) to each client’s CPA/ROAS targets.',
      okr: 'Hit each client’s CPA / ROAS target within budget each cycle.',
    },
    {
      slug: 'content',
      name: 'Content',
      charter:
        'Produce and refresh client content — briefs, drafts, optimization — feeding the SEO and AEO squads.',
      okr: 'Ship each client’s content calendar on cadence, through the review gate.',
    },
  ],

  // No dept-owned metrics at this version — agency signal flows via the CRO data fabric.
  metricsEmitted: [],

  // A render reference (nav iterates getActiveConsoleSections(); no per-department branch).
  consoleSection: {
    id: 'agency',
    title: 'Agency Services',
    navIcon: 'briefcase',
    path: '/departments/agency',
  },

  // 'member' is the floor to emit metrics; the ctx facade enforces it.
  requiredCapabilities: ['member'],

  // No connectors baked into the template — an agency's data sources (each client's GSC /
  // Google Ads / WordPress / PostHog) are PER-TENANT and wired through the CRO connector
  // vault at onboarding time (tenant supplies its own client credentials; Hadi-go for secrets).
  connectors: [],
}

register(AgencyModule)
