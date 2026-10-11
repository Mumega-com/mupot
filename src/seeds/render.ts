// Renders a structured seed request as a one-line sentence for a human reviewer. Author text
// only ever appears JSON-quoted (escaped), so a value like `x gated by mem-hadi` cannot read as
// a separate, trusted request line. The structured `fields` stay the source of truth.

import type { SeedRequest } from './contract'

// JSON.stringify leaves U+2028/U+2029 and C1 controls raw. Escape every control, format and
// separator character so a rendered line can never carry an invisible or line-breaking char.
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu
const esc = (c: string): string => {
  const cp = c.codePointAt(0) ?? 0
  return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`
}
const q = (v: string): string => JSON.stringify(v).replace(INVISIBLE_RE, esc)

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
