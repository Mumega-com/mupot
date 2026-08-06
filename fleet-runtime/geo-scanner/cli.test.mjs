import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { main } from './cli.mjs'

const POSTHOG_TOKEN = 'phc_project-token-for-cli-test'
const MUPOT_TOKEN = 'mupot_agent-token-for-cli-test'

function rawConfig() {
  return {
    schema: 'dme.geo-scanner-config/v1',
    project_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    google_project_id: 'mumegaproject',
    location: 'global',
    model: 'gemini-2.5-flash',
    posthog_host: 'https://us.i.posthog.com',
    daily_query_cap: 1,
    state_file: '/var/lib/mupot/geo-budget/state.json',
    mupot: {
      base_url: 'https://mupot-viamar.weathered-scene-2272.workers.dev',
      receipt_to: 'viamar-geo-receipts',
    },
    profiles: [{
      id: 'viamar',
      target_domain: 'viamar.ca',
      market: 'Canada',
      tracked_competitors: [],
      prompts: [{ id: 'prompt-1', text: 'Who is visible?' }],
    }],
  }
}

async function withFiles(run) {
  const dir = await mkdtemp(join(tmpdir(), 'mupot-geo-cli-'))
  try {
    const configFile = join(dir, 'config.json')
    const posthogFile = join(dir, 'posthog')
    const mupotFile = join(dir, 'mupot')
    await writeFile(configFile, JSON.stringify(rawConfig()))
    await writeFile(posthogFile, `${POSTHOG_TOKEN}\n`, { mode: 0o600 })
    await writeFile(mupotFile, `${MUPOT_TOKEN}\n`, { mode: 0o600 })
    await run({ configFile, posthogFile, mupotFile })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('validates files, runs once, and logs only a redacted completion summary', async () => {
  await withFiles(async ({ configFile, posthogFile, mupotFile }) => {
    const logs = []
    let received
    const exitCode = await main({
      env: {
        GEO_SCANNER_CONFIG_FILE: configFile,
        POSTHOG_PROJECT_TOKEN_FILE: posthogFile,
        MUPOT_AGENT_TOKEN_FILE: mupotFile,
      },
      log: (value) => logs.push(value),
      runScan: async (config, options) => {
        received = { config, options }
        return {
          ok: true,
          scanId: '11111111-1111-4111-8111-111111111111',
          counts: { ok: 1, empty: 0, failed: 0, budget_denied: 0, sink_failed: 0 },
          costStatus: 'billing_unreconciled',
          receipt: { ok: true, messageId: 'message-1', duplicate: false },
        }
      },
    })

    assert.equal(exitCode, 0)
    assert.equal(received.config.projectId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    assert.equal(received.options.posthogToken, POSTHOG_TOKEN)
    assert.equal(received.options.mupotToken, MUPOT_TOKEN)
    assert.deepEqual(logs, [{
      schema: 'mupot.geo-scanner-run/v1',
      scan_id: '11111111-1111-4111-8111-111111111111',
      project_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      counts: { ok: 1, empty: 0, failed: 0, budget_denied: 0, sink_failed: 0 },
      cost_status: 'billing_unreconciled',
      status: 'complete',
    }])
    const serialized = JSON.stringify(logs)
    assert.equal(serialized.includes(POSTHOG_TOKEN), false)
    assert.equal(serialized.includes(MUPOT_TOKEN), false)
  })
})

test('returns partial exit code without echoing sink or credential detail', async () => {
  await withFiles(async ({ configFile, posthogFile, mupotFile }) => {
    const logs = []
    const exitCode = await main({
      env: {
        GEO_SCANNER_CONFIG_FILE: configFile,
        POSTHOG_PROJECT_TOKEN_FILE: posthogFile,
        MUPOT_AGENT_TOKEN_FILE: mupotFile,
      },
      log: (value) => logs.push(value),
      runScan: async () => ({
        ok: false,
        scanId: '11111111-1111-4111-8111-111111111111',
        counts: { ok: 1, empty: 0, failed: 0, budget_denied: 0, sink_failed: 1 },
        costStatus: 'billing_unreconciled',
        receipt: { ok: false, reason: 'mupot_http_503' },
      }),
    })

    assert.equal(exitCode, 2)
    assert.equal(logs[0].status, 'partial')
    assert.equal(logs[0].reason, 'mupot_http_503')
    assert.equal(JSON.stringify(logs).includes(POSTHOG_TOKEN), false)
    assert.equal(JSON.stringify(logs).includes(MUPOT_TOKEN), false)
  })
})

test('fails before execution for unavailable config or malformed secret files', async () => {
  const logs = []
  let runCalls = 0
  assert.equal(await main({
    env: {},
    log: (value) => logs.push(value),
    runScan: async () => {
      runCalls++
    },
  }), 1)
  assert.equal(logs[0].reason, 'config_unavailable')

  await withFiles(async ({ configFile, posthogFile, mupotFile }) => {
    await writeFile(posthogFile, 'token with spaces\n')
    assert.equal(await main({
      env: {
        GEO_SCANNER_CONFIG_FILE: configFile,
        POSTHOG_PROJECT_TOKEN_FILE: posthogFile,
        MUPOT_AGENT_TOKEN_FILE: mupotFile,
      },
      log: (value) => logs.push(value),
      runScan: async () => {
        runCalls++
      },
    }), 1)
    assert.equal(logs.at(-1).reason, 'posthog_credential_unavailable')
  })
  assert.equal(runCalls, 0)
})
