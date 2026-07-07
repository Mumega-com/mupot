#!/usr/bin/env node

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright'

const baseUrl = (process.env.MUPOT_LOCAL_URL || process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '')
const artifactsDir = path.resolve(process.env.MUPOT_SMOKE_ARTIFACTS || 'tmp/local-smoke')
const runtimeContract = 'runtime-adapter/v1'
const hermesLifecycle = 'Hermes IM task lifecycle: Telegram update -> IM webhook -> chat_id member mapping -> capability gate -> task.created -> reply'

const pages = [
  '/',
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
  { lifecycle: 'Hermes IM task lifecycle', text: 'task: Local smoke task from Hermes @growth', expect: 'Added to Growth Local' },
]

function fail(message, details) {
  const err = new Error(message)
  err.details = details
  throw err
}

await mkdir(artifactsDir, { recursive: true })

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
const consoleErrors = []
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text())
})
page.on('pageerror', (err) => consoleErrors.push(err.message))

const results = []

try {
  const login = await page.goto(`${baseUrl}/auth/dev-login`, { waitUntil: 'networkidle', timeout: 20_000 })
  if (!login || login.status() >= 400) fail('dev login failed', { status: login?.status() })

  for (const route of pages) {
    const beforeErrors = consoleErrors.length
    const response = await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle', timeout: 20_000 })
    const status = response?.status() ?? 0
    const bodyText = (await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '')).slice(0, 240)
    const newErrors = consoleErrors.slice(beforeErrors)
    results.push({ route, status, finalUrl: page.url(), errors: newErrors, bodyText })

    if (status >= 400) fail(`page failed: ${route}`, { status, bodyText })
    if (/oauth_not_configured|unauthenticated/i.test(bodyText)) {
      fail(`page rendered auth failure: ${route}`, { status, bodyText })
    }
  }

  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' })
  await page.screenshot({ path: path.join(artifactsDir, 'home.png'), fullPage: true })
  await page.goto(`${baseUrl}/fleet`, { waitUntil: 'networkidle' })
  await page.screenshot({ path: path.join(artifactsDir, 'fleet.png'), fullPage: true })

  const hermes = []
  for (const msg of hermesMessages) {
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
  }

  const report = { baseUrl, contract: runtimeContract, hermesLifecycle, pages: results, hermes, screenshots: artifactsDir }
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser.close()
}
