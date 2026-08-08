// Webhook completion listener — Cursor statusChange FINISHED/ERROR.

import type { CompletionEvent, TerminalStatus } from './types'
import { verifyCursorWebhookSignature } from './webhook-signature'

export interface CursorWebhookPayload {
  event: string
  timestamp: string
  id: string
  status: string
  source?: { repository?: string; ref?: string }
  target?: { url?: string; branchName?: string; prUrl?: string }
  summary?: string
}

export type ParseWebhookResult =
  | { ok: true; event: CompletionEvent }
  | { ok: false; error: 'bad_json' | 'not_status_change' | 'not_terminal' | 'missing_id' }

export function parseCursorStatusChangePayload(rawBody: string): ParseWebhookResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return { ok: false, error: 'bad_json' }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'bad_json' }
  }
  const body = parsed as CursorWebhookPayload
  if (body.event !== 'statusChange') {
    return { ok: false, error: 'not_status_change' }
  }
  if (body.status !== 'FINISHED' && body.status !== 'ERROR') {
    return { ok: false, error: 'not_terminal' }
  }
  if (typeof body.id !== 'string' || body.id.length === 0) {
    return { ok: false, error: 'missing_id' }
  }
  const status: TerminalStatus = body.status
  return {
    ok: true,
    event: {
      vendor: 'cursor-background',
      vendorRunId: body.id,
      status,
      summary: typeof body.summary === 'string' ? body.summary : null,
      branchName:
        typeof body.target?.branchName === 'string' ? body.target.branchName : null,
      prUrl: typeof body.target?.prUrl === 'string' ? body.target.prUrl : null,
      raw: parsed,
    },
  }
}

export async function handleCursorWebhookCompletion(
  secret: string | null,
  rawBody: string,
  signatureHeader: string | null,
): Promise<
  | { ok: true; event: CompletionEvent }
  | {
      ok: false
      error: 'not_configured' | 'unauthorized' | 'bad_json' | 'not_status_change' | 'not_terminal' | 'missing_id'
    }
> {
  const verified = await verifyCursorWebhookSignature(secret, rawBody, signatureHeader)
  if (verified === 'not_configured') return { ok: false, error: 'not_configured' }
  if (verified === 'invalid') return { ok: false, error: 'unauthorized' }
  const parsed = parseCursorStatusChangePayload(rawBody)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  return { ok: true, event: parsed.event }
}
