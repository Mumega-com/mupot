// Inbound email() handler, SPIKE ONLY (PR1). Flag EMAIL_DECISIONS=1, off by default. Writes NO verdict, sends NO
// mail, stores NO body. It records one receipt row to answer: does Cloudflare hand the Worker the DKIM/SPF/DMARC
// result, and does the +token survive in message.to. Then it rejects with a neutral message.

import type { Env } from '../types'

export const SPIKE_REJECT_MESSAGE = 'Not accepting mail yet.'
export const MAX_RAW_SIZE = 64 * 1024
export const MAX_HEADER_VALUE = 2048
export const MAX_RECEIPTS_PER_HOUR = 200

/** Structural subset of ForwardableEmailMessage: lets tests pass a plain object. */
export interface InboundEmail {
  readonly from: string
  readonly to: string
  readonly headers: Headers
  readonly rawSize: number
  setReject(reason: string): void
}

export function emailDecisionsEnabled(env: Pick<Env, 'EMAIL_DECISIONS'>): boolean {
  return env.EMAIL_DECISIONS === '1'
}

const VALUE_WHITELIST = new Set([
  'authentication-results',
  'arc-authentication-results',
  'received-spf',
  'auto-submitted',
  'precedence',
  'message-id',
  'in-reply-to',
])

function capValue(value: string): string {
  return value.length > MAX_HEADER_VALUE ? `[redacted: ${value.length} chars]` : value
}

/** Only d= and s= of a DKIM-Signature; the b=/bh= blobs and everything else are dropped. */
function dkimDomainSelector(value: string): string {
  const d = /(?:^|;)\s*d=([^;\s]+)/i.exec(value)?.[1] ?? ''
  const s = /(?:^|;)\s*s=([^;\s]+)/i.exec(value)?.[1] ?? ''
  return `d=${d.slice(0, 255)}; s=${s.slice(0, 255)}`
}

export function summarizeHeaders(headers: Headers): { names: string[]; values: Record<string, string[]> } {
  const names: string[] = []
  const values: Record<string, string[]> = {}
  headers.forEach((value, rawName) => {
    const name = rawName.toLowerCase()
    names.push(name)
    let kept: string | null = null
    if (name === 'dkim-signature') kept = dkimDomainSelector(value)
    else if (VALUE_WHITELIST.has(name) || name.startsWith('cf-') || name.startsWith('x-cf-')) kept = capValue(value)
    if (kept !== null) (values[name] ??= []).push(kept)
  })
  return { names, values }
}

export async function handleInboundEmail(message: InboundEmail, env: Env, now: Date = new Date()): Promise<void> {
  if (!emailDecisionsEnabled(env)) {
    message.setReject(SPIKE_REJECT_MESSAGE)
    return
  }
  const { names, values } = summarizeHeaders(message.headers)
  const oversize = message.rawSize > MAX_RAW_SIZE
  const received = now.toISOString()
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString()
  try {
    // Unauthenticated writer: bounded by a rolling per-hour cap so a flood cannot fill D1.
    await env.DB.prepare(
      `INSERT INTO email_inbound_receipts (id, received_at, envelope_from, envelope_to, header_names, header_values, raw_size, outcome)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
       WHERE (SELECT COUNT(*) FROM email_inbound_receipts WHERE received_at > ?9) < ?10`,
    )
      .bind(
        crypto.randomUUID(),
        received,
        message.from.slice(0, 320),
        message.to.slice(0, 320),
        JSON.stringify(names.slice(0, 200)),
        JSON.stringify(values),
        message.rawSize,
        oversize ? 'spike_rejected_oversize' : 'spike_rejected',
        hourAgo,
        MAX_RECEIPTS_PER_HOUR,
      )
      .run()
  } catch (error) {
    console.error('[email-decisions] spike receipt failed', error)
  }
  message.setReject(SPIKE_REJECT_MESSAGE)
}
