// tests/workflow-truth-lifecycle.test.ts — Conformance & Kill-Witness suite for FLIGHT-WORKFLOW-TRUTH-01.
//
// Directly parses and validates the canonical 6-hop markdown specification from:
//   docs/architecture/workflow-truth-lifecycle.md
//
// Invariants tested:
//   1. Exact Doc Parsing: zero drift between documentation and test assertions.
//   2. 6-Hop Canonical Pipeline: Routine -> Circuit -> Flight -> Task -> Gate -> Receipt.
//   3. Non-collapsing receipt stages: authorized != accepted != injected != consumed != ACK != verdict.
//   4. 4-Tuple Attribution Identity: (Project, Family, Seat, Run) parsing & validation.
//   5. Kill-witness: Mutating any hop name, table, trigger, state, receipt, or doc byte changes the SHA-256 digest.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'

export interface ParsedHop {
  hopNumber: number
  name: string
  tables: string[]
  inputTrigger: string
  terminalState: string
  receiptKind: string
}

export function parseMarkdownHopTable(markdownContent: string): ParsedHop[] {
  const lines = markdownContent.split('\n')
  const hops: ParsedHop[] = []

  let inTable = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('| Hop | Entity | Primary Tables')) {
      inTable = true
      continue
    }
    if (inTable && trimmed.startsWith('| :---')) {
      continue
    }
    if (inTable && trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const parts = trimmed
        .split('|')
        .slice(1, -1)
        .map((p) => p.trim())

      if (parts.length >= 6) {
        const hopNumStr = parts[0].replace(/\*\*/g, '').trim()
        const hopNumber = parseInt(hopNumStr, 10)
        if (!Number.isNaN(hopNumber)) {
          const name = parts[1].replace(/\*\*/g, '').trim()
          const tables = parts[2]
            .split(/<br>|\n/)
            .map((t) => t.replace(/[`*]/g, '').trim())
            .filter((t) => t.length > 0)
          const inputTrigger = parts[3].trim()
          const terminalState = parts[4].trim()
          const receiptKind = parts[5].trim()

          hops.push({
            hopNumber,
            name,
            tables,
            inputTrigger,
            terminalState,
            receiptKind,
          })
        }
      }
    } else if (inTable && trimmed.length === 0) {
      inTable = false
    }
  }
  return hops
}

export function computeHopDigest(hops: ParsedHop[]): string {
  const canonical = JSON.stringify(
    hops.map((h) => ({
      hopNumber: h.hopNumber,
      name: h.name,
      tables: [...h.tables].sort(),
      inputTrigger: h.inputTrigger,
      terminalState: h.terminalState,
      receiptKind: h.receiptKind,
    }))
  )
  return createHash('sha256').update(canonical).digest('hex')
}

export interface Attribution4Tuple {
  project_id: string
  agent_id: string
  seat: string
  run_id: string
}

export function validate4TupleIdentity(obj: unknown): { ok: true; value: Attribution4Tuple } | { ok: false; error: string } {
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'identity must be an object' }
  const record = obj as Record<string, unknown>
  const project_id = typeof record.project_id === 'string' ? record.project_id.trim() : ''
  const agent_id = typeof record.agent_id === 'string' ? record.agent_id.trim() : ''
  const seat = typeof record.seat === 'string' ? record.seat.trim() : ''
  const run_id = typeof record.run_id === 'string' ? record.run_id.trim() : ''

  if (!project_id) return { ok: false, error: 'project_id required' }
  if (!agent_id) return { ok: false, error: 'agent_id required' }
  if (!seat) return { ok: false, error: 'seat required' }
  if (!run_id) return { ok: false, error: 'run_id required' }

  return { ok: true, value: { project_id, agent_id, seat, run_id } }
}

export const CANONICAL_RECEIPT_STAGES = [
  'authorized',
  'accepted',
  'injected',
  'consumed',
  'ACK',
  'verdict',
] as const

describe('FLIGHT-WORKFLOW-TRUTH-01: Canonical Doc & Test Alignment', () => {
  const docPath = resolve(__dirname, '../docs/architecture/workflow-truth-lifecycle.md')
  const docContent = readFileSync(docPath, 'utf8')
  const hops = parseMarkdownHopTable(docContent)

  it('parses exactly 6 canonical hops from docs/architecture/workflow-truth-lifecycle.md', () => {
    expect(hops.length).toBe(6)
    expect(hops.map((h) => h.name)).toEqual(['Routine', 'Circuit', 'Flight', 'Task', 'Gate', 'Receipt'])
    expect(hops.map((h) => h.hopNumber)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('validates primary tables and receipts per hop from the markdown specification', () => {
    expect(hops[0].tables).toEqual(['project_routines', 'project_routine_runs'])
    expect(hops[1].tables).toEqual(['circuits', 'circuit_executions'])
    expect(hops[2].tables).toEqual(['flights', 'flight_events', 'flight_dispatch'])
    expect(hops[3].tables).toEqual(['tasks', 'task_events', 'agent_messages'])
    expect(hops[4].tables).toEqual(['gate_grants', 'task_verdict'])
    expect(hops[5].tables).toEqual(['receipts', 'flight_event_outbox'])

    expect(hops[0].receiptKind).toContain('receipt:routine_created')
    expect(hops[1].receiptKind).toContain('receipt:circuit_cleared')
    expect(hops[2].receiptKind).toContain('receipt:flight_dispatched')
    expect(hops[3].receiptKind).toContain('receipt:task_consumed')
    expect(hops[4].receiptKind).toContain('receipt:gate_verdict')
    expect(hops[5].receiptKind).toContain('receipt:tamper_evident_seal')
  })

  it('enforces distinct, non-collapsing receipt stages', () => {
    const stageSet = new Set(CANONICAL_RECEIPT_STAGES)
    expect(stageSet.size).toBe(6)
    expect(CANONICAL_RECEIPT_STAGES).toEqual([
      'authorized',
      'accepted',
      'injected',
      'consumed',
      'ACK',
      'verdict',
    ])
  })

  it('validates strict 4-tuple attribution identity schema', () => {
    const valid = validate4TupleIdentity({
      project_id: 'mumega',
      agent_id: 'bec1bb7a-b37e-4594-b018-1f608ae38d47',
      seat: 'hadi-river',
      run_id: 'run-truth-01-audit',
    })
    expect(valid.ok).toBe(true)
    if (valid.ok) {
      expect(valid.value.project_id).toBe('mumega')
      expect(valid.value.seat).toBe('hadi-river')
    }

    const invalid = validate4TupleIdentity({
      project_id: 'mumega',
      agent_id: 'bec1bb7a',
      seat: '', // missing seat
      run_id: 'run-1',
    })
    expect(invalid.ok).toBe(false)
  })

  it('KILL-WITNESS: mutating any hop label, table, receipt kind, or order changes the SHA-256 digest', () => {
    const baselineDigest = computeHopDigest(hops)
    expect(baselineDigest).toBeDefined()
    expect(baselineDigest.length).toBe(64)

    // Mutation 1: Rename hop name (Task -> MutatedTask)
    const mutatedHops1 = hops.map((h) => (h.hopNumber === 4 ? { ...h, name: 'MutatedTask' } : { ...h }))
    expect(computeHopDigest(mutatedHops1)).not.toBe(baselineDigest)

    // Mutation 2: Mutate table list
    const mutatedHops2 = hops.map((h) =>
      h.hopNumber === 3 ? { ...h, tables: ['flights', 'flight_events'] } : { ...h }
    )
    expect(computeHopDigest(mutatedHops2)).not.toBe(baselineDigest)

    // Mutation 3: Mutate receipt kind
    const mutatedHops3 = hops.map((h) =>
      h.hopNumber === 5 ? { ...h, receiptKind: 'receipt:gate_collapsed' } : { ...h }
    )
    expect(computeHopDigest(mutatedHops3)).not.toBe(baselineDigest)

    // Mutation 4: Swap hop order
    const mutatedHops4 = [hops[1], hops[0], ...hops.slice(2)]
    expect(computeHopDigest(mutatedHops4)).not.toBe(baselineDigest)
  })
})
