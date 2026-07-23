// Poll / SSE completion listener — required for Claude Managed Agents (no webhook)
// and as Cursor Cloud Agents v1 fallback while webhooks are "coming soon" on v1.

import type { CompletionEvent, TerminalStatus, VendorKind } from './types'

export interface PollStatusSnapshot {
  id: string
  status: string
  summary: string | null
  branchName: string | null
  prUrl: string | null
  raw: unknown
}

export type PollOutcome =
  | { done: true; event: CompletionEvent }
  | { done: false; status: string }

const CURSOR_TERMINAL = new Set(['FINISHED', 'ERROR', 'FINISHED'.toLowerCase(), 'ERROR'.toLowerCase()])
const CMA_TERMINAL = new Set(['completed', 'failed', 'error', 'ended', 'FINISHED', 'ERROR'])

function normalizeTerminal(status: string): TerminalStatus | null {
  const upper = status.toUpperCase()
  if (upper === 'FINISHED' || upper === 'COMPLETED' || upper === 'ENDED') return 'FINISHED'
  if (upper === 'ERROR' || upper === 'FAILED') return 'ERROR'
  return null
}

export function interpretPollSnapshot(
  vendor: VendorKind,
  snapshot: PollStatusSnapshot,
): PollOutcome {
  const terminal = normalizeTerminal(snapshot.status)
  const known =
    vendor === 'cursor-background'
      ? CURSOR_TERMINAL.has(snapshot.status) || CURSOR_TERMINAL.has(snapshot.status.toUpperCase())
      : CMA_TERMINAL.has(snapshot.status) || CMA_TERMINAL.has(snapshot.status.toLowerCase())
  if (!known || terminal === null) {
    return { done: false, status: snapshot.status }
  }
  return {
    done: true,
    event: {
      vendor,
      vendorRunId: snapshot.id,
      status: terminal,
      summary: snapshot.summary,
      branchName: snapshot.branchName,
      prUrl: snapshot.prUrl,
      raw: snapshot.raw,
    },
  }
}

/**
 * Parse a single SSE `data:` JSON line from Cursor run stream or CMA session stream.
 * Returns null for heartbeats / non-terminal progress frames.
 */
export function parseSseDataLine(
  vendor: VendorKind,
  dataLine: string,
): PollOutcome | null {
  const trimmed = dataLine.trim()
  if (!trimmed || trimmed === '[DONE]') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new Error('sse_data_not_json')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('sse_data_not_object')
  }
  const obj = parsed as Record<string, unknown>
  const id =
    typeof obj.id === 'string'
      ? obj.id
      : typeof obj.session_id === 'string'
        ? obj.session_id
        : typeof obj.agent_id === 'string'
          ? obj.agent_id
          : null
  const status =
    typeof obj.status === 'string'
      ? obj.status
      : typeof obj.type === 'string' && obj.type === 'status'
        ? String(obj.status ?? '')
        : null
  if (id === null || status === null || status.length === 0) {
    return null
  }
  const summary = typeof obj.summary === 'string' ? obj.summary : null
  const target = obj.target as { branchName?: string; prUrl?: string } | undefined
  return interpretPollSnapshot(vendor, {
    id,
    status,
    summary,
    branchName: typeof target?.branchName === 'string' ? target.branchName : null,
    prUrl: typeof target?.prUrl === 'string' ? target.prUrl : null,
    raw: parsed,
  })
}

/** Extract `data:` payloads from an SSE text chunk (may contain multiple events). */
export function extractSseDataPayloads(chunk: string): string[] {
  const out: string[] = []
  for (const line of chunk.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      out.push(line.slice('data:'.length).trimStart())
    }
  }
  return out
}

export async function pollUntilComplete(
  vendor: VendorKind,
  fetchSnapshot: () => Promise<PollStatusSnapshot>,
  pollIntervalMs: number,
  timeoutMs: number,
  sleepFn: (ms: number) => Promise<void>,
): Promise<CompletionEvent> {
  const started = Date.now()
  while (true) {
    const snapshot = await fetchSnapshot()
    const outcome = interpretPollSnapshot(vendor, snapshot)
    if (outcome.done) return outcome.event
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`poll_sse_timeout after ${timeoutMs}ms last_status=${snapshot.status}`)
    }
    await sleepFn(pollIntervalMs)
  }
}
