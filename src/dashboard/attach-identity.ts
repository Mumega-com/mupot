// Shared, escaped identity statement for every human attach approval surface.
import { html } from 'hono/html'
import type { AttachIdentity } from '../members/seat-attach'

export function attachIdentityCard(v: AttachIdentity) {
  return html`<div class="attach-identity">
    <p><strong>${[v.seatLabel, v.harnessName].filter(Boolean).join(' / ') || 'This chat'} wants to act as ${v.agentName} (${v.agentRole}, owner ${v.ownerName})</strong></p>
    <p>Reason: ${v.reason ?? 'No reason recorded (older request).'}</p>
    ${v.runtimeMismatch ? html`<p role="alert"><strong>This chat does not usually run as ${v.agentName}.</strong></p>` : ''}
  </div>`
}
