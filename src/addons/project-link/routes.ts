import { Hono } from 'hono'
import type { Env } from '../../types'
import { receiveProjectLinkEnvelope } from './service'

const MAX_BODY_BYTES = 32 * 1024

export const projectLinkApp = new Hono<{ Bindings: Env }>()

async function readJson(request: Request): Promise<
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: 'invalid_body' | 'payload_too_large' }
> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: 'payload_too_large' }
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return { ok: false, status: 400, error: 'invalid_body' }
  }
  const stream = request.body
  if (!stream) return { ok: false, status: 400, error: 'invalid_body' }
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_BODY_BYTES) {
        await reader.cancel()
        return { ok: false, status: 413, error: 'payload_too_large' }
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, status: 400, error: 'invalid_body' }
  }
}

function failureStatus(reason: string): 400 | 401 | 403 | 404 | 409 | 410 | 502 | 503 {
  if (reason === 'invalid_signature') return 401
  if (reason === 'mapping_mismatch' || reason === 'not_authorized' || reason === 'capability_denied') return 403
  if (reason === 'link_not_found') return 404
  if (reason === 'idempotency_conflict') return 409
  if (reason === 'delivery_review_required') return 409
  if (reason === 'link_revoked') return 410
  if (reason === 'addon_inactive') return 410
  if (reason === 'remote_failure' || reason === 'receipt_mismatch') return 502
  if (reason === 'receipt_signing_unconfigured') return 503
  return 400
}

projectLinkApp.post('/:linkId/deliver', async (c) => {
  const body = await readJson(c.req.raw)
  if (!body.ok) return c.json({ error: body.error }, body.status)
  const result = await receiveProjectLinkEnvelope(c.env, c.req.param('linkId'), body.value)
  if (!result.ok) return c.json({ error: result.reason, ...(result.path ? { path: result.path } : {}) }, failureStatus(result.reason))
  return c.json(
    { ok: true, receipt: result.receipt, ...(result.idempotent ? { idempotent: true } : {}) },
    result.idempotent ? 200 : 201,
  )
})
