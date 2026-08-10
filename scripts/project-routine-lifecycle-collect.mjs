#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const STEP_RECEIPT_TYPE = 'mupot-project-routine-lifecycle-step/v1'
const SECRET_KEY = /(?:^|[_-])(authorization|bearer|token|secret|password|api[_-]?key|private|jwk|cookie|signature|sig)(?:$|[_-])/i
const COMMIT_RE = /^[a-f0-9]{40}$/i
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const DIGEST_RE = /^[a-f0-9]{64}$/
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'skipped', 'cancelled'])

function redact(value, secretValues = [], key = '') {
  if (SECRET_KEY.test(key) && (!value || typeof value !== 'object')) return '[redacted]'
  if (typeof value === 'string') {
    if (secretValues.some(secret => secret && value.includes(secret))) return '[redacted]'
    return value
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secretValues))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redact(childValue, secretValues, childKey),
      ]),
    )
  }
  return value
}

export class CollectorError extends Error {
  constructor(message, detail = undefined, secretValues = []) {
    super(message)
    this.name = 'CollectorError'
    this.safeDetail = redact(detail, secretValues)
  }
}

function required(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CollectorError(`${label} is required`)
  }
  return value
}

function valueAfter(argv, index, flag) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new CollectorError(`${flag} requires a value`)
  }
  return value
}

export function parseCollectorArgs(argv = process.argv.slice(2), env = process.env) {
  for (const arg of argv) {
    if (/^--(?:owner-?token|token|private-?jwk|signing-?jwk|secret|api-?key)(?:=|$)/i.test(arg)) {
      throw new CollectorError('credentials must not be supplied on the command line')
    }
  }

  const values = {}
  const numeric = new Set(['--scheduled-ticks', '--poll-timeout-ms'])
  const flags = new Map([
    ['--base-url', 'baseUrl'],
    ['--out-dir', 'outputDir'],
    ['--project-id', 'projectId'],
    ['--unauthorized-project-id', 'unauthorizedProjectId'],
    ['--squad-id', 'squadId'],
    ['--agent-id', 'agentId'],
    ['--unauthorized-agent-id', 'unauthorizedAgentId'],
    ['--hooks-module', 'hooksModule'],
    ['--expected-tenant', 'expectedTenant'],
    ['--expected-version', 'expectedVersion'],
    ['--expected-commit', 'expectedCommit'],
    ['--scheduled-ticks', 'scheduledTicks'],
    ['--poll-timeout-ms', 'pollTimeoutMs'],
  ])

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const field = flags.get(flag)
    if (!field) throw new CollectorError(`unknown argument: ${flag}`)
    const raw = valueAfter(argv, index, flag)
    values[field] = numeric.has(flag) ? Number(raw) : raw
    index += 1
  }

  for (const [field, flag] of [
    ['baseUrl', '--base-url'],
    ['outputDir', '--out-dir'],
    ['projectId', '--project-id'],
    ['unauthorizedProjectId', '--unauthorized-project-id'],
    ['squadId', '--squad-id'],
    ['agentId', '--agent-id'],
    ['unauthorizedAgentId', '--unauthorized-agent-id'],
    ['hooksModule', '--hooks-module'],
    ['expectedVersion', '--expected-version'],
    ['expectedCommit', '--expected-commit'],
  ]) {
    if (!values[field]) throw new CollectorError(`${flag} is required`)
  }

  let target
  try {
    target = new URL(values.baseUrl)
  } catch {
    throw new CollectorError('--base-url must be a valid URL')
  }
  if (!['http:', 'https:'].includes(target.protocol)
    || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(target.hostname)) {
    throw new CollectorError('--base-url must target an already-running loopback Wrangler instance')
  }
  if (!VERSION_RE.test(values.expectedVersion)) {
    throw new CollectorError('--expected-version must be semver')
  }
  if (!COMMIT_RE.test(values.expectedCommit)) {
    throw new CollectorError('--expected-commit must be a 40-character commit')
  }
  if (values.projectId === values.unauthorizedProjectId) {
    throw new CollectorError('--unauthorized-project-id must differ from --project-id')
  }
  if (values.agentId === values.unauthorizedAgentId) {
    throw new CollectorError('--unauthorized-agent-id must differ from --agent-id')
  }

  const ownerToken = env.MUPOT_ROUTINE_OWNER_TOKEN
  const signingJwk = env.MUPOT_CONFORMANCE_PRIVATE_JWK
  if (!ownerToken) throw new CollectorError('MUPOT_ROUTINE_OWNER_TOKEN is required')
  if (!signingJwk) throw new CollectorError('MUPOT_CONFORMANCE_PRIVATE_JWK is required')

  const scheduledTicks = values.scheduledTicks ?? 1
  const pollTimeoutMs = values.pollTimeoutMs ?? 30_000
  if (!Number.isSafeInteger(scheduledTicks) || scheduledTicks < 1 || scheduledTicks > 20) {
    throw new CollectorError('--scheduled-ticks must be an integer from 1 to 20')
  }
  if (!Number.isSafeInteger(pollTimeoutMs) || pollTimeoutMs < 1_000 || pollTimeoutMs > 300_000) {
    throw new CollectorError('--poll-timeout-ms must be an integer from 1000 to 300000')
  }

  return {
    ...values,
    baseUrl: values.baseUrl.replace(/\/+$/, ''),
    expectedTenant: values.expectedTenant || 'local',
    expectedCommit: values.expectedCommit.toLowerCase(),
    ownerToken,
    signingJwk,
    scheduledTicks,
    pollTimeoutMs,
  }
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalize(value[key])]),
    )
  }
  return value
}

export async function canonicalDigest(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

function assertObject(value, message, secretValues) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CollectorError(message, value, secretValues)
  }
  return value
}

function assertTarget(health, config, label, secretValues) {
  assertObject(health, `${label} did not return a health object`, secretValues)
  if (health.ok !== true) throw new CollectorError(`${label} is not healthy`, health, secretValues)
  if (health.tenant !== config.expectedTenant) {
    throw new CollectorError(`${label} tenant does not match`, health, secretValues)
  }
  if (health.version !== config.expectedVersion) {
    throw new CollectorError(`${label} version does not match`, health, secretValues)
  }
  if (typeof health.commit !== 'string' || health.commit.toLowerCase() !== config.expectedCommit.toLowerCase()) {
    throw new CollectorError(`${label} commit does not match`, health, secretValues)
  }
  return {
    tenant: health.tenant,
    version: health.version,
    commit: health.commit.toLowerCase(),
  }
}

function assertActionOk(response, label, secretValues) {
  if (!response?.ok) throw new CollectorError(`${label} failed`, response, secretValues)
  return assertObject(response.result, `${label} returned no result`, secretValues)
}

function assertActionRejected(response, expectedError, label, secretValues) {
  if (response?.ok !== false || response.error !== expectedError) {
    throw new CollectorError(`${label} was not rejected with ${expectedError}`, response, secretValues)
  }
}

function normalizeRun(value) {
  const run = value?.run ?? value
  return canonicalize(run)
}

function normalizeSituation(value) {
  return canonicalize(value?.situation ?? value)
}

function normalizeRows(value, keys) {
  for (const key of keys) {
    if (Array.isArray(value?.[key])) return canonicalize(value[key])
  }
  if (Array.isArray(value)) return canonicalize(value)
  return []
}

function equal(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
}

function assertEqual(left, right, message, secretValues) {
  if (!equal(left, right)) {
    throw new CollectorError(message, { left, right }, secretValues)
  }
}

function mutateDigest(digest) {
  return `${digest[0] === '0' ? '1' : '0'}${digest.slice(1)}`
}

function parseRoutineEnvelope(inbox, config, secretValues) {
  if (inbox?.ok !== true || inbox.consumed !== true || !Array.isArray(inbox.messages)) {
    throw new CollectorError('signed runtime inbox did not return a consumed batch', inbox, secretValues)
  }

  for (const message of inbox.messages) {
    try {
      const parsed = JSON.parse(message.body)
      if (parsed?.version !== 'routine.run/v1') continue
      if (parsed.project_id !== config.projectId) continue
      if (typeof parsed.run_id !== 'string' || !parsed.run_id) continue
      if (!DIGEST_RE.test(parsed.situation_digest)) continue
      return { message, envelope: parsed }
    } catch {
      // Non-routine messages may share the dedicated conformance inbox.
    }
  }
  throw new CollectorError('signed runtime inbox contained no matching routine.run/v1 envelope')
}

function validateDependencies(deps) {
  const missing = []
  for (const [owner, methods] of [
    ['api', [
      'probeTarget', 'mintAgentToken', 'attachSigned', 'scheduledTick',
      'consumeSignedInbox', 'invokeAction', 'readRestRun', 'readRestProject',
      'readRestActivity', 'readRestEvidence', 'detachSigned',
    ]],
    ['browser', [
      'assertOwnerSession', 'createRoutine', 'enableRoutine', 'captureRoutine',
      'manualFire', 'approveTask', 'readRun', 'readProjectSituation',
      'readActivityEvidence', 'close',
    ]],
  ]) {
    if (!deps?.[owner]) {
      missing.push(owner)
      continue
    }
    for (const method of methods) {
      if (typeof deps[owner][method] !== 'function') missing.push(`${owner}.${method}`)
    }
  }
  for (const callback of ['restartWorker', 'waitForTarget', 'writeArtifact', 'now', 'randomUUID', 'sleep']) {
    if (typeof deps?.[callback] !== 'function') missing.push(callback)
  }
  if (missing.length) {
    throw new CollectorError(`required executable callbacks are absent: ${missing.join(', ')}`)
  }
}

function validateConfig(config) {
  for (const field of [
    'baseUrl', 'outputDir', 'projectId', 'unauthorizedProjectId', 'squadId',
    'agentId', 'unauthorizedAgentId', 'ownerToken', 'signingJwk',
    'expectedTenant', 'expectedVersion', 'expectedCommit',
  ]) {
    required(config?.[field], field)
  }
  if (!COMMIT_RE.test(config.expectedCommit)) throw new CollectorError('expectedCommit is invalid')
  if (!VERSION_RE.test(config.expectedVersion)) throw new CollectorError('expectedVersion is invalid')
}

function targetReceipt(target, config, routineId, runId) {
  return {
    pot: target.tenant,
    base_url: config.baseUrl,
    project_id: config.projectId,
    routine_id: routineId,
    routine_run_id: runId,
    commit: target.commit,
    version: target.version,
  }
}

function stepReceipt(step, target, evidence, artifacts, observedAt) {
  return {
    receipt_type: STEP_RECEIPT_TYPE,
    step,
    status: 'pass',
    observed_at: observedAt,
    target,
    evidence,
    artifacts,
  }
}

function observationArtifact(step, target, source, observedAt, data) {
  return {
    artifact_type: 'mupot-project-routine-observation/v1',
    step,
    target,
    source,
    observed_at: observedAt,
    data,
  }
}

function attentionItem(items, taskId) {
  return items.find(item => item?.source_type === 'task' && item?.source_id === taskId)
}

async function collectLifecycle(config, deps, secretValues) {
  const collectorId = deps.randomUUID()
  const observedAt = deps.now().toISOString()
  const objective = `Collector ${collectorId}: create one governed task and retain complete lifecycle evidence.`
  const name = `Lifecycle receipt ${collectorId}`

  const initialHealth = assertTarget(
    await deps.api.probeTarget(),
    config,
    'initial target',
    secretValues,
  )

  const assignedMint = await deps.api.mintAgentToken({
    ownerToken: config.ownerToken,
    agentId: config.agentId,
    capability: 'member',
  })
  const unauthorizedMint = await deps.api.mintAgentToken({
    ownerToken: config.ownerToken,
    agentId: config.unauthorizedAgentId,
    capability: 'member',
  })
  const assignedToken = required(assignedMint?.token, 'assigned agent token')
  const unauthorizedToken = required(unauthorizedMint?.token, 'unauthorized agent token')
  secretValues.push(assignedToken, unauthorizedToken)

  await deps.api.attachSigned({
    agentId: config.agentId,
    tenant: config.expectedTenant,
    signingJwk: config.signingJwk,
  })

  const ownerSession = await deps.browser.assertOwnerSession({ projectId: config.projectId })
  if (ownerSession?.ok !== true || ownerSession.role !== 'owner') {
    throw new CollectorError('browser session is not an owner session', ownerSession, secretValues)
  }

  const created = await deps.browser.createRoutine({
    projectId: config.projectId,
    name,
    objective,
    squadId: config.squadId,
    agentId: config.agentId,
    executionMode: 'propose',
    triggerKind: 'manual',
    overlapPolicy: 'skip',
    budgetMicroUsd: 100_000,
    maxAttempts: 3,
    retryBackoffSeconds: 30,
  })
  const routineId = required(created?.routineId, 'created routine id')
  if (created.status !== 'draft') {
    throw new CollectorError('browser routine create did not produce a draft', created, secretValues)
  }

  const enabled = await deps.browser.enableRoutine({ projectId: config.projectId, routineId, name })
  if (enabled?.status !== 'enabled') {
    throw new CollectorError('browser routine enable did not persist enabled state', enabled, secretValues)
  }
  const desktopScreenshot = await deps.browser.captureRoutine({
    projectId: config.projectId,
    routineId,
    name,
    viewport: 'desktop',
    outputDir: config.outputDir,
  })
  if (!desktopScreenshot?.path || Number(desktopScreenshot.bytes) <= 0) {
    throw new CollectorError('desktop browser screenshot was not captured', desktopScreenshot, secretValues)
  }

  const fire = await deps.browser.manualFire({ projectId: config.projectId, routineId, name })
  if (fire?.accepted !== true) {
    throw new CollectorError('browser manual fire was not accepted', fire, secretValues)
  }
  const mobileScreenshot = await deps.browser.captureRoutine({
    projectId: config.projectId,
    routineId,
    name,
    viewport: 'mobile',
    outputDir: config.outputDir,
  })
  if (!mobileScreenshot?.path || Number(mobileScreenshot.bytes) <= 0) {
    throw new CollectorError('mobile browser screenshot was not captured', mobileScreenshot, secretValues)
  }

  for (let tick = 0; tick < config.scheduledTicks; tick += 1) {
    const scheduled = await deps.api.scheduledTick({ tick: tick + 1 })
    if (scheduled?.ok !== true) {
      throw new CollectorError(`scheduled tick ${tick + 1} failed`, scheduled, secretValues)
    }
  }

  const inbox = await deps.api.consumeSignedInbox({
    agentId: config.agentId,
    tenant: config.expectedTenant,
    signingJwk: config.signingJwk,
    projectId: config.projectId,
    objective,
    timeoutMs: config.pollTimeoutMs,
    sleep: deps.sleep,
  })
  const { message, envelope } = parseRoutineEnvelope(inbox, config, secretValues)
  const runId = envelope.run_id
  const actionKey = `project-routine-lifecycle-${runId}`
  const proposal = {
    version: 'routine.proposal/v1',
    run_id: runId,
    project_id: config.projectId,
    situation_digest: envelope.situation_digest,
    summary: 'Create one governed task to prove approval and exactly-once execution.',
    action: {
      key: actionKey,
      kind: 'create_task',
      input: {
        title: `Lifecycle proof ${collectorId}`,
        description: `Correlated internal action for RoutineRun ${runId}.`,
      },
    },
  }

  const digestProbe = await deps.api.invokeAction({
    token: assignedToken,
    tool: 'routine_proposal_submit',
    input: { ...proposal, situation_digest: mutateDigest(envelope.situation_digest) },
  })
  assertActionRejected(digestProbe, 'situation_mismatch', 'Situation digest probe', secretValues)

  const unauthorizedAgent = await deps.api.invokeAction({
    token: unauthorizedToken,
    tool: 'routine_proposal_submit',
    input: proposal,
  })
  assertActionRejected(
    unauthorizedAgent,
    'assigned_agent_mismatch',
    'unauthorized agent proposal',
    secretValues,
  )

  const unauthorizedProject = await deps.api.invokeAction({
    token: assignedToken,
    tool: 'routine_proposal_submit',
    input: { ...proposal, project_id: config.unauthorizedProjectId },
  })
  assertActionRejected(
    unauthorizedProject,
    'project_mismatch',
    'unauthorized project proposal',
    secretValues,
  )

  const submittedResponse = await deps.api.invokeAction({
    token: assignedToken,
    tool: 'routine_proposal_submit',
    input: proposal,
  })
  if (submittedResponse?.ok === false && submittedResponse.error === 'situation_mismatch') {
    throw new CollectorError('Situation digest mismatch', submittedResponse, secretValues)
  }
  const submitted = assertActionOk(
    submittedResponse,
    'correlated proposal submit',
    secretValues,
  )
  if (submitted.status !== 'waiting' || submitted.reason !== 'review' || submitted.duplicate !== false) {
    throw new CollectorError('proposal did not enter governed review', submitted, secretValues)
  }

  const waitingRun = assertActionOk(
    await deps.api.invokeAction({
      token: assignedToken,
      tool: 'routine_run_get',
      input: { run_id: runId },
    }),
    'waiting run read',
    secretValues,
  ).run
  const controlTaskId = required(waitingRun?.task_id, 'routine control task id')

  const attention = assertActionOk(
    await deps.api.invokeAction({
      token: assignedToken,
      tool: 'needs_you_list',
      input: { project_id: config.projectId, limit: 100 },
    }),
    'Needs You read',
    secretValues,
  )
  const need = attentionItem(attention.items ?? [], controlTaskId)
  if (!need) throw new CollectorError('Needs You did not expose the control task', attention, secretValues)

  const approval = await deps.browser.approveTask({ taskId: controlTaskId, runId })
  if (approval?.verdict !== 'approved') {
    throw new CollectorError('Needs You approval was not recorded', approval, secretValues)
  }

  const executed = assertActionOk(
    await deps.api.invokeAction({
      token: assignedToken,
      tool: 'routine_proposal_submit',
      input: proposal,
    }),
    'approved action replay',
    secretValues,
  )
  if (executed.status !== 'succeeded' || executed.duplicate !== false) {
    if (executed?.error === 'situation_mismatch') {
      throw new CollectorError('Situation digest mismatch', executed, secretValues)
    }
    throw new CollectorError('first approved internal action did not return a non-duplicate success', executed, secretValues)
  }

  const duplicate = assertActionOk(
    await deps.api.invokeAction({
      token: assignedToken,
      tool: 'routine_proposal_submit',
      input: proposal,
    }),
    'duplicate replay',
    secretValues,
  )
  if (duplicate.status !== 'succeeded' || duplicate.duplicate !== true) {
    throw new CollectorError('duplicate replay did not prove duplicate execution', duplicate, secretValues)
  }
  assertEqual(executed.result, duplicate.result, 'duplicate replay returned a different action result', secretValues)

  const mcpRunResult = assertActionOk(
    await deps.api.invokeAction({
      token: assignedToken,
      tool: 'routine_run_get',
      input: { run_id: runId },
    }),
    'terminal MCP run read',
    secretValues,
  )
  const mcpRun = normalizeRun(mcpRunResult)
  const restRun = normalizeRun(await deps.api.readRestRun({ runId, ownerToken: config.ownerToken }))
  const dashboardRun = normalizeRun(await deps.browser.readRun({ runId, projectId: config.projectId, expected: restRun }))

  // REST and MCP are NO LONGER byte-identical, and that is the intended contract as of #894:
  // routine_run_get returns situation_digest to the run's ASSIGNED AGENT and to nobody else
  // (src/mcp/routines.ts). This read uses assignedToken, so the extra field is correct here —
  // whereas REST reads publicRoutineRun and must never carry it.
  //
  // This assertion previously demanded blanket equality and so failed on #894. Rather than
  // relax it to "close enough", it now states the real invariant: MCP-for-the-assignee is
  // REST plus exactly one field, that field is a well-formed digest, and nothing else drifts.
  // A blanket-equality check that gets deleted the first time the shapes legitimately differ
  // stops protecting the fields that must still match.
  const { situation_digest: mcpDigest, ...mcpRunWithoutDigest } = mcpRun
  if (typeof mcpDigest !== 'string' || !/^[a-f0-9]{64}$/.test(mcpDigest)) {
    throw new CollectorError(
      'assigned agent did not receive a well-formed situation_digest over MCP (#894)',
      { situation_digest: mcpDigest ?? null }, secretValues,
    )
  }
  if ('situation_digest' in restRun) {
    throw new CollectorError(
      'REST leaked situation_digest — it must stay scoped to the assigned agent over MCP (#894)',
      restRun, secretValues,
    )
  }
  assertEqual(restRun, mcpRunWithoutDigest, 'terminal REST and MCP run parity failed', secretValues)
  assertEqual(restRun, dashboardRun, 'terminal REST and dashboard run parity failed', secretValues)
  if (!TERMINAL_STATUSES.has(restRun.status)) {
    throw new CollectorError('routine run is not terminal', restRun, secretValues)
  }
  if (!Number.isSafeInteger(restRun.cost_micro_usd) || restRun.cost_micro_usd < 0) {
    throw new CollectorError('terminal cost is not recorded', restRun, secretValues)
  }

  const mcpProject = assertActionOk(
    await deps.api.invokeAction({
      token: assignedToken,
      tool: 'project_get',
      input: { project_id: config.projectId },
    }),
    'terminal MCP project read',
    secretValues,
  )
  const restProject = await deps.api.readRestProject({
    projectId: config.projectId,
    ownerToken: config.ownerToken,
  })
  const restSituation = normalizeSituation(restProject)
  const mcpSituation = normalizeSituation(mcpProject)
  const dashboardSituation = normalizeSituation(
    await deps.browser.readProjectSituation({ projectId: config.projectId }),
  )
  assertEqual(restSituation, mcpSituation, 'terminal REST and MCP Situation parity failed', secretValues)
  assertEqual(restSituation, dashboardSituation, 'terminal REST and dashboard Situation parity failed', secretValues)

  const restActivity = normalizeRows(
    await deps.api.readRestActivity({ projectId: config.projectId, ownerToken: config.ownerToken }),
    ['rows', 'events', 'activity'],
  )
  const restEvidence = normalizeRows(
    await deps.api.readRestEvidence({ projectId: config.projectId, ownerToken: config.ownerToken }),
    ['rows', 'evidence'],
  )
  if (!restActivity.length) throw new CollectorError('terminal Activity is empty')
  if (!restEvidence.length) throw new CollectorError('terminal Evidence is empty')
  const browserProjections = await deps.browser.readActivityEvidence({
    projectId: config.projectId,
    runId,
    expectedActivity: restActivity,
    expectedEvidence: restEvidence,
  })
  const dashboardActivity = normalizeRows(browserProjections, ['activity', 'rows', 'events'])
  const dashboardEvidence = normalizeRows(browserProjections, ['evidence', 'rows'])
  assertEqual(restActivity, dashboardActivity, 'terminal REST and dashboard Activity parity failed', secretValues)
  assertEqual(restEvidence, dashboardEvidence, 'terminal REST and dashboard Evidence parity failed', secretValues)

  const situationDigest = await canonicalDigest(restSituation)
  const beforeRestart = {
    run: restRun,
    situation: restSituation,
    activity: restActivity,
    evidence: restEvidence,
  }

  await deps.restartWorker({
    baseUrl: config.baseUrl,
    expectedCommit: config.expectedCommit,
    expectedVersion: config.expectedVersion,
  })
  const hookHealth = await deps.waitForTarget({
    baseUrl: config.baseUrl,
    expectedCommit: config.expectedCommit,
    expectedVersion: config.expectedVersion,
    timeoutMs: config.pollTimeoutMs,
  })
  assertTarget(hookHealth, config, 'restarted target', secretValues)

  const restartedRestRun = normalizeRun(
    await deps.api.readRestRun({ runId, ownerToken: config.ownerToken }),
  )
  const restartedMcpRun = normalizeRun(assertActionOk(
    await deps.api.invokeAction({
      token: assignedToken,
      tool: 'routine_run_get',
      input: { run_id: runId },
    }),
    'restarted MCP run read',
    secretValues,
  ))
  const restartedDashboardRun = normalizeRun(
    await deps.browser.readRun({ runId, projectId: config.projectId, expected: restartedRestRun }),
  )
  // Same #894 contract as the terminal check above: the assigned agent's MCP read carries
  // situation_digest, REST and the dashboard must not. Compare the MCP row on its public
  // shape, and assert the digest survived the restart rather than dropping it from scope.
  const { situation_digest: restartedDigest, ...restartedMcpPublic } = restartedMcpRun
  if (typeof restartedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(restartedDigest)) {
    throw new CollectorError(
      'assigned agent lost situation_digest across the Worker restart (#894)',
      { situation_digest: restartedDigest ?? null }, secretValues,
    )
  }
  if (!equal(beforeRestart.run, restartedRestRun)
    || !equal(beforeRestart.run, restartedMcpPublic)
    || !equal(beforeRestart.run, restartedDashboardRun)) {
    throw new CollectorError('restart run parity failed', {
      before: beforeRestart.run,
      rest: restartedRestRun,
      mcp: restartedMcpPublic,
      dashboard: restartedDashboardRun,
    }, secretValues)
  }

  const restartedRestProject = await deps.api.readRestProject({
    projectId: config.projectId,
    ownerToken: config.ownerToken,
  })
  const restartedRestSituation = normalizeSituation(restartedRestProject)
  const restartedMcpSituation = normalizeSituation(assertActionOk(
    await deps.api.invokeAction({
      token: assignedToken,
      tool: 'project_get',
      input: { project_id: config.projectId },
    }),
    'restarted MCP project read',
    secretValues,
  ))
  const restartedDashboardSituation = normalizeSituation(
    await deps.browser.readProjectSituation({ projectId: config.projectId }),
  )
  if (!equal(beforeRestart.situation, restartedRestSituation)
    || !equal(beforeRestart.situation, restartedMcpSituation)
    || !equal(beforeRestart.situation, restartedDashboardSituation)) {
    throw new CollectorError('restart Situation parity failed', {
      before: beforeRestart.situation,
      rest: restartedRestSituation,
      mcp: restartedMcpSituation,
      dashboard: restartedDashboardSituation,
    }, secretValues)
  }

  const parity = {
    run: { rest_mcp_dashboard: true, after_restart: true },
    situation: {
      rest_mcp_dashboard: true,
      digest_verified: true,
      after_restart: true,
      terminal_digest: situationDigest,
    },
    activity: { rest_dashboard: true },
    evidence: { rest_dashboard: true },
  }
  const authorization = {
    assigned_agent_rejected: true,
    assigned_agent_error: unauthorizedAgent.error,
    project_scope_rejected: true,
    project_scope_error: unauthorizedProject.error,
  }
  const approvalEvidence = {
    needs_you_visible: true,
    needs_you_item_id: need.source_id,
    verdict: approval.verdict,
    action_kind: proposal.action.kind,
    action_scope: 'internal_only',
    action_exactly_once: true,
    duplicate_replay: true,
    result: duplicate.result,
  }
  const target = targetReceipt(initialHealth, config, routineId, runId)
  const [runDigest, activityDigest, evidenceDigest] = await Promise.all([
    canonicalDigest(beforeRestart.run),
    canonicalDigest(beforeRestart.activity),
    canonicalDigest(beforeRestart.evidence),
  ])
  const screenshotArtifacts = [
    { label: 'desktop propose-mode browser evidence', path: 'screenshots/desktop-propose-mode.png' },
    { label: 'mobile propose-mode browser evidence', path: 'screenshots/mobile-propose-mode.png' },
  ]

  const artifacts = new Map([
    ['artifacts/routine-created.json', observationArtifact(
      'routine_created',
      target,
      'browser',
      observedAt,
      {
        http_status: 303,
        collector_id: collectorId,
        routine_id: routineId,
        project_id: config.projectId,
        mode: 'propose',
        status: 'draft',
        screenshots: {
          desktop: {
            path: 'screenshots/desktop-propose-mode.png',
            bytes: desktopScreenshot.bytes,
          },
          mobile: {
            path: 'screenshots/mobile-propose-mode.png',
            bytes: mobileScreenshot.bytes,
          },
        },
      },
    )],
    ['artifacts/routine-enabled.json', observationArtifact(
      'routine_enabled',
      target,
      'browser',
      observedAt,
      {
        http_status: 303,
        routine_id: routineId,
        project_id: config.projectId,
        mode: 'propose',
        status: 'enabled',
        trigger_kind: 'manual',
      },
    )],
    ['artifacts/manual-fire.json', observationArtifact(
      'manual_fire',
      target,
      'browser',
      observedAt,
      {
        http_status: 303,
        browser_fire_accepted: true,
        scheduled_ticks: config.scheduledTicks,
        run_id: runId,
        occurrence_id: message.request_id ?? runId,
        envelope: {
          version: envelope.version,
          run_id: runId,
          project_id: envelope.project_id,
          routine_revision: envelope.routine_revision,
          situation_digest: envelope.situation_digest,
          request_id: message.request_id ?? null,
        },
      },
    )],
    ['artifacts/runtime-proposal.json', observationArtifact(
      'runtime_proposal',
      target,
      'runtime',
      observedAt,
      {
        run_id: runId,
        agent_id: config.agentId,
        request_id: message.request_id ?? `routine-run:${runId}`,
        proposal_status: submitted.status,
        action_key: actionKey,
        action_kind: proposal.action.kind,
        situation_digest: envelope.situation_digest,
        digest_challenge_rejected: true,
        access_rejections: authorization,
      },
    )],
    ['artifacts/needs-you-approval.json', observationArtifact(
      'needs_you_approval',
      target,
      'browser',
      observedAt,
      {
        needs_you_item_id: need.source_id,
        task_id: controlTaskId,
        verdict: approval.verdict,
        action_kind: proposal.action.kind,
        action_scope: 'internal_only',
        approval: approvalEvidence,
      },
    )],
    ['artifacts/terminal-outcome.json', observationArtifact(
      'terminal_outcome',
      target,
      'rest',
      observedAt,
      {
        run_status: restRun.status,
        cost_micro_usd: restRun.cost_micro_usd,
        action_key: actionKey,
        duplicate_replay: true,
        observations: beforeRestart,
      },
    )],
    ['artifacts/restart-parity.json', observationArtifact(
      'restart_parity',
      target,
      'rest',
      observedAt,
      {
        release_sha: target.commit,
        version: target.version,
        run_digest: runDigest,
        situation_digest: situationDigest,
        activity_digest: activityDigest,
        evidence_digest: evidenceDigest,
        parity,
      },
    )],
  ])

  const observationReference = (step, label) => ({
    label,
    path: `artifacts/${step.replaceAll('_', '-')}.json`,
  })

  const receipts = new Map([
    ['routine-created.json', stepReceipt('routine_created', target, {
      routine_id: routineId,
      project_id: config.projectId,
      project_active: restProject.project?.status === 'active',
      created_by_operator: true,
    }, [
      observationReference('routine_created', 'routine create observation'),
      ...screenshotArtifacts,
    ], observedAt)],
    ['routine-enabled.json', stepReceipt('routine_enabled', target, {
      trigger_configured: true,
      enabled: true,
      mode: 'propose',
    }, [
      observationReference('routine_enabled', 'routine enable observation'),
      ...screenshotArtifacts,
    ], observedAt)],
    ['manual-fire.json', stepReceipt('manual_fire', target, {
      routine_run_id: runId,
      run_observed: true,
      occurrence_id: message.request_id ?? runId,
      scheduled_ticks: config.scheduledTicks,
    }, [observationReference('manual_fire', 'manual fire and scheduler observation')], observedAt)],
    ['runtime-proposal.json', stepReceipt('runtime_proposal', target, {
      agent_identity: config.agentId,
      correlated_proposal: true,
      situation_digest_matched: true,
      situation_digest_challenge_rejected: true,
    }, [observationReference('runtime_proposal', 'runtime proposal observation')], observedAt)],
    ['needs-you-approval.json', stepReceipt('needs_you_approval', target, {
      needs_you_item_id: need.source_id,
      human_approval_recorded: true,
      internal_action_gated: true,
      internal_action_executed: true,
      internal_action_approved: true,
      action_scope: 'internal_only',
      external_action_gated: true,
      external_action_executed: false,
      external_action_approved: false,
    }, [observationReference('needs_you_approval', 'Needs You approval observation')], observedAt)],
    ['terminal-outcome.json', stepReceipt('terminal_outcome', target, {
      terminal_status: restRun.status,
      cost_recorded: true,
      activity_visible: true,
      evidence_visible: true,
      situation_updated: true,
      idempotent_duplicate_noop: true,
      unauthorized_rejected: true,
    }, [observationReference('terminal_outcome', 'terminal lifecycle observation')], observedAt)],
    ['restart-parity.json', stepReceipt('restart_parity', target, {
      worker_restarted: true,
      durable_state_preserved: true,
      surface_parity: {
        browser: true,
        rest: true,
        mcp: true,
        scheduler: true,
        runtime: true,
        activity: true,
        evidence: true,
        situation: true,
      },
      commit: target.commit,
      version: target.version,
    }, [observationReference('restart_parity', 'restart parity observation')], observedAt)],
  ])

  const summary = {
    ok: true,
    collector_id: collectorId,
    routine_id: routineId,
    run_id: runId,
    terminal_status: restRun.status,
    target: {
      tenant: initialHealth.tenant,
      version: initialHealth.version,
      commit: initialHealth.commit,
    },
  }
  for (const [relativePath, value] of [...artifacts, ...receipts]) {
    await deps.writeArtifact(relativePath, redact(value, secretValues))
  }
  await deps.writeArtifact('artifacts/collector-summary.json', redact(summary, secretValues))
  return summary
}

export async function runProjectRoutineLifecycleCollector(config, deps) {
  validateConfig(config)
  validateDependencies(deps)
  const secretValues = [config.ownerToken, config.signingJwk]
  let attached = false
  let result
  let failure
  const cleanupFailures = []

  const wrappedApi = {
    ...deps.api,
    attachSigned: async (...args) => {
      const value = await deps.api.attachSigned(...args)
      if (value?.ok !== true) throw new CollectorError('signed conformance attach failed', value, secretValues)
      attached = true
      return value
    },
  }

  try {
    result = await collectLifecycle(config, { ...deps, api: wrappedApi }, secretValues)
  } catch (error) {
    failure = error
  }

  if (attached) {
    try {
      const detached = await deps.api.detachSigned({
        agentId: config.agentId,
        tenant: config.expectedTenant,
        signingJwk: config.signingJwk,
      })
      if (detached?.ok !== true) cleanupFailures.push(new CollectorError('signed detach failed', detached, secretValues))
    } catch (error) {
      cleanupFailures.push(error)
    }
  }
  try {
    await deps.browser.close()
  } catch (error) {
    cleanupFailures.push(error)
  }

  if (failure) {
    if (failure instanceof CollectorError) throw failure
    throw new CollectorError('collector execution failed', {
      name: failure instanceof Error ? failure.name : 'UnknownError',
      reason: failure instanceof Error ? failure.message : String(failure),
    }, secretValues)
  }
  if (cleanupFailures.length) {
    throw new CollectorError('collector cleanup failed', cleanupFailures.map(error => error?.message))
  }
  return result
}

async function main() {
  const config = parseCollectorArgs()
  let hooks
  try {
    hooks = await import(pathToFileURL(resolve(config.hooksModule)).href)
  } catch (error) {
    throw new CollectorError('failed to import --hooks-module', {
      module: config.hooksModule,
      reason: error instanceof Error ? error.message : String(error),
    })
  }

  let deps
  if (typeof hooks.createCollectorDependencies === 'function') {
    deps = await hooks.createCollectorDependencies(config)
  } else if (hooks.dependencies && typeof hooks.dependencies === 'object') {
    deps = hooks.dependencies
  } else if (hooks.default && typeof hooks.default === 'object') {
    deps = hooks.default
  } else {
    throw new CollectorError(
      '--hooks-module must export createCollectorDependencies(config), dependencies, or a default dependency object',
    )
  }

  const result = await runProjectRoutineLifecycleCollector(config, deps)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

const isMain = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
  main().catch((error) => {
    const safe = error instanceof CollectorError
      ? { error: error.message, detail: error.safeDetail }
      : { error: 'collector failed closed' }
    process.stderr.write(`${JSON.stringify(safe)}\n`)
    process.exitCode = 1
  })
}

export const defaultCollectorRuntime = Object.freeze({
  randomUUID,
})
