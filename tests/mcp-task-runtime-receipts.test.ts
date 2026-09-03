import { describe, expect, it } from 'vitest'

import { TOOLS } from '../src/mcp'

describe('task_dispatch_runtime_receipt MCP contract', () => {
  it('advertises one strict receipt operation for MCP and generated REST Actions', () => {
    const tool = TOOLS.find((candidate) => candidate.name === 'task_dispatch_runtime_receipt')
    expect(tool).toBeDefined()
    expect(tool?.scope).toBe('assigned task runtime receipt')
    expect(tool?.min).toBe('member')
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        dispatch_receipt_id: { type: 'string' },
        message_id: { type: 'string' },
        stage: { type: 'string', enum: ['runtime_consumed', 'completed', 'failed'] },
        runtime_receipt_hash: { type: 'string' },
        attempt: { type: 'number' },
        artifact_refs: { type: 'array', items: { type: 'string' } },
        artifact_sha256: { type: ['string', 'null'] },
        result: { type: ['string', 'null'] },
        reason: { type: ['string', 'null'] },
      },
      required: [
        'task_id',
        'dispatch_receipt_id',
        'message_id',
        'stage',
        'runtime_receipt_hash',
        'attempt',
      ],
      additionalProperties: false,
    })
  })
})
