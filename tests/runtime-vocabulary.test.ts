// check_in and attach share GROK_CLI from one module. Divergence is the
// defect that left fleet_agents.runtime = 'pi' after a grok-cli check_in.
import { describe, expect, it } from 'vitest'
import { SEVEN_AXIS_HARNESSES } from '../src/fleet/presence'
import { SEVEN_AXIS_HARNESSES as PARSE_HARNESSES } from '../src/presence/seven-axis'
import { FLEET_RUNTIME_KIND_SET, FLEET_RUNTIME_KINDS, GROK_CLI } from '../src/fleet/runtime-vocabulary'
import { TOOLS } from '../src/mcp/index'

describe('runtime vocabulary — attach and check_in share grok-cli', () => {
  it('GROK_CLI is the attach allow-list spelling', () => {
    expect(GROK_CLI).toBe('grok-cli')
    expect(FLEET_RUNTIME_KINDS).toContain(GROK_CLI)
    expect(FLEET_RUNTIME_KIND_SET.has(GROK_CLI)).toBe(true)
  })

  it('check_in harness enum uses the same GROK_CLI constant', () => {
    expect(SEVEN_AXIS_HARNESSES).toContain(GROK_CLI)
    expect(PARSE_HARNESSES).toContain(GROK_CLI)
    expect([...SEVEN_AXIS_HARNESSES]).toEqual([...PARSE_HARNESSES])
  })

  it('check_in tool schema cannot drop grok-cli independently of attach', () => {
    const toolCheckIn = TOOLS.find((tool) => tool.name === 'check_in')
    if (!toolCheckIn) throw new Error('check_in missing')
    const schemaHarnesses = (toolCheckIn.inputSchema.properties.harness as { enum: string[] }).enum
    expect(schemaHarnesses).toContain(GROK_CLI)
    expect(schemaHarnesses).toEqual([...SEVEN_AXIS_HARNESSES])
  })

  it('does not pretend attach runtimes and check_in harnesses are the same list', () => {
    // attach `codex` is not check_in `codex-cli`. Unioning them is not cheap.
    expect(FLEET_RUNTIME_KINDS).toContain('codex')
    expect(SEVEN_AXIS_HARNESSES).not.toContain('codex')
    expect(SEVEN_AXIS_HARNESSES).toContain('codex-cli')
  })
})
