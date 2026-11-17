import { html } from 'hono/html'
import type { loadConnectionEcho } from '../members/connection-echo'

/** Advisory inbox-roundtrip evidence, under the agent page's existing read authorization. */
export function agentEchoStatus(status: Awaited<ReturnType<typeof loadConnectionEcho>>) {
  const heading = status.state === 'echo_roundtrip' ? 'Echo returned'
    : status.state === 'stale' ? 'Echo stale'
      : 'Echo not returned'
  return html`<section aria-label="Inbox echo status"><h2>${heading}</h2>
    ${status.echo_returned_at ? html`<p>${status.echo_returned_at} · inbox echo · ${status.latency_ms} ms</p>` : ''}
    <p>${status.state === 'echo_roundtrip' ? 'Your own inbox echo returned.' : 'Inbox roundtrip only.'}</p>
    ${status.state !== 'echo_roundtrip' ? html`<p>Ask the agent to run connection_check with echo enabled, then return the nonce from its own inbox.</p>` : ''}</section>`
}
