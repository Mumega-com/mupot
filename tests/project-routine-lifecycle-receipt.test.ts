import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  CHECK_RECEIPT_TYPE,
  REQUIRED_SCREENSHOTS,
  REQUIRED_STEPS,
  REQUIRED_SURFACES,
  STEP_RECEIPT_TYPE,
  checkBundle,
  formatPlan,
  parseArgs,
} from '../scripts/project-routine-lifecycle-receipt.mjs'

const COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const VERSION = '0.25.0'

const TARGET = {
  pot: 'local',
  base_url: 'http://127.0.0.1:8791',
  project_id: 'project-mupot',
  routine_id: 'routine-propose-1',
  routine_run_id: 'run-propose-1',
  commit: COMMIT,
  version: VERSION,
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])))
  return Buffer.concat([length, typeBytes, data, crc])
}

function screenshotPng(): Buffer {
  const width = 320
  const height = 200
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const rows = Buffer.alloc(height * (1 + width * 3))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'mupot-project-routine-lifecycle-'))
}

function evidenceFor(step: string): Record<string, unknown> {
  switch (step) {
    case 'routine_created':
      return {
        routine_id: TARGET.routine_id,
        project_id: TARGET.project_id,
        project_active: true,
        created_by_operator: true,
      }
    case 'routine_enabled':
      return {
        trigger_configured: true,
        enabled: true,
        mode: 'propose',
      }
    case 'manual_fire':
      return {
        routine_run_id: TARGET.routine_run_id,
        run_observed: true,
        occurrence_id: 'occurrence-1',
      }
    case 'runtime_proposal':
      return {
        agent_identity: 'agent-conformance',
        correlated_proposal: true,
        situation_digest_matched: true,
      }
    case 'needs_you_approval':
      return {
        needs_you_item_id: 'needs-you-1',
        human_approval_recorded: true,
        external_action_gated: true,
        external_action_executed: true,
        external_action_approved: true,
      }
    case 'terminal_outcome':
      return {
        terminal_status: 'succeeded',
        cost_recorded: true,
        activity_visible: true,
        evidence_visible: true,
        situation_updated: true,
        idempotent_duplicate_noop: true,
        unauthorized_rejected: true,
      }
    case 'restart_parity':
      return {
        worker_restarted: true,
        durable_state_preserved: true,
        surface_parity: Object.fromEntries(REQUIRED_SURFACES.map((surface) => [surface, true])),
        commit: COMMIT,
        version: VERSION,
      }
    default:
      throw new Error(`unknown step: ${step}`)
  }
}

function baseReceipt(step: string, evidence: Record<string, unknown>, observedAt: string) {
  return {
    receipt_type: STEP_RECEIPT_TYPE,
    step,
    status: 'pass',
    observed_at: observedAt,
    target: TARGET,
    evidence,
    artifacts: [
      { label: `${step} artifact`, path: `artifacts/${step}.json` },
    ],
  }
}

function writeScreenshots(dir: string) {
  mkdirSync(join(dir, 'screenshots'), { recursive: true })
  for (const relative of REQUIRED_SCREENSHOTS) {
    writeFileSync(join(dir, relative), screenshotPng())
  }
}

function writeBundle(dir: string, mutate?: (receipt: Record<string, unknown>, file: string) => void) {
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'artifacts'), { recursive: true })
  writeScreenshots(dir)
  REQUIRED_STEPS.forEach((spec, index) => {
    const receipt = baseReceipt(
      spec.step,
      evidenceFor(spec.step),
      `2026-07-19T18:${String(index).padStart(2, '0')}:00.000Z`,
    )
    mutate?.(receipt, spec.file)
    writeFileSync(join(dir, spec.file), JSON.stringify(receipt, null, 2))
    writeFileSync(join(dir, 'artifacts', `${spec.step}.json`), JSON.stringify({ step: spec.step, verified: true }))
  })
}

describe('project routine lifecycle receipt checker', () => {
  it('provides exact package plan and check commands', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
    expect(pkg.scripts['receipt:project-routine:plan']).toBe(
      'node scripts/project-routine-lifecycle-receipt.mjs --plan',
    )
    expect(pkg.scripts['receipt:project-routine:check']).toBe(
      'node scripts/project-routine-lifecycle-receipt.mjs --check',
    )
  })

  it('parses plan and check arguments', () => {
    expect(parseArgs([
      '--check',
      '--out-dir',
      './tmp/project-routine',
      '--expected-commit',
      COMMIT,
      '--expected-version',
      VERSION,
    ])).toMatchObject({
      check: true,
      expectedCommit: COMMIT,
      expectedVersion: VERSION,
    })
    expect(parseArgs(['--plan', '--project-id', TARGET.project_id]).plan).toBe(true)
  })

  it('prints the Project Routine lifecycle evidence plan', () => {
    const plan = formatPlan({
      outDir: 'tmp/project-routine-lifecycle/run-propose-1',
      pot: TARGET.pot,
      baseUrl: TARGET.base_url,
      projectId: TARGET.project_id,
      routineId: TARGET.routine_id,
      routineRunId: TARGET.routine_run_id,
      expectedCommit: COMMIT,
      expectedVersion: VERSION,
    })

    expect(plan).toContain('Mupot v0.25 Project Routine lifecycle evidence plan')
    expect(plan).toContain(STEP_RECEIPT_TYPE)
    expect(plan).toContain('restart-parity.json')
    expect(plan).toContain('screenshots/desktop-propose-mode.png')
    expect(plan).toContain('project-routine-lifecycle-check.json')
    expect(plan).toContain('Do not bump package version')
  })

  it('passes a complete Project Routine lifecycle bundle', () => {
    const dir = tempDir()
    writeBundle(dir)

    const receipt = checkBundle({
      outDir: dir,
      pot: TARGET.pot,
      baseUrl: TARGET.base_url,
      projectId: TARGET.project_id,
      routineId: TARGET.routine_id,
      routineRunId: TARGET.routine_run_id,
      expectedCommit: COMMIT,
      expectedVersion: VERSION,
    })

    expect(receipt.receipt_type).toBe(CHECK_RECEIPT_TYPE)
    expect(receipt.status).toBe('pass')
    expect(receipt.summary.step_receipts).toBe(REQUIRED_STEPS.length)
    expect(receipt.target.commit).toBe(COMMIT)
    expect(receipt.target.version).toBe(VERSION)
  })

  it('fails when a required screenshot is not a PNG', () => {
    const dir = tempDir()
    writeBundle(dir)
    writeFileSync(join(dir, 'screenshots/desktop-propose-mode.png'), 'not-a-png')

    const receipt = checkBundle({
      outDir: dir,
      expectedCommit: COMMIT,
      expectedVersion: VERSION,
    })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'screenshot_is_png',
      path: 'screenshots/desktop-propose-mode.png',
    }))
  })

  it('rejects a truncated PNG signature without decodable image data', () => {
    const dir = tempDir()
    writeBundle(dir)
    writeFileSync(
      join(dir, 'screenshots/mobile-propose-mode.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )

    const receipt = checkBundle({ outDir: dir, expectedCommit: COMMIT, expectedVersion: VERSION })
    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'screenshot_is_png',
      path: 'screenshots/mobile-propose-mode.png',
    }))
  })

  it('rejects trailing data after the PNG end chunk', () => {
    const dir = tempDir()
    writeBundle(dir)
    writeFileSync(
      join(dir, 'screenshots/mobile-propose-mode.png'),
      Buffer.concat([screenshotPng(), Buffer.from('not-image-data')]),
    )

    const receipt = checkBundle({ outDir: dir, expectedCommit: COMMIT, expectedVersion: VERSION })
    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'screenshot_is_png',
      path: 'screenshots/mobile-propose-mode.png',
    }))
  })

  it('fails when screenshots are absent entirely', () => {
    const missingDir = tempDir()
    REQUIRED_STEPS.forEach((spec, index) => {
      const receipt = baseReceipt(
        spec.step,
        evidenceFor(spec.step),
        `2026-07-19T18:${String(index).padStart(2, '0')}:00.000Z`,
      )
      writeFileSync(join(missingDir, spec.file), JSON.stringify(receipt, null, 2))
    })

    const receipt = checkBundle({
      outDir: missingDir,
      expectedCommit: COMMIT,
      expectedVersion: VERSION,
    })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'screenshot_present',
      path: 'screenshots/desktop-propose-mode.png',
    }))
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'screenshot_present',
      path: 'screenshots/mobile-propose-mode.png',
    }))
  })

  it('fails when commit or version is mismatched', () => {
    const dir = tempDir()
    writeBundle(dir)

    const receipt = checkBundle({
      outDir: dir,
      expectedCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      expectedVersion: '0.24.0',
    })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'target_commit_matches_expected',
    }))
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'target_version_matches_expected',
    }))
  })

  it('fails when any receipt omits a target identity field', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      if (file === 'manual-fire.json') delete (receipt.target as Record<string, unknown>).commit
    })

    const receipt = checkBundle({ outDir: dir, expectedCommit: COMMIT, expectedVersion: VERSION })
    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'target_field_consistent_across_receipts',
      field: 'commit',
    }))
  })

  it('requires each step receipt to declare a real in-bundle artifact', () => {
    const missingList = tempDir()
    writeBundle(missingList, (receipt, file) => {
      if (file === 'manual-fire.json') delete receipt.artifacts
    })
    const missingListReceipt = checkBundle({ outDir: missingList, expectedCommit: COMMIT, expectedVersion: VERSION })
    expect(missingListReceipt.status).toBe('fail')
    expect(missingListReceipt.checks).toContainEqual(expect.objectContaining({
      ok: false, check: 'receipt_artifacts_declared', path: join(missingList, 'manual-fire.json'),
    }))

    const missingFile = tempDir()
    writeBundle(missingFile, (receipt, file) => {
      if (file === 'manual-fire.json') {
        receipt.artifacts = [{ label: 'missing proof', path: 'artifacts/missing.json' }]
      }
    })
    const missingFileReceipt = checkBundle({ outDir: missingFile, expectedCommit: COMMIT, expectedVersion: VERSION })
    expect(missingFileReceipt.status).toBe('fail')
    expect(missingFileReceipt.checks).toContainEqual(expect.objectContaining({
      ok: false, check: 'receipt_artifact_file_present', artifact_path: 'artifacts/missing.json',
    }))
  })

  it('rejects artifact path traversal and secret material', () => {
    const traversal = tempDir()
    writeBundle(traversal, (receipt, file) => {
      if (file === 'manual-fire.json') receipt.artifacts = [{ label: 'outside', path: '../outside.json' }]
    })
    const traversalReceipt = checkBundle({ outDir: traversal, expectedCommit: COMMIT, expectedVersion: VERSION })
    expect(traversalReceipt.status).toBe('fail')
    expect(traversalReceipt.checks).toContainEqual(expect.objectContaining({
      ok: false, check: 'receipt_artifact_reference_valid', artifact_path: '../outside.json',
    }))

    const secret = tempDir()
    writeBundle(secret)
    writeFileSync(join(secret, 'artifacts', 'manual_fire.json'), JSON.stringify({ authorization: 'Bearer abcdefghijklmnop' }))
    const secretReceipt = checkBundle({ outDir: secret, expectedCommit: COMMIT, expectedVersion: VERSION })
    expect(secretReceipt.status).toBe('fail')
    expect(secretReceipt.checks).toContainEqual(expect.objectContaining({
      ok: false, check: 'receipt_artifact_has_no_secret_material', artifact_path: 'artifacts/manual_fire.json',
    }))
  })

  it('rejects stringified false proof and a nonterminal status', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      if (file === 'terminal-outcome.json') {
        const evidence = receipt.evidence as Record<string, unknown>
        evidence.unauthorized_rejected = 'no'
        evidence.terminal_status = 'running'
      }
    })

    const receipt = checkBundle({ outDir: dir, expectedCommit: COMMIT, expectedVersion: VERSION })
    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'required_evidence_present',
      evidence: 'unauthorized_rejected',
    }))
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'required_evidence_present',
      evidence: 'terminal_status',
    }))
  })

  it('fails when surface parity is incomplete', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      if (file === 'restart-parity.json') {
        const evidence = receipt.evidence as Record<string, unknown>
        evidence.surface_parity = {
          browser: true,
          rest: true,
          mcp: true,
        }
      }
    })

    const receipt = checkBundle({
      outDir: dir,
      expectedCommit: COMMIT,
      expectedVersion: VERSION,
    })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'surface_parity_complete',
    }))
  })

  it('fails when restart proof is absent', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      if (file === 'restart-parity.json') {
        const evidence = receipt.evidence as Record<string, unknown>
        evidence.worker_restarted = false
        delete evidence.durable_state_preserved
      }
    })

    const receipt = checkBundle({
      outDir: dir,
      expectedCommit: COMMIT,
      expectedVersion: VERSION,
    })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'restart_proof_worker_restarted',
    }))
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'required_evidence_present',
      evidence: 'durable_state_preserved',
    }))
  })

  it('fails when an external action is executed without approval', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      if (file === 'needs-you-approval.json') {
        const evidence = receipt.evidence as Record<string, unknown>
        evidence.external_action_executed = true
        evidence.external_action_approved = false
      }
    })

    const receipt = checkBundle({
      outDir: dir,
      expectedCommit: COMMIT,
      expectedVersion: VERSION,
    })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'external_action_requires_approval',
    }))
  })

  it('fails when an unapproved external action flag is present', () => {
    const dir = tempDir()
    writeBundle(dir, (receipt, file) => {
      if (file === 'needs-you-approval.json') {
        const evidence = receipt.evidence as Record<string, unknown>
        evidence.unapproved_external_action = true
      }
    })

    const receipt = checkBundle({
      outDir: dir,
      expectedCommit: COMMIT,
      expectedVersion: VERSION,
    })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'no_unapproved_external_action_flag',
    }))
  })
})
