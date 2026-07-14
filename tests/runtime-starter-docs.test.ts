import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const paths = [
  'fleet-runtime/README.md',
  'docs/runtime-starter.md',
  'docs/GO-LIVE.md',
]

const docs = paths.map((path) => readFileSync(path, 'utf8')).join('\n')
const starter = readFileSync('docs/runtime-starter.md', 'utf8')
const readme = readFileSync('fleet-runtime/README.md', 'utf8')

function expectOrdered(text: string, terms: string[]) {
  let cursor = -1
  for (const term of terms) {
    const index = text.indexOf(term, cursor + 1)
    expect(index, `missing or out of order: ${term}`).toBeGreaterThan(cursor)
    cursor = index
  }
}

describe('runtime starter documentation', () => {
  it.each([
    '--activate',
    'service-manager.mjs install',
    'service-manager.mjs reload',
    'service-manager.mjs status',
    'service-manager.mjs uninstall',
    '--require-services',
    'continuous-runtime-receipt.mjs',
    'control-receipt.mjs --observe-state',
    'loginctl enable-linger',
    'copied bundle',
  ])('documents %s', (term) => {
    expect(docs).toContain(term)
  })

  it('states topology and preservation rules', () => {
    expect(docs).toMatch(/co-resident/i)
    expect(docs).toMatch(/distributed/i)
    expect(docs).toMatch(/preserv(?:e|es|ed)[\s\S]{0,240}configs[\s\S]{0,160}keys[\s\S]{0,160}receipts/i)
    expect(docs).toMatch(/macOS[\s\S]{0,120}launchd/i)
    expect(docs).toMatch(/Linux[\s\S]{0,120}systemd/i)
  })

  it('collects service-aware host evidence inside the per-agent bundle', () => {
    const governed = starter.slice(starter.indexOf('## Governed Start And Stop Evidence'))
    expectOrdered(governed, ['--require-services --service-manager auto', '> "$OUT/host.json"', 'cutover-probe.mjs', 'receipt-bundle.mjs'])
  })

  it('passes the documented named token environment to the inbox probe', () => {
    const governed = starter.slice(starter.indexOf('## Governed Start And Stop Evidence'))
    expectOrdered(governed, ['AGENT_TOKEN_ENV=MUPOT_AGENT_TOKEN_MANAGER', 'cutover-probe.mjs', '--agent-token-env "$AGENT_TOKEN_ENV"', '--queue-inbox --control start'])
  })

  it('queues and observes a fresh start before recovery continuity proof', () => {
    const recovery = starter.slice(starter.indexOf('## Data-Preserving Rollback And Recovery'))
    expectOrdered(recovery, ['recovery-install.json', 'cutover-probe.mjs', '--control start', 'control-receipt.mjs', '--observe-state', 'continuous-runtime-receipt.mjs', '--require-control start'])
  })

  it('uses the unified service lifecycle and lists every preserved directory', () => {
    expect(readme).not.toContain('systemctl --user enable --now fleet-daemon.service')
    expect(starter).toMatch(/preserves configs, keys, runtime files, handlers, inboxes,\s+logs, state, and receipts/i)
  })

  it('passes an explicit Node path to every mutating lifecycle example', () => {
    const shell = [...docs.matchAll(/```bash\n([\s\S]*?)```/g)]
      .map((match) => match[1].replace(/\\\n\s*/g, ' '))
      .join('\n')
    const mutating = shell.split('\n').filter((line) =>
      /service-manager\.mjs (?:install|reload)\b/.test(line) ||
      (/install\.mjs\b/.test(line) && /--activate\b/.test(line)),
    )

    expect(mutating.length).toBeGreaterThan(0)
    for (const command of mutating) expect(command).toContain('--node')
  })

  it('never overwrites the configured control file before reload', () => {
    expect(readme).not.toContain('cp fleet-runtime/control.example.json ~/.fleet/control.json')
    expect(readme).not.toContain('cp fleet-runtime/inbox-handler.example.json ~/.fleet/inbox-handler.json')
    expectOrdered(readme, ['trust-bootstrap.mjs', 'service-manager.mjs reload --service-manager auto'])
  })

  it('keeps credentials out of files and service environments', () => {
    expect(docs).not.toMatch(/EnvironmentVariables[\s\S]{0,200}(?:TOKEN|SECRET|PRIVATE_KEY)/)
    expect(docs).not.toMatch(/Environment=(?:[^\n]*)(?:TOKEN|SECRET|PRIVATE_KEY)/)
    expect(docs).not.toMatch(/(?:MUPOT_AGENT_TOKEN|MUPOT_OWNER_TOKEN)=["']?[A-Za-z0-9_-]{12,}/)
    expect(docs).not.toMatch(/cp\s+fleet-runtime\/fleet-(?:daemon|control-daemon)\.service/)
  })
})
