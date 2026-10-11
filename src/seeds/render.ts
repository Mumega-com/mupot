// Renders a structured seed request as a one-line sentence for a human reviewer. Author text
// only ever appears JSON-quoted (escaped), so a value like `x gated by mem-hadi` cannot read as
// a separate, trusted request line. The structured `fields` stay the source of truth.

import type { SeedRequest } from './contract'

const q = (v: string): string => JSON.stringify(v)

export function renderRequest(r: SeedRequest): string {
  const f = r.fields
  switch (r.kind) {
    case 'gate': return `gate: action ${q(f.action)} gated by ${q(f.gate)}`
    case 'routine': return `routine: id ${q(f.id)} at ${q(f.cron)} approval ${q(f.approval)}`
    case 'seat': return `seat: up to ${q(f.max)} in squad ${q(f.squad)} at capability ${q(f.capability)} or lower`
    case 'memory': return `memory: scope ${q(f.scope)}`
    case 'data': return `data: store ${q(f.store)} at tier ${q(f.tier)}`
    case 'tool_credential': return `tool credential: ${q(f.tool)} needs slot ${q(f.cred_slot)} bound by a human`
    case 'direct_surface': return `direct surface: writes to ${q(f.target)}`
    case 'allow_direct': return `allow_direct: ${q(f.entry)}`
  }
}
