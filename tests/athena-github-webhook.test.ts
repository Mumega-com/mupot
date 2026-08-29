import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { Env } from '../src/types'
import {
  ATHENA_GATE_STATUS_CONTEXT,
  extractAthenaPullRequest,
  formatAthenaGateComment,
  githubStatusForVerdict,
  handleAthenaGitHubWebhook,
  listAthenaGateReceipts,
  persistAthenaGateReceipt,
  verifyAthenaGitHubWebhook,
} from '../src/athena/webhook'
import { createAthenaWebhookApp } from '../src/athena/routes'
import { reviewPullRequest } from '../src/athena/reviewer'
import { athenaGateReceiptsBody } from '../src/dashboard/verifications'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const CLEAN_DIFF = `diff --git a/src/greet.ts b/src/greet.ts
--- a/src/greet.ts
+++ b/src/greet.ts
@@ -1,3 +1,4 @@
+export const token = process.env.API_TOKEN
 export function greet(name: string) {
   return 'hi ' + name
 }
diff --git a/tests/greet.test.ts b/tests/greet.test.ts
--- /dev/null
+++ b/tests/greet.test.ts
@@ -0,0 +1,6 @@
+import { greet } from '../src/greet'
+import { expect, it } from 'vitest'
+it('greets', () => {
+  expect(greet('ada')).toBe('hi ada')
+})
`

const SYNTHETIC_OPENAI_KEY = ['sk', 'abcdefghijklmnopqrstuvwxyz123456'].join('-')

const SECRET_DIFF = `diff --git a/src/client.ts b/src/client.ts
--- a/src/client.ts
+++ b/src/client.ts
@@ -1,2 +1,3 @@
+const API_KEY = "${SYNTHETIC_OPENAI_KEY}"
 export const url = 'https://api.example.com'
`

const WEBHOOK_SECRET = 'athena-webhook-secret'
const GITHUB_TOKEN = 'test-github-token'

async function hmacHex(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg))
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function prPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'opened',
    pull_request: {
      number: 42,
      title: 'Greet helper',
      body: 'adds greet',
      html_url: 'https://github.com/Mumega-com/mupot/pull/42',
      user: { login: 'ada' },
      head: { sha: 'abc123def4567890' },
      diff: CLEAN_DIFF,
      files: [
        { path: 'src/greet.ts', status: 'modified' },
        { path: 'tests/greet.test.ts', status: 'added' },
      ],
    },
    repository: {
      full_name: 'Mumega-com/mupot',
      name: 'mupot',
      owner: { login: 'Mumega-com' },
    },
    ...overrides,
  }
}

function makeEnv(harness: SqliteD1Harness, extra: Partial<Env> = {}): Env {
  return {
    TENANT_SLUG: 'test',
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    DB: harness.db,
    ...extra,
  } as unknown as Env
}

async function signedRequest(
  body: string,
  headers: Record<string, string> = {},
  secret = WEBHOOK_SECRET,
): Promise<Request> {
  return new Request('https://pot.test/api/webhooks/github', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-hub-signature-256': `sha256=${await hmacHex(secret, body)}`,
      ...headers,
    },
    body,
  })
}

describe('verifyAthenaGitHubWebhook', () => {
  const body = '{"action":"opened"}'

  it('rejects a forged HMAC signature', async () => {
    const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET } as unknown as Env
    expect(await verifyAthenaGitHubWebhook(env, body, 'sha256=' + 'a'.repeat(64))).toBe('invalid')
    expect(await verifyAthenaGitHubWebhook(env, body, null)).toBe('invalid')
    expect(await verifyAthenaGitHubWebhook(env, body, 'deadbeef')).toBe('invalid')
  })

  it('accepts a correct HMAC signature', async () => {
    const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET } as unknown as Env
    const sig = `sha256=${await hmacHex(WEBHOOK_SECRET, body)}`
    expect(await verifyAthenaGitHubWebhook(env, body, sig)).toBe('ok')
  })

  it('fail-safe bearer path when HMAC secret is unset', async () => {
    const env = { GITHUB_TOKEN: GITHUB_TOKEN } as unknown as Env
    expect(await verifyAthenaGitHubWebhook(env, body, null, `Bearer ${GITHUB_TOKEN}`)).toBe('ok')
    expect(await verifyAthenaGitHubWebhook(env, body, null, 'Bearer wrong-token')).toBe('invalid')
    expect(await verifyAthenaGitHubWebhook(env, body, null, null)).toBe('invalid')
  })

  it('is not_configured when neither HMAC secret nor token is bound', async () => {
    expect(await verifyAthenaGitHubWebhook({} as Env, body, 'sha256=abc')).toBe('not_configured')
  })

  it('does not let a bearer bypass a configured HMAC secret', async () => {
    const env = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, GITHUB_TOKEN: GITHUB_TOKEN } as unknown as Env
    expect(await verifyAthenaGitHubWebhook(env, body, null, `Bearer ${GITHUB_TOKEN}`)).toBe('invalid')
  })
})

describe('extractAthenaPullRequest + comment format', () => {
  it('extracts PR number, repo, head SHA, author, and changed files', () => {
    const event = extractAthenaPullRequest('pull_request', prPayload())
    expect(event).toMatchObject({
      action: 'opened',
      repo: 'Mumega-com/mupot',
      owner: 'Mumega-com',
      name: 'mupot',
      prNumber: 42,
      commitSha: 'abc123def4567890',
      author: 'ada',
      title: 'Greet helper',
    })
    expect(event?.files.map((file) => file.path)).toEqual(['src/greet.ts', 'tests/greet.test.ts'])
    expect(event?.diff).toContain('src/greet.ts')
  })

  it('ignores non-gate pull_request actions and other events', () => {
    expect(extractAthenaPullRequest('ping', prPayload())).toBeNull()
    expect(extractAthenaPullRequest('pull_request', prPayload({ action: 'closed' }))).toBeNull()
    expect(extractAthenaPullRequest('pull_request', prPayload({ action: 'edited' }))).toBeNull()
  })

  it('formats the Markdown gate-audit receipt with badges', () => {
    const review = reviewPullRequest({
      title: 'Greet helper',
      diff: CLEAN_DIFF,
      files: [
        { path: 'src/greet.ts' },
        { path: 'tests/greet.test.ts' },
      ],
    })
    const markdown = formatAthenaGateComment(review, {
      repo: 'Mumega-com/mupot',
      prNumber: 42,
      commitSha: 'abc123def4567890',
      author: 'ada',
      title: 'Greet helper',
      files: [
        { path: 'src/greet.ts' },
        { path: 'tests/greet.test.ts' },
      ],
    })
    expect(markdown).toContain('### 🛡️ Athena Gate Verdict: [ APPROVED ]')
    expect(markdown).toMatch(/✅ \*\*No hardcoded secrets\*\*/)
    expect(markdown).toMatch(/✅ \*\*Verified unit tests\*\*/)
    expect(markdown).toMatch(/✅ \*\*RBAC compliance\*\*/)
    expect(markdown).toMatch(/✅ \*\*Schema backward-compatibility\*\*/)
    expect(markdown).toContain('Mumega-com/mupot')
    expect(markdown).toContain('#42')
    expect(githubStatusForVerdict('APPROVED')).toMatchObject({ state: 'success' })
    expect(githubStatusForVerdict('BLOCKED')).toMatchObject({ state: 'failure' })
    expect(githubStatusForVerdict('CHANGES_REQUESTED')).toMatchObject({ state: 'failure' })
  })

  it('uses blocker / warning badges on a failing review', () => {
    const review = reviewPullRequest({ title: 'Leak', diff: SECRET_DIFF })
    const markdown = formatAthenaGateComment(review, {
      repo: 'Mumega-com/mupot',
      prNumber: 7,
      commitSha: 'deadbeefcafebabe',
      author: 'mallory',
      title: 'Leak',
      files: [{ path: 'src/client.ts' }],
    })
    expect(markdown).toContain('### 🛡️ Athena Gate Verdict: [ BLOCKED ]')
    expect(markdown).toMatch(/🚫 \*\*No hardcoded secrets\*\*/)
  })
})

describe('POST /api/webhooks/github', () => {
  let harness: SqliteD1Harness

  afterEach(() => {
    harness?.close()
  })

  function setup() {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    return harness
  }

  it('rejects a forged payload before review or D1 write', async () => {
    setup()
    const env = makeEnv(harness)
    const body = JSON.stringify(prPayload())
    const result = await handleAthenaGitHubWebhook(
      env,
      await signedRequest(body, {}, 'wrong-secret'),
    )
    expect(result.status).toBe(401)
    expect(result.body).toEqual({ error: 'unauthorized' })
    expect(await listAthenaGateReceipts(env)).toEqual([])
  })

  it('returns 503 when no verification secret is configured', async () => {
    setup()
    const env = makeEnv(harness, { GITHUB_WEBHOOK_SECRET: undefined, GITHUB_TOKEN: undefined })
    const result = await handleAthenaGitHubWebhook(
      env,
      new Request('https://pot.test/api/webhooks/github', {
        method: 'POST',
        headers: { 'x-github-event': 'pull_request' },
        body: JSON.stringify(prPayload()),
      }),
    )
    expect(result.status).toBe(503)
    expect(result.body).toEqual({ error: 'not_configured' })
  })

  it('pull_request.opened runs reviewPullRequest and logs an immutable receipt', async () => {
    setup()
    const env = makeEnv(harness)
    const body = JSON.stringify(prPayload())
    const result = await handleAthenaGitHubWebhook(env, await signedRequest(body), {
      id: () => 'receipt-opened',
      now: () => '2026-08-26T12:00:00.000Z',
    })

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      ok: true,
      verdict: 'APPROVED',
      receipt_id: 'receipt-opened',
      duplicate: false,
      repo: 'Mumega-com/mupot',
      pr_number: 42,
      commit_sha: 'abc123def4567890',
      author: 'ada',
    })
    expect(result.body.comment).toContain('### 🛡️ Athena Gate Verdict: [ APPROVED ]')
    expect(result.body.files).toEqual(['src/greet.ts', 'tests/greet.test.ts'])

    const expected = reviewPullRequest({
      title: 'Greet helper',
      body: 'adds greet',
      diff: CLEAN_DIFF,
      files: [
        { path: 'src/greet.ts', status: 'modified' },
        { path: 'tests/greet.test.ts', status: 'added' },
      ],
      prUrl: 'https://github.com/Mumega-com/mupot/pull/42',
    })
    expect(result.body.verdict).toBe(expected.verdict)
    expect(result.body.summary).toBe(expected.summary)

    const receipts = await listAthenaGateReceipts(env)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      id: 'receipt-opened',
      repo: 'Mumega-com/mupot',
      pr_number: 42,
      commit_sha: 'abc123def4567890',
      verdict: 'APPROVED',
    })
    const checks = JSON.parse(receipts[0]!.checks_json) as Array<{ id: string; passed: boolean }>
    expect(checks.map((check) => check.id)).toEqual([
      'no_hardcoded_secrets',
      'verified_unit_tests',
      'rbac_compliance',
      'schema_backward_compatibility',
    ])
    expect(checks.every((check) => check.passed)).toBe(true)
  })

  it('posts the review comment and athena/gate status when GITHUB_TOKEN is bound', async () => {
    setup()
    const env = makeEnv(harness, { GITHUB_TOKEN })
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null })
      return new Response(JSON.stringify({ ok: true }), { status: 201 })
    }

    const result = await handleAthenaGitHubWebhook(
      env,
      await signedRequest(JSON.stringify(prPayload())),
      { fetchImpl, id: () => 'receipt-posted' },
    )

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ commented: true, status_set: true })
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'POST',
        url: 'https://api.github.com/repos/Mumega-com/mupot/issues/42/comments',
      }),
      expect.objectContaining({
        method: 'POST',
        url: 'https://api.github.com/repos/Mumega-com/mupot/statuses/abc123def4567890',
      }),
    ]))
    const commentCall = calls.find((call) => call.url.endsWith('/comments'))
    expect((commentCall?.body as { body: string }).body).toContain('### 🛡️ Athena Gate Verdict: [ APPROVED ]')
    const statusCall = calls.find((call) => call.url.includes('/statuses/'))
    expect(statusCall?.body).toMatchObject({
      state: 'success',
      context: ATHENA_GATE_STATUS_CONTEXT,
    })
  })

  it('does not post to GitHub when GITHUB_TOKEN is absent', async () => {
    setup()
    const env = makeEnv(harness)
    let fetches = 0
    const result = await handleAthenaGitHubWebhook(
      env,
      await signedRequest(JSON.stringify(prPayload())),
      { fetchImpl: async () => { fetches += 1; return new Response('no', { status: 500 }) } },
    )
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ commented: false, status_set: false, verdict: 'APPROVED' })
    expect(fetches).toBe(0)
    expect(await listAthenaGateReceipts(env)).toHaveLength(1)
  })

  it('acknowledges ping / non-gate events without writing a receipt', async () => {
    setup()
    const env = makeEnv(harness)
    const ping = await handleAthenaGitHubWebhook(
      env,
      await signedRequest('{"zen":"keep it logically awesome"}', { 'x-github-event': 'ping' }),
    )
    expect(ping).toEqual({ status: 200, body: { ok: true, ignored: 'ping' } })
    expect(await listAthenaGateReceipts(env)).toEqual([])
  })

  it('Hono route rejects forged signatures and accepts a signed opened event', async () => {
    setup()
    const env = makeEnv(harness)
    const app = createAthenaWebhookApp({ id: () => 'receipt-hono' })
    const body = JSON.stringify(prPayload())
    // The sub-app is mounted at /api/webhooks/github in src/index.ts, so its
    // own route table is POST /. Isolated fetch must use that path.
    const toApp = async (secret: string) => {
      const signed = await signedRequest(body, {}, secret)
      return new Request('https://pot.test/', {
        method: 'POST',
        headers: signed.headers,
        body,
      })
    }

    const forged = await app.fetch(await toApp('forged'), env, {} as ExecutionContext)
    expect(forged.status).toBe(401)

    const ok = await app.fetch(await toApp(WEBHOOK_SECRET), env, {} as ExecutionContext)
    expect(ok.status).toBe(200)
    const json = await ok.json() as { verdict: string; receipt_id: string }
    expect(json).toMatchObject({ verdict: 'APPROVED', receipt_id: 'receipt-hono' })
  })

  it('refuses UPDATE/DELETE on athena_gate_receipts', async () => {
    setup()
    const env = makeEnv(harness)
    await persistAthenaGateReceipt(env, {
      id: 'receipt-lock',
      repo: 'Mumega-com/mupot',
      pr_number: 1,
      commit_sha: 'abcdef1234567',
      verdict: 'APPROVED',
      checks_json: '[]',
      summary: 'ok',
      created_at: '2026-08-26T12:00:00.000Z',
    })

    await expect(
      env.DB.prepare(`UPDATE athena_gate_receipts SET summary = 'mutated' WHERE id = 'receipt-lock'`).run(),
    ).rejects.toThrow(/immutable/i)
    await expect(
      env.DB.prepare(`DELETE FROM athena_gate_receipts WHERE id = 'receipt-lock'`).run(),
    ).rejects.toThrow(/immutable/i)
  })

  it('dedupes the same repo/PR/SHA so a GitHub retry does not mint a second receipt', async () => {
    setup()
    const env = makeEnv(harness)
    const req = () => signedRequest(JSON.stringify(prPayload()))
    const first = await handleAthenaGitHubWebhook(env, await req(), { id: () => 'receipt-a' })
    const second = await handleAthenaGitHubWebhook(env, await req(), { id: () => 'receipt-b' })
    expect(first.body).toMatchObject({ receipt_id: 'receipt-a', duplicate: false })
    expect(second.body).toMatchObject({ receipt_id: 'receipt-a', duplicate: true })
    expect(await listAthenaGateReceipts(env)).toHaveLength(1)
  })
})

describe('Athena receipts on /verifications', () => {
  it('renders recent gate audits with verdict pills', async () => {
    const html = String(await athenaGateReceiptsBody([
      {
        id: 'r1',
        repo: 'Mumega-com/mupot',
        pr_number: 42,
        commit_sha: 'abc123def4567890',
        verdict: 'APPROVED',
        checks_json: JSON.stringify([
          { id: 'no_hardcoded_secrets', name: 'No hardcoded secrets', passed: true },
          { id: 'verified_unit_tests', name: 'Verified unit tests', passed: false },
        ]),
        summary: 'Athena APPROVED Greet helper',
        created_at: '2026-08-26T12:00:00.000Z',
      },
    ]))
    expect(html).toContain('Athena PR gate audits')
    expect(html).toContain('Mumega-com/mupot')
    expect(html).toContain('APPROVED')
    expect(html).toContain('CHECKS')
    expect(html).toContain('✓ No hardcoded secrets')
    expect(html).toContain('✗ Verified unit tests')
    expect(html).toContain('Athena APPROVED Greet helper')
  })
})

describe('source pins', () => {
  it('mounts POST /api/webhooks/github before the dashboard catch-all', () => {
    const root = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(root).toContain("app.route('/api/webhooks/github', athenaWebhookApp)")
    expect(root.indexOf("app.route('/api/webhooks/github', athenaWebhookApp)")).toBeLessThan(
      root.indexOf('app.route(ROUTES.dashboard, dashboardApp)'),
    )
  })
})
