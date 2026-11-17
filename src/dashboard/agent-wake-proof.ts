import { html } from 'hono/html'
import type { loadWakeProof } from '../members/wake-echo'

/** Advisory transport evidence, under the agent page's existing read authorization. */
export function agentWakeProof(proof: Awaited<ReturnType<typeof loadWakeProof>>, nowMs=Date.now()) {
  const paths={native_wake:'Native wake',push_host:'Push host',webhook_doorbell:'Webhook doorbell',none:'No recorded path'}
  const days=proof.wake_proven_at ? Math.max(0,Math.floor((nowMs-Date.parse(proof.wake_proven_at))/86400000)) : null
  return html`<section aria-label="Wake verification"><h2>${proof.state==='proven' ? 'Wake proven' : proof.state==='stale' ? `Wake proven ${days ?? '?'}d ago, re-prove` : 'Wake not proven'}</h2>
    ${proof.state!=='unproven' ? html`<p>${proof.wake_proven_at} · ${paths[proof.path]} · delivery to reply ${proof.delivery_to_reply_ms} ms · challenge to delivery ${proof.t0_to_delivery_ms} ms</p>` : ''}
    <p>Evidence covers recorded delivery followed by an inbox echo, with no inbox polling before delivery. It does not attest that the runtime ended its previous turn.</p>
    ${proof.state!=='proven' ? html`<p>Ask the agent to run connection_check with echo enabled, end its turn, and reply after wake.</p>` : ''}</section>`
}
