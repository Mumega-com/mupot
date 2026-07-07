import { describe, it, expect } from 'vitest'
import {
  GITHUB_INBOUND_MAX_BODY_BYTES,
  githubInboundApp,
  verifyGitHubWebhook,
  taskFromGitHubEvent,
} from '../src/integrations/github-routes'
import type { Env } from '../src/types'

async function hmacHex(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg))
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

describe('verifyGitHubWebhook', () => {
  const body = '{"action":"opened"}'
  it('not_configured when no secret', async () => {
    expect(await verifyGitHubWebhook({} as Env, body, 'sha256=abc')).toBe('not_configured')
  })
  it('invalid when signature missing/malformed', async () => {
    const env = { GITHUB_WEBHOOK_SECRET: 's' } as unknown as Env
    expect(await verifyGitHubWebhook(env, body, null)).toBe('invalid')
    expect(await verifyGitHubWebhook(env, body, 'deadbeef')).toBe('invalid') // no sha256= prefix
  })
  it('invalid on a wrong signature', async () => {
    const env = { GITHUB_WEBHOOK_SECRET: 'secret' } as unknown as Env
    expect(await verifyGitHubWebhook(env, body, 'sha256=' + 'f'.repeat(64))).toBe('invalid')
  })
  it('ok on a correct signature', async () => {
    const env = { GITHUB_WEBHOOK_SECRET: 'secret' } as unknown as Env
    const sig = 'sha256=' + (await hmacHex('secret', body))
    expect(await verifyGitHubWebhook(env, body, sig)).toBe('ok')
  })
  it('ok is case-insensitive on the hex', async () => {
    const env = { GITHUB_WEBHOOK_SECRET: 'secret' } as unknown as Env
    const sig = 'sha256=' + (await hmacHex('secret', body)).toUpperCase()
    expect(await verifyGitHubWebhook(env, body, sig)).toBe('ok')
  })
})

describe('taskFromGitHubEvent', () => {
  const repo = { repository: { full_name: 'Digidinc/Digid' } }
  it('pull_request opened → a work unit', () => {
    const t = taskFromGitHubEvent('pull_request', { ...repo, action: 'opened', pull_request: { number: 7, title: 'Add X', html_url: 'u' } })
    expect(t?.title).toBe('[GH Digidinc/Digid] PR #7 opened: Add X')
    expect(t?.body).toContain('u')
  })
  it('pull_request closed+merged → merged', () => {
    const t = taskFromGitHubEvent('pull_request', { ...repo, action: 'closed', pull_request: { number: 8, title: 'Y', merged: true } })
    expect(t?.title).toContain('PR #8 merged: Y')
  })
  it('workflow_run completed → CI work unit', () => {
    const t = taskFromGitHubEvent('workflow_run', { ...repo, workflow_run: { name: 'CI', conclusion: 'failure', head_branch: 'main', status: 'completed' } })
    expect(t?.title).toBe('[GH Digidinc/Digid] CI failure: CI (main)')
  })
  it('workflow_run in_progress → ignored (no noise)', () => {
    expect(taskFromGitHubEvent('workflow_run', { ...repo, workflow_run: { name: 'CI', status: 'in_progress' } })).toBeNull()
  })
  it('ping (and other events) → ignored', () => {
    expect(taskFromGitHubEvent('ping', { ...repo, zen: 'hi' })).toBeNull()
  })
  it('neutralizes mention/ref/markdown in a malicious PR title (reflection defense)', () => {
    const t = taskFromGitHubEvent('pull_request', {
      ...repo,
      action: 'opened',
      pull_request: { number: 1, title: '@org/team ping #123 [x](javascript:alert)' },
    })
    expect(t?.title).not.toContain('@')
    expect(t?.title).not.toContain('#123')
    expect(t?.title).not.toContain('](')
  })
  it('caps an overlong title', () => {
    const t = taskFromGitHubEvent('pull_request', {
      ...repo,
      action: 'opened',
      pull_request: { number: 1, title: 'x'.repeat(500) },
    })
    expect((t?.title.length ?? 0)).toBeLessThanOrEqual(200)
  })
  it('sanitizes a non-numeric PR number', () => {
    const t = taskFromGitHubEvent('pull_request', { ...repo, action: 'opened', pull_request: { number: 'evil' as unknown as number, title: 'Y' } })
    expect(t?.title).toContain('PR #?')
  })
})

describe('githubInboundApp body caps', () => {
  it('oversized declared body returns 413 before signature verification', async () => {
    const req = new Request('http://localhost/', {
      method: 'POST',
      body: '{}',
      headers: {
        'content-type': 'application/json',
        'content-length': String(GITHUB_INBOUND_MAX_BODY_BYTES + 1),
      },
    })
    const res = await githubInboundApp.fetch(req, {} as Env, {} as ExecutionContext)
    expect(res.status).toBe(413)
    const json = await res.json() as { error: string }
    expect(json.error).toBe('payload_too_large')
  })

  it('oversized actual UTF-8 body returns 413 before signature verification', async () => {
    const body = 'x'.repeat(GITHUB_INBOUND_MAX_BODY_BYTES + 1)
    const req = new Request('http://localhost/', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
    })
    const res = await githubInboundApp.fetch(req, {} as Env, {} as ExecutionContext)
    expect(res.status).toBe(413)
    const json = await res.json() as { error: string }
    expect(json.error).toBe('payload_too_large')
  })
})
