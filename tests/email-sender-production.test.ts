import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveEmailSender } from '../src/auth/email-sender'
import type { Env } from '../src/types'

// The console email sender prints sign-in links and codes. It is for local dev only, so a
// production environment must refuse it and say so at startup.
const env = (extra: Record<string, string>): Env => extra as unknown as Env // only the keys the resolver reads

afterEach(() => vi.restoreAllMocks())

describe('console email sender is refused in production', () => {
  it('returns null and logs an error for EMAIL_PROVIDER=console with ENVIRONMENT=production', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(resolveEmailSender(env({ EMAIL_PROVIDER: 'console', ENVIRONMENT: 'production' }))).toBeNull()
    expect(err).toHaveBeenCalled()
    expect(String(err.mock.calls[0]?.[0])).toMatch(/console/i)
  })
  it('refuses LOCAL_TEST_AUTH=1 in production too, but falls through to Resend when configured', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(resolveEmailSender(env({ LOCAL_TEST_AUTH: '1', ENVIRONMENT: 'production' }))).toBeNull()
    expect(resolveEmailSender(env({ EMAIL_PROVIDER: 'console', ENVIRONMENT: 'Production', RESEND_API_KEY: 'k', RESEND_FROM_EMAIL: 'a@b.co' }))).not.toBeNull()
  })
  it('still allows the console sender outside production', () => {
    expect(resolveEmailSender(env({ EMAIL_PROVIDER: 'console' }))).not.toBeNull()
    expect(resolveEmailSender(env({ EMAIL_PROVIDER: 'console', ENVIRONMENT: 'development' }))).not.toBeNull()
  })
})
