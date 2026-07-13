import { describe, expect, it } from 'vitest'
import { validateRouteEvidence } from '../scripts/local-browser-smoke.mjs'

describe('local browser route evidence', () => {
  const cleanEvidence = {
    route: '/fleet',
    expectedUrl: 'http://127.0.0.1:8787/fleet',
    finalUrl: 'http://127.0.0.1:8787/fleet',
    errors: [],
    bodyText: 'Fleet operations Active agents and runtime health',
  }

  it('accepts a clean route with meaningful content', () => {
    expect(() => validateRouteEvidence(cleanEvidence)).not.toThrow()
  })

  it('invalidates smoke when the browser records an error', () => {
    expect(() => validateRouteEvidence({
      ...cleanEvidence,
      errors: ['Uncaught TypeError: cannot read properties of undefined'],
    })).toThrow(/browser errors.*\/fleet/i)
  })

  it('invalidates smoke when a route redirects unexpectedly', () => {
    expect(() => validateRouteEvidence({
      ...cleanEvidence,
      finalUrl: 'http://127.0.0.1:8787/auth/login',
    })).toThrow(/redirected unexpectedly.*\/fleet/i)
  })

  it.each(['', '   \n\t ', 'Loading...'])(
    'invalidates smoke for blank or placeholder content: %j',
    (bodyText) => {
      expect(() => validateRouteEvidence({
        ...cleanEvidence,
        bodyText,
      })).toThrow(/meaningful content.*\/fleet/i)
    },
  )
})
