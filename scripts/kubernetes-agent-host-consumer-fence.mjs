export async function fetchConsumerFenceStatus({ baseUrl, token, fetchImpl = fetch }) {
  let origin
  try {
    const url = new URL(baseUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('unsafe base URL')
    }
    origin = url.toString().replace(/\/$/, '')
  } catch {
    throw new Error('consumer fence base URL invalid')
  }
  if (typeof token !== 'string' || token.length < 16 || token.length > 8192 || /[\r\n]/.test(token)) {
    throw new Error('consumer fence credential invalid')
  }
  const response = await fetchImpl(`${origin}/actions/inbox_consumer_status`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: '{}',
  })
  const declaredLength = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > 64 * 1024) {
    throw new Error('consumer fence response too large')
  }
  const raw = await response.text()
  if (Buffer.byteLength(raw, 'utf8') > 64 * 1024) throw new Error('consumer fence response too large')
  if (!response.ok) throw new Error(`consumer fence status HTTP ${response.status}`)
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    throw new Error('consumer fence response invalid')
  }
  const result = body?.ok === true && body?.tool === 'inbox_consumer_status' ? body?.result : null
  const keyFingerprintValid = result?.mode === 'signed_only'
    ? /^[a-f0-9]{64}$/.test(result?.key_fingerprint ?? '')
    : result?.mode === 'bearer_only' && result?.key_fingerprint === null
  if (
    typeof result?.agent_id !== 'string' ||
    !['bearer_only', 'signed_only'].includes(result?.mode) ||
    !Number.isInteger(result?.generation) || result.generation < 0 ||
    !keyFingerprintValid ||
    typeof result?.active_key_present !== 'boolean' || typeof result?.key_matches !== 'boolean'
  ) {
    throw new Error('consumer fence response invalid')
  }
  return {
    agent_id: result.agent_id,
    mode: result.mode,
    generation: result.generation,
    key_fingerprint: result.key_fingerprint,
    active_key_present: result.active_key_present,
    key_matches: result.key_matches,
  }
}

export async function fetchConsumerFenceFromSecret({ baseUrl, secret, fetchImpl = fetch }) {
  const encoded = secret?.data?.token
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('Host token Secret invalid')
  }
  const tokenBuffer = Buffer.from(encoded, 'base64')
  const token = tokenBuffer.toString('utf8')
  try {
    return await fetchConsumerFenceStatus({ baseUrl, token, fetchImpl })
  } finally {
    tokenBuffer.fill(0)
  }
}
