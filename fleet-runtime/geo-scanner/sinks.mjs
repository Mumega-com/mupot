import {
  GEO_EVENT_SCHEMA,
  GEO_RECEIPT_SCHEMA,
  validatePublicHttpsOrigin,
} from './contract.mjs'

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SECRET_VALUE_RE = /[\u0000-\u0020\u007f]/
const FORBIDDEN_RECEIPT_KEYS = new Set([
  'answer_text',
  'web_search_queries',
  'cited_domains',
  'citations',
  'tracked_competitors_named',
  'access_token',
  'api_key',
  'authorization',
  'token',
  'secret',
  'encrypted_secret',
  'raw_error',
  'error_body',
])

function withTimeout(timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { controller, timer }
}

function validToken(value) {
  return typeof value === 'string'
    && value.length >= 16
    && value.length <= 4096
    && !SECRET_VALUE_RE.test(value)
}

function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError('invalid_geo_event')
  if (
    event.schema !== GEO_EVENT_SCHEMA
    || !UUID_RE.test(event.event_uuid ?? '')
    || !UUID_RE.test(event.scan_id ?? '')
    || !REF_RE.test(event.project_id ?? '')
    || !REF_RE.test(event.profile_id ?? '')
    || !REF_RE.test(event.prompt_id ?? '')
    || typeof event.observed_at !== 'string'
    || !Number.isFinite(Date.parse(event.observed_at))
  ) throw new TypeError('invalid_geo_event')
  const serialized = JSON.stringify(event)
  if (Buffer.byteLength(serialized) > 64 * 1024) throw new TypeError('geo_event_too_large')
  return event
}

function receiptIsSafe(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return true
  if (seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) return value.every((item) => receiptIsSafe(item, seen))
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_RECEIPT_KEYS.has(key.toLowerCase())) return false
    if (!receiptIsSafe(child, seen)) return false
  }
  return true
}

function validateReceipt(receipt, projectId) {
  if (
    !receipt
    || typeof receipt !== 'object'
    || Array.isArray(receipt)
    || receipt.schema !== GEO_RECEIPT_SCHEMA
    || !UUID_RE.test(receipt.scan_id ?? '')
    || receipt.project_id !== projectId
    || !receiptIsSafe(receipt)
  ) throw new TypeError('unsafe_receipt')
  const serialized = JSON.stringify(receipt)
  if (Buffer.byteLength(serialized) > 7000) throw new TypeError('unsafe_receipt')
  return serialized
}

export async function captureGeoEvent(input, {
  fetchImpl = fetch,
  timeoutMs = 8_000,
} = {}) {
  const posthogHost = validatePublicHttpsOrigin(input?.posthogHost, 'invalid_posthog_host')
  if (!validToken(input?.token)) throw new TypeError('invalid_posthog_token')
  const event = validateEvent(input.event)
  const { controller, timer } = withTimeout(timeoutMs)
  try {
    const response = await fetchImpl(`${posthogHost}/i/v0/e/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: input.token,
        event: '$geo_scan',
        distinct_id: `project:${event.project_id}:profile:${event.profile_id}`,
        uuid: event.event_uuid,
        timestamp: event.observed_at,
        properties: event,
      }),
      redirect: 'manual',
      signal: controller.signal,
    })
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, reason: 'posthog_redirect' }
    }
    if (!response.ok) return { ok: false, reason: `posthog_http_${response.status}` }
    return { ok: true, eventUuid: event.event_uuid }
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === 'AbortError' ? 'posthog_timeout' : 'posthog_request_failed',
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function sendMupotReceipt(input, {
  fetchImpl = fetch,
  timeoutMs = 8_000,
} = {}) {
  const baseUrl = validatePublicHttpsOrigin(input?.baseUrl, 'invalid_mupot_base_url')
  if (!validToken(input?.token)) throw new TypeError('invalid_mupot_token')
  if (!REF_RE.test(input?.receiptTo ?? '')) throw new TypeError('invalid_receipt_to')
  if (!REF_RE.test(input?.projectId ?? '')) throw new TypeError('invalid_project_id')
  const receiptBody = validateReceipt(input.receipt, input.projectId)
  const { controller, timer } = withTimeout(timeoutMs)
  try {
    const response = await fetchImpl(`${baseUrl}/api/inbox/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: input.receiptTo,
        kind: 'ack',
        project_id: input.projectId,
        request_id: `geo:${input.receipt.scan_id}`,
        body: receiptBody,
      }),
      redirect: 'manual',
      signal: controller.signal,
    })
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, reason: 'mupot_redirect' }
    }
    if (!response.ok) return { ok: false, reason: `mupot_http_${response.status}` }
    let value
    try {
      value = await response.json()
    } catch {
      return { ok: false, reason: 'mupot_invalid_response' }
    }
    if (!value?.ok || typeof value.id !== 'string' || typeof value.duplicate !== 'boolean') {
      return { ok: false, reason: 'mupot_invalid_response' }
    }
    return {
      ok: true,
      messageId: value.id,
      duplicate: value.duplicate,
    }
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === 'AbortError' ? 'mupot_timeout' : 'mupot_request_failed',
    }
  } finally {
    clearTimeout(timer)
  }
}
