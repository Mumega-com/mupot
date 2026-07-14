// tests/dashboard-deployment.test.ts — /deployment: the pot's live deployment
// identity (replaces the mislabeled SOVEREIGNTY nav item that used to point at
// the first-run /setup wizard).
//
// Covers:
//   - loadDeployment: reuses publicHealth() verbatim for version/commit/ok/tenant,
//     and reads onboarding state from org_settings (isOnboardingComplete)
//   - deploymentBody: renders version/commit/tenant/health/onboarding for the
//     onboarded + live case, flags an unstamped RELEASE_SHA, and nudges a
//     not-yet-onboarded pot to /setup — with NO secret values ever rendered

import { describe, it, expect } from 'vitest'
import { loadDeployment, deploymentBody } from '../src/dashboard/deployment'
import { MUPOT_PUBLIC_API_VERSION } from '../src/version'
import type { Env } from '../src/types'

// ── D1 mock — drives the single isOnboardingComplete() read (org_settings) ─────
function makeEnv(opts: { tenant?: string; releaseSha?: string; onboardingComplete?: string | null }): Env {
  const { tenant = 'test-tenant', releaseSha, onboardingComplete = 'true' } = opts
  return {
    TENANT_SLUG: tenant,
    RELEASE_SHA: releaseSha,
    DB: {
      prepare() {
        const stmt = {
          bind() {
            return stmt
          },
          async first() {
            return onboardingComplete === null ? null : { value: onboardingComplete }
          },
        }
        return stmt
      },
    },
  } as unknown as Env
}

describe('loadDeployment', () => {
  it('reuses publicHealth() for version/commit/ok/tenant — never re-derives them', async () => {
    const sha = 'b'.repeat(40)
    const env = makeEnv({ tenant: 'mumega', releaseSha: sha, onboardingComplete: 'true' })
    const d = await loadDeployment(env)
    expect(d).toEqual({
      tenant: 'mumega',
      version: MUPOT_PUBLIC_API_VERSION,
      commit: sha,
      ok: true,
      onboarded: true,
    })
  })

  it('reports commit: null when RELEASE_SHA is unset', async () => {
    const env = makeEnv({ onboardingComplete: 'true' })
    const d = await loadDeployment(env)
    expect(d.commit).toBeNull()
  })

  it('reports commit: null when RELEASE_SHA is not a valid 40-hex sha (e.g. a branch name)', async () => {
    const env = makeEnv({ releaseSha: 'main', onboardingComplete: 'true' })
    const d = await loadDeployment(env)
    expect(d.commit).toBeNull()
  })

  it('reads onboarded: false when org_settings.onboarding_complete is unset', async () => {
    const env = makeEnv({ onboardingComplete: null })
    const d = await loadDeployment(env)
    expect(d.onboarded).toBe(false)
  })
})

describe('deploymentBody', () => {
  const stamped = {
    tenant: 'mumega',
    version: MUPOT_PUBLIC_API_VERSION,
    commit: 'c'.repeat(40),
    ok: true,
    onboarded: true,
  }

  it('renders version, full+short commit, tenant, and a live health tag for an onboarded pot', () => {
    const out = String(deploymentBody(stamped))
    expect(out).toContain(MUPOT_PUBLIC_API_VERSION)
    expect(out).toContain(stamped.commit) // full sha rendered
    expect(out).toContain(stamped.commit.slice(0, 12)) // short sha rendered
    expect(out).toContain('mumega')
    expect(out).toContain('live')
    expect(out).not.toContain('Finish first-run setup') // no onboarding nudge once done
    expect(out).not.toContain('Release SHA not set') // no warning once stamped
  })

  it('never renders a build/deploy trigger — guidance only, no button or form', () => {
    const out = String(deploymentBody(stamped))
    expect(out).not.toMatch(/<form/i)
    expect(out).not.toMatch(/<button/i)
    expect(out).toContain('wrangler deploy') // guidance text, not an action
  })

  it('flags clearly when RELEASE_SHA is unset (commit: null) — the deploy was not stamped', () => {
    const out = String(deploymentBody({ ...stamped, commit: null }))
    expect(out).toContain('Release SHA not set')
    expect(out).toContain('not stamped')
  })

  it('nudges to /setup when the pot is not yet onboarded, but still shows live identity', () => {
    const out = String(deploymentBody({ ...stamped, onboarded: false }))
    expect(out).toContain('Finish first-run setup')
    expect(out).toContain('href="/setup"')
    // Still shows what's live even pre-onboarding — the pot is already deployed.
    expect(out).toContain(MUPOT_PUBLIC_API_VERSION)
  })

  it('never renders a secret value or a secret-binding name (only public version/commit/tenant/health)', () => {
    // The page's copy is allowed to reference the CONCEPT of secrets (e.g. "the
    // runbook covers secrets") — what it must never do is render an actual secret
    // binding name or value. None of these Env secret fields exist on DeploymentData
    // at all, so this is really "the type stays narrow", asserted at the string level.
    const out = String(deploymentBody(stamped))
    for (const secretName of [
      'AI_GATEWAY_TOKEN',
      'TELEGRAM_BOT_TOKEN',
      'GITHUB_WEBHOOK_SECRET',
      'GHL_WEBHOOK_SECRET',
      'EVENT_INGEST_SECRET',
      'CONNECTOR_MASTER_KEY',
      'IM_WEBHOOK_SECRET',
    ]) {
      expect(out).not.toContain(secretName)
    }
    expect(out).not.toMatch(/Bearer\s/)
  })
})
