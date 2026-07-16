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

function renderedEntry(entry: AddonCatalogEntry, installations: AddonInstallation[] = []): string {
  return String(addonsBody([entry], installations))
}

function lifecycleScript(markup: string): string {
  const script = markup.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  if (!script) throw new Error('addon lifecycle script was not rendered')
  return script[1]
}

function lifecycleHarness(key = 'fixture-addon') {
  let click: (() => Promise<void>) | undefined
  const status = { textContent: '' }
  const card = { querySelector: (selector: string) => selector === '.addon-status' ? status : null }
  const button = {
    dataset: { addonKey: key, addonAction: 'install' },
    disabled: false,
    closest: (selector: string) => selector === '[data-addon-card]' ? card : null,
    addEventListener: (event: string, listener: () => Promise<void>) => {
      if (event === 'click') click = listener
    },
  }
  const document = {
    querySelectorAll: (selector: string) => selector === '[data-addon-action][data-addon-key]' ? [button] : [],
  }
  let reloads = 0
  const window = { location: { reload: () => { reloads += 1 } } }

  return {
    button,
    status,
    document,
    window,
    click: async () => {
      if (!click) throw new Error('lifecycle click listener was not attached')
      await click()
    },
    reloads: () => reloads,
  }
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
    ['installed', ['Configure', 'Disable'], ['Install', 'Activate', 'Uninstall', 'Reinstall']],
    ['configured', ['Activate', 'Disable'], ['Configure', 'Uninstall', 'Reinstall']],
    ['active', ['Disable'], ['Configure', 'Activate', 'Uninstall']],
    ['disabled', ['Activate', 'Uninstall'], ['Configure', 'Disable']],
  ] as const)('renders only valid lifecycle commands for %s addons', (state, present, absent) => {
    const html = rendered(state)

    for (const label of present) expect(html).toContain(`>${label}</button>`)
    for (const label of absent) expect(html).not.toContain(`>${label}</button>`)
  })

  it('renders archived addons with a reinstall command', () => {
    const html = rendered('archived')

    expect(html).toContain('Archived')
    expect(html).toMatch(/<button[^>]+data-addon-action="install"[^>]*>Reinstall<\/button>/)
    expect(html).not.toMatch(/data-addon-action="(?:configure|activate|disable|archive)"/)
  })

  it('explains retained operational data beside uninstall without nesting cards', () => {
    const html = rendered('disabled')

    expect(html).toContain('Uninstall retains tasks, flights, metrics, audit records, and receipts.')
    expect(html.match(/class="addon-card"/g)).toHaveLength(1)
    expect(html).not.toMatch(/class="addon-card"[^]*class="addon-card"/)
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

  it('escapes hostile display values and encodes the receipt path from renderer DTOs', () => {
    const hostileEntry: AddonCatalogEntry = {
      ...fixtureEntry,
      manifest: {
        ...FixtureAddon,
        key: 'receipt/key?x=1',
        name: '<img src=x onerror=alert(1)>',
        description: '<svg onload=alert(2)>',
        publisher: '<b onclick=alert(3)>',
      },
    }

    const html = renderedEntry(hostileEntry)

    expect(html).toContain('href="/api/addons/receipt%2Fkey%3Fx%3D1/receipts"')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&lt;svg onload=alert(2)&gt;')
    expect(html).toContain('&lt;b onclick=alert(3)&gt;')
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<svg onload=alert(2)>')
    expect(html).not.toContain('<b onclick=alert(3)>')
  })

  it('prefers a live installation over archived history in the renderer selection', () => {
    const archived = { ...installation('archived'), id: 'archived', manifestSha256: 'a'.repeat(64), archivedAt: '2026-07-03T00:00:00.000Z' }
    const live = { ...installation('disabled'), id: 'live', manifestSha256: 'b'.repeat(64), updatedAt: '2026-07-01T00:00:00.000Z' }

    const html = renderedEntry(fixtureEntry, [archived, live])

    expect(html).toContain('Disabled')
    expect(html).toContain('b'.repeat(12))
    expect(html).not.toContain('Archived')
  })

  it('selects the newest archive when no live installation remains', () => {
    const older = { ...installation('archived'), id: 'older', manifestSha256: 'a'.repeat(64), archivedAt: '2026-07-01T00:00:00.000Z' }
    const newer = { ...installation('archived'), id: 'newer', manifestSha256: 'b'.repeat(64), archivedAt: '2026-07-03T00:00:00.000Z' }

    const html = renderedEntry(fixtureEntry, [older, newer])

    expect(html).toContain('Archived')
    expect(html).toContain('b'.repeat(12))
  })

  it('executes plain browser JavaScript and preserves a stable lifecycle error', async () => {
    const harness = lifecycleHarness('fixture/addon?x=1')
    const script = lifecycleScript(rendered())
    let requestPath = ''
    let resolveResponse: ((response: { ok: boolean; json: () => Promise<{ error: string }> }) => void) | undefined
    const response = new Promise<{ ok: boolean; json: () => Promise<{ error: string }> }>((resolve) => { resolveResponse = resolve })
    const fetch = (path: string) => {
      requestPath = path
      return response
    }

    new Function('document', 'fetch', 'window', script)(harness.document, fetch, harness.window)
    const click = harness.click()

    expect(requestPath).toBe('/api/addons/fixture%2Faddon%3Fx%3D1/install')
    expect(harness.button.disabled).toBe(true)
    expect(harness.status.textContent).toBe('Working...')

    resolveResponse?.({ ok: false, json: async () => ({ error: 'invalid_state' }) })
    await click

    expect(harness.button.disabled).toBe(false)
    expect(harness.status.textContent).toBe('invalid_state')
    expect(harness.reloads()).toBe(0)
  })

  it('reloads after a successful lifecycle action', async () => {
    const harness = lifecycleHarness()
    const script = lifecycleScript(rendered())

    new Function('document', 'fetch', 'window', script)(
      harness.document,
      async () => ({ ok: true, json: async () => ({}) }),
      harness.window,
    )
    await harness.click()

    expect(harness.reloads()).toBe(1)
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
    expect(html).not.toContain("operatorRole === 'owner' || operatorRole === 'admin'")
  })

  it.each(['owner', 'admin'] as const)('server-renders the Addons nav entry across shell responses for %s', async (role) => {
    const response = await dashboardApp.fetch(new Request('https://pot.test/services', {
      headers: { Cookie: 'mupot_session=session-1' },
    }), dashboardEnv(role))
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('id="nav-addons">')
    expect(html).not.toContain('id="nav-addons" hidden')
    expect(html).not.toContain("operatorRole === 'owner' || operatorRole === 'admin'")
  })

  it('keeps the Addons nav entry hidden for members across shell responses', async () => {
    const response = await dashboardApp.fetch(new Request('https://pot.test/services', {
      headers: { Cookie: 'mupot_session=session-1' },
    }), dashboardEnv('member'))
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('id="nav-addons" hidden')
  })
})
