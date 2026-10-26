import type { StreamAuthorization } from './inbox-stream-auth'
import type { StreamMessage } from './inbox-routes'

export interface PushSocket extends EventTarget { close(code?: number, reason?: string): void }
export interface PushStreamOptions {
  socket: PushSocket
  authenticatedAt: number
  since: number
  validate: () => Promise<StreamAuthorization>
  read: (since: number) => Promise<{ ok: boolean; messages?: StreamMessage[] }>
  signal?: AbortSignal
  jitterMs?: number
  renewSocket?: () => Promise<PushSocket | null>
  fallback?: boolean
  metric?: (kind: 'connect' | 'hint' | 'resync' | 'fallback_poll' | 'auth_scheduled' | 'auth_retry' | 'auth_disclosure' | 'close') => void
}
const LEASE = 60_000
const REFRESH = 45_000
const TIMEOUT = 5_000
const DISCLOSURE_CACHE = 10_000
const HEARTBEAT = 25_000
const RESYNC = 300_000
const MAX_BUFFER_BYTES = 512 * 1024

/** Connection-local SSE lifecycle. Timers never poll the inbox except the explicitly
 * budgeted anti-entropy cycle. A late dependency result cannot reopen a closed stream. */
export function createInboxPushResponse(o: PushStreamOptions): Response {
  let socket = o.socket
  let controller: ReadableStreamDefaultController<Uint8Array>
  let closed = false
  let cursor = o.since
  let validatedAt = o.authenticatedAt
  let validUntil = validatedAt + LEASE
  let initial = true
  let dirty = false
  let reading = false
  let authFlight: Promise<boolean> | null = null
  let generation = 0
  let nextAuthTry = 0
  let authTimer: ReturnType<typeof setTimeout> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const pending = new Set<() => void>()
  const encoder = new TextEncoder()
  const after = (fn: () => void, ms: number) => {
    const t = setTimeout(() => { timers.delete(t); if (!closed) fn() }, Math.max(0, ms))
    timers.add(t); return t
  }
  const clear = (t: ReturnType<typeof setTimeout> | undefined) => { if (t !== undefined) { clearTimeout(t); timers.delete(t) } }
  function detach(s: PushSocket) { s.removeEventListener('message', onHint); s.removeEventListener('close', onClose); s.removeEventListener('error', onClose) }
  function close(reason: string, cancelled = false) {
    if (closed) return
    closed = true; generation++
    for (const t of timers) clearTimeout(t)
    for (const finish of pending) finish()
    pending.clear()
    timers.clear(); detach(socket); o.signal?.removeEventListener('abort', onAbort)
    try { socket.close(1000, reason) } catch { /* already closed */ }
    o.metric?.('close')
    if (!cancelled) { try { controller.close() } catch { /* cancelled */ } }
  }
  function enqueue(frame: string): boolean {
    if (closed || Date.now() >= validUntil) { close('authorization_deadline'); return false }
    const bytes = encoder.encode(frame)
    if (bytes.length > MAX_BUFFER_BYTES || (controller.desiredSize ?? 0) < bytes.length) { close('slow_reader'); return false }
    try { controller.enqueue(bytes); return true } catch { close('enqueue_failed'); return false }
  }
  function armLease() {
    clear(deadline); clear(authTimer)
    deadline = after(() => close('authorization_deadline'), validUntil - Date.now())
    authTimer = after(() => { void scheduled(0) }, validatedAt + REFRESH - Date.now())
  }
  async function timed<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    let timeout: ReturnType<typeof setTimeout>
    let finish!: () => void
    const expiry = new Promise<T>(resolve => { finish = () => resolve(fallback); pending.add(finish); timeout = setTimeout(finish, TIMEOUT); timers.add(timeout) })
    try { return await Promise.race([Promise.resolve().then(fn).catch(() => fallback), expiry]) }
    finally { clear(timeout!); pending.delete(finish) }
  }
  async function authorize(kind: 'scheduled' | 'retry' | 'disclosure'): Promise<boolean> {
    if (closed || Date.now() >= validUntil) { close('authorization_deadline'); return false }
    if (kind === 'disclosure' && Date.now() - validatedAt < DISCLOSURE_CACHE) return true
    if (authFlight) return authFlight
    if (Date.now() < nextAuthTry) return false
    const started = Date.now(); const epoch = ++generation
    o.metric?.(`auth_${kind}`)
    const flight = (async () => {
      const result = await timed(o.validate, 'error' as StreamAuthorization)
      if (closed || epoch !== generation || Date.now() >= validUntil) return false
      if (result === 'invalid') { close('authorization_invalid'); return false }
      if (result === 'error') { nextAuthTry = started + TIMEOUT; return false }
      validatedAt = started; validUntil = started + LEASE; nextAuthTry = 0; armLease()
      return true
    })()
    authFlight = flight
    try { return await flight } finally { if (authFlight === flight) authFlight = null }
  }
  async function scheduled(retry: number) {
    const leaseStart = validatedAt
    if (await authorize(retry ? 'retry' : 'scheduled')) { if (dirty) queueRead('hint'); return }
    if (!closed && validatedAt === leaseStart && retry < 2) {
      authTimer = after(() => { void scheduled(retry + 1) }, leaseStart + (50_000 + retry * 5_000) - Date.now())
    }
  }
  async function drain(kind: 'connect' | 'hint' | 'resync') {
    if (closed || reading) return
    reading = true; dirty = false
    let failed = false
    o.metric?.(kind)
    try {
      for (let page = 0; page < 10 && !closed; page++) {
        const result = await timed(() => o.read(cursor), { ok: false })
        if (closed) return
        if (!result.ok || !result.messages) { failed = true; close('inbox_unavailable'); return }
        const fresh = result.messages.filter(m => Number.isSafeInteger(m.seq) && m.seq > cursor)
        if (fresh.length && !await authorize('disclosure')) { dirty = true; failed = true; return }
        if (initial) {
          if (fresh.length) {
            // Keep the initial frame bounded even when a 100-row page is large.
            // Remaining rows use the unchanged message envelope and their own cursor.
            const first = fresh.shift()!
            const next = first.seq
            if (!enqueue(`id: ${next}\ndata: ${JSON.stringify({ type: 'initial', since: next, messages: [first] })}\n\n`)) return
            cursor = next
            await Promise.resolve()
          }
          initial = false
        }
        for (const message of fresh) {
          if (!await authorize('disclosure')) { dirty = true; failed = true; return }
          if (!enqueue(`id: ${message.seq}\ndata: ${JSON.stringify({ type: 'message', message })}\n\n`)) return
          cursor = message.seq
          await Promise.resolve()
        }
        if (result.messages.length < 100) return
        if (page === 9) { close('resync_page_limit'); return }
      }
    } finally {
      reading = false
      if (dirty && !failed && !closed) queueRead('hint')
      // Only hints received during a successful read trigger another chain. Failures
      // wait for the next auth refresh/resync, never create a tight retry loop.
    }
  }
  function queueRead(kind: 'connect' | 'hint' | 'resync') {
    if (closed) return
    if (reading) { dirty = true; return }
    if (debounce !== undefined) return
    debounce = after(() => {
      debounce = undefined
      void drain(kind)
    }, kind === 'hint' ? 20 : 0)
  }
  function onHint(event: Event) {
    if (event.currentTarget !== socket || closed) return
    try {
      const f = JSON.parse(String((event as MessageEvent).data))
      if (f.type !== 'hint' || !Number.isSafeInteger(f.seq) || typeof f.id !== 'string') return
      if (f.seq <= cursor) return
      queueRead('hint')
    } catch { close('invalid_hint') }
  }
  function onClose(event: Event) { if (event.currentTarget === socket) close('upstream_closed') }
  function onAbort() { close('client_aborted') }
  function attach(s: PushSocket) { s.addEventListener('message', onHint); s.addEventListener('close', onClose); s.addEventListener('error', onClose) }
  function heartbeat() { if (enqueue(': ping\n\n')) after(heartbeat, HEARTBEAT) }
  function resync() { queueRead('resync'); after(resync, RESYNC + Math.max(0, o.jitterMs ?? Math.floor(Math.random() * 30_000))) }
  function fallbackPoll() { o.metric?.('fallback_poll'); queueRead('hint'); after(fallbackPoll, 30_000) }
  async function renew() {
    if (!o.renewSocket || !await authorize('disclosure')) { close('observer_rotation'); return }
    const next = await timed(o.renewSocket, null)
    if (closed) { next?.close(); return }
    if (!next) { close('observer_rotation_failed'); return }
    const previous = socket; detach(previous); socket = next; attach(next); previous.close(1000, 'renewed')
    queueRead('resync'); after(() => { void renew() }, 14 * 60_000)
  }
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c; attach(socket); o.signal?.addEventListener('abort', onAbort, { once: true })
      if (o.signal?.aborted || Date.now() >= validUntil) { close('expired_at_start'); return }
      armLease(); enqueue('retry: 3000\n\n'); queueRead('connect')
      after(heartbeat, HEARTBEAT)
      if (o.fallback) after(fallbackPoll, 30_000)
      else {
        after(resync, RESYNC + Math.max(0, o.jitterMs ?? Math.floor(Math.random() * 30_000)))
        after(() => { void renew() }, 14 * 60_000)
      }
      after(() => close('stream_rotation'), 30 * 60_000)
    },
    cancel() { close('client_cancelled', true) },
  }, { highWaterMark: MAX_BUFFER_BYTES, size: chunk => chunk.byteLength })
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', 'X-Mupot-Stream-Mode': o.fallback ? 'fallback' : 'push' } })
}
