import { describe, expect, it } from 'vitest'
import { autoReplyReason } from '../src/email-decisions/auto-reply'
import { normalizeAddress, parseAddress, splitPlusTag } from '../src/email-decisions/address'
import { EMAIL_DECISION_TTL_SECONDS, mintDecisionToken, verifyDecisionToken, type TokenBinding } from '../src/email-decisions/tokens'

const SECRET = 'test-secret-key-0123456789'
const NOW = Date.UTC(2026, 9, 26, 12, 0, 0)
const BIND: TokenBinding = { tenant: 'mumega', taskId: 't-1', memberId: 'm-1', emailNormalized: 'hadi@example.com', reviewEnteredAt: '2026-10-26T11:00:00Z' }

describe('token mint/verify', () => {
  it('round-trips', async () => {
    const m = await mintDecisionToken(SECRET, BIND, NOW)
    expect(m).not.toBeNull()
    const v = await verifyDecisionToken(SECRET, m!.token, BIND, NOW + 1000)
    expect(v).toEqual({ ok: true, decisionId: m!.decisionId, expiresAt: m!.expiresAt })
    expect(m!.expiresAt - Math.floor(NOW / 1000)).toBe(EMAIL_DECISION_TTL_SECONDS)
  })
  it('fails closed without a secret', async () => {
    expect(await mintDecisionToken(undefined, BIND, NOW)).toBeNull()
    expect(await mintDecisionToken('', BIND, NOW)).toBeNull()
    const m = await mintDecisionToken(SECRET, BIND, NOW)
    expect(await verifyDecisionToken(undefined, m!.token, BIND, NOW)).toEqual({ ok: false, reason: 'no_secret' })
  })
  it('rejects a tampered mac, decision id and expiry', async () => {
    const m = (await mintDecisionToken(SECRET, BIND, NOW))!
    const [id, exp, mac] = m.token.split('.')
    const flipped = (mac.startsWith('A') ? 'B' : 'A') + mac.slice(1)
    expect((await verifyDecisionToken(SECRET, `${id}.${exp}.${flipped}`, BIND, NOW)).ok).toBe(false)
    expect((await verifyDecisionToken(SECRET, `${crypto.randomUUID()}.${exp}.${mac}`, BIND, NOW)).ok).toBe(false)
    // Extending the expiry must invalidate the signature, not just be accepted.
    expect(await verifyDecisionToken(SECRET, `${id}.${Number(exp) + 86400}.${mac}`, BIND, NOW)).toEqual({ ok: false, reason: 'bad_signature' })
  })
  it('rejects a wrong key', async () => {
    const m = (await mintDecisionToken(SECRET, BIND, NOW))!
    expect(await verifyDecisionToken('other-secret', m.token, BIND, NOW)).toEqual({ ok: false, reason: 'bad_signature' })
  })
  it('expires at 24h', async () => {
    const m = (await mintDecisionToken(SECRET, BIND, NOW))!
    expect((await verifyDecisionToken(SECRET, m.token, BIND, NOW + (EMAIL_DECISION_TTL_SECONDS - 1) * 1000)).ok).toBe(true)
    expect(await verifyDecisionToken(SECRET, m.token, BIND, NOW + EMAIL_DECISION_TTL_SECONDS * 1000)).toEqual({ ok: false, reason: 'expired' })
  })
  it.each([
    ['wrong member', { memberId: 'm-2' }],
    ['wrong task', { taskId: 't-2' }],
    ['wrong tenant', { tenant: 'other' }],
    ['wrong mailbox', { emailNormalized: 'eve@example.com' }],
    ['task re-submitted (review_entered_at moved)', { reviewEnteredAt: '2026-10-26T11:30:00Z' }],
  ])('binding mismatch: %s', async (_n, patch) => {
    const m = (await mintDecisionToken(SECRET, BIND, NOW))!
    expect(await verifyDecisionToken(SECRET, m.token, { ...BIND, ...patch }, NOW)).toEqual({ ok: false, reason: 'bad_signature' })
  })
  it.each(['', 'a.b', 'a.b.c.d', 'x'.repeat(36) + '.1.AAAA'])('malformed: %s', async (t) => {
    expect((await verifyDecisionToken(SECRET, t, BIND, NOW)).ok).toBe(false)
  })
})

function h(init: Record<string, string>): { get(n: string): string | null } {
  const m = new Headers(init)
  return { get: (n) => m.get(n) }
}

describe('auto-reply filter', () => {
  it('passes a human reply', () => expect(autoReplyReason(h({ 'content-type': 'text/plain' }), 'a@b.com')).toBeNull())
  it('Auto-Submitted: no is a human', () => expect(autoReplyReason(h({ 'auto-submitted': 'no' }), 'a@b.com')).toBeNull())
  it.each(['auto-replied', 'auto-generated', 'Auto-Replied (vacation)'])('Auto-Submitted %s', (v) => expect(autoReplyReason(h({ 'auto-submitted': v }), 'a@b.com')).toBe('auto_submitted'))
  it.each(['bulk', 'junk', 'auto_reply', 'list', 'BULK'])('Precedence %s', (v) => expect(autoReplyReason(h({ precedence: v }), 'a@b.com')).toBe('precedence'))
  it('multipart/report', () => expect(autoReplyReason(h({ 'content-type': 'multipart/report; report-type=delivery-status' }), 'a@b.com')).toBe('multipart_report'))
  it.each(['', '<>', 'MAILER-DAEMON@x.com', ' <> '])('null sender %j', (f) => expect(autoReplyReason(h({}), f)).toBe('null_sender'))
  it('X-Autoreply', () => expect(autoReplyReason(h({ 'x-autoreply': 'yes' }), 'a@b.com')).toBe('x_autoreply'))
  it('list headers', () => expect(autoReplyReason(h({ 'list-id': '<x.y>' }), 'a@b.com')).toBe('list_or_suppress'))
})

describe('address normalizer', () => {
  it('lowercases and keeps plus-tag and dots', () => expect(normalizeAddress('Hadi.Servat+Tag@Gmail.COM')).toBe('hadi.servat+tag@gmail.com'))
  it('quoted display name: only the addr-spec is compared', () => expect(normalizeAddress('"Hadi" <Hadi@Example.com>')).toBe('hadi@example.com'))
  it('plain display name', () => expect(normalizeAddress('Hadi <Hadi@Example.com>')).toBe('hadi@example.com'))
  it.each(['a@b.com, c@d.com', 'nope', '@x.com', 'a@', 'a@b', 'a@@b.com', 'a b@c.com', ''])('refuses %j', (v) => expect(parseAddress(v)).toBeNull())
  it('splits the plus token', () => {
    expect(splitPlusTag('approve+abc.123.xyz@Decide.Mumega.com')).toEqual({ base: 'approve', tag: 'abc.123.xyz', domain: 'decide.mumega.com' })
    expect(splitPlusTag('approve@decide.mumega.com')).toEqual({ base: 'approve', tag: null, domain: 'decide.mumega.com' })
  })
})
