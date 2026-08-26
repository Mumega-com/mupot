// tests/river-copilot-caching.test.ts — River lead routing, frozen-prefix cache, D1 + 7-axis.
//
// Schema is the committed migration chain (createSqliteD1 + applyAllMigrations).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { html } from 'hono/html'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  CACHE_DYNAMIC_MARKER,
  CACHE_PREFIX_MARKER,
  FROZEN_STATIC_PREFIX,
  formatCachedPrompt,
  keepAliveCacheSession,
  promptPrefixIsFrozen,
  resetCacheSessions,
  splitCachedPrompt,
  CACHE_HEARTBEAT_INTERVAL_MS,
} from '../src/ai/cache-context'
import {
  RIVER_AGENT_MODEL,
  RIVER_AGENT_PURPOSE,
  RIVER_CURSOR_SEAT,
  RIVER_LEAD_PROFILE,
  ensureRiverLeadAgent,
  loadRiverLeadAgent,
} from '../src/agents/river-lead'
import { parseSevenAxisCheckin, isRiverCursorSeat } from '../src/presence/seven-axis'
import { invokeTool } from '../src/mcp/index'
import { projectLivePreviewSplitHtml } from '../src/platform/routes'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', () => ({
  requireAuth: async (
    c: {
      get: (key: 'auth') => AuthContext | undefined
      set: (key: 'auth', value: AuthContext) => void
      json: (body: unknown, status: 401) => Response
    },
    next: () => Promise<void>,
  ) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
  peekSessionAuth: async () => authState.current,
}))

const { dashboardApp, shell } = await import('../src/dashboard')
const {
  COPILOT_RECIPIENTS,
  buildCopilotPersonaPrompt,
  copilotPageBody,
  copilotRecipientBadge,
  copilotRecipientSelectHtml,
  getCopilotRecipient,
  normalizeCopilotRecipient,
} = await import('../src/dashboard/copilot')
const { buildStudioChatSystemPrompt } = await import('../src/dashboard/studio-chat')

const TENANT = 'pot-river-cache'

let harness: SqliteD1Harness
let env: Env

function actor(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'operator-1',
    email: 'operator@mumega.com',
    role: 'admin',
    tenant: TENANT,
    memberId: 'member-river',
    boundAgentId: 'river',
    channel: 'workspace',
    capabilities: [],
    ...overrides,
  }
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = { DB: harness.db, TENANT_SLUG: TENANT, BRAND: 'Mupot' } as Env
  authState.current = actor()
  resetCacheSessions()
})

afterEach(() => {
  authState.current = null
  harness.close()
  resetCacheSessions()
})

function seedSquadCore(): void {
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-core', 'core', 'Council Core');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-core', 'dept-core', 'squad-core', 'Squad Core');
    INSERT INTO members (id, tenant, display_name, email, status, created_at)
      VALUES ('member-river', '${TENANT}', 'River', 'river@agents.mumega.com', 'active', datetime('now'));
  `)
}

describe('@river recipient resolution and persona routing', () => {
  it('resolves @river handles, aliases, and unknown fallbacks', () => {
    expect(normalizeCopilotRecipient('river')).toBe('river')
    expect(normalizeCopilotRecipient('@RIVER')).toBe('river')
    expect(normalizeCopilotRecipient('River')).toBe('river')
    expect(normalizeCopilotRecipient('not-an-agent')).toBe('copilot')
  })

  it('exposes River as a selectable Co-Pilot recipient', () => {
    const river = getCopilotRecipient('river')
    expect(river.id).toBe('river')
    expect(river.handle).toBe('@river')
    expect(river.label).toBe('River (Lead)')
    expect(river.role).toBe('Council Lead & Continuity')
    expect(river.avatarColor).toBe('#06b6d4')
    expect(river.color).toBe('#06b6d4')
    expect(copilotRecipientBadge('river')).toBe('🌊 River')
    expect(COPILOT_RECIPIENTS.some((agent) => agent.id === 'river')).toBe(true)
  })

  it('builds the River council-lead persona', () => {
    const prompt = buildCopilotPersonaPrompt('@river')
    expect(prompt).toContain('You are River (@river — Council Lead & Verification Lead).')
    expect(prompt).toContain('continuity')
    expect(prompt).toContain('high-coherence steering')
    expect(prompt).toContain('evidence rigor')
    expect(prompt).toContain('multi-squad direction')
    expect(prompt).toContain('verified outcomes')
  })

  it('threads River into the Studio system prompt', () => {
    const prompt = buildStudioChatSystemPrompt(
      {
        role: 'admin',
        tools: ['task_create'],
        operator: 'operator@mumega.com',
        tenant: TENANT,
        guest: false,
        source: 'session',
      },
      { squads: ['squad-core'] },
      'river',
    )
    expect(prompt).toContain(CACHE_PREFIX_MARKER)
    expect(prompt).toContain('Council Lead & Verification Lead')
    expect(prompt).toContain('🌊 River')
    expect(prompt).toContain('@river')
    expect(prompt.indexOf(CACHE_PREFIX_MARKER)).toBeLessThan(prompt.indexOf(CACHE_DYNAMIC_MARKER))
  })
})

describe('frozen static prefix and prompt cache structure', () => {
  it('keeps charter, architecture, tools, and River governance in a stable prefix', () => {
    expect(FROZEN_STATIC_PREFIX.startsWith(CACHE_PREFIX_MARKER)).toBe(true)
    expect(FROZEN_STATIC_PREFIX).toContain('Mupot Core Charter')
    expect(FROZEN_STATIC_PREFIX).toContain('Architecture')
    expect(FROZEN_STATIC_PREFIX).toContain('Tool Schemas')
    expect(FROZEN_STATIC_PREFIX).toContain('River Governance')
    expect(FROZEN_STATIC_PREFIX).not.toContain(CACHE_DYNAMIC_MARKER)
  })

  it('places timestamps, recalls, and the user message after the frozen prefix', () => {
    const first = formatCachedPrompt({
      userMessage: 'Steer the fleet',
      timestamp: '2026-08-26T16:00:00.000Z',
      recalls: ['last landing was verified'],
      persona: buildCopilotPersonaPrompt('river'),
      recipient: 'river',
    })
    const second = formatCachedPrompt({
      userMessage: 'Different turn',
      timestamp: '2026-08-26T16:05:00.000Z',
      recalls: ['new recall'],
      persona: buildCopilotPersonaPrompt('river'),
      recipient: 'river',
    })
    expect(first.prefix).toBe(second.prefix)
    expect(first.prefix).toContain(FROZEN_STATIC_PREFIX)
    expect(first.prefix).toContain('Council Lead & Verification Lead')
    expect(first.suffix).toContain(CACHE_DYNAMIC_MARKER)
    expect(first.suffix).toContain('2026-08-26T16:00:00.000Z')
    expect(first.suffix).toContain('last landing was verified')
    expect(first.suffix).toContain('Steer the fleet')
    expect(first.prompt.indexOf(CACHE_PREFIX_MARKER)).toBeLessThan(first.prompt.indexOf(CACHE_DYNAMIC_MARKER))
    expect(promptPrefixIsFrozen(first.prompt)).toBe(true)
    expect(splitCachedPrompt(first.prompt).prefix).toBe(first.prefix)
  })

  it('refreshes an active cache session on the keep-alive heartbeat', () => {
    const now = 1_000_000
    const first = keepAliveCacheSession('river-cursor', now)
    expect(first.refreshed).toBe(true)
    expect(first.sessionId).toBe('river-cursor')

    const tooSoon = keepAliveCacheSession('river-cursor', now + 1_000)
    expect(tooSoon.refreshed).toBe(false)
    expect(tooSoon.lastHeartbeatAt).toBe(now)

    const due = keepAliveCacheSession('river-cursor', now + CACHE_HEARTBEAT_INTERVAL_MS)
    expect(due.refreshed).toBe(true)
    expect(due.lastHeartbeatAt).toBe(now + CACHE_HEARTBEAT_INTERVAL_MS)
  })
})

describe('River D1 profile and 7-axis presence', () => {
  it('does not seed River on an empty migration chain', async () => {
    expect(await loadRiverLeadAgent(env)).toBeNull()
  })

  it('registers River on squad-core with the lead profile', async () => {
    seedSquadCore()
    const ensured = await ensureRiverLeadAgent(env)
    expect(ensured.ok).toBe(true)
    if (!ensured.ok) return
    const row = await loadRiverLeadAgent(env)
    expect(row).toMatchObject({
      id: 'river',
      slug: 'river',
      name: 'River',
      role: 'lead',
      model: RIVER_AGENT_MODEL,
      squad_id: 'squad-core',
      purpose: RIVER_AGENT_PURPOSE,
    })
    expect(row).toMatchObject(RIVER_LEAD_PROFILE)
  })

  it('records 7-axis check-in for seat river-cursor', async () => {
    seedSquadCore()
    await ensureRiverLeadAgent(env)
    const sessions = new Map<string, string>()
    env = {
      ...env,
      SESSIONS: {
        get: async (key: string) => sessions.get(key) ?? null,
        put: async (key: string, value: string) => {
          sessions.set(key, value)
        },
      },
    } as Env

    const axes = parseSevenAxisCheckin({
      seat: RIVER_CURSOR_SEAT,
      harness: 'cursor-cloud',
      machine: 'cursor-cloud-vm',
      model: 'gemini-3.7-flash',
      provider: 'google',
      effort: 'high',
      flight_id: 'flight-river-1',
    })
    expect(isRiverCursorSeat(axes.seat)).toBe(true)
    expect(axes.harness).toBe('cursor-cloud')

    const res = await invokeTool(
      actor(),
      env,
      'check_in',
      {
        source: 'cursor-cloud',
        seat: RIVER_CURSOR_SEAT,
        harness: 'cursor-cloud',
        machine: 'cursor-cloud-vm',
        model: 'gemini-3.7-flash',
        provider: 'google',
        effort: 'high',
        flight_id: 'flight-river-1',
      },
      'https://pot.test',
    )
    expect(res.ok).toBe(true)
    expect(res.result).toMatchObject({
      ok: true,
      seat: RIVER_CURSOR_SEAT,
      harness: 'cursor-cloud',
      machine: 'cursor-cloud-vm',
      model: 'gemini-3.7-flash',
      provider: 'google',
      effort: 'high',
      flight_id: 'flight-river-1',
      debounced: false,
    })

    const row = harness.sqlite
      .prepare(`SELECT seat, harness, machine, model, provider, effort, flight_id, label FROM presence WHERE label = ?`)
      .get(RIVER_CURSOR_SEAT) as Record<string, string>
    expect(row).toMatchObject({
      seat: RIVER_CURSOR_SEAT,
      harness: 'cursor-cloud',
      machine: 'cursor-cloud-vm',
      model: 'gemini-3.7-flash',
      provider: 'google',
      effort: 'high',
      flight_id: 'flight-river-1',
    })
  })
})

describe('persona dropdown surfaces', () => {
  it('renders @river on /copilot, the global drawer, and the project sandbox', async () => {
    const page = String(await copilotPageBody(actor({ role: 'admin' })))
    expect(page).toContain('@river')
    expect(page).toContain('River (Lead)')
    expect(page).toContain('value="river"')

    const drawer = String(await shell(env, 'Overview', html`<p>hi</p>`))
    expect(drawer).toContain('id="mupot-copilot-recipient"')
    expect(drawer).toContain('@river')
    expect(drawer).toContain('#06b6d4')

    const sandboxSelect = String(await copilotRecipientSelectHtml('mupot-copilot-sandbox-recipient'))
    expect(sandboxSelect).toContain('id="mupot-copilot-sandbox-recipient"')
    expect(sandboxSelect).toContain('@river')
    expect(sandboxSelect).toContain('Council Lead & Continuity')

    const sandbox = String(
      await projectLivePreviewSplitHtml({
        project: {
          id: 'project-worker-alpha',
          name: 'Worker Alpha',
          slug: 'worker-alpha',
          repo_url: 'https://github.com/Mumega-com/mupot',
          live_url: null,
          worker_name: 'worker-alpha',
          deploy_status: 'idle',
        },
      }),
    )
    expect(sandbox).toContain('@river')
    expect(sandbox).toContain('mupot-copilot-sandbox-recipient')
  })

  it('routes POST /api/studio/chat to the River persona', async () => {
    const res = await dashboardApp.fetch(
      new Request('https://pot.test/api/studio/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://pot.test' },
        body: JSON.stringify({ message: 'Who holds continuity?', recipient: '@river' }),
      }),
      env,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Mupot-Copilot-Recipient')).toBe('river')
    const text = await res.text()
    expect(text).toContain('@river')
    expect(text).toMatch(/River|Council Lead/)
  })

  it('refreshes the warm cache from the keep-alive route', async () => {
    const res = await dashboardApp.fetch(
      new Request('https://pot.test/api/studio/chat/keepalive', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://pot.test', 'X-Mupot-Recipient': 'river' },
      }),
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { refreshed: boolean; sessionId: string }
    expect(body.refreshed).toBe(true)
    expect(body.sessionId).toContain('river')
  })
})
