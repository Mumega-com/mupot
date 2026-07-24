#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const baseUrl = (process.env.MUPOT_LOCAL_URL || process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '')
const artifactsDir = path.resolve(process.env.MUPOT_SMOKE_ARTIFACTS || 'tmp/local-smoke')
const reportPath = path.join(artifactsDir, 'report.json')
const runtimeContract = 'runtime-adapter/v1'
const hermesLifecycle = 'Hermes IM lifecycle: Telegram update -> IM webhook -> chat_id member mapping -> capability gate -> fleet/approval/task effect -> reply'
const smokeRunId = new Date().toISOString().replace(/[:.]/g, '-')
const sendTaskTitle = `Browser workflow smoke ${smokeRunId}`
const approvalTaskTitle = `Approval workflow smoke ${smokeRunId}`
const hermesApprovalTaskTitle = `Hermes approval smoke ${smokeRunId}`
const hermesTaskTitle = `Hermes dashboard refresh ${smokeRunId}`
const hermesDirectiveText = `Hold all outbound automation until local browser smoke ${smokeRunId} is complete.`
const ownerProjectName = `Browser Project ${smokeRunId}`
const ownerProjectSlug = `browser-project-${Date.now()}`
const ownerProjectInitialGoal = 'Create a governed nested project through the dashboard.'
const ownerProjectEditedGoal = 'Prove the owner lifecycle is visible through the canonical Project situation.'
const connectionAgentSlug = `browser-connection-${Date.now()}`
const connectionAgentName = `Browser Connection ${smokeRunId}`
const mcpOwnerToken = process.env.MUPOT_CONFORMANCE_OWNER_TOKEN
  || ['local', 'runtime', 'conformance', 'owner', 'token'].join('-')

const pages = [
  '/',
  '/projects',
  '/projects/project-mupot',
  '/send',
  '/approvals',
  '/loops',
  '/services',
  '/economy',
  '/economy/billing',
  '/economy/wallet',
  '/economy/marketplace',
  '/verifications',
  '/audit',
  '/brain',
  '/departments/growth',
  '/flights',
  '/fleet',
  '/ops',
  '/coordination',
  '/agents',
  '/agents/connect',
  '/squads/sq-growth',
  '/agents/agent-hermes',
  '/admin/members',
  '/admin/divisions',
  '/admin/keys',
  '/admin/agent-token',
  '/admin/connectors',
  '/admin/github',
  '/admin/github/status',
  '/members',
  '/setup',
]

const hermesMessages = [
  { lifecycle: 'Hermes IM help lifecycle', text: 'help', expect: 'I can:' },
  { lifecycle: 'Hermes IM member status lifecycle', text: 'status', expect: 'Hermes Test Operator' },
  { lifecycle: 'Hermes IM agent status lifecycle', text: 'status hermes', expect: 'Hermes Local' },
  { lifecycle: 'Hermes IM fleet control lifecycle', text: 'fleet status agent-hermes', expect: 'Queued fleet status for Hermes Local Relay.' },
  { lifecycle: 'Hermes IM task lifecycle', text: `task: ${hermesTaskTitle} @growth`, expect: `Added to Growth Local: "${hermesTaskTitle}".` },
]

function fail(message, details) {
  const err = new Error(message)
  err.details = details
  throw err
}

export function validateRouteEvidence({ route, expectedUrl, finalUrl, errors, bodyText }) {
  if (errors.length > 0) {
    fail(`browser errors recorded for route: ${route}`, { errors })
  }

  const expected = new URL(expectedUrl)
  const actual = new URL(finalUrl)
  if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) {
    fail(`route redirected unexpectedly: ${route}`, { expectedUrl, finalUrl })
  }

  const normalizedText = bodyText.replace(/\s+/g, ' ').trim()
  if (normalizedText.length < 12 || /^(?:loading|please wait)[.!]*$/i.test(normalizedText)) {
    fail(`route did not render meaningful content: ${route}`, { bodyText })
  }
}

let browser
let context
let page
const consoleErrors = []

const results = []
const workflows = []

async function textSnippet(locator, limit = 240) {
  return (await locator.innerText({ timeout: 5_000 }).catch(() => '')).slice(0, limit)
}

async function documentOverflow() {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
}

async function assertNoDocumentOverflow(label) {
  const horizontalOverflow = await documentOverflow()
  if (horizontalOverflow > 1) fail(`${label} has document-level horizontal overflow`, { horizontalOverflow })
  return horizontalOverflow
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]))
}

function canonicalHash(value) {
  return createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex')
}

function comparedSituationFields(situation) {
  return {
    health: situation.health,
    blockerCount: situation.blockers.length,
    blockerDetailsTruncated: situation.blocker_details_truncated,
    pendingReviewCount: situation.pending_reviews.length,
    pendingReviewDetailsTruncated: situation.pending_review_details_truncated,
    taskCounts: situation.task_counts,
    taskCountsTruncated: situation.task_counts_truncated,
    activeWorkCount: situation.active_work_count,
    activeWorkCountTruncated: situation.active_work_count_truncated,
    activeFlightCount: situation.active_flight_count,
    activeFlightCountTruncated: situation.active_flight_count_truncated,
    snapshotTruncated: situation.snapshot_truncated,
    latestActivity: situation.latest_activity,
    nextAction: situation.next_action,
  }
}

async function readProjectRest(projectId) {
  const response = await context.request.get(`${baseUrl}/api/projects/${encodeURIComponent(projectId)}`, {
    timeout: 20_000,
  })
  const json = await response.json().catch(() => null)
  if (response.status() !== 200 || json?.project?.id !== projectId || !json?.situation) {
    fail('canonical Project REST read failed', { projectId, status: response.status(), json })
  }
  return json
}

async function grantProjectSquadWriteAccess(projectId, squadId) {
  const response = await context.request.put(`${baseUrl}/api/projects/${encodeURIComponent(projectId)}/squads/${encodeURIComponent(squadId)}`, {
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ access_level: 'write' }),
    timeout: 20_000,
  })
  const json = await response.json().catch(() => null)
  if (response.status() !== 200 || json?.squad?.squad_id !== squadId) {
    fail('project squad-access grant failed', { projectId, squadId, status: response.status(), json })
  }
  return json
}

async function readProjectMcp(projectId) {
  const response = await context.request.post(`${baseUrl}/actions/project_get`, {
    headers: {
      authorization: `Bearer ${mcpOwnerToken}`,
      'content-type': 'application/json',
    },
    data: { project_id: projectId },
    timeout: 20_000,
  })
  const json = await response.json().catch(() => null)
  if (response.status() !== 200 || !json?.ok || json?.result?.project?.id !== projectId || !json?.result?.situation) {
    fail('canonical Project MCP read failed', { projectId, status: response.status(), json })
  }
  return json.result
}

async function observeLifecycleStatus(projectId, command, expectedFrom, expectedTo) {
  const read = await readProjectRest(projectId)
  const observedPersistedStatus = read.project.status
  if (observedPersistedStatus !== expectedTo) {
    fail('Project lifecycle did not persist the expected status', {
      projectId,
      command,
      expectedTransition: { from: expectedFrom, to: expectedTo },
      observedPersistedStatus,
    })
  }
  return {
    command,
    expectedTransition: { from: expectedFrom, to: expectedTo },
    observedPersistedStatus,
    observedFrom: `GET /api/projects/${projectId}`,
  }
}

async function applyProjectLifecycleCommand(command, expectedResult, projectId, expectedFrom, expectedTo) {
  await page.goto(`${baseUrl}/projects/${encodeURIComponent(projectId)}/settings`, {
    waitUntil: 'networkidle',
    timeout: 20_000,
  })
  await page.locator('select[name="command"]').selectOption(command)
  await Promise.all([
    page.waitForURL(`${baseUrl}/projects/${encodeURIComponent(projectId)}?status=${expectedResult}`, { timeout: 10_000 }),
    page.getByRole('button', { name: 'Apply status' }).click(),
  ])
  const successText = await textSnippet(page.locator('[role="status"]'))
  if (!successText) fail('project lifecycle success state was not rendered', { command, expectedResult })
  return {
    successText,
    receipt: await observeLifecycleStatus(projectId, command, expectedFrom, expectedTo),
  }
}

async function runLoginWorkflow() {
  const me = await context.request.get(`${baseUrl}/auth/me`, { timeout: 20_000 })
  const json = await me.json().catch(() => null)
  if (me.status() !== 200 || json?.email !== 'local-owner@mupot.test') {
    fail('dev login auth context failed', { status: me.status(), json })
  }

  const anonymous = await fetch(`${baseUrl}/members`, { redirect: 'manual' })
  const location = anonymous.headers.get('location') ?? ''
  if (anonymous.status !== 302 || !location.includes('/auth/login')) {
    fail('unauthenticated dashboard gate did not redirect to login', {
      status: anonymous.status,
      location,
    })
  }

  workflows.push({
    name: 'owner login and auth gate',
    status: 'passed',
    email: json.email,
    anonymousRedirect: location,
  })
}

async function selectAdditionalAgentAccess(squadId, capability = 'member') {
  const row = page.locator(`[data-access-row][data-squad-id="${squadId}"]`)
  await row.waitFor({ state: 'visible', timeout: 10_000 })
  await row.locator('[data-access-check]').check()
  await row.locator('[data-access-capability]').selectOption(capability)
}

async function completeAgentConnection({
  expectedAgentId,
  expectedAgentSlug,
  expectedDisposition,
  expectedHomeSquadId,
  expectedAdditionalSquadId,
  screenshotName,
}) {
  await page.locator('#provision-button').click()
  await page.locator('#step-connect').waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('#step-verify').waitFor({ state: 'visible', timeout: 20_000 })

  // Keep show-once values in process memory only. They are never attached to a
  // workflow result, failure details, screenshot, URL, or artifact.
  const credential = (await page.locator('#show-credential').innerText()).trim()
  const challenge = (await page.locator('#show-challenge').innerText()).trim()
  await page.evaluate(() => {
    for (const id of ['show-credential', 'show-challenge', 'verify-arguments']) {
      const element = document.getElementById(id)
      if (element) element.textContent = '[removed after one-time capture]'
    }
  })
  if (!/^mupot_[0-9a-f]+$/.test(credential) || !/^[0-9a-f]{48}$/.test(challenge)) {
    fail('agent connection did not render valid show-once values')
  }

  const claudeConfig = await page.locator('#config-claude').innerText()
  const codexConfig = await page.locator('#config-codex').innerText()
  const cursorConfig = await page.locator('#config-cursor').innerText()
  if (
    !claudeConfig.includes('<MEMBER_TOKEN>')
    || !codexConfig.includes('bearer_token_env_var')
    || !cursorConfig.includes('<MEMBER_TOKEN>')
    || claudeConfig.includes(credential)
    || codexConfig.includes(credential)
    || cursorConfig.includes(credential)
  ) {
    fail('agent connection configuration separation failed')
  }

  const receiptHref = await page.locator('#receipt-link').getAttribute('href')
  if (!receiptHref) fail('agent connection receipt link missing')
  const receiptUrl = new URL(receiptHref)
  const receiptId = decodeURIComponent(receiptUrl.pathname.split('/').at(-1) || '')
  if (!receiptId) fail('agent connection receipt id missing')

  const verificationResponse = await context.request.post(`${baseUrl}/mcp`, {
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
    },
    data: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'verify_agent_connection',
        arguments: { receipt_id: receiptId, challenge },
      },
    }),
    timeout: 20_000,
  })
  const verification = await verificationResponse.json().catch(() => null)
  if (
    verificationResponse.status() !== 200
    || verification?.result?.structuredContent?.status !== 'messaging_verified'
    || verification?.result?.structuredContent?.receiptId !== receiptId
  ) {
    fail('agent connection MCP verification failed', {
      status: verificationResponse.status(),
      resultStatus: verification?.result?.structuredContent?.status ?? null,
    })
  }

  const statusResponse = await context.request.get(
    `${baseUrl}/api/agent-connections/${encodeURIComponent(receiptId)}/status`,
    { timeout: 20_000 },
  )
  const status = await statusResponse.json().catch(() => null)
  const expectedSquads = [expectedHomeSquadId, expectedAdditionalSquadId]
  const accessSynchronized = expectedSquads.every((squadId) => (
    status?.current?.access?.filter((entry) => (
      entry.squad_id === squadId && entry.synchronized === true
    )).length === 1
  )) && status?.current?.access?.length === expectedSquads.length
  const verificationChecks = status?.verification?.checks
  if (
    statusResponse.status() !== 200
    || status?.issuance?.agent?.slug !== expectedAgentSlug
    || status?.issuance?.agent?.disposition !== expectedDisposition
    || status?.issuance?.home_squad_id !== expectedHomeSquadId
    || (expectedAgentId && status?.issuance?.agent?.id !== expectedAgentId)
    || !status?.issuance?.additional_access?.some((entry) => (
      entry.squadId === expectedAdditionalSquadId && entry.capability === 'member'
    ))
    || !accessSynchronized
    || status?.verification?.status !== 'pass'
    || verificationChecks?.orient?.status !== 'pass'
    || verificationChecks?.send?.status !== 'pass'
    || verificationChecks?.inbox_peek?.status !== 'pass'
  ) {
    fail('agent connection status did not prove identity, access, and messaging', {
      httpStatus: statusResponse.status(),
      agentId: status?.issuance?.agent?.id ?? null,
      agentSlug: status?.issuance?.agent?.slug ?? null,
      disposition: status?.issuance?.agent?.disposition ?? null,
      homeSquadId: status?.issuance?.home_squad_id ?? null,
      additionalAccess: status?.issuance?.additional_access ?? null,
      currentAccess: status?.current?.access ?? null,
      verificationStatus: status?.verification?.status ?? null,
      verificationChecks: verificationChecks ?? null,
    })
  }

  const searchResponse = await context.request.get(
    `${baseUrl}/agents/connect/search?q=${encodeURIComponent(expectedAgentSlug)}`,
    { timeout: 20_000 },
  )
  const search = await searchResponse.json().catch(() => null)
  const exactIdentities = search?.candidates?.filter((candidate) => (
    candidate.slug === expectedAgentSlug
  )) ?? []
  if (
    searchResponse.status() !== 200
    || exactIdentities.length !== 1
    || exactIdentities[0]?.id !== status.issuance.agent.id
  ) {
    fail('agent connection identity was not canonical after provisioning', {
      httpStatus: searchResponse.status(),
      exactIdentityCount: exactIdentities.length,
      expectedAgentSlug,
    })
  }

  const serializedVerification = JSON.stringify(verification)
  if (
    serializedVerification.includes(credential)
    || serializedVerification.includes(challenge)
  ) {
    fail('agent connection verification response exposed show-once material')
  }

  // The configured PUBLIC_ORIGIN can differ from an alternate harness port.
  // Reuse only the authorized same-origin path when loading the durable receipt.
  await page.goto(`${baseUrl}${receiptUrl.pathname}`, {
    waitUntil: 'networkidle',
    timeout: 20_000,
  })
  await page.locator('#verification-status').filter({ hasText: 'pass' }).waitFor({ timeout: 10_000 })
  const receiptText = await page.locator('body').innerText()
  if (receiptText.includes(credential) || receiptText.includes(challenge)) {
    fail('durable agent connection receipt exposed show-once material')
  }
  await page.screenshot({
    path: path.join(artifactsDir, screenshotName),
    fullPage: true,
  })

  return {
    receiptId,
    agentId: status.issuance.agent.id,
    credentialShownOnce: true,
    configurationSeparated: true,
    messagingVerified: true,
    additionalAccessSynchronized: true,
    canonicalIdentityCount: exactIdentities.length,
    durableReceiptSecretFree: true,
  }
}

async function runAgentConnectionWorkflow() {
  await page.goto(`${baseUrl}/agents/connect`, { waitUntil: 'networkidle', timeout: 20_000 })
  await page.locator('#new-name').fill(connectionAgentName)
  await page.locator('#new-slug').fill(connectionAgentSlug)
  await page.locator('#new-role').fill('member')
  await page.locator('#new-model').fill('local-fixture')
  await page.locator('#new-home').selectOption('sq-growth')
  await page.locator('#choose-new').click()
  await page.locator('#search-status').filter({ hasText: 'New identity selected' }).waitFor({ timeout: 10_000 })
  await selectAdditionalAgentAccess('sq-operations')
  await page.locator('#credential-label').fill('Local browser connection')
  await page.locator('#home-capability').selectOption('member')

  const evidence = await completeAgentConnection({
    expectedAgentSlug: connectionAgentSlug,
    expectedDisposition: 'created',
    expectedHomeSquadId: 'sq-growth',
    expectedAdditionalSquadId: 'sq-operations',
    screenshotName: 'agent-connection-new-receipt.png',
  })
  workflows.push({
    name: 'owner create-connect-verify agent journey',
    status: 'passed',
    agentSlug: connectionAgentSlug,
    ...evidence,
    existingIdentityReused: false,
  })
}

async function runExistingAgentConnectionWorkflow() {
  await page.goto(`${baseUrl}/agents/connect`, { waitUntil: 'networkidle', timeout: 20_000 })
  await page.locator('#agent-search').fill('browser-existing')
  await page.locator('#search-button').click()
  await page.locator('#search-status').filter({ hasText: '1 candidate(s)' }).waitFor({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Use this identity' }).click()
  await page.locator('#agent-choice').filter({ hasText: 'existing identity selected' }).waitFor({ timeout: 10_000 })
  await page.locator('#home-summary').filter({ hasText: 'Operations Local · immutable' }).waitFor({ timeout: 10_000 })
  await selectAdditionalAgentAccess('sq-growth')
  await page.locator('#credential-label').fill('Local existing-agent connection')
  await page.locator('#home-capability').selectOption('member')

  const evidence = await completeAgentConnection({
    expectedAgentId: 'agent-browser-existing',
    expectedAgentSlug: 'browser-existing',
    expectedDisposition: 'reused',
    expectedHomeSquadId: 'sq-operations',
    expectedAdditionalSquadId: 'sq-growth',
    screenshotName: 'agent-connection-existing-receipt.png',
  })
  workflows.push({
    name: 'owner connect existing agent journey',
    status: 'passed',
    agentSlug: 'browser-existing',
    ...evidence,
    existingIdentityReused: true,
  })
  return evidence
}

async function runExistingAgentReplacementWorkflow(priorReceiptId) {
  await page.goto(`${baseUrl}/agents/connect`, { waitUntil: 'networkidle', timeout: 20_000 })
  await page.locator('#agent-search').fill('browser-existing')
  await page.locator('#search-button').click()
  await page.locator('#search-status').filter({ hasText: '1 candidate(s)' }).waitFor({ timeout: 10_000 })
  const candidate = page.locator('#search-results .candidate')
  await candidate.filter({ hasText: 'connected' }).waitFor({ timeout: 10_000 })
  await candidate.getByRole('button', { name: 'Use this identity' }).click()
  await page.locator('#home-summary').filter({ hasText: 'Operations Local · immutable' }).waitFor({ timeout: 10_000 })
  await page.locator('#credential-action').selectOption('replace')
  await page.locator('#replace-wrap').waitFor({ state: 'visible', timeout: 10_000 })
  if (await page.locator('#replace-token option').count() !== 1) {
    fail('connected existing agent did not expose exactly one replaceable credential')
  }
  await selectAdditionalAgentAccess('sq-growth')
  await page.locator('#credential-label').fill('Local replacement connection')
  await page.locator('#home-capability').selectOption('member')

  const evidence = await completeAgentConnection({
    expectedAgentId: 'agent-browser-existing',
    expectedAgentSlug: 'browser-existing',
    expectedDisposition: 'reused',
    expectedHomeSquadId: 'sq-operations',
    expectedAdditionalSquadId: 'sq-growth',
    screenshotName: 'agent-connection-replacement-receipt.png',
  })

  const priorStatusResponse = await context.request.get(
    `${baseUrl}/api/agent-connections/${encodeURIComponent(priorReceiptId)}/status`,
    { timeout: 20_000 },
  )
  const priorStatus = await priorStatusResponse.json().catch(() => null)
  if (
    priorStatusResponse.status() !== 200
    || priorStatus?.issuance?.agent?.id !== 'agent-browser-existing'
    || priorStatus?.issuance?.home_squad_id !== 'sq-operations'
    || priorStatus?.current?.token_revoked !== true
  ) {
    fail('replacement did not revoke only the prior credential', {
      httpStatus: priorStatusResponse.status(),
      agentId: priorStatus?.issuance?.agent?.id ?? null,
      homeSquadId: priorStatus?.issuance?.home_squad_id ?? null,
      priorTokenRevoked: priorStatus?.current?.token_revoked ?? null,
    })
  }

  workflows.push({
    name: 'owner replace existing agent credential journey',
    status: 'passed',
    agentSlug: 'browser-existing',
    ...evidence,
    existingIdentityReused: true,
    existingCredentialReplaced: true,
    priorCredentialRevoked: true,
  })
}

async function runProjectWorkspaceWorkflow() {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(`${baseUrl}/projects`, { waitUntil: 'networkidle', timeout: 20_000 })

  const portfolioText = await textSnippet(page.locator('body'), 6000)
  const portfolioLabels = [
    'Mumega Products',
    'Inkwell',
    'Mirror',
    'SOS',
    'Mupot',
    'Marketing Infrastructure',
    'MCPWP',
    'MumCP',
  ]
  const missingPortfolioLabels = portfolioLabels.filter((label) => !portfolioText.includes(label))
  if (missingPortfolioLabels.length > 0) {
    fail('project portfolio labels missing', { missingPortfolioLabels, portfolioText })
  }

  const primaryNavigation = await page.locator('#app-nav > a.nav-link .nav-label').allInnerTexts()
  const expectedPrimaryNavigation = ['Home', 'Projects', 'Work', 'Approvals']
  if (JSON.stringify(primaryNavigation.slice(0, 4)) !== JSON.stringify(expectedPrimaryNavigation)) {
    fail('primary navigation order changed', { primaryNavigation, expectedPrimaryNavigation })
  }

  const mupotLink = page.locator('a[href="/projects/project-mupot"]').first()
  if (await mupotLink.count() !== 1) {
    fail('nested Mupot project link missing', { portfolioText })
  }
  await mupotLink.click()
  await page.waitForURL(`${baseUrl}/projects/project-mupot`, { timeout: 10_000 })
  const detailText = await textSnippet(page.locator('body'), 6000)
  if (!detailText.includes('Mupot') || !detailText.includes('Mumega Products')) {
    fail('Mupot project detail did not render project and parent context', { detailText })
  }
  for (const href of ['/send?project_id=project-mupot', '/flights?project_id=project-mupot']) {
    if (await page.locator(`a[href="${href}"]`).count() === 0) {
      fail('project-filtered work link missing', { href, detailText })
    }
  }
  const activityText = await textSnippet(page.locator('#activity'), 4000)
  if (!activityText.includes('In-progress local task') || !activityText.includes('Run local browser smoke')) {
    fail('project Activity did not render attributed task and flight rows', { activityText })
  }
  const evidenceText = await textSnippet(page.locator('#evidence'), 4000)
  if (!evidenceText.includes('Done local task') || !evidenceText.includes('Completed local baseline.')) {
    fail('project Evidence did not render the retained task result', { evidenceText })
  }
  const browserSituation = JSON.parse(await page.locator('#project-situation-json').textContent())
  const [restProject, mcpProject] = await Promise.all([
    readProjectRest('project-mupot'),
    readProjectMcp('project-mupot'),
  ])
  const situationSurfaces = {
    browser: browserSituation,
    rest: restProject.situation,
    mcp: mcpProject.situation,
  }
  const surfaceHashes = Object.fromEntries(Object.entries(situationSurfaces).map(([surface, situation]) => (
    [surface, canonicalHash(situation)]
  )))
  if (new Set(Object.values(surfaceHashes)).size !== 1) {
    fail('Project situation differs across browser, REST, and MCP', {
      projectId: 'project-mupot',
      surfaceHashes,
      surfaceValues: Object.fromEntries(Object.entries(situationSurfaces).map(([surface, situation]) => (
        [surface, comparedSituationFields(situation)]
      ))),
    })
  }
  const surfaceValues = Object.fromEntries(Object.entries(situationSurfaces).map(([surface, situation]) => (
    [surface, comparedSituationFields(situation)]
  )))
  const browserFields = surfaceValues.browser
  if (browserFields.health !== 'blocked'
    || browserFields.blockerCount !== 1
    || browserFields.pendingReviewCount !== 1
    || JSON.stringify(browserFields.taskCounts) !== JSON.stringify({ blocked: 1, review: 1, in_progress: 1, open: 0 })
    || browserFields.activeWorkCount !== 3
    || browserFields.activeFlightCount !== 1
    || browserFields.blockerDetailsTruncated
    || browserFields.pendingReviewDetailsTruncated
    || Object.values(browserFields.taskCountsTruncated).some(Boolean)
    || browserFields.activeWorkCountTruncated
    || browserFields.activeFlightCountTruncated
    || browserFields.snapshotTruncated
    || !browserFields.latestActivity
    || browserFields.nextAction?.type !== 'review_task') {
    fail('browser did not structurally observe the seeded Mupot situation', { browserFields })
  }
  const teamPresence = await page.locator('[data-project-agent-presence]').evaluateAll((nodes) => nodes.map((node) => ({
    agentId: node.dataset.agentId,
    presence: node.dataset.presence,
    label: node.textContent?.trim(),
  })).sort((left, right) => String(left.agentId).localeCompare(String(right.agentId))))
  const expectedTeamPresence = [
    { agentId: 'agent-conformance', presence: 'stale', label: 'Stale' },
    { agentId: 'agent-conformance-sender', presence: 'not_attached', label: 'Not attached' },
    { agentId: 'agent-growth', presence: 'offline', label: 'Offline' },
    { agentId: 'agent-hermes', presence: 'live', label: 'Live' },
  ]
  if (JSON.stringify(teamPresence) !== JSON.stringify(expectedTeamPresence)) {
    fail('browser Team presence labels do not match seeded runtime truth', { teamPresence, expectedTeamPresence })
  }
  const surfaceParity = {
    projectId: 'project-mupot',
    comparedFields: [
      'health', 'blockerCount', 'blockerDetailsTruncated',
      'pendingReviewCount', 'pendingReviewDetailsTruncated',
      'taskCounts', 'taskCountsTruncated',
      'activeWorkCount', 'activeWorkCountTruncated',
      'activeFlightCount', 'activeFlightCountTruncated',
      'snapshotTruncated', 'latestActivity', 'nextAction',
    ],
    equal: true,
    surfaces: Object.fromEntries(Object.keys(situationSurfaces).map((surface) => [surface, {
      canonicalHash: surfaceHashes[surface],
      values: surfaceValues[surface],
    }])),
    browserTeamPresence: teamPresence,
  }
  const mupotDesktopOverflow = await assertNoDocumentOverflow('Mupot desktop Project')
  await page.screenshot({ path: path.join(artifactsDir, 'project-mupot.png'), fullPage: true })

  await page.goto(`${baseUrl}/send?project_id=project-mupot`, { waitUntil: 'networkidle', timeout: 20_000 })
  const projectSendText = await textSnippet(page.locator('body'), 3000)
  if (!projectSendText.includes('Project context: Mupot') || await page.locator('#send-agent option').count() === 0) {
    fail('project task context did not render an authorized picker', { projectSendText })
  }
  await page.goto(`${baseUrl}/flights?project_id=project-mupot`, { waitUntil: 'networkidle', timeout: 20_000 })
  const projectFlightsText = await textSnippet(page.locator('body'), 3000)
  if (!projectFlightsText.includes('Flights attributed to Mupot') || !projectFlightsText.includes('Run local browser smoke')) {
    fail('project flight context did not render filtered flights', { projectFlightsText })
  }

  await page.goto(`${baseUrl}/projects/new`, { waitUntil: 'networkidle', timeout: 20_000 })
  await page.locator('input[name="name"]').fill(ownerProjectName)
  await page.locator('input[name="slug"]').fill(ownerProjectSlug)
  await page.locator('textarea[name="description"]').fill('Created by the local browser smoke through the owner Project form.')
  await page.locator('textarea[name="goal"]').fill(ownerProjectInitialGoal)
  await page.locator('select[name="parent_project_id"]').selectOption('project-mumega-products')
  await Promise.all([
    page.waitForURL(new RegExp(`${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/projects/[^?]+\\?status=created$`), { timeout: 10_000 }),
    page.getByRole('button', { name: 'Create project' }).click(),
  ])
  const createdUrl = new URL(page.url())
  const createdProjectId = createdUrl.pathname.split('/').at(-1)
  if (!createdProjectId) fail('project create did not redirect to a canonical Project URL', { url: page.url() })
  const createdText = await textSnippet(page.locator('body'), 4000)
  if (!createdText.includes('Project created.') || !createdText.includes('Mumega Products')) {
    fail('created nested project did not render its success state and parent context', { createdText })
  }
  const lifecycleTransitions = [
    await observeLifecycleStatus(createdProjectId, 'create', null, 'planned'),
  ]

  await page.goto(`${baseUrl}/projects/${encodeURIComponent(createdProjectId)}/settings`, { waitUntil: 'networkidle', timeout: 20_000 })
  await page.locator('textarea[name="goal"]').fill(ownerProjectEditedGoal)
  await Promise.all([
    page.waitForURL(`${baseUrl}/projects/${encodeURIComponent(createdProjectId)}?status=updated`, { timeout: 10_000 }),
    page.getByRole('button', { name: 'Save settings' }).click(),
  ])
  const updatedText = await textSnippet(page.locator('body'), 4000)
  if (!updatedText.includes('Project settings saved.') || !updatedText.includes(ownerProjectEditedGoal)) {
    fail('project goal edit did not render its success state and saved value', { updatedText })
  }
  lifecycleTransitions.push(await observeLifecycleStatus(
    createdProjectId,
    'edit_goal',
    'planned',
    'planned',
  ))

  // Slice 3 start-gate requires a writable squad + active squad agent before
  // planned -> active is allowed. The owner-created project above has neither
  // by default, so provision it through the real grant path before activating.
  await grantProjectSquadWriteAccess(createdProjectId, 'sq-growth')

  const activated = await applyProjectLifecycleCommand(
    'activate', 'activated', createdProjectId, 'planned', 'active',
  )
  if (!activated.successText.includes('Project activated.')) {
    fail('project activation success state missing', { activatedText: activated.successText })
  }
  lifecycleTransitions.push(activated.receipt)

  const createdBrowserSituation = JSON.parse(await page.locator('#project-situation-json').textContent())
  const createdProjectRead = await readProjectRest(createdProjectId)
  const createdProjectObservation = {
    health: createdBrowserSituation.health,
    nextAction: createdBrowserSituation.next_action,
    goal: createdProjectRead.project.goal,
  }
  // Slice 3 start-gate seeds a first open task from the project goal as part
  // of the planned -> active provisioning, so the freshly activated project
  // is never an empty 'ready' situation anymore -- it has one open task
  // waiting to be started.
  if (createdProjectObservation.health !== 'active'
    || createdProjectObservation.nextAction?.type !== 'start_task'
    || createdProjectObservation.goal !== ownerProjectEditedGoal
    || canonicalHash(createdBrowserSituation) !== canonicalHash(createdProjectRead.situation)) {
    fail('activated Project did not render its canonical start-gate-seeded situation', {
      createdProjectObservation,
      browserSituationHash: canonicalHash(createdBrowserSituation),
      restSituationHash: canonicalHash(createdProjectRead.situation),
    })
  }
  const createdDesktopOverflow = await assertNoDocumentOverflow('created desktop Project')
  await page.screenshot({ path: path.join(artifactsDir, 'created-project-desktop.png'), fullPage: true })

  await page.goto(`${baseUrl}/projects`, { waitUntil: 'networkidle', timeout: 20_000 })
  await page.locator('input[name="search"]').fill(ownerProjectName)
  await page.locator('select[name="status"]').selectOption('active')
  await Promise.all([
    page.waitForURL(new RegExp(`/projects\\?search=${encodeURIComponent(ownerProjectName).replace(/%20/g, '\\+')}&status=active$`), { timeout: 10_000 }),
    page.getByRole('button', { name: 'Filter' }).click(),
  ])
  const filteredText = await textSnippet(page.locator('body'), 4000)
  if (!filteredText.includes(ownerProjectName) || !filteredText.includes(ownerProjectEditedGoal)) {
    fail('project search and status filter did not retain the activated Project', { filteredText, url: page.url() })
  }

  // Slice 2 structural completion gate: 'completed' is no longer reachable by
  // a bare dashboard flip from 'active' (only from 'review', via a passed
  // completion-gate verdict — see tests/project-completion-gate.test.ts). The
  // bare-flip cycle this smoke covers is pause/activate/archive/restore,
  // matching tests/dashboard-projects.test.ts's updated transitions list.
  const paused = await applyProjectLifecycleCommand(
    'pause', 'paused', createdProjectId, 'active', 'paused',
  )
  if (!paused.successText.includes('Project paused.')) {
    fail('project pause success state missing', { pausedText: paused.successText })
  }
  lifecycleTransitions.push(paused.receipt)

  const reactivated = await applyProjectLifecycleCommand(
    'activate', 'activated', createdProjectId, 'paused', 'active',
  )
  if (!reactivated.successText.includes('Project activated.')) {
    fail('project reactivate success state missing', { reactivatedText: reactivated.successText })
  }
  lifecycleTransitions.push(reactivated.receipt)

  const archived = await applyProjectLifecycleCommand(
    'archive', 'archived', createdProjectId, 'active', 'archived',
  )
  if (!archived.successText.includes('Project archived.')) {
    fail('project archive success state missing', { archivedText: archived.successText })
  }
  lifecycleTransitions.push(archived.receipt)

  const restored = await applyProjectLifecycleCommand(
    'restore', 'restored', createdProjectId, 'archived', 'planned',
  )
  if (!restored.successText.includes('Project restored to planned.')) {
    fail('project restore success state missing', { restoredText: restored.successText })
  }
  lifecycleTransitions.push(restored.receipt)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${baseUrl}/projects`, { waitUntil: 'networkidle', timeout: 20_000 })
  const projectsMobileOverflow = await assertNoDocumentOverflow('mobile Projects')
  await page.locator('#topbar-menu-btn').click()
  const mobileNavigation = await page.locator('#app-nav > a.nav-link .nav-label').allInnerTexts()
  if (JSON.stringify(mobileNavigation.slice(0, 4)) !== JSON.stringify(expectedPrimaryNavigation)) {
    fail('mobile primary navigation order changed', { mobileNavigation, expectedPrimaryNavigation })
  }
  await page.screenshot({ path: path.join(artifactsDir, 'projects-mobile.png'), fullPage: true })

  await page.goto(`${baseUrl}/projects/project-mupot`, { waitUntil: 'networkidle', timeout: 20_000 })
  const mupotMobileOverflow = await assertNoDocumentOverflow('Mupot mobile Project')
  const teamScroll = await page.locator('[role="region"][aria-label="Readable project agent members"]').evaluate((region) => {
    const element = region
    const initial = element.scrollLeft
    element.scrollLeft = 32
    const scrolled = element.scrollLeft
    element.scrollLeft = element.scrollWidth - element.clientWidth
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      scrolled,
      screenshotScrollLeft: element.scrollLeft,
    }
  })
  if (teamScroll.scrollWidth <= teamScroll.clientWidth || teamScroll.scrolled <= 0) {
    fail('Team / Squads table did not provide an internal horizontal scroll region', { teamScroll })
  }
  await page.locator('#squads').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(artifactsDir, 'project-mupot-team-mobile.png') })

  await page.goto(`${baseUrl}/projects/${encodeURIComponent(createdProjectId)}`, { waitUntil: 'networkidle', timeout: 20_000 })
  const createdMobileOverflow = await assertNoDocumentOverflow('created mobile Project')
  await page.screenshot({ path: path.join(artifactsDir, 'created-project-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1000 })

  workflows.push({
    name: 'project-centered workspace and owner lifecycle',
    status: 'passed',
    projectId: 'project-mupot',
    createdProjectId,
    createdProjectParentId: 'project-mumega-products',
    lifecycleTransitions,
    surfaceParity,
    createdProjectObservation,
    viewports: {
      desktop: { width: 1440, height: 1000, mupotDocumentOverflow: mupotDesktopOverflow, createdDocumentOverflow: createdDesktopOverflow },
      mobile: {
        width: 390,
        height: 844,
        projectsDocumentOverflow: projectsMobileOverflow,
        mupotDocumentOverflow: mupotMobileOverflow,
        createdDocumentOverflow: createdMobileOverflow,
      },
    },
    teamScroll,
    screenshots: [
      path.join(artifactsDir, 'project-mupot.png'),
      path.join(artifactsDir, 'created-project-desktop.png'),
      path.join(artifactsDir, 'projects-mobile.png'),
      path.join(artifactsDir, 'project-mupot-team-mobile.png'),
      path.join(artifactsDir, 'created-project-mobile.png'),
    ],
    primaryNavigation: expectedPrimaryNavigation,
  })
}

async function runSendTaskWorkflow() {
  await page.addInitScript(() => {
    window.__MUPOT_SMOKE_DISABLE_DISPATCH = true
  })
  await page.goto(`${baseUrl}/send?project_id=project-mupot`, { waitUntil: 'networkidle', timeout: 20_000 })

  await page.locator('#send-btn').click()
  const validationText = await textSnippet(page.locator('#send-status'))
  if (!validationText.includes('Write what you need first')) {
    fail('send form validation state missing', { validationText })
  }

  await page.locator('#send-body').fill([
    sendTaskTitle,
    '',
    'Verify the browser harness can create a task, preserve done_when, and render a visible result.',
  ].join('\n'))
  await page.locator('#send-agent').selectOption('agent-hermes|sq-growth')

  const createResponsePromise = page.waitForResponse(
    (res) => res.url() === `${baseUrl}/api/tasks` && res.request().method() === 'POST',
    { timeout: 20_000 },
  )
  await page.locator('#send-btn').click()
  const createResponse = await createResponsePromise
  const submittedTask = createResponse.request().postDataJSON()
  const created = await createResponse.json().catch(() => null)
  const taskId = created?.task?.id
  if (createResponse.status() !== 201 || typeof taskId !== 'string') {
    fail('send task create failed', { status: createResponse.status(), created })
  }
  if (created?.dispatched !== false) {
    fail('send smoke task unexpectedly dispatched to runtime', { created })
  }
  if (submittedTask.project_id !== 'project-mupot') {
    fail('send smoke task lost project context', { submittedTask })
  }
  if (typeof created?.task?.done_when !== 'string' || created.task.done_when.length === 0) {
    fail('send task create did not preserve done_when', { created })
  }

  const completionResult = `Local browser smoke completed "${sendTaskTitle}". Verified task creation, lifecycle completion, and visible result rendering.`
  const completeResponse = await context.request.post(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/local-smoke-complete`, {
    headers: { 'content-type': 'application/json' },
    data: { result: completionResult },
    timeout: 20_000,
  })
  const completed = await completeResponse.json().catch(() => null)
  if (completeResponse.status() !== 200 || completed?.task?.status !== 'done') {
    fail('local smoke task completion failed', { status: completeResponse.status(), completed })
  }

  await page.waitForFunction(
    () => document.querySelector('#send-status')?.textContent?.includes('Done'),
    null,
    { timeout: 15_000 },
  )
  const resultText = await textSnippet(page.locator('#send-result'), 1000)
  if (!resultText.includes(completionResult)) {
    fail('send page did not render completed result', { resultText, completionResult })
  }

  await page.screenshot({ path: path.join(artifactsDir, 'send-workflow.png'), fullPage: true })
  workflows.push({
    name: 'send task through visible result',
    status: 'passed',
    taskId,
    title: sendTaskTitle,
    doneWhen: created.task.done_when,
    dispatched: created.dispatched,
  })
}

async function runApprovalWorkflow() {
  const createResponse = await context.request.post(`${baseUrl}/api/tasks`, {
    headers: { 'content-type': 'application/json' },
    data: {
      squad_id: 'sq-growth',
      title: approvalTaskTitle,
      done_when: 'A reviewer approves this browser smoke task through the gate.',
      body: 'Created by the local browser smoke harness to exercise the approval queue.',
      status: 'in_progress',
      assignee_agent_id: 'agent-hermes',
      gate_owner: 'gate:local',
    },
    timeout: 20_000,
  })
  const created = await createResponse.json().catch(() => null)
  const taskId = created?.task?.id
  if (createResponse.status() !== 201 || typeof taskId !== 'string') {
    fail('approval workflow task create failed', { status: createResponse.status(), created })
  }

  const reviewResponse = await context.request.patch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}`, {
    headers: { 'content-type': 'application/json' },
    data: { status: 'review' },
    timeout: 20_000,
  })
  const reviewed = await reviewResponse.json().catch(() => null)
  if (reviewResponse.status() !== 200 || reviewed?.task?.status !== 'review') {
    fail('approval workflow task did not enter review', { status: reviewResponse.status(), reviewed })
  }

  await page.goto(`${baseUrl}/approvals`, { waitUntil: 'networkidle', timeout: 20_000 })
  const card = page.locator(`[data-task="${taskId}"]`).first()
  await card.waitFor({ state: 'visible', timeout: 10_000 })

  await card.locator('.appr-reject').click()
  const rejectValidation = await textSnippet(card.locator('.appr-status'))
  if (!rejectValidation.includes('note is required')) {
    fail('approval rejection validation state missing', { rejectValidation })
  }

  await card.locator('.appr-note').fill('Approved by local browser smoke.')
  await card.locator('.appr-approve').click()
  await page.waitForFunction(
    (id) => document.querySelector(`[data-task="${id}"] .appr-status`)?.textContent?.includes('approved'),
    taskId,
    { timeout: 10_000 },
  )
  const approvedStatus = await textSnippet(card.locator('.appr-status'))
  if (!approvedStatus.includes('approved')) {
    fail('approval did not reach approved state', { approvedStatus })
  }

  await page.screenshot({ path: path.join(artifactsDir, 'approvals-workflow.png'), fullPage: true })
  workflows.push({
    name: 'approval queue validation and approval',
    status: 'passed',
    taskId,
    title: approvalTaskTitle,
    verdict: 'approved',
  })
}

async function postHermesMessage(hermes, msg) {
  const res = await context.request.post(`${baseUrl}/im/webhook`, {
    headers: {
      'content-type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': 'local-im-secret',
    },
    data: { message: { chat: { id: 123456789 }, text: msg.text } },
    timeout: 20_000,
  })
  const json = await res.json().catch(() => null)
  hermes.push({ lifecycle: msg.lifecycle, text: msg.text, status: res.status(), json })
  if (res.status() !== 200 || !json?.ok || !String(json.reply ?? '').includes(msg.expect)) {
    fail(`Hermes smoke failed: ${msg.text}`, { status: res.status(), json, expected: msg.expect })
  }
  return json
}

async function runHermesApprovalWorkflow(hermes) {
  const createResponse = await context.request.post(`${baseUrl}/api/tasks`, {
    headers: { 'content-type': 'application/json' },
    data: {
      squad_id: 'sq-growth',
      title: hermesApprovalTaskTitle,
      done_when: 'Hermes approves this browser smoke task through the IM gate.',
      body: 'Created by the local browser smoke harness to exercise IM approval parity.',
      status: 'in_progress',
      assignee_agent_id: 'agent-hermes',
      gate_owner: 'gate:local',
    },
    timeout: 20_000,
  })
  const created = await createResponse.json().catch(() => null)
  const taskId = created?.task?.id
  if (createResponse.status() !== 201 || typeof taskId !== 'string') {
    fail('Hermes approval task create failed', { status: createResponse.status(), created })
  }

  const reviewResponse = await context.request.patch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}`, {
    headers: { 'content-type': 'application/json' },
    data: { status: 'review' },
    timeout: 20_000,
  })
  const reviewed = await reviewResponse.json().catch(() => null)
  if (reviewResponse.status() !== 200 || reviewed?.task?.status !== 'review') {
    fail('Hermes approval task did not enter review', { status: reviewResponse.status(), reviewed })
  }

  await postHermesMessage(hermes, {
    lifecycle: 'Hermes IM approval lifecycle',
    text: `approve ${taskId}`,
    expect: `Approved "${hermesApprovalTaskTitle}".`,
  })

  const readResponse = await context.request.get(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}`, {
    timeout: 20_000,
  })
  const read = await readResponse.json().catch(() => null)
  if (readResponse.status() !== 200 || read?.task?.status !== 'approved') {
    fail('Hermes-approved task did not persist approved status', { status: readResponse.status(), read })
  }

  workflows.push({
    name: 'Hermes IM approval verdict',
    status: 'passed',
    taskId,
    title: hermesApprovalTaskTitle,
    verdict: 'approved',
  })
}

async function runHermesDirectiveWorkflow(hermes) {
  await postHermesMessage(hermes, {
    lifecycle: 'Hermes IM directive set lifecycle',
    text: `directive: ${hermesDirectiveText}`,
    expect: 'Pinned directive for the brain.',
  })

  await page.goto(`${baseUrl}/brain`, { waitUntil: 'networkidle', timeout: 20_000 })
  const pinnedBrainText = await textSnippet(page.locator('body'), 3000)
  if (!pinnedBrainText.includes(hermesDirectiveText)) {
    fail('Hermes-pinned directive did not appear on the brain dashboard', {
      hermesDirectiveText,
      pinnedBrainText,
    })
  }

  await postHermesMessage(hermes, {
    lifecycle: 'Hermes IM directive clear lifecycle',
    text: 'directive clear',
    expect: 'Cleared the pinned directive.',
  })

  await page.goto(`${baseUrl}/brain`, { waitUntil: 'networkidle', timeout: 20_000 })
  const clearedBrainText = await textSnippet(page.locator('body'), 3000)
  if (clearedBrainText.includes(hermesDirectiveText)) {
    fail('Hermes-cleared directive still appears on the brain dashboard', {
      hermesDirectiveText,
      clearedBrainText,
    })
  }

  workflows.push({
    name: 'Hermes IM brain directive set and clear',
    status: 'passed',
    directive: hermesDirectiveText,
  })
}

export async function runLocalBrowserSmoke() {
  await mkdir(artifactsDir, { recursive: true })

  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  page = await context.newPage()
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(err.message))

  try {
    const login = await page.goto(`${baseUrl}/auth/dev-login`, { waitUntil: 'networkidle', timeout: 20_000 })
    if (!login || login.status() >= 400) fail('dev login failed', { status: login?.status() })
    await runLoginWorkflow()

    for (const route of pages) {
      const beforeErrors = consoleErrors.length
      const response = await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle', timeout: 20_000 })
      const status = response?.status() ?? 0
      const bodyText = await textSnippet(page.locator('body'))
      const newErrors = consoleErrors.slice(beforeErrors)
      results.push({ route, status, finalUrl: page.url(), errors: newErrors, bodyText })
      validateRouteEvidence({
        route,
        expectedUrl: `${baseUrl}${route}`,
        finalUrl: page.url(),
        errors: newErrors,
        bodyText,
      })

      if (status >= 400) fail(`page failed: ${route}`, { status, bodyText })
      if (/oauth_not_configured|unauthenticated/i.test(bodyText)) {
        fail(`page rendered auth failure: ${route}`, { status, bodyText })
      }
    }

    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' })
    await page.screenshot({ path: path.join(artifactsDir, 'home.png'), fullPage: true })
    await page.goto(`${baseUrl}/fleet`, { waitUntil: 'networkidle' })
    await page.screenshot({ path: path.join(artifactsDir, 'fleet.png'), fullPage: true })
    await page.goto(`${baseUrl}/ops`, { waitUntil: 'networkidle' })
    await page.screenshot({ path: path.join(artifactsDir, 'ops-health.png'), fullPage: true })

    await runProjectWorkspaceWorkflow()
    await runAgentConnectionWorkflow()
    const existingConnection = await runExistingAgentConnectionWorkflow()
    await runExistingAgentReplacementWorkflow(existingConnection.receiptId)
    await runSendTaskWorkflow()
    await runApprovalWorkflow()

    const hermes = []
    await runHermesApprovalWorkflow(hermes)
    await runHermesDirectiveWorkflow(hermes)
    for (const msg of hermesMessages) {
      await postHermesMessage(hermes, msg)
    }

    await page.goto(`${baseUrl}/squads/sq-growth`, { waitUntil: 'networkidle', timeout: 20_000 })
    const squadText = await textSnippet(page.locator('body'), 2000)
    if (!squadText.includes(hermesTaskTitle)) {
      fail('Hermes-created task did not appear on the squad dashboard', { hermesTaskTitle, squadText })
    }
    await page.screenshot({ path: path.join(artifactsDir, 'hermes-dashboard-update.png'), fullPage: true })
    workflows.push({
      name: 'Hermes webhook dashboard update',
      status: 'passed',
      title: hermesTaskTitle,
    })

    const report = { baseUrl, contract: runtimeContract, hermesLifecycle, pages: results, workflows, hermes, screenshots: artifactsDir, reportPath }
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report, null, 2))
  } catch (err) {
    const failureStamp = Date.now()
    const failurePath = path.join(artifactsDir, `failure-${failureStamp}.png`)
    const failureReportPath = path.join(artifactsDir, `failure-${failureStamp}.json`)
    await page.screenshot({ path: failurePath, fullPage: true }).catch(() => undefined)
    const failureReport = {
      error: err instanceof Error ? err.message : String(err),
      details: err instanceof Error && 'details' in err ? err.details : undefined,
      workflows,
      pagesChecked: results.length,
      failureScreenshot: failurePath,
      failureReportPath,
    }
    await writeFile(failureReportPath, JSON.stringify(failureReport, null, 2) + '\n').catch(() => undefined)
    console.error(JSON.stringify(failureReport, null, 2))
    throw err
  } finally {
    await browser.close()
  }
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isDirectRun) await runLocalBrowserSmoke()
