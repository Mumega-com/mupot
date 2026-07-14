import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const paths = [
  'fleet-runtime/README.md',
  'docs/runtime-starter.md',
  'docs/GO-LIVE.md',
]

const docs = paths.map((path) => readFileSync(path, 'utf8')).join('\n')

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

  it('keeps credentials out of files and service environments', () => {
    expect(docs).not.toMatch(/EnvironmentVariables[\s\S]{0,200}(?:TOKEN|SECRET|PRIVATE_KEY)/)
    expect(docs).not.toMatch(/Environment=(?:[^\n]*)(?:TOKEN|SECRET|PRIVATE_KEY)/)
    expect(docs).not.toMatch(/(?:MUPOT_AGENT_TOKEN|MUPOT_OWNER_TOKEN)=["']?[A-Za-z0-9_-]{12,}/)
    expect(docs).not.toMatch(/cp\s+fleet-runtime\/fleet-(?:daemon|control-daemon)\.service/)
  })
})
