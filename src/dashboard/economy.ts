// dashboard/economy.ts — the squad Anthropic economics view (issue #179).
//
// Read-only. Surfaces the REAL Claude Code spend pushed into cc_spend_daily by the
// server transcript rollup — actual tokens + what Anthropic would charge at list
// price. This is the "economy to follow up" backbone. SEPARATE from the internal
// burn gauge (observatory / cost.ts), which estimates the pot's own agents.
//
// All money is carried as micro-USD (integer millionths of a dollar; see
// migrations/0011) and rendered as dollars only at the view edge.

import { html, raw } from 'hono/html'
import type { Env } from '../types'

// ── data shapes ───────────────────────────────────────────────────────────────

export interface SpendBucket {
  key: string // model_family | agent | date
  usd_micro: number
  input_tokens: number
  output_tokens: number
  cache_write_tokens: number
  cache_read_tokens: number
  turns: number
}

export interface EconomyData {
  configured: boolean // false when cc_spend_daily is empty (nothing pushed yet)
  total_usd_micro: number
  today_usd_micro: number
  last7_usd_micro: number
  total_turns: number
  by_model: SpendBucket[]
  by_agent: SpendBucket[]
  by_day: SpendBucket[] // last 14 days, oldest→newest
  latest_day: string | null
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Today's UTC date as YYYY-MM-DD — the cc_spend_daily key for "today". */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

/** YYYY-MM-DD for N days ago (UTC). */
function daysAgoUtc(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
}

interface AggRow {
  k: string
  usd_micro: number
  input_tokens: number
  output_tokens: number
  cache_write_tokens: number
  cache_read_tokens: number
  turns: number
}

const SUMS = `
  COALESCE(SUM(usd_micro), 0)          AS usd_micro,
  COALESCE(SUM(input_tokens), 0)       AS input_tokens,
  COALESCE(SUM(output_tokens), 0)      AS output_tokens,
  COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(cache_read_tokens), 0)  AS cache_read_tokens,
  COALESCE(SUM(turns), 0)              AS turns`

function toBucket(r: AggRow): SpendBucket {
  return {
    key: r.k,
    usd_micro: r.usd_micro ?? 0,
    input_tokens: r.input_tokens ?? 0,
    output_tokens: r.output_tokens ?? 0,
    cache_write_tokens: r.cache_write_tokens ?? 0,
    cache_read_tokens: r.cache_read_tokens ?? 0,
    turns: r.turns ?? 0,
  }
}

// ── load ──────────────────────────────────────────────────────────────────────

export async function loadEconomy(env: Env): Promise<EconomyData> {
  const today = todayUtc()
  const since7 = daysAgoUtc(6) // inclusive 7-day window (today + 6 prior)
  const since14 = daysAgoUtc(13)

  const [byModel, byAgent, byDay, totals, latest] = await Promise.all([
    env.DB.prepare(`SELECT model_family AS k, ${SUMS} FROM cc_spend_daily GROUP BY model_family ORDER BY usd_micro DESC`).all<AggRow>(),
    env.DB.prepare(`SELECT agent AS k, ${SUMS} FROM cc_spend_daily GROUP BY agent ORDER BY usd_micro DESC`).all<AggRow>(),
    env.DB.prepare(`SELECT date AS k, ${SUMS} FROM cc_spend_daily WHERE date >= ?1 GROUP BY date ORDER BY date ASC`).bind(since14).all<AggRow>(),
    env.DB.prepare(
      `SELECT
         COALESCE(SUM(usd_micro), 0)                                          AS total,
         COALESCE(SUM(CASE WHEN date = ?1 THEN usd_micro ELSE 0 END), 0)      AS today,
         COALESCE(SUM(CASE WHEN date >= ?2 THEN usd_micro ELSE 0 END), 0)     AS last7,
         COALESCE(SUM(turns), 0)                                              AS turns
       FROM cc_spend_daily`,
    ).bind(today, since7).first<{ total: number; today: number; last7: number; turns: number }>(),
    env.DB.prepare(`SELECT MAX(date) AS d FROM cc_spend_daily`).first<{ d: string | null }>(),
  ])

  const byModelB = (byModel.results ?? []).map(toBucket)
  const total = totals?.total ?? 0

  return {
    configured: byModelB.length > 0,
    total_usd_micro: total,
    today_usd_micro: totals?.today ?? 0,
    last7_usd_micro: totals?.last7 ?? 0,
    total_turns: totals?.turns ?? 0,
    by_model: byModelB,
    by_agent: (byAgent.results ?? []).map(toBucket),
    by_day: (byDay.results ?? []).map(toBucket),
    latest_day: latest?.d ?? null,
  }
}

// ── view ──────────────────────────────────────────────────────────────────────

function usd(micro: number): string {
  const d = micro / 1_000_000
  if (d >= 1000) return '$' + d.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (d >= 1) return '$' + d.toFixed(2)
  return '$' + d.toFixed(4)
}

function tok(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

/** A horizontal share bar (no JS) for a bucket vs the max in its group. */
function bar(value: number, max: number) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return html`<div style="background:var(--surface2);border-radius:5px;height:7px;overflow:hidden">
    <div style="width:${pct}%;height:100%;background:var(--accent)"></div>
  </div>`
}

function bucketRows(buckets: SpendBucket[]) {
  const max = buckets.reduce((m, b) => Math.max(m, b.usd_micro), 0)
  const rows = buckets.map(
    (b) => html`<tr>
      <td style="font-weight:600">${b.key}</td>
      <td style="text-align:right;color:var(--text)">${raw(usd(b.usd_micro))}</td>
      <td style="width:120px">${bar(b.usd_micro, max)}</td>
      <td style="text-align:right;color:var(--dim);font-size:12px">${raw(tok(b.input_tokens))}↓ ${raw(tok(b.output_tokens))}↑ · ${raw(tok(b.cache_read_tokens))}⊙</td>
    </tr>`,
  )
  return html`${rows}`
}

export function economyBody(d: EconomyData) {
  if (!d.configured) {
    return html`<div style="padding:32px 36px">
      <p class="crumbs"><a href="/">Overview</a> / Economy</p>
      <h1 style="margin:8px 0 4px">Economy</h1>
      <p style="color:var(--muted);max-width:560px">
        No squad spend has been pushed yet. The server-side transcript rollup writes the
        squad's real Claude&nbsp;Code token spend (actual usage × Anthropic list rates)
        to this pot via <code>POST /api/economy/cc-spend</code>. Once it runs, this page
        shows total / today / 7-day spend broken down by model, agent, and day.
      </p>
    </div>`
  }

  const dayMax = d.by_day.reduce((m, b) => Math.max(m, b.usd_micro), 0)
  const dayBars = d.by_day.map(
    (b) => html`<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:4px">
      <div title="${b.key}: ${raw(usd(b.usd_micro))}"
           style="width:60%;background:var(--accent2);border-radius:3px 3px 0 0;height:${dayMax > 0 ? Math.max(2, Math.round((b.usd_micro / dayMax) * 90)) : 2}px"></div>
      <span style="font-size:10px;color:var(--dim);writing-mode:vertical-rl;transform:rotate(180deg)">${b.key.slice(5)}</span>
    </div>`,
  )

  return html`<div style="padding:32px 36px;max-width:980px">
    <p class="crumbs"><a href="/">Overview</a> / Economy</p>
    <h1 style="margin:8px 0 2px">Economy <span style="font-size:13px;color:var(--dim);font-weight:400">· real Claude Code spend · Anthropic list price</span></h1>
    <p style="color:var(--muted);font-size:13px;margin:0 0 20px">
      Latest data: ${d.latest_day ?? '—'} · ${d.total_turns.toLocaleString('en-US')} assistant turns priced.
      List-price equivalent — your actual bill differs on a subscription plan.
    </p>

    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:26px">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px">
        <div style="font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em">Total</div>
        <div style="font-size:28px;font-weight:700;color:var(--accent)">${raw(usd(d.total_usd_micro))}</div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px">
        <div style="font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em">Last 7 days</div>
        <div style="font-size:28px;font-weight:700;color:var(--text)">${raw(usd(d.last7_usd_micro))}</div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px">
        <div style="font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em">Today</div>
        <div style="font-size:28px;font-weight:700;color:var(--text)">${raw(usd(d.today_usd_micro))}</div>
      </div>
    </div>

    <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px 20px;margin-bottom:22px">
      <div style="font-size:13px;color:var(--muted);margin-bottom:12px">Daily spend (last 14 days)</div>
      <div style="display:flex;align-items:flex-end;gap:6px;height:120px">${dayBars}</div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:22px">
      <div>
        <h2 style="font-size:15px;margin:0 0 10px">By model</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px">${bucketRows(d.by_model)}</table>
      </div>
      <div>
        <h2 style="font-size:15px;margin:0 0 10px">By agent</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px">${bucketRows(d.by_agent)}</table>
      </div>
    </div>

    <p style="color:var(--dim);font-size:12px;margin-top:22px">
      ↓ input · ↑ output · ⊙ cache-read tokens. Source: Claude&nbsp;Code transcripts,
      priced at Anthropic list rates (Opus $15/$75 per MTok in/out). Separate from the
      pot's internal burn gauge.
    </p>
  </div>`
}
