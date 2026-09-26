// mupot — pluggable email sender for the email-login door (#1564/#1442).
//
// Two implementations behind one interface: a real Resend sender for
// production, and a console sender for local dev / tests that never makes a
// network call. Callers (src/auth/email-login.ts) hold only the interface —
// swapping providers later means adding a class here, never touching a
// call site.
//
// Env names deliberately MIRROR workers/inkwell-api's own request-code Resend
// sender (src/routes/auth.ts: RESEND_API_KEY + RESEND_FROM_EMAIL, POST
// https://api.resend.com/emails, console.error on non-2xx) so one Resend API
// key can serve both workers without a second naming convention to track.

import type { Env } from '../types'

export interface EmailMessage {
  to: string
  subject: string
  text: string
  html: string
}

export interface EmailSendResult {
  ok: boolean
}

export interface EmailSender {
  send(message: EmailMessage): Promise<EmailSendResult>
}

const RESEND_TIMEOUT_MS = 10_000

/**
 * Real sender. Never logs the message body (link/code are secrets) — only a
 * status code on failure, matching inkwell-api's own `console.error` shape.
 */
class ResendEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          from: this.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      })
      if (!res.ok) {
        console.error(`[email-sender] resend failed: ${res.status}`)
        return { ok: false }
      }
      return { ok: true }
    } catch (err) {
      console.error('[email-sender] resend error:', err instanceof Error ? err.message : err)
      return { ok: false }
    }
  }
}

/**
 * Dev/test sender. Logs the message (link + code included — this path is
 * ONLY ever selected for local dev or an in-process test run, never a real
 * deployment; see resolveEmailSender's gate below) instead of sending real
 * mail. Never throws.
 */
class ConsoleEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<EmailSendResult> {
    console.log(`[email-sender:console] to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.text}`)
    return { ok: true }
  }
}

/**
 * Resolve which sender this pot uses, or null when nothing is configured.
 *
 * - LOCAL_TEST_AUTH=1 or EMAIL_PROVIDER='console' → console sender,
 *   unconditionally (dev/test only — same LOCAL_TEST_AUTH gate /auth/dev-login
 *   already uses, so a test env that enables one gets the other for free).
 * - Both RESEND_API_KEY and RESEND_FROM_EMAIL set → Resend.
 * - Otherwise → null. The caller (startEmailLogin) treats null as "log one
 *   structured error, send nothing" — the /email/start ROUTE still returns
 *   its unconditional 200 either way (no oracle on server misconfiguration).
 */
export function resolveEmailSender(env: Env): EmailSender | null {
  if (env.LOCAL_TEST_AUTH === '1' || env.EMAIL_PROVIDER === 'console') {
    return new ConsoleEmailSender()
  }
  if (typeof env.RESEND_API_KEY === 'string' && env.RESEND_API_KEY.length > 0
    && typeof env.RESEND_FROM_EMAIL === 'string' && env.RESEND_FROM_EMAIL.length > 0) {
    return new ResendEmailSender(env.RESEND_API_KEY, env.RESEND_FROM_EMAIL)
  }
  return null
}
