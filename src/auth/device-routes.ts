// mupot — HTTP surface for RFC 8628 device grants.
// Mounted at /device BEFORE the dashboard catch-all.
// GET /device never lists pending grants. The human types the user_code.

import { Hono } from 'hono'
import type { Env, AuthContext } from '../types'
import { peekSessionAuth } from './index'
import {
  DEVICE_POLL_INTERVAL_SECONDS,
  consumeDeviceCsrf,
  createDeviceGrant,
  decideDeviceGrant,
  issueDeviceCsrf,
  lookupDeviceGrant,
  pollDeviceGrant,
  type DeviceGrantPublic,
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
      expires_in: polled.expires_in,
      agent_id: polled.agent_id,
      agent_slug: polled.agent_slug,
    })
  }
  return c.json({ error: polled.status, interval: DEVICE_POLL_INTERVAL_SECONDS }, 400)
})

deviceApp.get('/', async (c) => {
  const auth = await peekSessionAuth(c)
  if (!auth) return c.redirect('/auth/login')
  const csrf = await issueDeviceCsrf(c.env)
  const html = renderEnterCodePage(csrf, auth, null)
  return htmlResponse(c, html, csrf)
})

deviceApp.post('/preview', async (c) => {
  const auth = await peekSessionAuth(c)
  if (!auth) return c.redirect('/auth/login')
  const form = await c.req.parseBody()
  const userCode = typeof form.user_code === 'string' ? form.user_code : ''
  const nonce = typeof form.csrf === 'string' ? form.csrf : ''
  if (!(await validCsrf(c, nonce))) return c.text('CSRF check failed', 403)
  const grant = await lookupDeviceGrant(c.env, userCode)
  const csrf = await issueDeviceCsrf(c.env)
  if (!grant) {
    const html = renderEnterCodePage(csrf, auth, 'That code is not valid or has expired.')
    return htmlResponse(c, html, csrf)
  }
  const html = renderConfirmPage(grant, csrf, auth)
  return htmlResponse(c, html, csrf)
})

deviceApp.post('/decision', async (c) => {
  const auth = await peekSessionAuth(c)
  if (!auth) return c.redirect('/auth/login')
  const form = await c.req.parseBody()
  const userCode = typeof form.user_code === 'string' ? form.user_code : ''
  const actionRaw = typeof form.action === 'string' ? form.action : ''
  const nonce = typeof form.csrf === 'string' ? form.csrf : ''
  if (!(await validCsrf(c, nonce))) return c.text('CSRF check failed', 403)
  const action = actionRaw === 'allow' ? 'allow' : actionRaw === 'deny' ? 'deny' : null
  if (!action) return c.text('invalid action', 400)
  const decided = await decideDeviceGrant(c.env, { user_code: userCode, action, auth })
  const csrf = await issueDeviceCsrf(c.env)
  if (!decided.ok) {
    const html = renderEnterCodePage(csrf, auth, 'That code is not valid or has expired.')
    return htmlResponse(c, html, csrf)
  }
  const html = renderDonePage(decided.status, csrf, auth)
  return htmlResponse(c, html, csrf)
})

async function validCsrf(c: { req: { header: (n: string) => string | undefined }; env: Env }, nonce: string): Promise<boolean> {
  const cookieHeader = c.req.header('Cookie') ?? ''
  const cookieNonce = parseCookie(cookieHeader, 'mupot_device_csrf')
  if (!cookieNonce || cookieNonce !== nonce) return false
  return consumeDeviceCsrf(c.env, nonce)
}

function htmlResponse(c: { req: { url: string } }, html: string, csrf: string): Response {
  const res = new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  const secure = new URL(c.req.url).protocol === 'https:'
  res.headers.append(
    'Set-Cookie',
    `mupot_device_csrf=${csrf}; HttpOnly; SameSite=Lax; Path=/device; Max-Age=600${secure ? '; Secure' : ''}`,
  )
  return res
}

function parseCookie(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return rest.join('=')
  }
  return null
}

function pageShell(title: string, auth: AuthContext, body: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; color: #111; }
  h1 { font-size: 1.25rem; }
  .card { border: 1px solid #ccc; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  .code-input { font-size: 1.5rem; letter-spacing: 0.2rem; font-family: ui-monospace, monospace; width: 12rem; padding: 0.4rem; text-transform: uppercase; }
  .actions { display: flex; gap: 0.75rem; margin-top: 1rem; }
  button { padding: 0.5rem 1rem; font-size: 1rem; }
  .hint, .meta, .error { font-size: 0.85rem; color: #444; }
  .error { color: #8a1f1f; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="meta">Signed in as <strong>${escapeHtml(auth.email ?? auth.userId)}</strong>.</p>
${body}
</body>
</html>`
}

function renderEnterCodePage(csrf: string, auth: AuthContext, error: string | null): string {
  const body = `
<p class="hint">Type the code shown on the agent screen, then continue. Pending requests are not listed here.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="POST" action="/device/preview" class="card">
  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <label for="user_code">Code</label><br>
  <input class="code-input" id="user_code" name="user_code" autocomplete="one-time-code" required maxlength="12" placeholder="XXXX-XXXX">
  <div class="actions">
    <button type="submit">Continue</button>
  </div>
</form>`
  return pageShell('Approve agent access', auth, body)
}

function renderConfirmPage(grant: DeviceGrantPublic, csrf: string, auth: AuthContext): string {
  const body = `
<form method="POST" action="/device/decision" class="card">
  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <input type="hidden" name="user_code" value="${escapeHtml(grant.user_code)}">
  <p>Grant a pot token to <strong>${escapeHtml(grant.agent_name)}</strong> <code>${escapeHtml(grant.agent_slug)}</code>?</p>
  <p class="hint">This is the request for the code you typed. No token is shown on this page.</p>
  <div class="actions">
    <button type="submit" name="action" value="allow">Allow</button>
    <button type="submit" name="action" value="deny">Deny</button>
  </div>
</form>`
  return pageShell('Confirm agent access', auth, body)
}

function renderDonePage(status: 'approved' | 'denied', csrf: string, auth: AuthContext): string {
  const msg =
    status === 'approved'
      ? 'Allowed. The agent can collect its token. Nothing is shown here.'
      : 'Denied. No token was issued.'
  const body = `
<p class="hint">${escapeHtml(msg)}</p>
<form method="GET" action="/device">
  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <button type="submit">Another code</button>
</form>`
  return pageShell('Approve agent access', auth, body)
}
