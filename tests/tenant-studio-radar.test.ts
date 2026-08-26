// tests/tenant-studio-radar.test.ts — Unit tests for Sovereign Tenant Studio UI & Agent Radar (Flight 5).

import { describe, expect, it } from 'vitest'
import {
  studioPageHtml,
  normalizeStudioModel,
  type StudioViewData,
  type StudioAgentCard,
} from '../src/dashboard/studio'
import type { FlightRow } from '../src/flight/service'

describe('Sovereign Tenant Studio UI & Agent Radar (Flight 5)', () => {
  it('normalizes studio model correctly', () => {
    expect(normalizeStudioModel('cursor-cloud')).toBe('cursor-cloud')
    expect(normalizeStudioModel('codex')).toBe('codex')
    expect(normalizeStudioModel('CODEX')).toBe('codex')
    expect(normalizeStudioModel(undefined)).toBe('cursor-cloud')
    expect(normalizeStudioModel('')).toBe('cursor-cloud')
  })

  it('renders studio HTML with tenant branding and tier badge', async () => {
    const data: StudioViewData = {
      brand: 'GAF Materials',
      tenant: 'gaf',
      tier: 'scale',
      operator: 'admin@gaf.com',
      branch: 'main',
      flights: [],
      authorityRole: 'admin',
    }

    const htmlOutput = String(await studioPageHtml(data))

    expect(htmlOutput).toContain('GAF Materials Studio')
    expect(htmlOutput).toContain('⚡ SCALE TIER')
    expect(htmlOutput).toContain('data-tenant="gaf"')
    expect(htmlOutput).toContain('[ 🛡️ Admin Authority ]')
    expect(htmlOutput).toContain('Signed in as <b>admin@gaf.com</b>')
  })

  it('renders active workforce radar cards with 7-axis telemetry', async () => {
    const agents: StudioAgentCard[] = [
      {
        id: 'gaf-business-agent',
        slug: 'gaf-business-agent',
        name: 'GAF Business Agent',
        role: 'lead',
        model: 'claude-3-7-sonnet',
        activeSeat: 'gaf-cursor-cloud',
        harness: 'cursor-cloud',
        provider: 'anthropic',
        isLive: true,
      },
      {
        id: 'gaf-warranty-triage',
        slug: 'gaf-warranty-triage',
        name: 'GAF Warranty Claims Specialist',
        role: 'member',
        model: 'claude-3-7-sonnet',
        activeSeat: 'gaf-warranty-worker',
        harness: 'routine-worker',
        provider: 'anthropic',
        isLive: false,
      },
    ]

    const data: StudioViewData = {
      brand: 'GAF Materials',
      tenant: 'gaf',
      tier: 'scale',
      operator: 'operator@gaf.com',
      branch: 'main',
      flights: [],
      agents,
      authorityRole: 'member',
    }

    const htmlOutput = String(await studioPageHtml(data))

    expect(htmlOutput).toContain('Active Workforce Radar')
    expect(htmlOutput).toContain('2 Agents')
    expect(htmlOutput).toContain('GAF Business Agent')
    expect(htmlOutput).toContain('LEAD')
    expect(htmlOutput).toContain('is-live')
    expect(htmlOutput).toContain('gaf-cursor-cloud')
    expect(htmlOutput).toContain('GAF Warranty Claims Specialist')
    expect(htmlOutput).toContain('MEMBER')
    expect(htmlOutput).toContain('is-idle')
  })

  it('renders flights list with status and goal snippets', async () => {
    const mockFlight: FlightRow = {
      id: 'flight-1234-5678-90ab',
      tenant: 'gaf',
      agent: 'gaf-business-agent',
      goal: 'Execute automated roof warranty claim triage',
      status: 'running',
      trigger_source: 'api',
      gate_verdict: null,
      gate_reason: null,
      score: null,
      budget_micro_usd: null,
      cost_micro_usd: 0,
      next_run_at: null,
      created_at: Date.now(),
      started_at: Date.now(),
      ended_at: null,
      meta: {
        schema: 'mupot.flight.meta/v1',
        goal_id: 'goal-123',
        objective_id: 'obj-123',
        squad_ids: ['squad-gaf-core'],
        task_ids: ['task-123'],
        done_when: ['Done'],
        artifact_refs: [],
        receipt_refs: [],
        confidentiality: 'internal',
        publication_target: 'none',
        parent_flight_id: null,
      },
      project_id: null,
      dispatched_by_agent_id: 'gaf-business-agent',
    }

    const data: StudioViewData = {
      brand: 'GAF Materials',
      tenant: 'gaf',
      operator: 'operator@gaf.com',
      branch: 'main',
      flights: [mockFlight],
    }

    const htmlOutput = String(await studioPageHtml(data))

    expect(htmlOutput).toContain('Execute automated roof warranty claim triage')
    expect(htmlOutput).toContain('data-status="running"')
    expect(htmlOutput).toContain('flight-1234-5678-90ab'.slice(0, 8))
  })
})
