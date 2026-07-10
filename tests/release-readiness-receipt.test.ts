import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildBundle, exportBundle } from '../fleet-runtime/receipt-bundle.mjs'
import {
  CHECK_RECEIPT_TYPE,
  REQUIRED_APP_PERMISSIONS,
  REQUIRED_CHECKS,
  REQUIRED_ISSUES,
  REQUIRED_RECEIPTS,
  checkBundle,
  formatPlan,
  parseArgs,
} from '../scripts/release-readiness-receipt.mjs'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'mupot-release-readiness-'))
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}

function sha256(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const HOST_BASE_URL = 'https://pot.example.org'
const HOST_TENANT = 'tenant-a'

function hostProbeReceipt() {
  return {
    receipt_type: 'mupot-fleet-cutover-probe/v1',
    generated_at: '2026-07-08T00:00:30.000Z',
    status: 'pass',
    summary: { status: 'pass', passed: 2, failed: 0, warnings: 0 },
    inputs: { base_url: HOST_BASE_URL, agent: 'agent-one', queue_inbox: true, control_verbs: ['start'] },
    actions: [
      { kind: 'inbox_probe', target_agent: 'agent-one', request_id: 'probe-1-inbox', ok: true },
      { kind: 'control_request', target_agent: 'agent-one', verb: 'start', ok: true },
    ],
    checks: [{ ok: true, component: 'cutover-probe', check: 'inbox_probe_queued' }],
  }
}

function hostReceipt() {
  return {
    receipt_type: 'mupot-fleet-host-receipt/v1',
    generated_at: '2026-07-08T00:00:00.000Z',
    status: 'pass',
    summary: { status: 'pass', passed: 1, failed: 0, warnings: 0 },
    target: {
      base_url: HOST_BASE_URL,
      tenant: HOST_TENANT,
      daemon_agents: ['agent-one'],
      control_consumer_agent: 'fleet-consumer',
    },
    checks: [{ ok: true, component: 'fleet-control-daemon', check: 'panel_public_key_public_only' }],
  }
}

function runtimeReceipt() {
  return {
    receipt_type: 'mupot-fleet-runtime-receipt/v1',
    generated_at: '2026-07-08T00:01:00.000Z',
    status: 'pass',
    inputs: { selected_agents: ['agent-one'] },
    target: { base_url: HOST_BASE_URL, tenant: HOST_TENANT, agents: ['agent-one'] },
    agents: [{ agent: 'agent-one' }],
    checks: [
      { ok: true, component: 'fleet-daemon', check: 'signed_attach_ok', agent_id: 'agent-one' },
      { ok: true, component: 'fleet-daemon', check: 'signed_inbox_handoff_consumed', agent_id: 'agent-one' },
    ],
  }
}

function controlReceipt(verb: 'start' | 'stop') {
  const action = verb === 'start' ? 'open' : 'close'
  return {
    receipt_type: 'mupot-fleet-control-receipt/v1',
    generated_at: '2026-07-08T00:02:00.000Z',
    status: 'pass',
    target: {
      base_url: HOST_BASE_URL,
      tenant: HOST_TENANT,
      consumer_agent: 'fleet-consumer',
      executed_agents: ['agent-one'],
    },
    checks: [{ ok: true, component: 'fleet-control-daemon', check: 'control_request_executed', agent_id: 'agent-one', verb, action }],
    poll: { ok: true, action, request: { agent_id: 'agent-one', verb } },
  }
}

async function writeHostBundle(exportDir: string) {
  const sourceDir = tempDir()
  writeJson(join(sourceDir, 'probe-start.json'), hostProbeReceipt())
  writeJson(join(sourceDir, 'host.json'), hostReceipt())
  writeJson(join(sourceDir, 'runtime-agent-one.json'), runtimeReceipt())
  writeJson(join(sourceDir, 'control-start.json'), controlReceipt('start'))
  writeJson(join(sourceDir, 'control-stop.json'), controlReceipt('stop'))
  await buildBundle({
    outDir: sourceDir,
    agents: ['agent-one'],
    daemonPath: '/tmp/daemon.json',
    inboxPath: '/tmp/inbox.json',
    controlPath: '/tmp/control.json',
    verifyOnly: true,
    requiredControlVerbs: ['start', 'stop'],
  })
  const exported = exportBundle({ outDir: sourceDir, exportDir })
  if (exported.status !== 'pass') throw new Error('failed to build passing host bundle fixture')
}

async function writeBundle(dir: string, mutate?: (dir: string) => void) {
  mkdirSync(join(dir, 'host-go'), { recursive: true })
  for (const required of REQUIRED_RECEIPTS) {
    if (required.file.startsWith('host-go/')) continue
    writeJson(join(dir, required.file), {
      receipt_type: required.receipt_type,
      status: 'pass',
      checked_at: '2026-07-10T00:00:00.000Z',
      evidence: {
        objective: required.objective,
        issue: required.issue,
      },
    })
  }
  await writeHostBundle(join(dir, 'host-go'))

  writeJson(join(dir, 'github-issues.json'), REQUIRED_ISSUES.map((number) => ({
    number,
    title: `issue ${number}`,
    state: 'CLOSED',
    url: `https://github.test/issues/${number}`,
  })))

  writeJson(join(dir, 'github-checks.json'), REQUIRED_CHECKS.map((name) => ({
    name,
    bucket: 'pass',
    state: 'SUCCESS',
    link: `https://github.test/checks/${encodeURIComponent(name)}`,
  })))

  writeJson(join(dir, 'github-pr.json'), {
    number: 285,
    url: 'https://github.test/pull/285',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'codex/v0.23-rc',
    headRefOid: 'abc123',
    baseRefName: 'main',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: REQUIRED_CHECKS.map((name) => ({
      name,
      conclusion: 'SUCCESS',
      status: 'COMPLETED',
      link: `https://github.test/checks/${encodeURIComponent(name)}`,
    })),
  })

  writeJson(join(dir, 'github-app.json'), {
    id: 123456,
    slug: 'mupot',
    permissions: REQUIRED_APP_PERMISSIONS,
  })
  writeJson(join(dir, 'github-installation.json'), {
    id: 789012,
    app_id: 123456,
    app_slug: 'mupot',
    account: { login: 'Mumega-com', id: 999, type: 'Organization' },
    repository_selection: 'all',
    permissions: REQUIRED_APP_PERMISSIONS,
    updated_at: '2026-07-10T00:00:00.000Z',
    suspended_at: null,
  })
  const permissionReceipt = REQUIRED_RECEIPTS.find((receipt) => receipt.file === 'github-app-permissions-check.json')!
  writeJson(join(dir, permissionReceipt.file), {
    receipt_type: permissionReceipt.receipt_type,
    status: 'pass',
    artifacts: {
      'github-app.json': { sha256: sha256(join(dir, 'github-app.json')) },
      'github-installation.json': { sha256: sha256(join(dir, 'github-installation.json')) },
    },
  })

  mutate?.(dir)
}

describe('release readiness receipt checker', () => {
  it('parses plan and check arguments', () => {
    expect(parseArgs(['--plan', '--version', 'v0.23.0']).plan).toBe(true)
    expect(parseArgs(['--check', '--out-dir', './tmp/release-readiness']).check).toBe(true)
    expect(parseArgs(['--plan', '--checks-pr', '285']).checksPr).toBe('285')
  })

  it('prints the final release-readiness evidence plan', () => {
    const plan = formatPlan({
      outDir: 'tmp/release-readiness/v0.23.0',
      version: 'v0.23.0',
      repo: 'Mumega-com/mupot',
      checksPr: '285',
    })

    expect(plan).toContain('Mupot v0.23 final release-readiness evidence plan')
    expect(plan).toContain('complete exported #274 attachable directory')
    expect(plan).toContain('reruns the read-only fleet manifest verifier')
    expect(plan).toContain('fresh-install-check.json')
    expect(plan).toContain('github-issues.json')
    expect(plan).toContain('github-pr.json')
    expect(plan).toContain('gh pr view 285 --repo Mumega-com/mupot')
    expect(plan).toContain('github-checks.json')
    expect(plan).toContain('gh pr checks --repo Mumega-com/mupot 285')
    expect(plan).toContain('github-app.json')
    expect(plan).toContain('github-installation.json')
    expect(plan).toContain('--installation-id')
    expect(plan).toContain('--export-gh')
    expect(plan).toContain('--organization')
    expect(plan).not.toContain('--export-app')
    expect(plan).not.toContain('--private-key-file')
    expect(plan).toContain('release-readiness-check.json')
  })

  it('passes when every objective receipt, issue, and CI check is present and passing', async () => {
    const dir = tempDir()
    await writeBundle(dir)

    const receipt = checkBundle({ outDir: dir, version: 'v0.23.0', checksPr: '285' })

    expect(receipt.receipt_type).toBe(CHECK_RECEIPT_TYPE)
    expect(receipt.status).toBe('pass')
    expect(receipt.summary.required_receipts).toBe(REQUIRED_RECEIPTS.length)
    expect(receipt.summary.required_issues).toBe(REQUIRED_ISSUES.length)
    expect(receipt.summary.required_ci_checks).toBe(REQUIRED_CHECKS.length)
    expect(receipt.summary.required_app_permissions).toBe(Object.keys(REQUIRED_APP_PERMISSIONS).length)
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: true,
      check: 'host_go_exported_bundle_reverified',
      status: 'pass',
    }))
  })

  it('fails when an artifact in the copied host bundle is changed after export', async () => {
    const dir = tempDir()
    await writeBundle(dir)
    const hostPath = join(dir, 'host-go', 'host.json')
    const host = JSON.parse(readFileSync(hostPath, 'utf8'))
    host.generated_at = '2026-07-10T02:00:00.000Z'
    writeJson(hostPath, host)

    const receipt = checkBundle({ outDir: dir, version: 'v0.23.0', checksPr: '285' })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'host_go_exported_bundle_reverified',
      status: 'fail',
    }))
  })

  it('fails when a required receipt has the wrong type', async () => {
    const dir = tempDir()
    await writeBundle(dir, () => {
      const required = REQUIRED_RECEIPTS[0]
      writeJson(join(dir, required.file), {
        receipt_type: 'wrong/v1',
        status: 'pass',
      })
    })

    const receipt = checkBundle({ outDir: dir, version: 'v0.23.0', checksPr: '285' })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'receipt_type_matches',
      expected: REQUIRED_RECEIPTS[0].receipt_type,
    }))
  })

  it('fails when a release tracker issue is still open', async () => {
    const dir = tempDir()
    await writeBundle(dir, () => {
      writeJson(join(dir, 'github-issues.json'), REQUIRED_ISSUES.map((number) => ({
        number,
        state: number === 150 ? 'OPEN' : 'CLOSED',
      })))
    })

    const receipt = checkBundle({ outDir: dir, version: 'v0.23.0', checksPr: '285' })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'required_issue_closed',
      issue: 150,
    }))
  })

  it('fails when a required CI check did not pass', async () => {
    const dir = tempDir()
    await writeBundle(dir, () => {
      writeJson(join(dir, 'github-checks.json'), REQUIRED_CHECKS.map((name) => ({
        name,
        bucket: name === 'local-evidence' ? 'fail' : 'pass',
        state: name === 'local-evidence' ? 'FAILURE' : 'SUCCESS',
      })))
    })

    const receipt = checkBundle({ outDir: dir, version: 'v0.23.0', checksPr: '285' })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'required_ci_check_passed',
      check_name: 'local-evidence',
    }))
  })

  it('fails when the GitHub App still has workflow write permission', async () => {
    const dir = tempDir()
    await writeBundle(dir, () => {
      writeJson(join(dir, 'github-app.json'), {
        permissions: {
          ...REQUIRED_APP_PERMISSIONS,
          workflows: 'write',
        },
      })
    })

    const receipt = checkBundle({ outDir: dir, version: 'v0.23.0', checksPr: '285' })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'github_app_workflows_disabled',
      actual: 'write',
    }))
  })

  it('fails when the GitHub App has extra organization admin permissions', async () => {
    const dir = tempDir()
    await writeBundle(dir, () => {
      writeJson(join(dir, 'github-app.json'), {
        permissions: {
          ...REQUIRED_APP_PERMISSIONS,
          members: 'write',
        },
      })
    })

    const receipt = checkBundle({ outDir: dir, version: 'v0.23.0', checksPr: '285' })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'github_app_has_no_extra_permissions',
      extras: [{ permission: 'members', actual: 'write' }],
    }))
  })

  it('fails when the installed GitHub App retained broader effective permissions', async () => {
    const dir = tempDir()
    await writeBundle(dir, () => {
      writeJson(join(dir, 'github-installation.json'), {
        id: 789012,
        app_id: 123456,
        app_slug: 'mupot',
        account: { login: 'Mumega-com', id: 999, type: 'Organization' },
        permissions: {
          ...REQUIRED_APP_PERMISSIONS,
          organization_secrets: 'write',
        },
        suspended_at: null,
      })
    })

    const receipt = checkBundle({ outDir: dir, version: 'v0.23.0', checksPr: '285' })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'github_installation_has_no_extra_permissions',
      extras: [{ permission: 'organization_secrets', actual: 'write' }],
    }))
  })

  it('fails when permission artifacts do not match the passing permission receipt', async () => {
    const dir = tempDir()
    await writeBundle(dir, () => {
      const installation = JSON.parse(readFileSync(join(dir, 'github-installation.json'), 'utf8'))
      installation.updated_at = '2026-07-10T01:00:00.000Z'
      writeJson(join(dir, 'github-installation.json'), installation)
    })

    const receipt = checkBundle({ outDir: dir, version: 'v0.23.0', checksPr: '285' })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'github_permission_artifact_matches_receipt',
      file: 'github-installation.json',
    }))
  })

  it('fails when the release-candidate PR metadata is from another PR', async () => {
    const dir = tempDir()
    await writeBundle(dir, () => {
      writeJson(join(dir, 'github-pr.json'), {
        number: 284,
        statusCheckRollup: REQUIRED_CHECKS.map((name) => ({
          name,
          conclusion: 'SUCCESS',
          status: 'COMPLETED',
        })),
      })
    })

    const receipt = checkBundle({ outDir: dir, version: 'v0.23.0', checksPr: '285' })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'checks_pr_number_matches_export',
      expected: 285,
      actual: 284,
    }))
  })

  it('fails when the release-candidate PR rollup lacks a required passing check', async () => {
    const dir = tempDir()
    await writeBundle(dir, () => {
      writeJson(join(dir, 'github-pr.json'), {
        number: 285,
        statusCheckRollup: REQUIRED_CHECKS.map((name) => ({
          name,
          conclusion: name === 'CodeQL' ? 'FAILURE' : 'SUCCESS',
          status: 'COMPLETED',
        })),
      })
    })

    const receipt = checkBundle({ outDir: dir, version: 'v0.23.0', checksPr: '285' })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'required_pr_rollup_check_passed',
      check_name: 'CodeQL',
    }))
  })
})
