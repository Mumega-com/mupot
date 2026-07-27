/**
 * COMPILE-FAIL PROBE — must NOT type-check under tsc --strict.
 * Proves VerifiedReceiptRef is unforgeable without the module-private unique symbol.
 * Invoked by the contract suite; do not import from production code.
 */
import {
  mayDistillFromReceiptRef,
  type VerifiedReceiptRef,
} from '../../src/brain/learning-ranker-contract'

const forged: VerifiedReceiptRef = {
  receiptId: 'attacker-fabricated-id-1',
  sourceKind: 'fabrication_receipt',
  store: 'frc',
  projectId: 'p1',
  resolvedAt: '2026-07-27T12:00:00.000Z',
  sanitizedContent: 'totally fabricated, never touched a resolver',
  corroboratingReceipts: [
    {
      receiptId: 'r1',
      agentId: 'a1',
      incidentId: 'i1',
      resolvedAt: '2026-07-27T12:00:00.000Z',
    },
    {
      receiptId: 'r2',
      agentId: 'a2',
      incidentId: 'i2',
      resolvedAt: '2026-07-27T12:00:00.000Z',
    },
  ],
}

mayDistillFromReceiptRef(forged)
