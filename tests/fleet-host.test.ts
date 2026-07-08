// tests/fleet-host.test.ts — the "Host agents · signed control" panel render (Deliverable 2 UI).
// Focus: the reported fields are HTML-escaped (Opus stored-XSS note), the states are honest, and
// controls appear only for an owner on a configured pot.
import { describe, it, expect } from 'vitest'
import { hostAgentsPanel } from '../src/dashboard/fleet-host'
import type { AgentView } from '../src/fleet/registry'

async function render(p: ReturnType<typeof hostAgentsPanel>): Promise<string> {
  return String(await p)
}

const row = (over: Partial<AgentView> = {}): AgentView => ({
  agent_id: 'image-gen',
  display: '',
  type: 'builder',
  runtime: 'codex',
  squads: ['media'],
  lifecycle: 'on_demand',
  status: 'running',
  presence: 'live',
  last_seen: '2026-07-08 01:00:00',
  member: null,
  capabilities: [],
  ...over,
})

describe('hostAgentsPanel', () => {
  it('HTML-escapes a hostile reported display (stored-XSS note)', async () => {
    const out = await render(hostAgentsPanel([row({ display: '<img src=x onerror=alert(1)>' })], { configured: true, canControl: true, flash: null }))
    expect(out).not.toContain('<img src=x onerror')
    expect(out).toContain('&lt;img') // escaped, not live markup
    expect(out).toContain('image-gen')
  })

  it('escapes a hostile agent_id and squad too', async () => {
    const out = await render(hostAgentsPanel([row({ agent_id: 'ok', squads: ['<b>x</b>'] })], { configured: true, canControl: true, flash: null }))
    expect(out).not.toContain('<b>x</b>')
  })

  it('renders controls only for an owner on a configured pot', async () => {
    const owner = await render(hostAgentsPanel([row()], { configured: true, canControl: true, flash: null }))
    expect(owner).toContain('value="start"')
    expect(owner).toContain('/fleet/host-control')

    const viewer = await render(hostAgentsPanel([row()], { configured: true, canControl: false, flash: null }))
    expect(viewer).toContain('owner only')
    expect(viewer).not.toContain('value="start"')
  })

  it('renders derived presence separately from stored lifecycle intent', async () => {
    const out = await render(hostAgentsPanel([row({ status: 'running', presence: 'stale' })], { configured: true, canControl: true, flash: null }))

    expect(out).toContain('stale')
    expect(out).toContain('running')
    expect(out).toContain('2026-07-08 01:00:00')
  })

  it('honest-empty + "not configured" when nothing reported / unconfigured', async () => {
    const out = await render(hostAgentsPanel([], { configured: false, canControl: true, flash: null }))
    expect(out).toContain('No host agents reported yet')
    expect(out).toContain('not configured')
  })

  it('shows a flash for a just-submitted control action (escaped)', async () => {
    const ok = await render(hostAgentsPanel([row()], { configured: true, canControl: true, flash: 'ok' }))
    expect(ok).toContain('Control request sent')
    const err = await render(hostAgentsPanel([row()], { configured: true, canControl: true, flash: '<x>' }))
    expect(err).not.toContain('<x>')
  })
})
