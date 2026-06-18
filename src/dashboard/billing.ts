// src/dashboard/billing.ts — billing tier surface for the pot console.
//
// PURE READ + PRESENTATION (no mutation, no new write routes, no new authority).
//
// Reads org_settings.billing_state (key 'billing_state') and the plain 'plan' /
// 'tier' fallback keys via the shared getJSON / getSetting helpers in settings.ts.
// The billing state is written ONLY by the HMAC-authed POST /api/billing/plan
// route (src/billing/admin.ts) — this module is the read side only.
//
// View model fields:
//   plan   — the PotTier string ('free' | 'starter' | 'pro' | 'scale'), or null
//   tier   — alias for plan (billing_state also carries a redundant 'tier' field)
//   status — 'active' | 'not_configured' (not_configured → emptyState render)
//   since  — ISO effective_at from billing_state, or null
//
// NO billing secrets, NO payment-method or card data, NO invoice events.
// NO fabricated card numbers, amounts, or balances (Codex condition 6).

import type { Env, AuthContext } from '../types'
import { getJSON, getSetting } from './settings'
import { BILLING_STATE_KEY } from '../billing/entitlement'
import { isPotTier, type PotTier, PLAN_LIMITS, POT_FEATURES, coerceTier } from '../billing/plans'
import {
  pageHeader,
  sectionPanel,
  statCard,
  kpiRow,
  pill,
  emptyState,
} from './ui'
import type { HtmlEscapedString } from 'hono/utils/html'
import { html, raw } from 'hono/html'

// ── types ─────────────────────────────────────────────────────────────────────

export interface BillingViewModel {
  /** The resolved plan tier ('free' | 'starter' | 'pro' | 'scale'). */
  plan: PotTier
  /**
   * 'active' — billing_state key exists (pot was ever assigned a tier by the
   *            central billing source).
   * 'not_configured' — no billing_state key present; the pot is on the implicit
   *            free tier but was never explicitly provisioned.
   */
  status: 'active' | 'not_configured'
  /**
   * ISO-8601 effective_at from billing_state, or null when the key was not
   * present or the date could not be parsed.
   */
  since: string | null
}

// ── data loader ───────────────────────────────────────────────────────────────

/**
 * Load the pot's billing view model.
 *
 * Visibility: all roles (billing tier is not secret — it gates feature access
 * that every member can observe anyway).  The _write_ path is HMAC-gated; this
 * read is unrestricted.
 *
 * Reads:
 *   1. org_settings.'billing_state'  — canonical: { tier, event_id, effective_at }
 *   2. org_settings.'plan'           — legacy / manual override fallback
 *   3. org_settings.'tier'           — legacy / manual override fallback
 *
 * Priority: billing_state > plan > tier > implicit 'free'.
 */
// auth is accepted to keep the signature uniform with other loaders but is not
// used — billing tier is visible to all roles.
export async function loadBilling(
  env: Env,
  _auth: AuthContext,
): Promise<BillingViewModel> {
  // Primary: billing_state JSON blob written by the HMAC-authed plan setter.
  const billingState = await getJSON<{ tier?: unknown; effective_at?: unknown }>(
    env,
    BILLING_STATE_KEY,
  )

  if (billingState !== null) {
    const plan = coerceTier(billingState.tier)
    const rawEff = billingState.effective_at
    const since =
      typeof rawEff === 'string'
        ? rawEff
        : typeof rawEff === 'number'
          ? new Date(rawEff).toISOString()
          : null
    return { plan, status: 'active', since }
  }

  // Fallback 1: plain 'plan' key (legacy / manual).
  const planRaw = await getSetting(env, 'plan')
  if (planRaw !== null && isPotTier(planRaw)) {
    return { plan: planRaw, status: 'active', since: null }
  }

  // Fallback 2: plain 'tier' key.
  const tierRaw = await getSetting(env, 'tier')
  if (tierRaw !== null && isPotTier(tierRaw)) {
    return { plan: tierRaw, status: 'active', since: null }
  }

  // Not configured — fail-closed to free.
  return { plan: 'free', status: 'not_configured', since: null }
}

// ── body renderer ─────────────────────────────────────────────────────────────

const TIER_TONE: Record<PotTier, Parameters<typeof pill>[1]> = {
  free: 'dim',
  starter: 'accent2',
  pro: 'ok',
  scale: 'primary',
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toUTCString().replace(' GMT', ' UTC')
  } catch {
    return iso
  }
}

function fmtLimit(v: number): string {
  return v < 0 ? 'Unlimited' : String(v)
}

/**
 * Render the Billing page body.
 *
 * When status === 'not_configured' → honest emptyState.
 * When status === 'active' → plan pill + numeric limits from the frozen catalog.
 *
 * NO fabricated amounts, cards, or payment data (Codex condition 6).
 */
export function billingBody(model: BillingViewModel): HtmlEscapedString {
  const header = pageHeader({ title: 'Billing', sub: 'Current plan and feature entitlements.' })

  if (model.status === 'not_configured') {
    return html`${header}${emptyState({
      title: 'Billing not configured',
      detail:
        'No billing plan has been applied to this pot. The pot runs on the implicit free tier until the central billing source assigns a plan.',
      hint: 'Contact the platform operator to configure billing for this pot.',
    })}` as HtmlEscapedString
  }

  const limits = PLAN_LIMITS[model.plan]

  // KPI row: numeric limits from the frozen catalog (these are structural
  // scaffolding values — actual limits are set by the product/pricing decision).
  const kpis = kpiRow([
    statCard({ label: 'Agents', value: fmtLimit(limits.maxAgents) }),
    statCard({ label: 'Squads', value: fmtLimit(limits.maxSquads) }),
    statCard({
      label: 'Monthly model budget',
      value:
        limits.monthlyModelBudgetMicroUsd < 0
          ? 'Unlimited'
          : `$${(limits.monthlyModelBudgetMicroUsd / 1_000_000).toFixed(0)}`,
    }),
  ])

  // Feature list for this tier — derived from the frozen POT_FEATURES catalog.
  const features = (Object.entries(POT_FEATURES) as Array<[string, { minTier: PotTier; label: string }]>)
    .filter(([, spec]) => {
      const TIER_RANK: Record<PotTier, number> = { free: 0, starter: 1, pro: 2, scale: 3 }
      return TIER_RANK[model.plan] >= TIER_RANK[spec.minTier]
    })
    .map(([, spec]) => spec.label)

  // featureItems: sync html`` expressions. Cast because Hono's tagged template
  // returns HtmlEscapedString | Promise<HtmlEscapedString> but these have no
  // async interpolations — they are always sync.
  const featureItems: HtmlEscapedString[] =
    features.length > 0
      ? features.map((f) => html`<li>${f}</li>` as HtmlEscapedString)
      : [html`<li style="color:var(--dim)">Base features only</li>` as HtmlEscapedString]

  // panelBody cast: sync template, no async interpolations.
  const panelBody = html`
    <div style="display:flex;flex-wrap:wrap;gap:var(--sp-3);align-items:center;margin-bottom:var(--sp-4)">
      <span style="font-size:1.1rem;font-weight:600">Plan:</span>
      ${pill(model.plan.charAt(0).toUpperCase() + model.plan.slice(1), TIER_TONE[model.plan])}
      ${model.since ? html`<span style="color:var(--dim);font-size:.85rem">Active since ${raw(fmtDate(model.since))}</span>` as HtmlEscapedString : ''}
    </div>
    ${kpis}
    <div style="margin-top:var(--sp-4)">
      <h3 style="font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin-bottom:var(--sp-2)">Included features</h3>
      <ul style="padding-left:1.25rem;line-height:1.8">${featureItems}</ul>
    </div>` as HtmlEscapedString

  const panel = sectionPanel({ title: 'Plan details', body: panelBody })

  return html`${header}${panel}` as HtmlEscapedString
}
