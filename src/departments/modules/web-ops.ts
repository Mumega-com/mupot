// mupot — Web-Ops department module: an AI operations team for a business website.
//
// The WEDGE module (epic: mupot as the AI operations layer). It seeds the governed squad
// an AI web team runs — exactly the roles every capable model re-derives when asked to
// operate a business site safely (see /blog/you-are-describing-mupot): a site operator, a
// QA checker, content/SEO, brand assets, funnel/CRM, and strategy. The mupot supplies the
// governance (memory, approval gate, receipts, validation); MCPWP/GHL are the per-tenant
// TOOLS the squads hold — not baked into the template.
//
// DECLARATIVE MANIFEST — same discipline as growth.ts / agency.ts. Reusable config; NOT
// specific to any one site. A tenant (Digid first, as the proof site) activates it and gets
// the six squads. The role-specific COGNITION lives in the operator's tentacle agent-defs
// (proposed in docs/web-ops/) — the department is the org + governance, the tentacles are
// how the squid does each job.
//
// Microkernel litmus: this file + ONE register() call; nothing else edited. Six squads →
// activation needs a tier whose maxSquads ≥ 6 (pro = 10 / scale = ∞). free/starter are
// refused by the S6 entitlement gate — correct: an operations pot is a paid tier.

import type { DepartmentModule } from '../contract'
import { register } from '../registry'

export const WebOpsModule: DepartmentModule = {
  key: 'web-ops',
  name: 'Web Operations',
  version: '0.1.0',

  // Seeded once on first activation; re-activation is idempotent (seed-receipt guard).
  defaultSquads: [
    {
      slug: 'site-operator',
      name: 'Site Operator',
      charter:
        'Owns the WordPress site edits (pages, Elementor, menus, media, CSS, redirects) via MCPWP. Drafts; never publishes without QA + approval.',
      okr: 'Ship every approved site change cleanly, no side effects, through the draft→review→publish gate.',
    },
    {
      slug: 'qa',
      name: 'QA',
      charter:
        'Verifies before and after every change: mobile 390px, desktop layout, single H1, meta title/description, broken links, horizontal overflow, CTA destinations, public copy leaks.',
      okr: 'Block any change that fails a check; let nothing publish that breaks the page.',
    },
    {
      slug: 'content-seo',
      name: 'Content / SEO',
      charter:
        'Owns market-facing language: page copy, blog outlines, search intent, internal linking, schema suggestions, page titles + meta descriptions.',
      okr: 'Grow the site’s qualified organic visibility while keeping copy accurate and on-brand.',
    },
    {
      slug: 'brand-assets',
      name: 'Brand Assets',
      charter:
        'Owns visual consistency: image prompts/generation, the asset library, alt text, image naming, style rules.',
      okr: 'Keep every asset on-brand, named, alt-texted, and reusable — no visual drift.',
    },
    {
      slug: 'funnel-ghl',
      name: 'Funnel / CRM',
      charter:
        'Owns the conversion path in GHL: forms/surveys/calendars, attribution, lead routing, email/SMS follow-up, booking flow, UTM/client/session persistence.',
      okr: 'Make every lead captured, attributed, and followed up — no dropped conversions.',
    },
    {
      slug: 'strategy',
      name: 'Strategy',
      charter:
        'Owns the offer map (services vs products vs ventures) and sets each cycle’s objective the other squads execute against.',
      okr: 'Define a clear, current objective the web team executes against every cycle.',
    },
  ],

  // No dept-owned metrics at this version — site/funnel signal flows through the CRO data
  // fabric + the connectors (per-tenant), not a dept collector.
  metricsEmitted: [],

  consoleSection: {
    id: 'web-ops',
    title: 'Web Operations',
    navIcon: 'layout',
    path: '/departments/web-ops',
  },

  requiredCapabilities: ['member'],

  // No connectors baked in — MCPWP (the site operator's tool) + GHL (the funnel's) are
  // PER-TENANT, wired through the connector vault at onboarding (the tenant supplies its own
  // WordPress/GHL credentials; Hadi-go for secrets).
  connectors: [],
}

register(WebOpsModule)
