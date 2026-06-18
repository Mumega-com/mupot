// tests/kernel-no-approval-export.test.ts — BLOCK-1 structural-close guard.
//
// The department kernel must expose NO in-process approval seam. Approval is a row
// in task_verdicts, written ONLY by the authenticated verdict route (writeVerdict ←
// POST /api/tasks/:id/verdict, RBAC-gated on gate_owner) and read by executor.execute
// via handle.db. If a future change re-introduces an importable approval function
// (the relocated `_kernelApproveForTest` seam Opus flagged), a hostile/future
// collector could `import { … } from '../kernel'` and self-approve its own proposal,
// bypassing the human gate. This test fails the build if any such export returns.

import { describe, it, expect } from 'vitest'
import * as kernel from '../src/departments/kernel'

describe('kernel exports — no approval seam (BLOCK-1 guard)', () => {
  it('exports nothing whose name matches /approve/i', () => {
    const offenders = Object.keys(kernel as Record<string, unknown>).filter((k) =>
      /approve/i.test(k),
    )
    expect(offenders).toEqual([])
  })

  it('does not export the old _kernelApproveForTest seam', () => {
    expect((kernel as Record<string, unknown>)['_kernelApproveForTest']).toBeUndefined()
  })

  it('exports no callable whose name suggests recording/granting approval', () => {
    const suspicious = Object.entries(kernel as Record<string, unknown>)
      .filter(([k, v]) => typeof v === 'function' && /(approve|grant|verdict|recordApproval)/i.test(k))
      .map(([k]) => k)
    expect(suspicious).toEqual([])
  })
})
