import { sha256Hex } from '../lib/canonical-json'

/** Stable identity shared by Routine dispatch and cancellation reconciliation. */
export async function routineControlId(kind: 'task' | 'flight', runAttemptKey: string): Promise<string> {
  const hex = await sha256Hex(`mupot:routine:${kind}:${runAttemptKey}`)
  const bytes = Array.from({ length: 16 }, (_, index) => hex.slice(index * 2, index * 2 + 2))
  bytes[6] = (((Number.parseInt(bytes[6], 16) & 0x0f) | 0x50).toString(16)).padStart(2, '0')
  bytes[8] = (((Number.parseInt(bytes[8], 16) & 0x3f) | 0x80).toString(16)).padStart(2, '0')
  const normalized = bytes.join('')
  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20)}`
}

export function routineRequestId(runId: string, attempt: number): string {
  return attempt <= 1 ? `routine-run:${runId}` : `routine-run:${runId}:attempt:${attempt}`
}
