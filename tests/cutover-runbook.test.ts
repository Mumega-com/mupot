import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const runbook = readFileSync(new URL('../docs/squad-mupot-cutover.md', import.meta.url), 'utf8')

describe('squad mupot cutover runbook', () => {
  it('does not describe wake-hook cutover as blocked by a missing inbox route', () => {
    expect(runbook).toContain('now that signed inbox exists')
    expect(runbook).toContain('gated by live host receipts, not by route availability')
    expect(runbook).toContain('/api/inbox/signed')
    expect(runbook).toContain('fleet-runtime/inbox-handler.mjs')
    expect(runbook).not.toContain('blocked on the HTTP inbox route')
    expect(runbook).not.toContain('once the HTTP inbox route exists')
  })

  it('keeps SOS wake-hook removal gated by the complete host evidence bundle', () => {
    expect(runbook).toContain('until the target host has a passing receipt bundle')
    expect(runbook).toContain('install.json')
    expect(runbook).toContain('probe-*.json')
    expect(runbook).toContain('runtime-<agent_id>.json')
    expect(runbook).toContain('control-*.json')
    expect(runbook).toContain('cutover-gate.json')
    expect(runbook).toContain('manifest.json')
    expect(runbook).toContain('manifest.json` and `cutover-gate.json` report `status:"pass"`')
    expect(runbook).toContain('--verify-only')
    expect(runbook).toContain('--check-manifest')
    expect(runbook).toContain('mupot-fleet-receipt-bundle-check/v1')
    expect(runbook).toContain('SHA-256 hashes')
    expect(runbook).toContain('manifest.json.next_steps')
    expect(runbook).toContain('advisory `next_steps`')
  })
})
