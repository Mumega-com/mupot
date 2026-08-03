const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'
const VERTEX_HOST = 'https://aiplatform.googleapis.com'
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576

const EMPTY_USAGE = Object.freeze({
  promptTokens: 0,
  candidateTokens: 0,
  totalTokens: 0,
})

function failed(reason) {
  return {
    status: 'failed',
    reason,
    answerText: '',
    webSearchQueries: [],
    citations: [],
    usage: { ...EMPTY_USAGE },
  }
}

function withTimeout(timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { controller, timer }
}

async function readBoundedText(response, maxBytes) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      try {
        await reader.cancel()
      } catch {
        // The response is already being discarded.
      }
      throw new Error('response_too_large')
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

function bounded(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0
}

function normalizeUsage(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    promptTokens: nonNegativeInteger(value.promptTokenCount),
    candidateTokens: nonNegativeInteger(value.candidatesTokenCount),
    totalTokens: nonNegativeInteger(value.totalTokenCount),
  }
}

function normalizeDomain(value) {
  const domain = bounded(value, 253).toLowerCase().replace(/\.$/, '')
  return /^[a-z0-9.-]+$/.test(domain) && domain.includes('.') ? domain : ''
}

function normalizeCitation(raw) {
  const web = raw?.web
  if (!web || typeof web !== 'object' || Array.isArray(web)) return null
  const rawUri = bounded(web.uri, 4096)
  let uri = ''
  let derivedDomain = ''
  try {
    const parsed = new URL(rawUri)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null
    uri = parsed.href.slice(0, 2048)
    derivedDomain = parsed.hostname.toLowerCase().replace(/\.$/, '').slice(0, 253)
  } catch {
    return null
  }
  const domain = normalizeDomain(web.domain) || derivedDomain
  if (!domain) return null
  return {
    title: bounded(web.title, 512),
    domain,
    uri,
  }
}

function normalizeVertexResponse(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return failed('vertex_invalid_response')
  const candidate = Array.isArray(raw.candidates) ? raw.candidates[0] : null
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
  const answerText = bounded(
    parts.map((part) => typeof part?.text === 'string' ? part.text : '').join(''),
    16_000,
  )
  const metadata = candidate?.groundingMetadata
  const webSearchQueries = Array.isArray(metadata?.webSearchQueries)
    ? metadata.webSearchQueries
      .map((query) => bounded(query, 512))
      .filter(Boolean)
      .slice(0, 10)
    : []
  const citations = Array.isArray(metadata?.groundingChunks)
    ? metadata.groundingChunks
      .map(normalizeCitation)
      .filter(Boolean)
      .slice(0, 20)
    : []
  const usage = normalizeUsage(raw.usageMetadata)
  if (!answerText) {
    return {
      status: 'empty',
      reason: 'empty_answer',
      answerText: '',
      webSearchQueries: [],
      citations: [],
      usage,
    }
  }
  return {
    status: 'ok',
    answerText,
    webSearchQueries,
    citations,
    usage,
  }
}

export async function readWorkloadIdentityToken({
  fetchImpl = fetch,
  timeoutMs = 5_000,
  maxResponseBytes = 16_384,
} = {}) {
  const { controller, timer } = withTimeout(timeoutMs)
  try {
    // VPS/local fallback (2026-08-03): outside GKE there is no metadata
    // server. If GEO_VERTEX_ACCESS_TOKEN_FILE is set, read the token from
    // that file (written by the operator from `gcloud auth print-access-token`)
    // instead of the metadata endpoint. File-based like the other credentials.
    const tokenFile = process.env.GEO_VERTEX_ACCESS_TOKEN_FILE
    if (typeof tokenFile === 'string' && tokenFile.startsWith('/')) {
      const { readFile } = await import('node:fs/promises')
      const raw = (await readFile(tokenFile, 'utf8')).trim()
      if (raw.length < 16 || raw.length > 4096 || /[\u0000-\u0020\u007f]/.test(raw)) {
        throw new Error('metadata_token_invalid')
      }
      return raw
    }
    const response = await fetchImpl(METADATA_TOKEN_URL, {
      method: 'GET',
      headers: { 'Metadata-Flavor': 'Google' },
      redirect: 'manual',
      signal: controller.signal,
    })
    if (response.status >= 300 && response.status < 400) throw new Error('metadata_token_redirect')
    if (!response.ok) throw new Error(`metadata_token_http_${response.status}`)
    const raw = await readBoundedText(response, maxResponseBytes)
    let value
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error('metadata_token_invalid')
    }
    if (
      !value
      || typeof value.access_token !== 'string'
      || value.access_token.length < 16
      || value.access_token.length > 4096
      || /[\u0000-\u0020\u007f]/.test(value.access_token)
      || !Number.isFinite(value.expires_in)
      || value.expires_in <= 0
    ) throw new Error('metadata_token_invalid')
    return value.access_token
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('metadata_token_timeout')
    if (error?.message === 'response_too_large') throw new Error('metadata_token_response_too_large')
    if (typeof error?.message === 'string' && error.message.startsWith('metadata_token_')) throw error
    throw new Error('metadata_token_request_failed')
  } finally {
    clearTimeout(timer)
  }
}

export async function runGroundedQuery(input, {
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  if (
    !input
    || typeof input.accessToken !== 'string'
    || input.accessToken.length < 16
    || input.accessToken.length > 4096
    || /[\u0000-\u0020\u007f]/.test(input.accessToken)
  ) throw new TypeError('invalid_vertex_access_token')
  if (input.location !== 'global') throw new TypeError('invalid_vertex_location')
  if (input.model !== 'gemini-2.5-flash') throw new TypeError('invalid_vertex_model')
  if (
    typeof input.googleProjectId !== 'string'
    || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(input.googleProjectId)
  ) throw new TypeError('invalid_google_project_id')
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.trim().length > 600) {
    throw new TypeError('invalid_vertex_prompt')
  }

  const endpoint = `${VERTEX_HOST}/v1/projects/${encodeURIComponent(input.googleProjectId)}`
    + `/locations/global/publishers/google/models/gemini-2.5-flash:generateContent`
  const { controller, timer } = withTimeout(timeoutMs)
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{ text: input.prompt.trim() }],
        }],
        tools: [{ googleSearch: {} }],
      }),
      redirect: 'manual',
      signal: controller.signal,
    })
    if (response.status >= 300 && response.status < 400) return failed('vertex_redirect')
    if (!response.ok) return failed(`vertex_http_${response.status}`)
    let text
    try {
      text = await readBoundedText(response, maxResponseBytes)
    } catch (error) {
      if (error?.message === 'response_too_large') return failed('vertex_response_too_large')
      throw error
    }
    let raw
    try {
      raw = JSON.parse(text)
    } catch {
      return failed('vertex_invalid_response')
    }
    return normalizeVertexResponse(raw)
  } catch (error) {
    if (error?.name === 'AbortError') return failed('vertex_timeout')
    return failed('vertex_request_failed')
  } finally {
    clearTimeout(timer)
  }
}
