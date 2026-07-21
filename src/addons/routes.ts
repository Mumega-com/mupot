import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import type { Context } from 'hono'
import type { Env, AuthContext } from '../types'
import { requireAuth } from '../auth'
import { isOrgAdmin } from '../auth/capability'
import { resolveOrgAdmin } from '../auth/member-bearer'
import './modules'
import { getRegisteredAddon, listRegisteredAddons } from './registry'
import { validateBindingInputs, type AddonBindingInput } from './bindings'
import {
  activateAddon,
  archiveAddon,
  countAddonOwnershipClaims,
  configureAddon,
  disableAddon,
  getAddonReceipts,
  getBusinessStateSha256,
  getDepartmentStateSha256,
  installAddon,
  listAddonInstallations,
  type AddonInstallation,
  type AddonMutationResult,
  type AddonReceipt,
} from './service'
import {
  MAX_MARKETING_MONITOR_RUN_LIST,
  canonicalMarketingMonitorWindow,
  getLatestMarketingMonitorRun,
  listMarketingMonitorRuns,
  prepareMarketingRecommendation,
  runMarketingMonitor,
  type MarketingRecommendation,
  type MarketingRecommendationFailureReason,
  type MarketingMonitorFailureReason,
} from './marketing/service'
import type {
  MarketingMonitorRun,
  MarketingMonitorRunSource,
  MarketingOutcomes,
  MonitorWindow,
  SourceStatus,
} from './marketing/types'

const MAX_BODY_BYTES = 8192

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }
type LifecycleAction = 'install' | 'configure' | 'activate' | 'disable' | 'archive'

function archivedLifecycleTimestamp(installation: AddonInstallation): string {
  return installation.archivedAt ?? installation.updatedAt
}

function latestInstallationsByKey(installations: AddonInstallation[]): Map<string, AddonInstallation> {
  const byKey = new Map<string, AddonInstallation>()
  for (const installation of installations) {
    const current = byKey.get(installation.addonKey)
    if (!current || (
      current.state === 'archived' && (
        installation.state !== 'archived' || (
          installation.state === 'archived' &&
          archivedLifecycleTimestamp(installation) > archivedLifecycleTimestamp(current)
        )
      )
    )) {
      byKey.set(installation.addonKey, installation)
    }
  }
  return byKey
}

function catalogAddon(entry: ReturnType<typeof listRegisteredAddons>[number], installation: AddonInstallation | undefined) {
  return {
    key: entry.manifest.key,
    name: entry.manifest.name,
    version: entry.manifest.version,
    publisher: entry.manifest.publisher,
    trustClass: entry.manifest.trustClass,
    kind: entry.manifest.kind,
    description: entry.manifest.description,
    state: installation?.state ?? null,
  }
}

interface PublicAddonReceipt {
  readonly sequence: number
  readonly action: string
  readonly previousState: AddonReceipt['previousState']
  readonly nextState: AddonReceipt['nextState']
  readonly addonKey: string
  readonly installedVersion: string
  readonly manifestSha256: string
  readonly mupotCompatibility: string
  readonly publisher: string
  readonly trustClass: AddonReceipt['trustClass']
  readonly outcome: AddonReceipt['outcome']
  readonly errorCode: string | null
  readonly createdAt: string
}

interface PublicMarketingMonitorSource {
  readonly slot: string
  readonly status: SourceStatus
  readonly reason?: string
  readonly observationCount: number
}

interface PublicMarketingMonitorRun {
  readonly id: string
  readonly status: 'completed'
  readonly window: MonitorWindow
  readonly sourceCount: number
  readonly observationCount: number
  readonly sources: readonly PublicMarketingMonitorSource[]
  readonly outcomes: MarketingOutcomes
  readonly evidenceDigest: string
  readonly completedAt: string
}

interface PublicMarketingRecommendation {
  readonly kind: string
  readonly target: string
  readonly problem: string
  readonly hypothesis: string
  readonly primaryKpi: string
  readonly kpiBaseline: MarketingRecommendation['kpiBaseline']
  readonly limitingEvidence: MarketingRecommendation['limitingEvidence']
  readonly evidenceDigest: string
  readonly approval: MarketingRecommendation['approval']
  readonly terminalAction: MarketingRecommendation['terminalAction']
  readonly receiptDigest: string
  readonly createdAt: string
  readonly preparedAt: string
  readonly links: {
    readonly reviewTask: '/approvals'
    readonly flightRecord: '/flights'
  }
}

function publicReceipt(receipt: AddonReceipt): PublicAddonReceipt {
  return {
    sequence: receipt.sequence,
    action: receipt.action,
    previousState: receipt.previousState,
    nextState: receipt.nextState,
    addonKey: receipt.addonKey,
    installedVersion: receipt.installedVersion,
    manifestSha256: receipt.manifestSha256,
    mupotCompatibility: receipt.mupotCompatibility,
    publisher: receipt.publisher,
    trustClass: receipt.trustClass,
    outcome: receipt.outcome,
    errorCode: receipt.errorCode,
    createdAt: receipt.createdAt,
  }
}

function publicMonitorSource(source: MarketingMonitorRunSource): PublicMarketingMonitorSource {
  return {
    slot: source.slot,
    status: source.status,
    ...(source.reason === undefined ? {} : { reason: source.reason }),
    observationCount: source.observationCount,
  }
}

function publicMonitorRun(run: MarketingMonitorRun): PublicMarketingMonitorRun {
  return {
    id: run.id,
    status: run.status,
    window: { start: run.window.start, end: run.window.end },
    sourceCount: run.sourceCount,
    observationCount: run.observationCount,
    sources: run.sources.map(publicMonitorSource),
    outcomes: run.outcomes,
    evidenceDigest: run.evidenceDigest,
    completedAt: run.completedAt,
  }
}

function publicRecommendation(recommendation: MarketingRecommendation): PublicMarketingRecommendation {
  return {
    kind: recommendation.kind,
    target: recommendation.target,
    problem: recommendation.problem,
    hypothesis: recommendation.hypothesis,
    primaryKpi: recommendation.primaryKpi,
    kpiBaseline: recommendation.kpiBaseline,
    limitingEvidence: recommendation.limitingEvidence,
    evidenceDigest: recommendation.evidenceDigest,
    approval: recommendation.approval,
    terminalAction: recommendation.terminalAction,
    receiptDigest: recommendation.receiptDigest,
    createdAt: recommendation.createdAt,
    preparedAt: recommendation.preparedAt,
    links: {
      reviewTask: '/approvals',
      flightRecord: '/flights',
    },
  }
}

async function readBoundedBody(c: Context<AppEnv>) {
  const declaredLength = Number(c.req.header('content-length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return { ok: false as const, status: 413 as const }

  const stream = c.req.raw.body
  if (!stream) return { ok: true as const, raw: '' }
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > MAX_BODY_BYTES) {
        await reader.cancel()
        return { ok: false as const, status: 413 as const }
      }
      chunks.push(value)
    }
  } catch {
    return { ok: false as const, status: 400 as const }
  }

  const body = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return {
      ok: true as const,
      raw: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body),
    }
  } catch {
    return { ok: false as const, status: 400 as const }
  }
}

function parseConfigureBody(
  raw: string,
  maximumBindings: number,
): { ok: true; bindings: AddonBindingInput[] } | { ok: false } {
  if (raw.length === 0) return { ok: true, bindings: [] }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { ok: false }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false }
  const body = value as Record<string, unknown>
  if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'bindings') || !Array.isArray(body.bindings)) {
    return { ok: false }
  }
  // Shared with the addon_configure MCP tool (src/mcp/addons.ts) — see
  // validateBindingInputs' docstring in src/addons/bindings.ts for why this is the
  // ONE validator both entry points call, rather than two hand-kept-in-sync copies.
  return validateBindingInputs(body.bindings, maximumBindings)
}

function parseMonitorBody(raw: string): { ok: true; window: MonitorWindow } | { ok: false } {
  if (raw.length === 0) return { ok: false }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { ok: false }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false }
  const body = value as Record<string, unknown>
  if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'window')) return { ok: false }
  const window = canonicalMarketingMonitorWindow(body.window)
  return window ? { ok: true, window } : { ok: false }
}

function parseRecommendationBody(raw: string): { ok: true; runId: string } | { ok: false } {
  if (raw.length === 0) return { ok: false }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { ok: false }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false }
  const body = value as Record<string, unknown>
  if (Object.keys(body).length !== 1 || typeof body.runId !== 'string' || body.runId.length === 0) {
    return { ok: false }
  }
  return { ok: true, runId: body.runId }
}

function parseMonitorLimit(url: string): number | null {
  const parameters = new URL(url).searchParams
  const keys = [...parameters.keys()]
  if (keys.some((key) => key !== 'limit') || parameters.getAll('limit').length > 1) return null
  const raw = parameters.get('limit')
  if (raw === null) return 20
  if (!/^[1-9]\d*$/.test(raw)) return null
  const limit = Number(raw)
  return Number.isInteger(limit) && limit <= MAX_MARKETING_MONITOR_RUN_LIST ? limit : null
}

function monitorError(reason: MarketingMonitorFailureReason) {
  switch (reason) {
    case 'not_authorized':
      return { status: 403 as const, body: { error: 'forbidden', detail: 'owner/admin only' } }
    case 'invalid_window':
    case 'invalid_limit':
      return { status: 400 as const, body: { error: reason } }
    case 'addon_not_active':
    case 'addon_identity_mismatch':
    case 'binding_generation_not_live':
    case 'collection_invalid':
    case 'fence_lost':
      return { status: 409 as const, body: { error: reason } }
    case 'collection_failed':
    case 'stored_run_invalid':
    case 'write_failed':
      return { status: 500 as const, body: { error: reason } }
  }
}

function recommendationError(reason: MarketingRecommendationFailureReason) {
  switch (reason) {
    case 'not_authorized':
      return { status: 403 as const, body: { error: 'forbidden', detail: 'owner/admin only' } }
    case 'invalid_window':
    case 'invalid_limit':
      return { status: 400 as const, body: { error: reason } }
    case 'addon_not_active':
    case 'addon_identity_mismatch':
    case 'binding_generation_not_live':
    case 'collection_invalid':
    case 'fence_lost':
    case 'run_not_latest':
    case 'no_opportunity':
    case 'approval_policy_missing':
    case 'web_operations_squad_not_found':
    case 'recommendation_busy':
      return { status: 409 as const, body: { error: reason } }
    case 'collection_failed':
    case 'stored_run_invalid':
    case 'write_failed':
      return { status: 500 as const, body: { error: reason } }
  }
}

function mutationError(result: Extract<AddonMutationResult, { ok: false }>) {
  switch (result.reason) {
    case 'addon_not_registered':
      return { status: 404 as const, body: { error: result.reason } }
    case 'not_authorized':
      return { status: 403 as const, body: { error: 'forbidden', detail: 'owner/admin only' } }
    case 'invalid_state':
    case 'manifest_digest_drift':
    case 'missing_required_slot':
    case 'unknown_slot':
    case 'adapter_not_allowed':
    case 'binding_kind_mismatch':
    case 'connector_not_available':
    case 'adapter_type_mismatch':
    case 'capability_mismatch':
    case 'operation_busy':
    case 'fence_lost':
      return { status: 409 as const, body: { error: result.reason, state: result.state ?? null } }
    case 'write_failed':
      return { status: 500 as const, body: { error: result.reason } }
  }
}

async function mutate(c: Context<AppEnv>, action: LifecycleAction) {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) return c.json({ error: 'forbidden', detail: 'owner/admin only' }, 403)

  const key = c.req.param('key')
  if (!key) return c.json({ error: 'addon_not_registered' }, 404)
  const entry = getRegisteredAddon(key)
  if (!entry) return c.json({ error: 'addon_not_registered' }, 404)

  const body = await readBoundedBody(c)
  if (!body.ok) return c.json({ error: body.status === 413 ? 'payload_too_large' : 'invalid_body' }, body.status)
  let configureInput: { bindings: AddonBindingInput[] } | undefined
  if (action === 'configure') {
    const parsed = parseConfigureBody(body.raw, entry.manifest.connectorRequirements.length)
    if (!parsed.ok) return c.json({ error: 'invalid_body' }, 400)
    configureInput = { bindings: parsed.bindings }
  } else if (body.raw.length !== 0) {
    return c.json({ error: 'invalid_body' }, 400)
  }

  const actor = { id: auth.userId, role: auth.role }

  let result: AddonMutationResult
  try {
    result = action === 'configure'
      ? await configureAddon(c.env, actor, key, configureInput)
      : await {
          install: installAddon,
          activate: activateAddon,
          disable: disableAddon,
          archive: archiveAddon,
        }[action](c.env, actor, key)
  } catch {
    return c.json({ error: 'write_failed' }, 500)
  }
  if (!result.ok) {
    const error = mutationError(result)
    return c.json(error.body, error.status)
  }

  return c.json(
    { ok: true, key, state: result.state, ...(result.idempotent ? { idempotent: true } : {}) },
    action === 'install' && result.created ? 201 : 200,
  )
}

export const addonsApp = new Hono<AppEnv>()

const cookieCsrf = csrf()
function hasSessionCookie(c: Context<AppEnv>): boolean {
  return /(?:^|;\s*)mupot_session=/.test(c.req.header('cookie') ?? '')
}

addonsApp.use('*', (c, next) => (
  hasSessionCookie(c) ? cookieCsrf(c, next) : next()
))
addonsApp.use('*', async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return next()
  if (!hasSessionCookie(c)) return next()

  const origin = c.req.header('origin')
  const sameOrigin = origin === undefined
    ? c.req.header('sec-fetch-site') === 'same-origin'
    : origin === new URL(c.req.url).origin
  if (!sameOrigin) return c.text('Forbidden', 403)
  return next()
})
addonsApp.use('*', async (c, next) => {
  if (hasSessionCookie(c)) return requireAuth(c, next)

  let resolved: Awaited<ReturnType<typeof resolveOrgAdmin>>
  try {
    resolved = await resolveOrgAdmin(c.env, c.req.header('authorization'))
  } catch {
    return c.json({ error: 'unauthenticated' }, 401)
  }
  if (!resolved.ok) {
    return c.json({ error: resolved.status === 401 ? 'unauthenticated' : 'forbidden' }, resolved.status)
  }
  c.set('auth', {
    userId: resolved.id.memberId,
    memberId: resolved.id.memberId,
    email: resolved.id.email,
    role: 'admin',
    tenant: c.env.TENANT_SLUG,
    channel: 'workspace',
    boundAgentId: resolved.id.boundAgentId,
  })
  return next()
})

addonsApp.get('/', async (c) => {
  if (!isOrgAdmin(c.get('auth'))) return c.json({ error: 'forbidden', detail: 'owner/admin only' }, 403)

  try {
    const installations = latestInstallationsByKey(await listAddonInstallations(c.env))
    return c.json({ addons: listRegisteredAddons().map((entry) => catalogAddon(entry, installations.get(entry.manifest.key))) })
  } catch {
    return c.json({ error: 'read_failed' }, 500)
  }
})

addonsApp.post('/marketing-cro-monitor/monitor', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) return c.json({ error: 'forbidden', detail: 'owner/admin only' }, 403)
  const body = await readBoundedBody(c)
  if (!body.ok) return c.json({ error: body.status === 413 ? 'payload_too_large' : 'invalid_body' }, body.status)
  const parsed = parseMonitorBody(body.raw)
  if (!parsed.ok) return c.json({ error: 'invalid_body' }, 400)

  const result = await runMarketingMonitor(
    c.env,
    { id: auth.userId, role: auth.role },
    { window: parsed.window },
  )
  if (!result.ok) {
    const error = monitorError(result.reason)
    return c.json(error.body, error.status)
  }
  return c.json({
    ok: true,
    idempotent: result.idempotent,
    run: publicMonitorRun(result.run),
  }, result.idempotent ? 200 : 201)
})

addonsApp.get('/marketing-cro-monitor/monitor/latest', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) return c.json({ error: 'forbidden', detail: 'owner/admin only' }, 403)
  const result = await getLatestMarketingMonitorRun(c.env, { id: auth.userId, role: auth.role })
  if (!result.ok) {
    const error = monitorError(result.reason)
    return c.json(error.body, error.status)
  }
  return c.json({ run: result.run ? publicMonitorRun(result.run) : null })
})

addonsApp.get('/marketing-cro-monitor/monitor', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) return c.json({ error: 'forbidden', detail: 'owner/admin only' }, 403)
  const limit = parseMonitorLimit(c.req.url)
  if (limit === null) return c.json({ error: 'invalid_limit' }, 400)
  const result = await listMarketingMonitorRuns(c.env, { id: auth.userId, role: auth.role }, { limit })
  if (!result.ok) {
    const error = monitorError(result.reason)
    return c.json(error.body, error.status)
  }
  return c.json({ runs: result.runs.map(publicMonitorRun) })
})

addonsApp.post('/marketing-cro-monitor/recommendation', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) return c.json({ error: 'forbidden', detail: 'owner/admin only' }, 403)
  const body = await readBoundedBody(c)
  if (!body.ok) return c.json({ error: body.status === 413 ? 'payload_too_large' : 'invalid_body' }, body.status)
  const parsed = parseRecommendationBody(body.raw)
  if (!parsed.ok) return c.json({ error: 'invalid_body' }, 400)

  const result = await prepareMarketingRecommendation(
    c.env,
    { id: auth.userId, role: auth.role },
    parsed.runId,
  )
  if (!result.ok) {
    const error = recommendationError(result.reason)
    return c.json(error.body, error.status)
  }
  return c.json({
    ok: true,
    idempotent: result.idempotent,
    recommendation: publicRecommendation(result.recommendation),
  }, result.idempotent ? 200 : 201)
})

addonsApp.post('/:key/install', (c) => mutate(c, 'install'))
addonsApp.post('/:key/configure', (c) => mutate(c, 'configure'))
addonsApp.post('/:key/activate', (c) => mutate(c, 'activate'))
addonsApp.post('/:key/disable', (c) => mutate(c, 'disable'))
addonsApp.post('/:key/archive', (c) => mutate(c, 'archive'))

addonsApp.get('/:key/evidence', async (c) => {
  if (!isOrgAdmin(c.get('auth'))) return c.json({ error: 'forbidden', detail: 'owner/admin only' }, 403)
  const entry = getRegisteredAddon(c.req.param('key'))
  if (!entry) return c.json({ error: 'addon_not_registered' }, 404)

  try {
    return c.json({
      businessStateSha256: await getBusinessStateSha256(c.env),
      manifestSha256: entry.manifestSha256,
      installedVersion: entry.manifest.version,
      mupotCompatibility: entry.manifest.mupotCompatibility,
      publisher: entry.manifest.publisher,
      trustClass: entry.manifest.trustClass,
    })
  } catch {
    return c.json({ error: 'evidence_unavailable' }, 500)
  }
})

addonsApp.get('/:key/receipts', async (c) => {
  if (!isOrgAdmin(c.get('auth'))) return c.json({ error: 'forbidden', detail: 'owner/admin only' }, 403)

  if (!getRegisteredAddon(c.req.param('key'))) return c.json({ error: 'addon_not_registered' }, 404)
  try {
    const departmentStateSha256 = await getDepartmentStateSha256(c.env)
    const installation = latestInstallationsByKey(await listAddonInstallations(c.env)).get(c.req.param('key'))
    if (!installation) return c.json({ receipts: [], ownershipClaimCount: 0, departmentStateSha256 })
    return c.json({
      receipts: (await getAddonReceipts(c.env, installation.id)).map(publicReceipt),
      ownershipClaimCount: await countAddonOwnershipClaims(c.env, installation.id),
      departmentStateSha256,
    })
  } catch {
    return c.json({ error: 'receipt_unavailable' }, 500)
  }
})
