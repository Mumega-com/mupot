import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { checkBundle as checkIntegrity } from '../scripts/release-integrity-receipt.mjs'
import {
  checkBundle as checkReadiness,
  formatPlan as readinessPlan,
  parseArgs as readinessArgs,
} from '../scripts/release-readiness-receipt.mjs'

const VERSION = 'v0.30.0'
const CONTRACT_RELATIVE = 'docs/releases/v0.30.0-contract.json'
const CONTRACT = join(process.cwd(), CONTRACT_RELATIVE)

describe('v0.30.0 repository release contract', () => {
  const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as {
    receipts: Array<{ file: string; receipt_type: string }>
  }

  it('requires the neutral Host-Go cutover receipt', () => {
    expect(contract.receipts).toContainEqual(expect.objectContaining({
      file: 'host-go/cutover-gate.json',
      receipt_type: 'mupot-host-go-cutover/v1',
    }))
    expect(JSON.stringify(contract)).not.toContain('mupot-sos-cutover-gate/v1')
    const plan = readinessPlan({
      version: VERSION,
      contractPath: CONTRACT_RELATIVE,
      outDir: 'tmp/release-readiness/v0.30.0',
      repo: 'Mumega-com/mupot',
      checksPr: '1250',
      releaseSha: 'a'.repeat(40),
      phase: 'prepublication',
    })
    expect(plan).toContain('mupot-host-go-cutover/v1')
    expect(plan).not.toContain('mupot-sos-cutover-gate/v1')
  })

  it('keeps the caller contract path portable in generated commands', () => {
    const opts = readinessArgs([
      '--plan',
      '--version', VERSION,
      '--contract', CONTRACT_RELATIVE,
      '--checks-pr', '1249',
      '--release-sha', 'a'.repeat(40),
    ])

    expect(readinessPlan(opts)).toContain(`--contract ${CONTRACT_RELATIVE}`)
  })

  it('drives prepublication and final plans without legacy issue trackers', () => {
    const common = {
      version: VERSION,
      contractPath: CONTRACT_RELATIVE,
      outDir: 'tmp/release-readiness/v0.30.0',
      repo: 'Mumega-com/mupot',
      checksPr: '1249',
      releaseSha: 'a'.repeat(40),
    }

    const prepublication = readinessPlan({ ...common, phase: 'prepublication' })
    const final = readinessPlan({ ...common, phase: 'final' })

    expect(prepublication).toContain('Mupot v0.30.0 prepublication-readiness evidence plan')
    expect(prepublication).toContain('stable-deployment-check.json')
    expect(prepublication).not.toContain('release-integrity-check.json')
    expect(prepublication).not.toContain('issue #')
    expect(prepublication).not.toContain('github-issues.json')
    expect(prepublication).toContain(`--contract ${CONTRACT_RELATIVE}`)

    expect(final).toContain('Mupot v0.30.0 final release-readiness evidence plan')
    expect(final).toContain('stable-deployment-check.json')
    expect(final).toContain('release-integrity-check.json')
  })

  it('binds integrity to the v0.30 document, changelog entry, and roadmap section', () => {
    const receipt = checkIntegrity({
      repoRoot: process.cwd(),
      outDir: mkdtempSync(join(tmpdir(), 'mupot-v030-integrity-')),
      version: VERSION,
      repo: 'Mumega-com/mupot',
    })

    expect(receipt.artifacts.release_doc).toMatchObject({
      exists: true,
      path: join(process.cwd(), 'docs', 'releases', 'v0.30.0.md'),
    })
    for (const check of [
      'changelog_has_final_version_entry',
      'roadmap_has_final_version_section',
      'release_doc_names_final_version',
      'release_doc_keeps_release_integrity_gate',
    ]) {
      expect(receipt.checks).toContainEqual(expect.objectContaining({ ok: true, check }))
    }
  })

  it('records the exact release-contract hash in readiness receipts', () => {
    const receipt = checkReadiness({
      version: VERSION,
      contractPath: CONTRACT,
      outDir: mkdtempSync(join(tmpdir(), 'mupot-v030-readiness-')),
      checksPr: '1249',
      releaseSha: 'a'.repeat(40),
      phase: 'prepublication',
    })

    expect(receipt.contract).toMatchObject({
      schema_version: 1,
      version: VERSION,
      source: CONTRACT,
    })
    expect(receipt.contract.sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})
