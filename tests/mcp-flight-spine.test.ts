import { describe, expect, it } from 'vitest'
import { TOOLS, invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'

const MEMBER_ID = 'member-flight-spine'
const AGENT_ID = 'agent-flight-spine'
const SQUAD_ID = 'squad-flight-spine'
const FLIGHT_SPINE_TOOL_NAMES = [
  'objective_accept',
  'objective_get',
  'execution_receipt_get',
  'token_binding_attest',
  'runtime_seat_register_pending',
] as const

function flightSpineTools() {
  return FLIGHT_SPINE_TOOL_NAMES.map((name) => {
    const tool = TOOLS.find((candidate) => candidate.name === name)
    expect(tool, `missing ${name}`).toBeDefined()
    return tool as NonNullable<typeof tool>
  })
}

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: MEMBER_ID,
    memberId: MEMBER_ID,
    email: 'flight-spine@example.test',
    role: 'member',
    tenant: 'tenant-flight-spine',
    channel: 'workspace',
    tokenId: 'token-flight-spine',
    boundAgentId: AGENT_ID,
    capabilities: [{
      member_id: MEMBER_ID,
      scope_type: 'squad',
      scope_id: SQUAD_ID,
      capability: 'member',
    }],
    ...overrides,
  }
}

const OBJECTIVE_ARGS = {
  squadId: SQUAD_ID,
  projectId: null,
  title: 'Bounded objective',
  successContract: 'The bounded MCP integration suite passes.',
  authorityEnvelope: { mode: 'supervised' },
  policy: { deployment: false },
  budgetMicroUsd: 0,
  payload: { task: 7 },
  idempotencyKey: 'objective-flight-spine-1',
}

describe('Flight Spine MCP tool surface', () => {
  it('registers exactly the five bounded tools once', () => {
    expect(flightSpineTools().map((tool) => tool.name)).toEqual(FLIGHT_SPINE_TOOL_NAMES)
    for (const name of FLIGHT_SPINE_TOOL_NAMES) {
      expect(TOOLS.filter((tool) => tool.name === name)).toHaveLength(1)
    }
    expect(TOOLS.map((tool) => tool.name)).not.toEqual(expect.arrayContaining([
      'runtime_seat_lease_acquire',
      'runtime_seat_lease_renew',
      'runtime_seat_lease_release',
      'runtime_process_register',
      'host_control_request',
      'decision_create',
      'decision_resolve',
      'artifact_store',
      'artifact_retrieve',
      'result_report',
      'gate_verdict',
      'flight_spine_land',
      'controller_start',
    ]))
  })

  it('publishes exact closed schemas with no caller-controlled identity or runtime facts', () => {
    const schemas = Object.fromEntries(
      flightSpineTools().map((tool) => [tool.name, tool.inputSchema]),
    )

    expect(schemas).toEqual({
      objective_accept: {
        type: 'object',
        properties: {
          squadId: { type: 'string' },
          projectId: { type: ['string', 'null'] },
          title: { type: 'string' },
          successContract: { type: 'string' },
          authorityEnvelope: { type: 'object' },
          policy: { type: 'object' },
          budgetMicroUsd: { type: 'number' },
          payload: { type: 'object' },
          idempotencyKey: { type: 'string' },
        },
        required: [
          'squadId',
          'title',
          'successContract',
          'authorityEnvelope',
          'policy',
          'budgetMicroUsd',
          'payload',
          'idempotencyKey',
        ],
        additionalProperties: false,
      },
      objective_get: {
        type: 'object',
        properties: { objectiveId: { type: 'string' } },
        required: ['objectiveId'],
        additionalProperties: false,
      },
      execution_receipt_get: {
        type: 'object',
        properties: { receiptId: { type: 'string' } },
        required: ['receiptId'],
        additionalProperties: false,
      },
      token_binding_attest: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      runtime_seat_register_pending: {
        type: 'object',
        properties: {
          seatName: { type: 'string' },
          hostId: { type: 'string' },
          adapterKind: { type: 'string' },
          attestationId: { type: 'string' },
        },
        required: ['seatName', 'hostId', 'adapterKind', 'attestationId'],
        additionalProperties: false,
      },
    })
  })

  it.each([
    ['objective_accept', { ...OBJECTIVE_ARGS, agentId: 'forged-agent' }],
    ['objective_accept', { ...OBJECTIVE_ARGS, acceptedAt: '2000-01-01T00:00:00.000Z' }],
    ['token_binding_attest', { credentialFingerprint: 'v1:caller-controlled' }],
    ['token_binding_attest', { memberId: 'forged-member' }],
    ['token_binding_attest', { channel: 'workspace' }],
    ['runtime_seat_register_pending', {
      seatName: 'codex-desktop-command',
      hostId: 'hadi-mac',
      adapterKind: 'codex-desktop',
      attestationId: 'attestation-1',
      processPublicKey: 'caller-process-key',
    }],
    ['runtime_seat_register_pending', {
      seatName: 'codex-desktop-command',
      hostId: 'hadi-mac',
      adapterKind: 'codex-desktop',
      attestationId: 'attestation-1',
      leaseTokenHash: 'a'.repeat(64),
    }],
  ])('rejects schema widening on %s', async (tool, args) => {
    const outcome = await invokeTool(auth(), {} as Env, tool, args)

    expect(outcome).toMatchObject({ ok: false, status: 400, error: 'invalid_args' })
  })

  it.each([
    ['objective_accept', OBJECTIVE_ARGS],
    ['token_binding_attest', {}],
    ['runtime_seat_register_pending', {
      seatName: 'codex-desktop-command',
      hostId: 'hadi-mac',
      adapterKind: 'codex-desktop',
      attestationId: 'attestation-1',
    }],
  ])('keeps %s off directory, consent-zero, and unbound workspace writes', async (tool, args) => {
    const directory = await invokeTool(auth({ channel: 'directory' }), {} as Env, tool, args)
    const consentZero = await invokeTool(auth({ capabilities: [] }), {} as Env, tool, args)
    const unbound = await invokeTool(auth({ boundAgentId: null }), {} as Env, tool, args)

    expect(directory).toMatchObject({
      ok: false,
      status: 403,
      error: 'agent_bound_workspace_credential_required',
    })
    expect(consentZero).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    expect(unbound).toMatchObject({
      ok: false,
      status: 403,
      error: 'agent_bound_workspace_credential_required',
    })
  })
})
