import { describe, expect, it } from 'vitest'
import { addonsBody } from '../src/dashboard/addons'
import { dashboardApp } from '../src/dashboard/index'
import type { AddonCatalogEntry } from '../src/addons/registry'
import type { AddonInstallation, AddonState } from '../src/addons/service'
import { FixtureAddon } from '../src/addons/modules/fixture'
import type { Env } from '../src/types'

const fixtureEntry: AddonCatalogEntry = {
  manifest: FixtureAddon,
  manifestSha256: 'a'.repeat(64),
}

function installation(state: AddonState): AddonInstallation {
  return {
    id: 'installation-1',
    tenant: 'tenant-a',
    addonKey: FixtureAddon.key,
    installedVersion: FixtureAddon.version,
    publisher: FixtureAddon.publisher,
    trustClass: 'native_reviewed',
    manifestSha256: 'b'.repeat(64),
    mupotCompatibility: FixtureAddon.mupotCompatibility,
    state,
    latestPreviousState: null,
    installedBy: 'owner-1',
    latestActorId: 'owner-1',
    latestReceiptId: 'receipt-1',
    installedAt: '2026-07-01T00:00:00.000Z',
    configuredAt: null,
    activatedAt: null,
    disabledAt: null,
    archivedAt: state === 'archived' ? '2026-07-02T00:00:00.000Z' : null,
    updatedAt: '2026-07-02T00:00:00.000Z',
    lastError: null,
  }
}

function rendered(state: AddonState | null = null): string {
  return String(addonsBody([fixtureEntry], state ? [installation(state)] : []))
}

function dashboardEnv(role: 'owner' | 'admin' | 'member'): Env {
  const statement = {
    bind: (..._args: unknown[]) => statement,
    all: async () => ({ results: [] }),
  }
  return {
    TENANT_SLUG: 'tenant-a',
    BRAND: 'Test',
    DB: { prepare: () => statement },
    SESSIONS: {
      get: async () => JSON.stringify({
        userId: `${role}-1`, email: `${role}@example.test`, role, createdAt: '2026-07-01T00:00:00.000Z',
      }),
    },
    OAUTH_KV: { get: async () => null, put: async () => undefined },
  } as unknown as Env
}

function addonsRequest(): Request {
  return new Request('https://pot.test/addons', { headers: { Cookie: 'mupot_session=session-1' } })
}

describe('addonsBody', () => {
  it('renders the available fixture catalog with its operational metadata', () => {
    const html = rendered()

    expect(html).toContain('Addons')
    expect(html).toContain('Fixture Addon')
    expect(html).toContain('No connectors or authority requested')
    expect(html).toContain('Install')
    expect(html).toContain('Digest')
    expect(html).toContain('a'.repeat(12))
    expect(html).toContain('href="/api/addons/fixture-addon/receipts"')
    expect(html).not.toContain('Upgrade')
    expect(html).not.toContain('Delete data')
  })

  it.each([
    ['installed', ['Configure'], ['Install', 'Activate', 'Disable', 'Uninstall']],
    ['configured', ['Activate'], ['Configure', 'Disable', 'Uninstall']],
    ['active', ['Disable'], ['Configure', 'Activate', 'Uninstall']],
    ['disabled', ['Activate', 'Uninstall'], ['Configure', 'Disable']],
  ] as const)('renders only valid lifecycle commands for %s addons', (state, present, absent) => {
    const html = rendered(state)

    for (const label of present) expect(html).toContain(`>${label}</button>`)
    for (const label of absent) expect(html).not.toContain(`>${label}</button>`)
  })

  it('renders archived addons without a lifecycle mutation button', () => {
    const html = rendered('archived')

    expect(html).toContain('Archived')
    expect(html).not.toMatch(/<button[^>]+data-addon-action=/)
  })

  it('binds every lifecycle command to addon data rather than a rendered action URL', () => {
    const html = rendered('disabled')

    expect(html).toMatch(/<button[^>]+data-addon-key="fixture-addon"[^>]+data-addon-action="activate"/)
    expect(html).toMatch(/<button[^>]+data-addon-key="fixture-addon"[^>]+data-addon-action="archive"/)
    expect(html).toContain("encodeURIComponent(key)")
    expect(html).not.toMatch(/<form[^>]+action=|data-action-url=|onclick=/)
  })

  it('includes loading, disabled, inline-error, and refresh behavior for lifecycle commands', () => {
    const html = rendered()

    expect(html).toContain('button.disabled = true')
    expect(html).toContain("status.textContent = 'Working...'")
    expect(html).toContain("status.textContent = data.error || 'request_failed'")
    expect(html).toContain('window.location.reload()')
  })
})

describe('GET /addons', () => {
  it.each(['owner', 'admin'] as const)('renders the owner console and nav entry for %s', async (role) => {
    const response = await dashboardApp.fetch(addonsRequest(), dashboardEnv(role))
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('Fixture Addon')
    expect(html).toContain('href="/addons"')
    expect(html).toContain('>Addons</span>')
  })

  it('blocks members before catalog reads and keeps the owner console navigation hidden', async () => {
    const response = await dashboardApp.fetch(addonsRequest(), dashboardEnv('member'))
    const html = await response.text()

    expect(response.status).toBe(403)
    expect(html).toContain('Addons requires owner or admin.')
    expect(html).toContain('id="nav-addons" hidden')
    expect(html).toContain("operatorRole === 'owner' || operatorRole === 'admin'")
  })
})
