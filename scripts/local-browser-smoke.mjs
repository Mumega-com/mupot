#!/usr/bin/env node

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
  { lifecycle: 'Hermes IM fleet control lifecycle', text: 'fleet status hermes', expect: 'Queued fleet status for Hermes Local Relay.' },
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
  await page.screenshot({ path: path.join(artifactsDir, 'project-mupot.png'), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${baseUrl}/projects`, { waitUntil: 'networkidle', timeout: 20_000 })
  const horizontalOverflow = await page.evaluate(() => (
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  ))
  if (horizontalOverflow > 1) {
    fail('mobile project workspace has horizontal overflow', { horizontalOverflow })
  }
  await page.locator('#topbar-menu-btn').click()
  const mobileNavigation = await page.locator('#app-nav > a.nav-link .nav-label').allInnerTexts()
  if (JSON.stringify(mobileNavigation.slice(0, 4)) !== JSON.stringify(expectedPrimaryNavigation)) {
    fail('mobile primary navigation order changed', { mobileNavigation, expectedPrimaryNavigation })
  }
  await page.screenshot({ path: path.join(artifactsDir, 'projects-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1000 })

  workflows.push({
    name: 'project-centered workspace desktop and mobile',
    status: 'passed',
    projectId: 'project-mupot',
    viewport: { width: 390, height: 844 },
    horizontalOverflow,
    primaryNavigation: expectedPrimaryNavigation,
  })
}

async function runSendTaskWorkflow() {
  await page.addInitScript(() => {
    window.__MUPOT_SMOKE_DISABLE_DISPATCH = true
  })
  await page.goto(`${baseUrl}/send`, { waitUntil: 'networkidle', timeout: 20_000 })

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
  const created = await createResponse.json().catch(() => null)
  const taskId = created?.task?.id
  if (createResponse.status() !== 201 || typeof taskId !== 'string') {
    fail('send task create failed', { status: createResponse.status(), created })
  }
  if (created?.dispatched !== false) {
    fail('send smoke task unexpectedly dispatched to runtime', { created })
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
