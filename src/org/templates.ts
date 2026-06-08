// mupot — starter agent templates (#14).
//
// Pure data: no side effects, no imports from the rest of the pot. Each template
// is a ready-to-run work-unit definition. The wizard uses these to seed the first
// agent so a freshly-onboarded pot is never empty.
//
// Field contract (mirrors AgentInput in ./service):
//   key          unique id used by the wizard to select a template
//   name         display name (becomes the agent row's name)
//   role         accountability line (short, human-readable role label)
//   okr          qualitative objective for the unit
//   kpi_target   measurable target — MUST start with a leading integer where
//                the loop's parseLeadingInt is expected to parse a denominator
//                (e.g. "25 booked assessments / month")
//   effort       one of: low | standard | high | sprint
//   autonomy     one of: suggest | draft | execute | execute_with_approval
//   description  one-line human explanation shown in the wizard picker

import type { Effort, Autonomy } from '../types'

export interface AgentTemplate {
  key: string
  name: string
  role: string
  okr: string
  kpi_target: string
  effort: Effort
  autonomy: Autonomy
  description: string
}

// Five starter templates covering the most common first-agent use cases.
// Autonomy is kept conservative by default — owners can dial it up later from
// the agent admin panel once they've seen the unit run.
export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    key: 'outreach-researcher',
    name: 'Outreach Researcher',
    role: 'Researcher',
    okr: 'Identify and qualify outbound leads so the team always has a warm pipeline',
    kpi_target: '20 qualified leads / week',
    effort: 'standard',
    autonomy: 'draft',
    description: 'Surfaces prospect lists and writes first-draft outreach — you review before sending.',
  },
  {
    key: 'content-writer',
    name: 'Content Writer',
    role: 'Writer',
    okr: 'Produce consistent, on-brand content that grows audience and inbound traffic',
    kpi_target: '4 published pieces / week',
    effort: 'standard',
    autonomy: 'draft',
    description: 'Drafts blog posts, social copy, and newsletters — you edit and publish.',
  },
  {
    key: 'support-agent',
    name: 'Support Agent',
    role: 'Support',
    okr: 'Resolve customer questions quickly so satisfaction stays high and the team stays unblocked',
    kpi_target: '50 resolved tickets / week',
    effort: 'high',
    autonomy: 'execute_with_approval',
    description: 'Handles support tickets and drafts replies — approval required before each send.',
  },
  {
    key: 'ops-dispatcher',
    name: 'Ops Dispatcher',
    role: 'Dispatcher',
    okr: 'Keep internal workflows moving by routing tasks and surfacing blockers before they stall',
    kpi_target: '30 tasks triaged / week',
    effort: 'standard',
    autonomy: 'execute_with_approval',
    description: 'Classifies and routes incoming tasks — a human gates each dispatch decision.',
  },
  {
    key: 'seo-pathfinder',
    name: 'SEO Pathfinder',
    role: 'SEO Analyst',
    okr: 'Grow organic search traffic by surfacing keyword gaps and content opportunities',
    kpi_target: '10 keyword opportunities / week',
    effort: 'low',
    autonomy: 'suggest',
    description: 'Analyzes search trends and suggests topics — read-only, no autonomous publishing.',
  },
]

/** Look up a template by key. Returns undefined when the key is not found. */
export function getTemplate(key: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES.find((t) => t.key === key)
}
