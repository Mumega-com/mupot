#!/usr/bin/env node

import { readFile } from 'node:fs/promises'

import { validateScannerConfig } from './contract.mjs'
import { runGeoScan } from './scanner.mjs'

async function readSecret(path, code, readFileImpl) {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error(code)
  let value
  try {
    value = (await readFileImpl(path, 'utf8')).trim()
  } catch {
    throw new Error(code)
  }
  if (value.length < 16 || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new Error(code)
  }
  return value
}

export async function main({
  env = process.env,
  log = (value) => console.log(JSON.stringify(value)),
  runScan = runGeoScan,
  readFileImpl = readFile,
} = {}) {
  try {
    if (typeof env.GEO_SCANNER_CONFIG_FILE !== 'string' || !env.GEO_SCANNER_CONFIG_FILE.startsWith('/')) {
      throw new Error('config_unavailable')
    }
    const config = validateScannerConfig(JSON.parse(
      await readFileImpl(env.GEO_SCANNER_CONFIG_FILE, 'utf8'),
    ))
    const posthogToken = await readSecret(
      env.POSTHOG_PROJECT_TOKEN_FILE,
      'posthog_credential_unavailable',
      readFileImpl,
    )
    const mupotToken = await readSecret(
      env.MUPOT_AGENT_TOKEN_FILE,
      'mupot_credential_unavailable',
      readFileImpl,
    )
    const result = await runScan(config, { posthogToken, mupotToken })
    log({
      schema: 'mupot.geo-scanner-run/v1',
      scan_id: result.scanId,
      project_id: config.projectId,
      counts: result.counts,
      cost_status: result.costStatus,
      status: result.ok ? 'complete' : 'partial',
      ...(!result.receipt.ok ? { reason: result.receipt.reason } : {}),
    })
    return result.ok ? 0 : 2
  } catch (error) {
    log({
      schema: 'mupot.geo-scanner-run/v1',
      status: 'failed',
      reason: typeof error?.message === 'string'
        ? error.message.slice(0, 128)
        : 'scanner_failed',
    })
    return 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main()
}
