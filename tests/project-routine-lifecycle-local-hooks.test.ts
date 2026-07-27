import { generateKeyPairSync, webcrypto } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import * as localHooks from '../scripts/project-routine-lifecycle-local-hooks.mjs'

const { createCollectorDependencies } = localHooks

const OWNER_TOKEN = 'owner-secret-never-persist'
const MINTED_TOKEN = 'minted-secret-never-persist'
const COMMIT = 'a'.repeat(40)
const ENV_KEYS = [
  'MUPOT_WRANGLER_PID_FILE',
  'MUPOT_LOCAL_STATE_DIR',
  'MUPOT_WRANGLER_LOG',
  'MUPOT_LOCAL_PORT',
] as const

const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function signingJwks() {
  const pair = generateKeyPairSync('ed25519')
  return {
    privateJwk: pair.privateKey.export({ format: 'jwk' }),
    publicJwk: pair.publicKey.export({ format: 'jwk' }),
  }
}

function config(baseUrl: string, outputDir: string, signingJwk: JsonWebKey) {
  return {
    baseUrl,
    outputDir,
    projectId: 'project-main',
    unauthorizedProjectId: 'project-other',
    squadId: 'squad-main',
    agentId: 'agent-conformance',
    unauthorizedAgentId: 'agent-other',
    ownerToken: OWNER_TOKEN,
    signingJwk: JSON.stringify(signingJwk),
    expectedTenant: 'local',
    expectedVersion: '0.25.0',
    expectedCommit: COMMIT,
    scheduledTicks: 1,
    pollTimeoutMs: 3_000,
  }
}

function installRestartContract(root: string, port: number) {
  const stateDir = join(root, 'state')
  mkdirSync(stateDir)
  const values = {
    MUPOT_WRANGLER_PID_FILE: join(root, 'wrangler.pid'),
    MUPOT_LOCAL_STATE_DIR: stateDir,
    MUPOT_WRANGLER_LOG: join(root, 'wrangler.log'),
    MUPOT_LOCAL_PORT: String(port),
  }
  for (const [key, value] of Object.entries(values)) process.env[key] = value
  return values
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    }),
  }
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

function fromB64url(value: string): Uint8Array {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

async function verifySigned(
  publicJwk: JsonWebKey,
  signature: string,
  lines: string[],
): Promise<boolean> {
  const key = await webcrypto.subtle.importKey(
    'jwk',
    publicJwk,
    { name: 'Ed25519' },
    false,
    ['verify'],
  )
  return webcrypto.subtle.verify(
    { name: 'Ed25519' },
    key,
    fromB64url(signature),
    new TextEncoder().encode(lines.join('\n')),
  )
}

describe('Project Routine local lifecycle hooks', () => {
  it('requires mobile routine labels to be hidden from assistive technology and linked to real headers', () => {
    const validate = (localHooks as unknown as {
      validateRoutineAccessibility?: (snapshot: {
        headerIds: string[]
        contentIds: string[]
        cellLabelledBy: string[]
        cellCount: number
        mobileLabelCount: number
        mobileLabelHiddenCount: number
      }) => boolean
    }).validateRoutineAccessibility

    expect(validate).toBeTypeOf('function')
    if (!validate) return

    expect(() => validate({
      headerIds: ['routine-header-1', 'routine-header-1'],
      contentIds: ['routine-content-1'],
      cellLabelledBy: ['routine-header-1 routine-content-1'],
      cellCount: 1,
      mobileLabelCount: 1,
      mobileLabelHiddenCount: 1,
    })).toThrow(/unique/i)

    expect(validate({
      headerIds: ['routine-header-1'],
      contentIds: ['routine-content-1'],
      cellLabelledBy: ['routine-header-1 routine-content-1'],
      cellCount: 1,
      mobileLabelCount: 1,
      mobileLabelHiddenCount: 1,
    })).toBe(true)

    expect(() => validate({
      headerIds: ['routine-header-1'],
      contentIds: ['routine-content-1'],
      cellLabelledBy: ['routine-header-1'],
      cellCount: 1,
      mobileLabelCount: 1,
      mobileLabelHiddenCount: 1,
    })).toThrow(/own content/i)
  })

  it('fails closed before making dependencies when the explicit Wrangler restart contract is absent', async () => {
    for (const key of ENV_KEYS) delete process.env[key]
    const root = mkdtempSync(join(tmpdir(), 'mupot-routine-hooks-missing-'))
    const { privateJwk } = signingJwks()

    await expect(createCollectorDependencies(
      config('http://127.0.0.1:8787', root, privateJwk),
    )).rejects.toThrow(/MUPOT_WRANGLER_PID_FILE/)
  })

  it('provides every collector callback and rejects non-loopback targets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mupot-routine-hooks-surface-'))
    const { privateJwk } = signingJwks()
    installRestartContract(root, 8787)

    await expect(createCollectorDependencies(
      config('https://mupot.example.com', root, privateJwk),
    )).rejects.toThrow(/loopback/i)

    const dependencies = await createCollectorDependencies(
      config('http://127.0.0.1:8787', root, privateJwk),
    )
    for (const callback of [
      'probeTarget', 'mintAgentToken', 'attachSigned', 'scheduledTick',
      'consumeSignedInbox', 'invokeAction', 'readRestRun', 'readRestProject',
      'readRestActivity', 'readRestEvidence', 'detachSigned',
    ]) {
      expect(dependencies.api[callback]).toBeTypeOf('function')
    }
    for (const callback of [
      'assertOwnerSession', 'createRoutine', 'enableRoutine', 'captureRoutine',
      'manualFire', 'approveTask', 'readRun', 'readProjectSituation',
      'readActivityEvidence', 'close',
    ]) {
      expect(dependencies.browser[callback]).toBeTypeOf('function')
    }
    for (const callback of [
      'restartWorker', 'waitForTarget', 'writeArtifact', 'now', 'randomUUID', 'sleep',
    ]) {
      expect(dependencies[callback]).toBeTypeOf('function')
    }
    await dependencies.browser.close()
  })

  it('uses real loopback HTTP for MCP mint, scheduled ticks, and Ed25519 runtime lifecycle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mupot-routine-hooks-http-'))
    const outputDir = join(root, 'artifacts')
    const { privateJwk, publicJwk } = signingJwks()
    const observations: Array<{ path: string; authorization?: string; value?: any }> = []
    let baseUrl = ''

    const fixture = await listen(async (request, response) => {
      const url = new URL(request.url ?? '/', baseUrl || 'http://127.0.0.1')
      const raw = request.method === 'POST' ? await body(request) : ''
      const value = raw ? JSON.parse(raw) : undefined
      observations.push({
        path: url.pathname,
        authorization: request.headers.authorization,
        value,
      })

      if (url.pathname === '/health') {
        return json(response, 200, {
          ok: true, tenant: 'local', version: '0.25.0', commit: COMMIT,
        })
      }
      if (url.pathname === '/actions/mint_agent_token') {
        return json(response, 200, {
          ok: true,
          tool: 'mint_agent_token',
          result: {
            token: { raw: MINTED_TOKEN, agent_id: value.agent, capability: value.capability },
          },
        })
      }
      if (url.pathname === '/__scheduled') {
        response.writeHead(200, { 'content-type': 'text/plain' })
        return response.end('scheduled')
      }
      if (url.pathname === '/api/fleet/attach-signed') {
        const valid = await verifySigned(publicJwk, value.sig, [
          'fleet-attach:v1',
          'local',
          value.agent_id,
          value.type,
          value.runtime,
          value.lifecycle,
          String(value.ts),
          value.nonce,
        ])
        return json(response, valid ? 200 : 401, { ok: valid })
      }
      if (url.pathname === '/api/inbox/signed') {
        const valid = await verifySigned(publicJwk, value.sig, [
          'agent-inbox:v1',
          'local',
          value.agent_id,
          value.peek ? '1' : '0',
          String(value.limit),
          String(value.ts),
          value.nonce,
        ])
        return json(response, valid ? 200 : 401, {
          ok: valid,
          consumed: !value.peek,
          messages: [{
            body: JSON.stringify({
              version: 'routine.run/v1',
              run_id: 'run-1',
              project_id: 'project-main',
              situation_digest: 'b'.repeat(64),
            }),
          }],
        })
      }
      if (url.pathname === '/api/fleet/detach-signed') {
        const valid = await verifySigned(publicJwk, value.sig, [
          'fleet-detach:v1',
          'local',
          value.agent_id,
          String(value.ts),
          value.nonce,
        ])
        return json(response, valid ? 200 : 401, { ok: valid })
      }
      return json(response, 404, { error: 'not_found' })
    })
    baseUrl = fixture.baseUrl
    installRestartContract(root, fixture.port)
    const dependencies = await createCollectorDependencies(config(baseUrl, outputDir, privateJwk))

    try {
      await expect(dependencies.api.probeTarget()).resolves.toMatchObject({ ok: true, tenant: 'local' })
      await expect(dependencies.api.mintAgentToken({
        ownerToken: OWNER_TOKEN,
        agentId: 'agent-conformance',
        capability: 'member',
      })).resolves.toMatchObject({ token: MINTED_TOKEN, agentId: 'agent-conformance' })
      await expect(dependencies.api.scheduledTick({ tick: 1 })).resolves.toMatchObject({ ok: true })
      await expect(dependencies.api.attachSigned({
        agentId: 'agent-conformance',
        tenant: 'local',
        signingJwk: JSON.stringify(privateJwk),
      })).resolves.toEqual({ ok: true })
      await expect(dependencies.api.consumeSignedInbox({
        agentId: 'agent-conformance',
        tenant: 'local',
        signingJwk: JSON.stringify(privateJwk),
        projectId: 'project-main',
        timeoutMs: 1_000,
        sleep: async () => undefined,
      })).resolves.toMatchObject({ ok: true, consumed: true })
      await expect(dependencies.api.detachSigned({
        agentId: 'agent-conformance',
        tenant: 'local',
        signingJwk: JSON.stringify(privateJwk),
      })).resolves.toEqual({ ok: true })

      await dependencies.writeArtifact('redacted.json', {
        authorization: OWNER_TOKEN,
        nested: { raw: MINTED_TOKEN },
        safe: 'retained',
      })
      const artifact = readFileSync(join(outputDir, 'redacted.json'), 'utf8')
      expect(artifact).toContain('"safe": "retained"')
      expect(artifact).not.toContain(OWNER_TOKEN)
      expect(artifact).not.toContain(MINTED_TOKEN)
      await expect(dependencies.writeArtifact('../escape.json', {})).rejects.toThrow(/artifact path/i)
    } finally {
      await dependencies.browser.close()
      await fixture.close()
    }

    const mint = observations.find(item => item.path === '/actions/mint_agent_token')
    expect(mint).toMatchObject({
      authorization: `Bearer ${OWNER_TOKEN}`,
      value: { agent: 'agent-conformance', capability: 'member' },
    })
    expect(observations.some(item => item.path === '/__scheduled')).toBe(true)
    expect(observations.map(item => item.path)).toEqual(expect.arrayContaining([
      '/api/fleet/attach-signed',
      '/api/inbox/signed',
      '/api/fleet/detach-signed',
    ]))
    expect(observations.find(item => item.path === '/api/fleet/attach-signed')?.value)
      .toMatchObject({ type: 'builder', runtime: 'python', lifecycle: 'on_demand' })
  })

  it('uses Playwright for the owner routine, approval, screenshots, and rendered parity surfaces', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mupot-routine-hooks-browser-'))
    const outputDir = join(root, 'receipt')
    const { privateJwk } = signingJwks()
    let routineStatus = 'draft'
    let runQueued = false
    let approved = false
    let sessionRestRequests = 0
    let baseUrl = ''
    const routineName = 'Lifecycle receipt browser'
    const situation = { health: 'healthy', summary: 'Browser situation', routines: { enabled_count: 1 } }
    const expectedRun = {
      id: 'run-browser',
      routine_id: 'routine-browser',
      project_id: 'project-main',
      status: 'succeeded',
      cost_micro_usd: 17,
    }
    const activity = [{ source_id: 'activity-browser', title: 'Lifecycle activity' }]
    const evidence = [{ source_id: 'evidence-browser', title: 'Lifecycle evidence' }]

    const fixture = await listen(async (request, response) => {
      const url = new URL(request.url ?? '/', baseUrl || 'http://127.0.0.1')
      if (url.pathname === '/auth/dev-login') {
        response.writeHead(302, {
          location: '/projects/project-main/routines',
          'set-cookie': 'mupot_session=fixture; Path=/; HttpOnly',
        })
        return response.end()
      }
      if (url.pathname === '/auth/me') {
        return json(response, 200, {
          email: 'local-owner@mupot.test',
          role: 'owner',
        })
      }
      if (url.pathname === '/projects/project-main/routines' && request.method === 'POST') {
        await body(request)
        response.writeHead(303, { location: '/projects/project-main/routines?status=created' })
        return response.end()
      }
      if (url.pathname === '/projects/project-main/routines/routine-browser/enable') {
        routineStatus = 'enabled'
        response.writeHead(303, { location: '/projects/project-main/routines?status=enabled' })
        return response.end()
      }
      if (url.pathname === '/projects/project-main/routines/routine-browser/run') {
        await body(request)
        runQueued = true
        response.writeHead(303, { location: '/projects/project-main/routines?status=run_queued' })
        return response.end()
      }
      if (url.pathname === '/api/tasks/control-task/verdict') {
        const verdict = JSON.parse(await body(request))
        approved = verdict.verdict === 'approved'
        return json(response, 201, { verdict: verdict.verdict, task_id: 'control-task' })
      }
      if (url.pathname.startsWith('/api/projects/project-main')) {
        if (!request.headers.cookie?.includes('mupot_session=fixture')) {
          return json(response, 401, { error: 'unauthorized' })
        }
        sessionRestRequests += 1
        if (url.pathname.endsWith('/activity')) return json(response, 200, { rows: activity })
        if (url.pathname.endsWith('/evidence')) return json(response, 200, { rows: evidence })
        return json(response, 200, { project: { id: 'project-main' }, situation })
      }
      if (url.pathname === '/approvals') {
        response.writeHead(200, { 'content-type': 'text/html' })
        return response.end(`<!doctype html><body>
          <div class="card approval" data-task="control-task">
            <button class="appr-approve">Approve</button><span class="appr-status"></span>
          </div>
          <script>
            document.querySelector('.appr-approve').addEventListener('click', async () => {
              const response = await fetch('/api/tasks/control-task/verdict', {
                method: 'POST',
                headers: {'content-type':'application/json'},
                body: JSON.stringify({verdict:'approved'})
              });
              if (response.ok) document.querySelector('.appr-status').textContent = 'approved';
            });
          </script>
        </body>`)
      }
      if (url.pathname === '/projects/project-main') {
        response.writeHead(200, { 'content-type': 'text/html' })
        return response.end(`<!doctype html><body>
          <h1>Project Main</h1>
          <script type="application/json" id="project-situation-json">${JSON.stringify(situation)}</script>
          <script type="application/json" id="project-activity-json">${JSON.stringify({ rows: activity })}</script>
          <script type="application/json" id="project-evidence-json">${JSON.stringify({ rows: evidence })}</script>
          <section id="activity">activity-browser Lifecycle activity</section>
          <section id="evidence">evidence-browser Lifecycle evidence</section>
        </body>`)
      }
      if (url.pathname === '/projects/project-main/routines') {
        response.writeHead(200, { 'content-type': 'text/html' })
        const row = `<div role="row">
          <a href="/projects/project-main/routines?routine_id=routine-browser"><strong>${routineName}</strong></a>
          <span>${routineStatus}</span><span>propose</span>
          ${routineStatus === 'draft'
            ? '<form method="post" action="/projects/project-main/routines/routine-browser/enable"><button>Enable</button></form>'
            : ''}
          ${routineStatus === 'enabled'
            ? '<form method="post" action="/projects/project-main/routines/routine-browser/run"><input type="hidden" name="nonce" value="nonce-1"><button>Run now</button></form>'
            : ''}
        </div>`
        const detail = url.searchParams.get('run_id') === 'run-browser'
          ? `<script type="application/json" id="routine-run-json">${JSON.stringify(expectedRun)}</script>
             <section>Completed with recorded cost</section>`
          : ''
        return response.end(`<!doctype html><body>
          <form method="post" action="/projects/project-main/routines">
            <input name="name"><input name="responsible_squad_id"><input name="preferred_agent_id">
            <select name="trigger_kind"><option value="manual">Manual</option></select>
            <input name="run_once_at"><input name="cron_expression"><input name="timezone">
            <select name="execution_mode"><option value="propose">Propose</option></select>
            <select name="overlap_policy"><option value="skip">Skip</option></select>
            <input name="budget_micro_usd"><input name="max_attempts">
            <input name="retry_backoff_seconds"><input name="max_occurrences"><input name="stop_at">
            <textarea name="objective"></textarea><button>Create draft</button>
          </form>
          ${url.searchParams.has('status') || url.searchParams.has('routine_id') || runQueued ? row : ''}
          ${detail}
        </body>`)
      }
      return json(response, 404, { error: 'not_found' })
    })
    baseUrl = fixture.baseUrl
    installRestartContract(root, fixture.port)
    const dependencies = await createCollectorDependencies(config(baseUrl, outputDir, privateJwk))

    try {
      await expect(dependencies.browser.assertOwnerSession({ projectId: 'project-main' }))
        .resolves.toMatchObject({ ok: true, role: 'owner' })
      await expect(dependencies.browser.createRoutine({
        projectId: 'project-main',
        name: routineName,
        objective: 'Browser lifecycle',
        squadId: 'squad-main',
        agentId: 'agent-conformance',
        executionMode: 'propose',
        triggerKind: 'manual',
        overlapPolicy: 'skip',
        budgetMicroUsd: 100_000,
        maxAttempts: 3,
        retryBackoffSeconds: 30,
      })).resolves.toEqual({ routineId: 'routine-browser', status: 'draft' })
      await expect(dependencies.browser.enableRoutine({
        projectId: 'project-main', routineId: 'routine-browser', name: routineName,
      })).resolves.toEqual({ routineId: 'routine-browser', status: 'enabled' })
      await expect(dependencies.browser.captureRoutine({
        projectId: 'project-main',
        routineId: 'routine-browser',
        name: routineName,
        viewport: 'desktop',
        outputDir,
      })).resolves.toMatchObject({ viewport: 'desktop', bytes: expect.any(Number) })
      await expect(dependencies.browser.manualFire({
        projectId: 'project-main', routineId: 'routine-browser', name: routineName,
      })).resolves.toEqual({ accepted: true, routineId: 'routine-browser' })
      await expect(dependencies.browser.approveTask({
        taskId: 'control-task', runId: 'run-browser',
      })).resolves.toEqual({ taskId: 'control-task', runId: 'run-browser', verdict: 'approved' })
      expect(approved).toBe(true)
      await expect(dependencies.browser.readRun({
        runId: 'run-browser', projectId: 'project-main', expected: expectedRun,
      })).resolves.toEqual(expectedRun)
      await expect(dependencies.browser.readProjectSituation({ projectId: 'project-main' }))
        .resolves.toEqual(situation)
      await expect(dependencies.browser.readActivityEvidence({
        projectId: 'project-main',
        runId: 'run-browser',
        expectedActivity: activity,
        expectedEvidence: evidence,
      })).resolves.toEqual({ activity, evidence })
      await expect(dependencies.api.readRestProject({ projectId: 'project-main' }))
        .resolves.toMatchObject({ project: { id: 'project-main' }, situation })
      await expect(dependencies.api.readRestActivity({ projectId: 'project-main' }))
        .resolves.toEqual({ rows: activity })
      await expect(dependencies.api.readRestEvidence({ projectId: 'project-main' }))
        .resolves.toEqual({ rows: evidence })
      expect(sessionRestRequests).toBe(3)
    } finally {
      await dependencies.browser.close()
      await fixture.close()
    }
  }, 30_000)
})
