// tests/ghl-reply-tracking.test.ts — inbound event → prospect status mapping (P4, #35).
import { describe, expect, it } from 'vitest'
import { prospectUpdateFromEvent } from '../src/integrations/ghl-routes'

describe('prospectUpdateFromEvent', () => {
  it('a reply maps to replied (the positive-outcome KPI signal)', () => {
    expect(prospectUpdateFromEvent({ type: 'inbound_message', email: 'a@y.com' }))
      .toEqual({ email: 'a@y.com', status: 'replied' })
  })
  it('an unsubscribe/opt-out maps to opted_out', () => {
    expect(prospectUpdateFromEvent({ type: 'unsubscribe', email: 'a@y.com' })?.status).toBe('opted_out')
    expect(prospectUpdateFromEvent({ type: 'contact.opt_out', email: 'a@y.com' })?.status).toBe('opted_out')
  })
  it('a bounce maps to bounced', () => {
    expect(prospectUpdateFromEvent({ type: 'email.bounce', email: 'a@y.com' })?.status).toBe('bounced')
  })
  it('reads a nested contact.email', () => {
    expect(prospectUpdateFromEvent({ type: 'reply', contact: { email: 'n@y.com' } })?.email).toBe('n@y.com')
  })
  it('returns null when there is no email', () => {
    expect(prospectUpdateFromEvent({ type: 'reply' })).toBeNull()
  })
})
