import { describe, expect, it } from 'vitest'
import {
  renderAgentConnectionEntry,
  renderAgentConnectionReceipt,
  renderAgentConnectionWizard,
} from '../src/dashboard/agent-connection-wizard'
import type { AgentConnectionPublicStatus } from '../src/members/agent-connection-status'

const STATUS: AgentConnectionPublicStatus = {
  receipt_id: 'receipt-1',
  request_id: 'request-1',
  issuance: {
    agent: {
      id: 'agent-1',
      slug: 'agent',
      status_at_issue: 'active',
      disposition: 'created',
    },
    credential_action: 'issue_if_missing',
    home_squad_id: 'squad-home',
    home_capability: 'member',
    additional_access: [{ squadId: 'squad-extra', capability: 'lead' }],
    token_label: 'Codex',
    token_id_suffix: 'abcd',
    endpoint: 'https://pot.example/mcp',
    transport: 'streamable_http',
    credential_issued_at: '2026-07-24T12:00:00.000Z',
  },
  verification: {
    status: 'pending',
    attempts: 0,
    client_connected_at: null,
    messaging_verified_at: null,
    error_code: null,
    checks: {},
  },
  current: {
    agent_status: 'active',
    token_revoked: false,
    access: [{
      squad_id: 'squad-home',
      membership_capability: 'member',
      member_capability: 'member',
      synchronized: true,
    }],
  },
  updated_at: '2026-07-24T12:00:00.000Z',
}

describe('agent connection wizard rendering', () => {
  it('promotes one guided entry instead of a create-only form', () => {
    const entry = renderAgentConnectionEntry(true, true)
    expect(entry).toContain('href="/agents/connect"')
    expect(entry).toContain('Create or connect agent')
    expect(entry).not.toContain('<form')
    expect(renderAgentConnectionEntry(false, true)).toBe('')
  })

  it('renders the five guided steps and keeps show-once values out of durable storage APIs', () => {
    const page = renderAgentConnectionWizard('Mupot', [{
      id: 'squad-home',
      name: 'Home',
      department_name: 'Department',
      ceiling: 'owner',
    }])
    expect(page).toContain('1 · Agent')
    expect(page).toContain('2 · Access')
    expect(page).toContain('3 · Credential')
    expect(page).toContain('4 · Connect')
    expect(page).toContain('5 · Verify')
    expect(page).toContain('crypto.randomUUID')
    expect(page).not.toContain('localStorage')
    expect(page).not.toContain('sessionStorage')
    expect(page).not.toContain('history.pushState')
    expect(page).not.toContain('history.replaceState')
    expect(page).not.toContain('indexedDB')
    expect(page).not.toContain('caches.open')
  })

  it('renders issuance separately from current state and polls only the same-origin status route', () => {
    const page = renderAgentConnectionReceipt('Mupot', STATUS)
    expect(page).toContain('Issuance record')
    expect(page).toContain('Current state')
    expect(page).toContain('/api/agent-connections/')
    expect(page).toContain('encodeURIComponent')
    expect(page).toContain("['pass', 'fail', 'expired']")
    expect(page).not.toContain('<MEMBER_TOKEN>')
    expect(page).not.toContain('verification_challenge')
  })
})
