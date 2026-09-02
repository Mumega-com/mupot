// check_in and attach share GROK_CLI from one module. Divergence is the
// defect that left fleet_agents.runtime = 'pi' after a grok-cli check_in.
import { describe, expect, it } from 'vitest'
import { SEVEN_AXIS_HARNESSES } from '../src/fleet/presence'
import { SEVEN_AXIS_HARNESSES as PARSE_HARNESSES } from '../src/presence/seven-axis'
import { CURSOR_CLI, FLEET_RUNTIME_KIND_SET, FLEET_RUNTIME_KINDS, GROK_CLI } from '../src/fleet/runtime-vocabulary'
import { TOOLS } from '../src/mcp/index'

describe('runtime vocabulary — attach and check_in agree where they must, differ where they should', () => {
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
  // A cursor-agent seat could not hold a correct fleet_agents.runtime: check_in
  // already accepted cursor-ide/cursor-cloud while attach accepted no cursor
  // spelling at all, so the row stayed wrong however truthfully the seat reported.
  it('attach accepts the cursor-agent CLI', () => {
    expect(CURSOR_CLI).toBe('cursor')
    expect(FLEET_RUNTIME_KINDS).toContain(CURSOR_CLI)
    expect(FLEET_RUNTIME_KIND_SET.has(CURSOR_CLI)).toBe(true)
  })

  it('keeps the three cursor bodies distinct — CLI is not the IDE or the cloud agent', () => {
    // Same vendor, three different runtimes. Blurring them puts dispatch on the
    // wrong body: fleet_agents.runtime is what task dispatch reads.
    expect(SEVEN_AXIS_HARNESSES).toContain('cursor-ide')
    expect(SEVEN_AXIS_HARNESSES).toContain('cursor-cloud')
    expect(SEVEN_AXIS_HARNESSES).not.toContain(CURSOR_CLI)
    expect(FLEET_RUNTIME_KINDS).not.toContain('cursor-ide')
    expect(FLEET_RUNTIME_KINDS).not.toContain('cursor-cloud')
  })
})
