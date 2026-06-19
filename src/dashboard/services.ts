// src/dashboard/services.ts — the service-catalog console surface (the priced basket).
//
// PURE READ + PRESENTATION. Renders SERVICE_CATALOG (src/services/catalog.ts) — the
// offerings a reseller sells, with quality tiers + prices. Prices are config (draft until
// the operator sets them), so this view is honest about that: a "DRAFT pricing" badge, no
// fabricated balances or sales data. The squads named in `deliveredBy` are what fulfill each.

import { html } from 'hono/html'
import { pageHeader, sectionPanel, statCard, kpiRow, dataTable, pill } from './ui'
import { SERVICE_CATALOG, formatTierPrice, type ServiceOffering } from '../services/catalog'

export function servicesBody(catalog: readonly ServiceOffering[] = SERVICE_CATALOG) {
  const header = pageHeader({
    crumbs: 'Console',
    title: 'Services',
    sub: 'The basket of services you sell to your clients. Prices are editable in config — figures below are drafts.',
    badge: 'DRAFT pricing',
    badgeTone: 'accent2',
  })

  const tierCount = catalog.reduce((n, s) => n + s.tiers.length, 0)
  const kpis = kpiRow([
    statCard({ label: 'Services', value: String(catalog.length) }),
    statCard({ label: 'Tiers', value: String(tierCount) }),
    statCard({ label: 'Pricing', value: 'Draft', sub: 'set in config', subTone: 'dim' }),
  ])

  const panels = catalog.map((svc) =>
    sectionPanel({
      title: svc.name,
      right: pill(`fulfilled by: ${svc.deliveredBy}`, 'dim'),
      body: html`
        <p class="ui-sub">${svc.summary}</p>
        ${dataTable({
          cols: [
            { label: 'Tier', width: '1fr' },
            { label: 'Price', width: '1fr' },
            { label: 'Includes', width: '2fr' },
          ],
          rows: svc.tiers.map((t) => [
            html`${t.name}`,
            html`<strong>${formatTierPrice(t)}</strong>`,
            html`${t.note ?? ''}`,
          ]),
        })}
      `,
    }),
  )

  return html`${header}${kpis}${panels}`
}
