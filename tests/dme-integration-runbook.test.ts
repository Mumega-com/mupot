import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const runbook = readFileSync(new URL('../docs/dme-integration-runbook.md', import.meta.url), 'utf8')
const receipt = readFileSync(new URL('../docs/releases/dme-integration.md', import.meta.url), 'utf8')
const activation = readFileSync(new URL('../docs/dme-activation-runbook.md', import.meta.url), 'utf8')
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
  scripts: Record<string, string>
}
const versionSource = readFileSync(new URL('../src/version.ts', import.meta.url), 'utf8')
const addonManifest = readFileSync(new URL('../src/addons/project-link/manifest.ts', import.meta.url), 'utf8')

describe('DME integration runbook', () => {
  it('covers every operator section required by the release brief', () => {
    for (const heading of [
      '## Installation',
      '## Token handling',
      '## Activation modes',
      '## Project pairing',
      '## Troubleshooting',
      '## Rollback',
      '## Evidence verification',
    ]) {
      expect(runbook).toContain(heading)
    }
  })

  it('documents clean-pot install, addon activation, and local reproduction commands', () => {
    expect(runbook).toContain('scripts/provision-pot.sh')
    expect(runbook).toContain('/api/addons/project-link/')
    expect(runbook).toContain('PROJECT_LINK_SIGNING_KEY')
    expect(runbook).toContain('npx vitest run')
    expect(runbook).toContain('tests/project-link-addon.test.ts')
    expect(runbook).toContain('createProjectLink')
  })

  it('documents token mint, show-once storage, and revocation', () => {
    expect(runbook).toContain('mintAgentBoundToken')
    expect(runbook).toContain('/admin/agent-token/mint')
    expect(runbook).toContain('show-once')
    expect(runbook).toContain('Never put bearer values')
    expect(runbook).toContain('Revoke the token row')
  })

  it('names on-demand, supervised background, and Kubernetes Host activation modes', () => {
    expect(runbook).toContain('**On demand**')
    expect(runbook).toContain('**Supervised background**')
    expect(runbook).toContain('**Kubernetes Host**')
    expect(runbook).toContain('bearer_only')
    expect(runbook).toContain('signed_only')
  })

  it('documents pairing contract, deliver path, and customer-data boundary', () => {
    expect(runbook).toContain('remote_base_url')
    expect(runbook).toContain('approved_evidence_origins')
    expect(runbook).toContain('api/project-links/')
    expect(runbook).toContain('/deliver')
    expect(runbook).toContain('mupot.project-link-envelope/v1')
    expect(runbook).toContain('prohibited_content')
    expect(runbook).toContain('never raw `INSERT INTO project_links`')
  })

  it('documents rollback for link, Host, addon, and pot deploy', () => {
    expect(runbook).toContain('revokeProjectLink')
    expect(runbook).toContain('--mode rollback-ready')
    expect(runbook).toContain('--mode rollback-complete')
    expect(runbook).toContain('/api/addons/project-link/disable')
    expect(runbook).toContain('wrangler rollback')
  })

  it('documents flight evidence verification with token files', () => {
    expect(runbook).toContain('receipt:project-link-flight')
    expect(runbook).toContain('--source-token-file')
    expect(runbook).toContain('--destination-token-file')
    expect(runbook).toContain('mupot.project-link-flight-evidence/v1')
    expect(runbook).toContain('shared_receipt_sha256')
  })

  it('links the release receipt', () => {
    expect(runbook).toContain('./releases/dme-integration.md')
  })
})

describe('DME integration release receipt', () => {
  it('pins package, public API, and addon versions that match the tree', () => {
    expect(pkg.version).toBe('0.24.0')
    expect(versionSource).toContain("MUPOT_PUBLIC_API_VERSION = '0.24.0'")
    expect(addonManifest).toContain("key: 'project-link'")
    expect(addonManifest).toContain("version: '1.0.0'")
    expect(addonManifest).toContain("mupotCompatibility: '^0.24.0'")
    expect(receipt).toContain('`0.24.0`')
    expect(receipt).toContain('`1.0.0`')
    expect(receipt).toContain('`^0.24.0`')
  })

  it('links automated checks and matching evidence schemas', () => {
    for (const check of [
      'tests/project-link-addon.test.ts',
      'tests/project-link-routes.test.ts',
      'tests/project-link-ssrf.test.ts',
      'tests/project-link-envelope-security.test.ts',
      'tests/send-target-confinement.test.ts',
      'tests/kubernetes-agent-host.test.ts',
      'tests/dme-integration-runbook.test.ts',
    ]) {
      expect(receipt).toContain(check)
    }

    for (const schema of [
      'mupot.project-link-flight-evidence/v1',
      'mupot-kubernetes-agent-host-receipt/v1',
      'mupot.hermes-plugin-smoke/v1',
      'mupot.project-link-envelope/v1',
      'mupot.project-link-receipt/v1',
      'mupot.project-link-receipt-proof/v1',
    ]) {
      expect(receipt).toContain(schema)
    }
  })

  it('names the npm scripts that produce matching evidence', () => {
    expect(pkg.scripts['receipt:project-link-flight']).toBe('node scripts/project-link-flight-evidence.mjs')
    expect(pkg.scripts['receipt:kubernetes-agent-host']).toBe('node scripts/kubernetes-agent-host-receipt.mjs')
    expect(pkg.scripts['receipt:kubernetes-hermes-plugin-smoke']).toBe(
      'node scripts/kubernetes-hermes-plugin-smoke-evidence.mjs',
    )
    expect(pkg.scripts['activate:kubernetes-agent-host']).toBe('node scripts/kubernetes-agent-host-activate.mjs')
    expect(receipt).toContain('receipt:project-link-flight')
    expect(receipt).toContain('receipt:kubernetes-agent-host')
    expect(receipt).toContain('receipt:kubernetes-hermes-plugin-smoke')
    expect(receipt).toContain('activate:kubernetes-agent-host')
  })

  it('links the operator runbook and states the green definition', () => {
    expect(receipt).toContain('../dme-integration-runbook.md')
    expect(receipt).toContain('## Integration green definition')
    expect(receipt).toContain('status:"pass"')
  })
})

describe('DME integration discoverability', () => {
  it('is linked from the activation runbook and README', () => {
    expect(activation).toContain('./dme-integration-runbook.md')
    expect(activation).toContain('./releases/dme-integration.md')
    expect(readme).toContain('./docs/dme-integration-runbook.md')
    expect(readme).toContain('./docs/releases/dme-integration.md')
  })
})
