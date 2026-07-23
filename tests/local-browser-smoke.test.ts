import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateRouteEvidence } from '../scripts/local-browser-smoke.mjs'

const browserSmokeSource = readFileSync(join(__dirname, '..', 'scripts', 'local-browser-smoke.mjs'), 'utf8')

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

  it('exercises project-context send and flight pages and verifies task attribution', () => {
    expect(browserSmokeSource).toContain("page.goto(`${baseUrl}/send?project_id=project-mupot`")
    expect(browserSmokeSource).toContain("page.goto(`${baseUrl}/flights?project_id=project-mupot`")
    expect(browserSmokeSource).toContain('submittedTask.project_id !== \'project-mupot\'')
  })

  it('covers Docs RBAC viewer visibility (public+project visible, private/entity omitted)', () => {
    expect(browserSmokeSource).toContain('/projects/project-mupot/docs')
    expect(browserSmokeSource).toContain('VISIBLE_PUBLIC_MARKER')
    expect(browserSmokeSource).toContain('VISIBLE_PROJECT_MARKER')
    expect(browserSmokeSource).toContain('HIDDEN_PRIVATE_MARKER')
    expect(browserSmokeSource).toContain('HIDDEN_ENTITY_MARKER')
    expect(browserSmokeSource).toContain('must not include HIDDEN_PRIVATE_MARKER')
  })
})
