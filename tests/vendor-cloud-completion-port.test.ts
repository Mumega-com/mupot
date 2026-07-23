import { describe, expect, it } from 'vitest'
import {
  createPollSseCompletionPort,
  createWebhookCompletionPort,
  landAtReviewIntent,
  selectCompletionPort,
} from '../src/runtime/vendor-cloud/completion-port'
import {
  extractSseDataPayloads,
  interpretPollSnapshot,
  parseSseDataLine,
  pollUntilComplete,
} from '../src/runtime/vendor-cloud/poll-sse-listener'
import {
  handleCursorWebhookCompletion,
  parseCursorStatusChangePayload,
} from '../src/runtime/vendor-cloud/webhook-listener'
import {
  cursorWebhookSignatureHeader,
  verifyCursorWebhookSignature,
} from '../src/runtime/vendor-cloud/webhook-signature'

describe('pluggable completion port', () => {
  it('selects webhook for Cursor when secret is set', () => {
    const port = selectCompletionPort('cursor-background', 's3cret', 1000, 60_000)
    expect(port.kind).toBe('webhook')
    expect(port.vendor).toBe('cursor-background')
  })

  it('selects poll/SSE for Cursor when secret is absent', () => {
    const port = selectCompletionPort('cursor-background', null, 1000, 60_000)
    expect(port.kind).toBe('poll_sse')
  })

  it('forces poll/SSE for Claude Managed Agents even when a secret is offered', () => {
    const port = selectCompletionPort('claude-managed', 'ignored', 500, 30_000)
    expect(port).toEqual(createPollSseCompletionPort('claude-managed', 500, 30_000))
  })

  it('refuses webhook port for CMA', () => {
    expect(() => createWebhookCompletionPort('claude-managed', 'x')).toThrow(
      'webhook_completion_only_for_cursor_background',
    )
  })

  it('lands at review and forbids merge/deploy/self_verdict', () => {
    const land = landAtReviewIntent(
      {
        vendor: 'cursor-background',
        vendorRunId: 'bc_1',
        status: 'FINISHED',
        summary: 'done',
        branchName: 'cursor/task-1',
        prUrl: null,
        raw: {},
      },
      'gate:kasra-core',
    )
    expect(land.status).toBe('review')
    expect(land.forbidden).toEqual(['merge', 'deploy', 'publish', 'self_verdict'])
  })
})

describe('Cursor HMAC webhook completion', () => {
  const secret = 'whsec_test_cursor'
  const payload = {
    event: 'statusChange',
    timestamp: '2026-07-23T15:00:00Z',
    id: 'bc_abc123',
    status: 'FINISHED',
    source: { repository: 'https://github.com/org/repo', ref: 'main' },
    target: {
      url: 'https://cursor.com/agents?id=bc_abc123',
      branchName: 'cursor/add-readme',
      prUrl: 'https://github.com/org/repo/pull/9',
    },
    summary: 'Added README',
  }
  const rawBody = JSON.stringify(payload)

  it('verifies sha256= HMAC over the raw body', async () => {
    const sig = await cursorWebhookSignatureHeader(secret, rawBody)
    expect(sig.startsWith('sha256=')).toBe(true)
    expect(await verifyCursorWebhookSignature(secret, rawBody, sig)).toBe('ok')
  })

  it('rejects missing secret (fail-closed)', async () => {
    expect(await verifyCursorWebhookSignature(null, rawBody, 'sha256=abc')).toBe('not_configured')
    expect(await verifyCursorWebhookSignature('', rawBody, 'sha256=abc')).toBe('not_configured')
  })

  it('rejects bad or missing signature', async () => {
    expect(await verifyCursorWebhookSignature(secret, rawBody, null)).toBe('invalid')
    expect(await verifyCursorWebhookSignature(secret, rawBody, 'sha256=deadbeef')).toBe('invalid')
    expect(await verifyCursorWebhookSignature(secret, rawBody, 'md5=abc')).toBe('invalid')
  })

  it('parses statusChange FINISHED/ERROR only', () => {
    const ok = parseCursorStatusChangePayload(rawBody)
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.event.vendorRunId).toBe('bc_abc123')
      expect(ok.event.status).toBe('FINISHED')
      expect(ok.event.branchName).toBe('cursor/add-readme')
      expect(ok.event.prUrl).toContain('/pull/9')
    }
    const errBody = JSON.stringify({ ...payload, status: 'ERROR', summary: 'boom' })
    const err = parseCursorStatusChangePayload(errBody)
    expect(err.ok).toBe(true)
    if (err.ok) expect(err.event.status).toBe('ERROR')

    expect(parseCursorStatusChangePayload(JSON.stringify({ ...payload, status: 'RUNNING' }))).toEqual({
      ok: false,
      error: 'not_terminal',
    })
  })

  it('handleCursorWebhookCompletion end-to-end', async () => {
    const sig = await cursorWebhookSignatureHeader(secret, rawBody)
    const result = await handleCursorWebhookCompletion(secret, rawBody, sig)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.event.status).toBe('FINISHED')

    const bad = await handleCursorWebhookCompletion(secret, rawBody, 'sha256=00')
    expect(bad).toEqual({ ok: false, error: 'unauthorized' })
  })
})

describe('poll/SSE completion path', () => {
  it('interprets Cursor FINISHED/ERROR snapshots', () => {
    const done = interpretPollSnapshot('cursor-background', {
      id: 'bc_1',
      status: 'FINISHED',
      summary: 'ok',
      branchName: 'cursor/x',
      prUrl: null,
      raw: {},
    })
    expect(done.done).toBe(true)
    if (done.done) expect(done.event.status).toBe('FINISHED')

    const running = interpretPollSnapshot('cursor-background', {
      id: 'bc_1',
      status: 'ACTIVE',
      summary: null,
      branchName: null,
      prUrl: null,
      raw: {},
    })
    expect(running).toEqual({ done: false, status: 'ACTIVE' })
  })

  it('interprets CMA completed/failed statuses', () => {
    const done = interpretPollSnapshot('claude-managed', {
      id: 'sess_1',
      status: 'completed',
      summary: null,
      branchName: null,
      prUrl: null,
      raw: {},
    })
    expect(done.done).toBe(true)
    if (done.done) expect(done.event.status).toBe('FINISHED')
  })

  it('parses SSE data lines and extracts payloads from chunks', () => {
    const chunk = 'event: status\ndata: {"id":"bc_1","status":"FINISHED","summary":"done"}\n\n'
    const payloads = extractSseDataPayloads(chunk)
    expect(payloads).toHaveLength(1)
    const outcome = parseSseDataLine('cursor-background', payloads[0]!)
    expect(outcome?.done).toBe(true)
  })

  it('pollUntilComplete resolves on terminal status', async () => {
    let n = 0
    const sleeps: number[] = []
    const event = await pollUntilComplete(
      'claude-managed',
      async () => {
        n += 1
        return {
          id: 'sess_9',
          status: n < 3 ? 'running' : 'completed',
          summary: null,
          branchName: null,
          prUrl: null,
          raw: { n },
        }
      },
      10,
      5_000,
      async (ms) => {
        sleeps.push(ms)
      },
    )
    expect(event.status).toBe('FINISHED')
    expect(event.vendorRunId).toBe('sess_9')
    expect(n).toBe(3)
    expect(sleeps.length).toBe(2)
  })
})
