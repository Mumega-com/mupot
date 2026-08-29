// mupot — HTTP surface for click-to-approve device grants.
// Mounted at /device BEFORE the dashboard catch-all.

import { Hono } from 'hono'
import type { Env, AuthContext } from '../types'
import { peekSessionAuth } from './index'
import {
  DEVICE_POLL_INTERVAL_SECONDS,
  consumeDeviceCsrf,
  createDeviceGrant,
  decideDeviceGrant,
  issueDeviceCsrf,
  listPendingDeviceGrants,
  pollDeviceGrant,
} from './device-grant'

type AppEnv = { Bindings: Env }

export const deviceApp = new Hono<AppEnv>()

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

deviceApp.post('/code', async (c) => {
  let agent = ''
  const ctype = c.req.header('content-type') ?? ''
  if (ctype.includes('application/json')) {
    const body = (await c.req.json().catch(() => null)) as { agent?: unknown } | null
    agent = typeof body?.agent === 'string' ? body.agent : ''
  } else {
    const form = await c.req.parseBody()
    agent = typeof form.agent === 'string' ? form.agent : ''
  }
  const origin = new URL(c.req.url).origin
  const res = await createDeviceGrant(c.env, { agent, origin })
  if (!res.ok) {
    const status = res.error === 'pending_cap' ? 429 : 400
    return c.json({ error: res.error }, status)
  }
  return c.json(res.value, 200)
})

deviceApp.post('/token', async (c) => {
  let deviceCode = ''
  const ctype = c.req.header('content-type') ?? ''
  if (ctype.includes('application/json')) {
    const body = (await c.req.json().catch(() => null)) as { device_code?: unknown } | null
    deviceCode = typeof body?.device_code === 'string' ? body.device_code : ''
  } else {
    const form = await c.req.parseBody()
    deviceCode = typeof form.device_code === 'string' ? form.device_code : ''
  }
  const polled = await pollDeviceGrant(c.env, deviceCode)
  if (polled.status === 'ok') {
    return c.json({
      access_token: polled.access_token,
      token_type: polled.token_type,
      agent_id: polled.agent_id,
      agent_slug: polled.agent_slug,
    })
  }
  const status = polled.status === 'authorization_pending' ? 400 : 400
  return c.json({ error: polled.status, interval: DEVICE_POLL_INTERVAL_SECONDS }, status)
})

deviceApp.get('/', async (c) => {
  const auth = await peekSessionAuth(c)
  if (!auth) return c.redirect('/auth/login')
  const pending = await listPendingDeviceGrants(c.env)
  const csrf = await issueDeviceCsrf(c.env)
  const html = renderDevicePage(pending, csrf, auth)
  const res = new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  const secure = new URL(c.req.url).protocol === 'https:'
  res.headers.append(
    'Set-Cookie',
    `mupot_device_csrf=${csrf}; HttpOnly; SameSite=Lax; Path=/device; Max-Age=600${secure ? '; Secure' : ''}`,
  )
  return res
})

deviceApp.post('/decision', async (c) => {
  const auth = await peekSessionAuth(c)
  if (!auth) return c.redirect('/auth/login')
  const form = await c.req.parseBody()
  const userCode = typeof form.user_code === 'string' ? form.user_code : ''
  const actionRaw = typeof form.action === 'string' ? form.action : ''
  const nonce = typeof form.csrf === 'string' ? form.csrf : ''
  const cookieHeader = c.req.header('Cookie') ?? ''
  const cookieNonce = parseCookie(cookieHeader, 'mupot_device_csrf')
  if (!cookieNonce || cookieNonce !== nonce || !(await consumeDeviceCsrf(c.env, nonce))) {
    return c.text('CSRF check failed', 403)
  }
  const action = actionRaw === 'allow' ? 'allow' : actionRaw === 'deny' ? 'deny' : null
  if (!action) return c.text('invalid action', 400)
  const decided = await decideDeviceGrant(c.env, { user_code: userCode, action, auth })
  if (!decided.ok) return c.text(decided.error, decided.error === 'forbidden' ? 403 : 400)
  return c.redirect('/device')
})

function parseCookie(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return rest.join('=')
  }
  return null
}

function renderDevicePage(grants: Awaited<ReturnType<typeof listPendingDeviceGrants>>, csrf: string, auth: AuthContext): string {
  const rows = grants
    .filter((g) => g.status === 'pending')
    .map(
      (g) => `
    <form method="POST" action="/device/decision" class="card">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="user_code" value="${escapeHtml(g.user_code)}">
      <p class="code">${escapeHtml(g.user_code)}</p>
      <p>Agent <strong>${escapeHtml(g.agent_name)}</strong> <code>${escapeHtml(g.agent_slug)}</code> wants a pot token. Match this code on the agent screen, then click.</p>
      <div class="actions">
        <button type="submit" name="action" value="allow">Allow</button>
        <button type="submit" name="action" value="deny">Deny</button>
      </div>
    </form>`,
    )
    .join('\n')

  const waiting = grants.filter((g) => g.status === 'approved')
  const waitingHtml = waiting.length
    ? `<p class="hint">${waiting.length} approved — waiting for the agent to collect. No token is shown here.</p>`
    : ''

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Approve agent access</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; color: #111; }
  h1 { font-size: 1.25rem; }
  .card { border: 1px solid #ccc; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  .code { font-size: 2rem; letter-spacing: 0.2rem; font-family: ui-monospace, monospace; margin: 0.25rem 0 0.75rem; }
  .actions { display: flex; gap: 0.75rem; }
  button { padding: 0.5rem 1rem; font-size: 1rem; }
  .hint, .meta { font-size: 0.85rem; color: #444; }
</style>
</head>
<body>
<h1>Approve agent access</h1>
<p class="meta">Signed in as <strong>${escapeHtml(auth.email ?? auth.userId)}</strong>. Compare the code with the one on the agent screen. Click Allow or Deny — do not type a code.</p>
${rows || '<p class="hint">No pending agent requests.</p>'}
${waitingHtml}
</body>
</html>`
}
