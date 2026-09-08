// The picker groups department -> squad -> agent.
//
// Asserts the OUTCOME — what the operator's browser actually renders — not that
// the data arrived on the view model. #1218 shipped a fix whose tests proved an
// intermediate (auth.memberId was set) while the page it was meant to fix still
// rendered empty; the check that would have caught it is the one that reads the
// output.
import { describe, expect, it } from 'vitest'
import { enrollPageBody } from '../src/dashboard/enroll'
import type { EnrollView } from '../src/dashboard/enroll'

type ViewAgent = EnrollView['agents'][number]

function agent(over: Partial<ViewAgent>): ViewAgent {
  return {
    id: 'ag-1',
    slug: 'a-one',
    name: 'Agent One',
    squad_id: 'sq-1',
    squad_name: 'Core Platform',
    department_id: 'dep-1',
    department_name: 'Engineering',
    autonomy: 'draft',
    budget_cap_cents: null,
    budget_window: 'week',
    capabilities: [],
    liveKeys: [],
    ...over,
  } as ViewAgent
}

function render(agents: ViewAgent[]): string {
  const view = {
    principal: 'owner@pot.test',
    memberId: 'm-owner',
    seat: 'cursor-cloud-dme-lead',
    preselectedAgent: null,
    agents,
  } as unknown as EnrollView
  return String(enrollPageBody(view))
}

describe('enroll picker — department → squad → agent grouping', () => {
  it('renders a heading per department and a label per squad', () => {
    const html = render([
      agent({ id: 'ag-1', name: 'Core Agent', department_name: 'Engineering', squad_name: 'Core Platform' }),
      agent({ id: 'ag-2', name: 'DME Agent', department_name: 'Digid', squad_name: 'dgd-dme' }),
      agent({ id: 'ag-3', name: 'Second Core', department_name: 'Engineering', squad_name: 'Core Platform' }),
    ])

    expect(html).toContain('Engineering')
    expect(html).toContain('Digid')
    expect(html).toContain('Core Platform')
    expect(html).toContain('dgd-dme')

    // Grouped, not repeated once per agent: two Engineering agents, ONE heading.
    expect(html.split('Engineering').length - 1).toBe(1)
    // And the squad line counts its members. Matched on the count phrase itself
    // rather than the following markup — asserting on incidental whitespace makes
    // a test that fails on formatting and says nothing about behaviour.
    expect(html).toMatch(/·\s*2\s*agents/)
    expect(html).toMatch(/·\s*1\s*agent(?!s)/)
  })

  it('every agent is still selectable — grouping is presentation, not filtering', () => {
    const html = render([
      agent({ id: 'ag-1', department_name: 'Engineering', squad_name: 'Core Platform' }),
      agent({ id: 'ag-2', department_name: 'Digid', squad_name: 'dgd-dme' }),
    ])
    // The mechanic the form depends on must be untouched.
    expect(html).toContain('value="ag-1"')
    expect(html).toContain('value="ag-2"')
    expect(html.split('name="agent_id"').length - 1).toBe(2)
  })

  it('shows autonomy and budget — the two facts that decide which agent to weld', () => {
    const capped = render([agent({ autonomy: 'execute', budget_cap_cents: 1000, budget_window: 'week' })])
    expect(capped).toContain('execute')
    expect(capped).toContain('$10.00/week')

    const uncapped = render([agent({ autonomy: 'draft', budget_cap_cents: null })])
    expect(uncapped).toContain('no budget cap')
  })

  it('an empty picker renders no department scaffolding at all', () => {
    const html = render([])
    expect(html).not.toContain('Engineering')
    // No squad count line, and no radio to select — the grouping must not
    // manufacture an empty department heading out of nothing.
    expect(html).not.toMatch(/·\s*\d+\s*agents?/)
    expect(html).not.toContain('name="agent_id"')
  })
})
