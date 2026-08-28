// src/mcp/body-mint.ts — Open Body Minting & Runtime Attachment (FLIGHT ID-03 / #1168).
//
// WHY THIS EXISTS
//
// "Identity is the Name, the Body is (machine, harness, folder, thread) — mint bodies freely, gate authority only" (#1168).
// Minting a body is not a privilege grant: declaring "this runtime is river on Mac in folder X" confers no ambient authority.
// Capability remains attached to the continuum name / member identity; the body merely identifies the active hands.
//
// This tool allows any authenticated runtime to register and attach its active body tuple freely,
// recording presence and obtaining a body descriptor with generation counter without requiring admin capability.

import type { ToolSpec } from './index'
import { fail, done, str } from './index'
import type { Env, AuthContext } from '../types'
import { recordCheckin, resolveSeatLabel } from '../fleet/presence'
import { extractContinuumName } from './index'

export interface MintBodyInput {
  continuum_name: string
  machine: string
  harness: string
  folder?: string
  thread?: string
  label?: string
}

export interface MintBodyOutput {
  ok: true
  body_id: string
  continuum: string
  tuple: {
    machine: string
    harness: string
    folder: string
    thread: string
  }
  seat: string
  generation: number
  registered_at: string
}

export const toolMintBody: ToolSpec = {
  name: 'mint_body',
  scope: 'self / open (attaches a runtime body tuple to an agent continuum)',
  min: 'authenticated',
  args: '{ continuum_name: string, machine: string, harness: string, folder?: string, thread?: string, label?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      continuum_name: {
        type: 'string',
        description: 'The root continuum identity (e.g. "river", "kasra", "loom", "dara").',
      },
      machine: {
        type: 'string',
        description: 'Host machine identifier (e.g. "hadi-mac", "hetzner-ash-1", "cursor-cloud-vm").',
      },
      harness: {
        type: 'string',
        description: 'Harness kind (e.g. "cursor-cloud", "cursor-ide", "grok-cli", "claude-code", "hermes").',
      },
      folder: {
        type: 'string',
        description: 'Active project or working directory path.',
      },
      thread: {
        type: 'string',
        description: 'Thread or execution run identifier.',
      },
      label: {
        type: 'string',
        description: 'Optional custom display label for the seat.',
      },
    },
    required: ['continuum_name', 'machine', 'harness'],
    additionalProperties: false,
  },
  async run(auth: AuthContext, env: Env, args: Record<string, unknown>) {
    const rawContinuum = str(args.continuum_name)
    const machine = str(args.machine)
    const harness = str(args.harness)
    const folder = str(args.folder) || 'root'
    const thread = str(args.thread) || 'main'
    const label = str(args.label) || undefined

    if (!rawContinuum || !machine || !harness) {
      return fail(400, 'invalid_args', 'continuum_name, machine, and harness are required')
    }

    const continuum = extractContinuumName(rawContinuum)
    const principalId = auth.memberId || auth.boundAgentId || auth.userId
    if (!principalId) {
      return fail(401, 'unauthenticated', 'no valid member or agent identity')
    }

    const compositeSeat = label || `${machine}:${harness}:${folder}:${thread}`
    const bodyId = crypto.randomUUID()
    const now = new Date().toISOString()

    // Record presence with body tuple and continuum name
    try {
      await recordCheckin(env, {
        memberId: principalId,
        displayName: auth.email || continuum,
        boundAgentId: auth.boundAgentId ?? null,
      }, {
        seat: compositeSeat,
        harness,
        machine,
        folder,
        thread,
        continuum_name: continuum,
        source: harness,
      })
    } catch (err: any) {
      return fail(500, 'presence_record_failed', err?.message || String(err))
    }

    return done({
      body_id: bodyId,
      continuum,
      tuple: {
        machine,
        harness,
        folder,
        thread,
      },
      seat: compositeSeat,
      generation: 1,
      registered_at: now,
    })
  },
}
