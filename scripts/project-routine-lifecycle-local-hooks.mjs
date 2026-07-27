#!/usr/bin/env node

import { randomUUID, webcrypto } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { chromium } from 'playwright'

const cryptoImpl = globalThis.crypto ?? webcrypto
const execFileAsync = promisify(execFile)
const encoder = new TextEncoder()
const SECRET_KEY = /(?:^|[_-])(authorization|bearer|token|raw|secret|password|api[_-]?key|private|jwk|cookie|signature|sig)(?:$|[_-])/i
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const RESTART_ENV = {
  pidFile: 'MUPOT_WRANGLER_PID_FILE',
  stateDir: 'MUPOT_LOCAL_STATE_DIR',
  logFile: 'MUPOT_WRANGLER_LOG',
  port: 'MUPOT_LOCAL_PORT',
}

function required(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`)
  return value
}

function loopbackTarget(raw) {
  let target
  try {
    target = new URL(raw)
  } catch {
    throw new Error('baseUrl must be a valid loopback URL')
  }
  if (target.protocol !== 'http:' || !LOOPBACK_HOSTS.has(target.hostname)) {
    throw new Error('baseUrl must use loopback HTTP')
  }
  return target
}

function absolute(value, label) {
  const resolved = required(value, label)
  if (!path.isAbsolute(resolved)) throw new Error(`${label} must be an absolute path`)
  return path.normalize(resolved)
}

async function directory(value, label) {
  const target = absolute(value, label)
  const metadata = await stat(target).catch(() => null)
  if (!metadata?.isDirectory()) throw new Error(`${label} must reference an existing directory`)
  return target
}

async function regularFile(value, label) {
  const target = absolute(value, label)
  const metadata = await stat(target).catch(() => null)
  if (!metadata?.isFile()) throw new Error(`${label} must reference an existing file`)
  return target
}

async function restartContract(env, target) {
  for (const name of Object.values(RESTART_ENV)) required(env[name], name)
  const port = Number(env[RESTART_ENV.port])
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${RESTART_ENV.port} must be an integer from 1 to 65535`)
  }
  const targetPort = Number(target.port || 80)
  if (targetPort !== port) {
    throw new Error(`${RESTART_ENV.port} must match the loopback target port`)
  }

  const contract = {
    pidFile: absolute(env[RESTART_ENV.pidFile], RESTART_ENV.pidFile),
    stateDir: await directory(env[RESTART_ENV.stateDir], RESTART_ENV.stateDir),
    logFile: absolute(env[RESTART_ENV.logFile], RESTART_ENV.logFile),
    port,
    cwd: await directory(process.cwd(), 'collector working directory'),
    config: await regularFile(
      path.join(process.cwd(), 'wrangler-local-test.toml'),
      'local Wrangler config',
    ),
  }
  for (const [value, label] of [
    [path.dirname(contract.pidFile), `${RESTART_ENV.pidFile} parent`],
    [path.dirname(contract.logFile), `${RESTART_ENV.logFile} parent`],
  ]) {
    await directory(value, label)
  }
  return contract
}

function parsePrivateJwk(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (
      !parsed
      || parsed.kty !== 'OKP'
      || parsed.crv !== 'Ed25519'
      || typeof parsed.d !== 'string'
      || typeof parsed.x !== 'string'
    ) {
      throw new Error('invalid key')
    }
    return parsed
  } catch {
    throw new Error('signingJwk must be a private Ed25519 JWK')
  }
}

function base64url(bytes) {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64url')
}

function nonce() {
  const bytes = new Uint8Array(24)
  cryptoImpl.getRandomValues(bytes)
  return base64url(bytes)
}

async function signer(raw) {
  const key = await cryptoImpl.subtle.importKey(
    'jwk',
    parsePrivateJwk(raw),
    { name: 'Ed25519' },
    false,
    ['sign'],
  )
  return async lines => base64url(await cryptoImpl.subtle.sign(
    { name: 'Ed25519' },
    key,
    encoder.encode(lines.join('\n')),
  ))
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

function redact(value, secrets, key = '') {
  if (SECRET_KEY.test(key)) return '[redacted]'
  if (typeof value === 'string') {
    return [...secrets].some(secret => secret && value.includes(secret)) ? '[redacted]' : value
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redact(childValue, secrets, childKey),
      ]),
    )
  }
  return value
}

function errorFor(label, response) {
  return new Error(`${label} failed with HTTP ${response.status}`)
}

function assertResponse(label, response, accepted = [200]) {
  if (!accepted.includes(response.status)) throw errorFor(label, response)
  return response.json
}

function containsRoutineEnvelope(messages, projectId) {
  return Array.isArray(messages) && messages.some(message => {
    try {
      const envelope = JSON.parse(message?.body ?? '')
      return envelope?.version === 'routine.run/v1' && envelope.project_id === projectId
    } catch {
      return false
    }
  })
}

function stableScalarStrings(value, prefix = '') {
  if (value === null || value === undefined) return []
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => stableScalarStrings(child, `${prefix}.${key}`))
  }
  if (typeof value === 'string' || typeof value === 'number') return [{ path: prefix, value: String(value) }]
  return []
}

async function processCommand(pid) {
  try {
    const result = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 5_000,
    })
    return result.stdout.trim()
  } catch {
    return ''
  }
}

async function waitForStopped(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
      await new Promise(resolve => setTimeout(resolve, 100))
    } catch {
      return
    }
  }
  throw new Error('Wrangler did not stop after SIGTERM')
}

async function restartWrangler(contract, { expectedCommit, baseUrl }) {
  const rawPid = await readFile(contract.pidFile, 'utf8')
    .catch(() => { throw new Error(`${RESTART_ENV.pidFile} is unreadable`) })
  const pid = Number(rawPid.trim())
  if (!Number.isSafeInteger(pid) || pid < 2 || pid === process.pid) {
    throw new Error(`${RESTART_ENV.pidFile} does not contain a safe Wrangler PID`)
  }

  const command = await processCommand(pid)
  if (!/\bwrangler\b/.test(command) || !new RegExp(`(?:--port(?:=|\\s+))${contract.port}(?:\\s|$)`).test(command)) {
    throw new Error(`${RESTART_ENV.pidFile} does not identify the contracted Wrangler process`)
  }

  process.kill(pid, 'SIGTERM')
  await waitForStopped(pid)

  const executable = await regularFile(
    path.join(contract.cwd, 'node_modules', '.bin', 'wrangler'),
    'local Wrangler executable',
  )
  const log = await open(contract.logFile, 'a')
  let child
  try {
    child = spawn(executable, [
      'dev',
      '--local',
      '--config', contract.config,
      '--persist-to', contract.stateDir,
      '--port', String(contract.port),
      '--test-scheduled',
      '--var', `RELEASE_SHA:${expectedCommit}`,
      '--var', `PUBLIC_ORIGIN:${baseUrl}`,
      '--show-interactive-dev-session=false',
      '--log-level', 'warn',
    ], {
      cwd: contract.cwd,
      env: process.env,
      stdio: ['ignore', log.fd, log.fd],
      shell: false,
    })
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
  } finally {
    await log.close()
  }
  if (!child.pid) throw new Error('Wrangler restart did not return a PID')
  child.unref()
  const temporary = `${contract.pidFile}.${process.pid}.tmp`
  await writeFile(temporary, `${child.pid}\n`, { mode: 0o600 })
  await rename(temporary, contract.pidFile)
  return { restarted: true, pid: child.pid, port: contract.port }
}

export async function createCollectorDependencies(config) {
  const target = loopbackTarget(required(config?.baseUrl, 'baseUrl'))
  const baseUrl = target.origin
  const outputDir = path.resolve(required(config?.outputDir, 'outputDir'))
  const ownerToken = required(config?.ownerToken, 'ownerToken')
  const configuredSigningJwk = required(config?.signingJwk, 'signingJwk')
  parsePrivateJwk(configuredSigningJwk)
  const contract = await restartContract(process.env, target)
  const secrets = new Set([ownerToken, configuredSigningJwk])
  let browser
  let context
  let page
  let browserReady

  async function requestJson(route, init = {}) {
    const response = await fetch(`${baseUrl}${route}`, {
      ...init,
      redirect: init.redirect ?? 'manual',
      headers: {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    })
    const text = await response.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: response.status, json, text }
  }

  async function invokeAction({ token, tool, input }) {
    const response = await requestJson(`/actions/${encodeURIComponent(tool)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(input ?? {}),
    })
    if (!response.json || typeof response.json !== 'object') {
      return { ok: false, status: response.status, error: 'invalid_response' }
    }
    return { ...response.json, status: response.status }
  }

  async function signedAttach({ agentId, tenant, signingJwk }) {
    if (tenant !== config.expectedTenant) throw new Error('signed attach tenant does not match collector target')
    const sign = await signer(signingJwk)
    const payload = {
      agent_id: agentId,
      type: 'builder',
      runtime: 'python',
      lifecycle: 'on_demand',
      ts: nowSeconds(),
      nonce: nonce(),
    }
    payload.sig = await sign([
      'fleet-attach:v1',
      tenant,
      payload.agent_id,
      payload.type,
      payload.runtime,
      payload.lifecycle,
      String(payload.ts),
      payload.nonce,
    ])
    const response = await requestJson('/api/fleet/attach-signed', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    return assertResponse('signed attach', response)
  }

  async function signedInboxBody({ agentId, tenant, signingJwk, peek = false, limit = 10 }) {
    const sign = await signer(signingJwk)
    const payload = {
      agent_id: agentId,
      peek,
      limit,
      ts: nowSeconds(),
      nonce: nonce(),
    }
    payload.sig = await sign([
      'agent-inbox:v1',
      tenant,
      payload.agent_id,
      payload.peek ? '1' : '0',
      String(payload.limit),
      String(payload.ts),
      payload.nonce,
    ])
    return payload
  }

  async function signedDetach({ agentId, tenant, signingJwk }) {
    if (tenant !== config.expectedTenant) throw new Error('signed detach tenant does not match collector target')
    const sign = await signer(signingJwk)
    const payload = {
      agent_id: agentId,
      ts: nowSeconds(),
      nonce: nonce(),
    }
    payload.sig = await sign([
      'fleet-detach:v1',
      tenant,
      payload.agent_id,
      String(payload.ts),
      payload.nonce,
    ])
    const response = await requestJson('/api/fleet/detach-signed', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    return assertResponse('signed detach', response)
  }

  async function ensureBrowser() {
    if (!browserReady) {
      browserReady = (async () => {
        browser = await chromium.launch({ headless: true })
        context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
        page = await context.newPage()
        const login = await page.goto(`${baseUrl}/auth/dev-login`, {
          waitUntil: 'networkidle',
          timeout: 20_000,
        })
        if (!login || login.status() >= 400) throw new Error('local owner dev login failed')
      })()
    }
    await browserReady
    return { browser, context, page }
  }

  async function routineRow(projectId, routineId, name) {
    const active = await ensureBrowser()
    await active.page.goto(
      `${baseUrl}/projects/${encodeURIComponent(projectId)}/routines?routine_id=${encodeURIComponent(routineId)}`,
      { waitUntil: 'networkidle', timeout: 20_000 },
    )
    const row = active.page.locator('[role="row"]', { hasText: name }).first()
    if (await row.count() !== 1) throw new Error('routine row was not rendered in the dashboard')
    return { ...active, row }
  }

  const api = {
    async probeTarget() {
      const response = await requestJson('/health')
      return assertResponse('target health', response)
    },

    async mintAgentToken({ ownerToken: callerToken, agentId, capability }) {
      if (callerToken !== ownerToken) throw new Error('mint caller token does not match collector owner token')
      const response = await invokeAction({
        token: callerToken,
        tool: 'mint_agent_token',
        input: {
          agent: agentId,
          capability,
          label: `project-routine-lifecycle:${agentId}`.slice(0, 64),
        },
      })
      const raw = response?.result?.token?.raw
      if (response.ok !== true || typeof raw !== 'string' || raw.length === 0) {
        throw new Error(`mint_agent_token failed with HTTP ${response.status}`)
      }
      secrets.add(raw)
      return {
        token: raw,
        agentId: response.result.token.agent_id,
        capability: response.result.token.capability,
      }
    },

    attachSigned: signedAttach,

    async scheduledTick({ tick }) {
      const response = await fetch(`${baseUrl}/__scheduled?cron=${encodeURIComponent('* * * * *')}`, {
        method: 'GET',
        redirect: 'manual',
      })
      if (!response.ok) throw new Error(`scheduled tick ${tick} failed with HTTP ${response.status}`)
      await response.arrayBuffer()
      return { ok: true, tick, status: response.status }
    },

    async consumeSignedInbox({
      agentId,
      tenant,
      signingJwk,
      projectId,
      timeoutMs,
      sleep,
    }) {
      if (tenant !== config.expectedTenant) throw new Error('signed inbox tenant does not match collector target')
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const payload = await signedInboxBody({
          agentId,
          tenant,
          signingJwk,
          peek: false,
          limit: 10,
        })
        const response = await requestJson('/api/inbox/signed', {
          method: 'POST',
          body: JSON.stringify(payload),
        })
        const result = assertResponse('signed inbox consume', response)
        if (result?.ok === true && result.consumed === true && containsRoutineEnvelope(result.messages, projectId)) {
          return result
        }
        await sleep(250)
      }
      throw new Error('timed out waiting for a routine.run/v1 signed inbox message')
    },

    invokeAction,

    async readRestRun({ runId, ownerToken: callerToken }) {
      const response = await requestJson(`/api/routine-runs/${encodeURIComponent(runId)}`, {
        headers: { authorization: `Bearer ${callerToken}` },
      })
      return assertResponse('REST routine run read', response)
    },

    async readRestProject({ projectId, ownerToken: callerToken }) {
      const response = await requestJson(`/api/projects/${encodeURIComponent(projectId)}`, {
        headers: { authorization: `Bearer ${callerToken}` },
      })
      return assertResponse('REST project read', response)
    },

    async readRestActivity({ projectId, ownerToken: callerToken }) {
      const response = await requestJson(`/api/projects/${encodeURIComponent(projectId)}/activity?limit=100`, {
        headers: { authorization: `Bearer ${callerToken}` },
      })
      return assertResponse('REST project Activity read', response)
    },

    async readRestEvidence({ projectId, ownerToken: callerToken }) {
      const response = await requestJson(`/api/projects/${encodeURIComponent(projectId)}/evidence?limit=100`, {
        headers: { authorization: `Bearer ${callerToken}` },
      })
      return assertResponse('REST project Evidence read', response)
    },

    detachSigned: signedDetach,
  }

  const browserCallbacks = {
    async assertOwnerSession({ projectId }) {
      const active = await ensureBrowser()
      const response = await active.context.request.get(`${baseUrl}/auth/me`)
      const json = await response.json().catch(() => null)
      if (response.status() !== 200 || json?.role !== 'owner') {
        throw new Error('Playwright session is not authenticated as owner')
      }
      const routines = await active.page.goto(
        `${baseUrl}/projects/${encodeURIComponent(projectId)}/routines`,
        { waitUntil: 'networkidle', timeout: 20_000 },
      )
      if (!routines || routines.status() >= 400) throw new Error('owner cannot open Project Routines')
      return { ok: true, role: json.role, email: json.email }
    },

    async createRoutine(input) {
      const active = await ensureBrowser()
      await active.page.goto(
        `${baseUrl}/projects/${encodeURIComponent(input.projectId)}/routines`,
        { waitUntil: 'networkidle', timeout: 20_000 },
      )
      const values = {
        name: input.name,
        objective: input.objective,
        responsible_squad_id: input.squadId,
        preferred_agent_id: input.agentId,
        trigger_kind: input.triggerKind,
        run_once_at: '',
        cron_expression: '',
        timezone: 'UTC',
        execution_mode: input.executionMode,
        overlap_policy: input.overlapPolicy,
        budget_micro_usd: String(input.budgetMicroUsd),
        max_attempts: String(input.maxAttempts),
        retry_backoff_seconds: String(input.retryBackoffSeconds),
        max_occurrences: '',
        stop_at: '',
      }
      for (const [field, value] of Object.entries(values)) {
        const locator = active.page.locator(`[name="${field}"]`)
        if (await locator.count() !== 1) throw new Error(`routine form field is absent: ${field}`)
        if (await locator.evaluate(element => element.tagName === 'SELECT')) {
          await locator.selectOption(value)
        } else {
          await locator.fill(value)
        }
      }
      await Promise.all([
        active.page.waitForURL(url => url.searchParams.get('status') === 'created', { timeout: 10_000 }),
        active.page.getByRole('button', { name: 'Create draft' }).click(),
      ])
      const link = active.page.getByRole('link', { name: input.name, exact: true }).first()
      const href = await link.getAttribute('href')
      const routineId = href ? new URL(href, baseUrl).searchParams.get('routine_id') : null
      if (!routineId) throw new Error('created routine id was not rendered')
      return { routineId, status: 'draft' }
    },

    async enableRoutine({ projectId, routineId, name }) {
      const active = await routineRow(projectId, routineId, name)
      await Promise.all([
        active.page.waitForURL(url => url.searchParams.get('status') === 'enabled', { timeout: 10_000 }),
        active.row.getByRole('button', { name: 'Enable', exact: true }).click(),
      ])
      return { routineId, status: 'enabled' }
    },

    async captureRoutine({ projectId, routineId, name, viewport, outputDir: requestedOutputDir }) {
      const active = await ensureBrowser()
      const size = viewport === 'mobile'
        ? { width: 390, height: 844 }
        : { width: 1440, height: 1000 }
      await active.page.setViewportSize(size)
      await active.page.goto(
        `${baseUrl}/projects/${encodeURIComponent(projectId)}/routines?routine_id=${encodeURIComponent(routineId)}`,
        { waitUntil: 'networkidle', timeout: 20_000 },
      )
      const bodyText = await active.page.locator('body').innerText()
      if (!bodyText.includes(name) || !bodyText.toLowerCase().includes('propose')) {
        throw new Error(`${viewport} routine dashboard did not render propose mode`)
      }
      const screenshotDir = path.join(path.resolve(requestedOutputDir), 'screenshots')
      await mkdir(screenshotDir, { recursive: true })
      const screenshotPath = path.join(screenshotDir, `${viewport}-propose-mode.png`)
      await active.page.screenshot({ path: screenshotPath, fullPage: true })
      const metadata = await stat(screenshotPath)
      return { viewport, path: screenshotPath, bytes: metadata.size }
    },

    async manualFire({ projectId, routineId, name }) {
      const active = await routineRow(projectId, routineId, name)
      await Promise.all([
        active.page.waitForURL(url => url.searchParams.get('status') === 'run_queued', { timeout: 10_000 }),
        active.row.getByRole('button', { name: 'Run now', exact: true }).click(),
      ])
      return { accepted: true, routineId }
    },

    async approveTask({ taskId, runId }) {
      const active = await ensureBrowser()
      await active.page.goto(`${baseUrl}/approvals`, { waitUntil: 'networkidle', timeout: 20_000 })
      const safeTaskId = taskId.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
      const card = active.page.locator(`[data-task="${safeTaskId}"]`)
      if (await card.count() !== 1) throw new Error('control task was not rendered in Approvals')
      const verdictResponse = active.page.waitForResponse(response => {
        const target = new URL(response.url())
        return target.pathname === `/api/tasks/${encodeURIComponent(taskId)}/verdict`
          && response.request().method() === 'POST'
      }, { timeout: 10_000 })
      await card.locator('.appr-approve').click()
      const response = await verdictResponse
      if (!response.ok()) {
        const failure = await response.json().catch(() => null)
        const code = typeof failure?.error === 'string' ? failure.error : 'unknown_error'
        throw new Error(`approval request failed with HTTP ${response.status()}: ${code}`)
      }
      await expectLocatorText(card.locator('.appr-status'), 'approved')
      return { taskId, runId, verdict: 'approved' }
    },

    async readRun({ runId, projectId, expected }) {
      const active = await ensureBrowser()
      await active.page.goto(
        `${baseUrl}/projects/${encodeURIComponent(projectId)}/routines?run_id=${encodeURIComponent(runId)}`,
        { waitUntil: 'networkidle', timeout: 20_000 },
      )
      const bodyText = await active.page.locator('body').innerText()
      for (const entry of stableScalarStrings({
        id: expected.id,
        status: expected.status,
        cost_micro_usd: expected.cost_micro_usd,
      })) {
        if (!bodyText.includes(entry.value)) throw new Error(`dashboard run omitted ${entry.path}`)
      }
      return expected
    },

    async readProjectSituation({ projectId }) {
      const active = await ensureBrowser()
      await active.page.goto(
        `${baseUrl}/projects/${encodeURIComponent(projectId)}`,
        { waitUntil: 'networkidle', timeout: 20_000 },
      )
      const raw = await active.page.locator('#project-situation-json').textContent()
      if (!raw) throw new Error('dashboard Project Situation JSON is absent')
      try {
        return JSON.parse(raw)
      } catch {
        throw new Error('dashboard Project Situation JSON is invalid')
      }
    },

    async readActivityEvidence({ projectId, expectedActivity, expectedEvidence }) {
      const active = await ensureBrowser()
      await active.page.goto(
        `${baseUrl}/projects/${encodeURIComponent(projectId)}`,
        { waitUntil: 'networkidle', timeout: 20_000 },
      )
      const activityText = await active.page.locator('#activity').innerText()
      const evidenceText = await active.page.locator('#evidence').innerText()
      for (const row of expectedActivity) {
        if (typeof row?.source_id === 'string' && !activityText.includes(row.source_id)) {
          throw new Error(`dashboard Activity omitted source ${row.source_id}`)
        }
      }
      for (const row of expectedEvidence) {
        if (typeof row?.source_id === 'string' && !evidenceText.includes(row.source_id)) {
          throw new Error(`dashboard Evidence omitted source ${row.source_id}`)
        }
      }
      return { activity: expectedActivity, evidence: expectedEvidence }
    },

    async close() {
      if (browserReady) {
        await browserReady.catch(() => undefined)
        await browser?.close()
      }
      browser = undefined
      context = undefined
      page = undefined
      browserReady = undefined
    },
  }

  return {
    api,
    browser: browserCallbacks,
    restartWorker: async ({ baseUrl: requestedBaseUrl, expectedCommit }) => {
      const requested = loopbackTarget(requestedBaseUrl)
      if (requested.origin !== baseUrl) throw new Error('restart target does not match adapter target')
      return restartWrangler(contract, { expectedCommit, baseUrl })
    },
    async waitForTarget({ baseUrl: requestedBaseUrl, expectedCommit, expectedVersion, timeoutMs }) {
      if (loopbackTarget(requestedBaseUrl).origin !== baseUrl) {
        throw new Error('health wait target does not match adapter target')
      }
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        try {
          const health = await api.probeTarget()
          if (
            health?.ok === true
            && health.commit === expectedCommit
            && health.version === expectedVersion
          ) return health
        } catch {
          // Restart deliberately creates a short interval with no listener.
        }
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      throw new Error('timed out waiting for the restarted Wrangler target')
    },
    async writeArtifact(relativePath, value) {
      const destination = path.resolve(outputDir, relativePath)
      const relative = path.relative(outputDir, destination)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('artifact path must remain within outputDir')
      }
      await mkdir(path.dirname(destination), { recursive: true })
      const temporary = `${destination}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(redact(value, secrets), null, 2)}\n`, {
        mode: 0o600,
      })
      await rename(temporary, destination)
    },
    now: () => new Date(),
    randomUUID,
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  }
}

async function expectLocatorText(locator, expected) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if ((await locator.textContent().catch(() => ''))?.trim() === expected) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`dashboard did not render verdict: ${expected}`)
}
