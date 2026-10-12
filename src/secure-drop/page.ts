// mupot - the credential page body. Server-rendered; every value is HTML-escaped; the agent's purpose text goes ONLY
// inside the "untrusted" box. The host key's fingerprint is shown in human-comparable form: the human compares it
// with what the host printed at keygen. THREAT MODEL: a compromised Worker could serve a page that seals to the
// attacker's key; the fingerprint comparison against the host's own output is the check that catches it, so it is
// shown prominently and recomputed in the browser from the key the page would use.
import { escapeHtml, untrustedBox } from '../access/page'
import { groupFingerprint } from './keys'
import type { AgentRow } from './authority'
import type { DropRow, HostKeyRow } from './store'

export function credentialViewInner(input: { drop: DropRow; agent: AgentRow; hostKey: HostKeyRow; csrf: string; maxBytes: number }): string {
  const { drop, agent, hostKey } = input
  return `<h1>Provide a credential</h1>
<form id="drop-form" data-csrf="${input.csrf}" data-drop-id="${escapeHtml(drop.id)}" data-pub="${escapeHtml(hostKey.public_key_b64u)}" data-fp="${escapeHtml(hostKey.fingerprint)}">
<dl><dt>Agent</dt><dd>${escapeHtml(agent.name)} <span class="muted">(${escapeHtml(agent.slug)})</span></dd>
<dt>Name</dt><dd><code>${escapeHtml(drop.name)}</code></dd>
<dt>Written to</dt><dd><code>~/.sos/keys/${escapeHtml(drop.name)}</code> on the agent's host</dd></dl>
${untrustedBox('Why it wants this credential.', drop.purpose)}${drop.scope_hint ? untrustedBox('Scope it asked for.', drop.scope_hint) : ''}
<div class="card status-warn"><p><strong>Host key fingerprint</strong></p>
<p class="fp" id="fp-shown">${escapeHtml(groupFingerprint(hostKey.fingerprint))}</p>
<p class="muted">Computed in this browser from the key it will seal to:</p><p class="fp" id="fp-computed">checking</p>
<p>Compare the fingerprint with the one printed by <code>secure-drop.mjs keygen</code> on the agent's host. If they differ, do not paste anything.</p></div>
<p><label for="secret">Secret (up to ${escapeHtml(String(input.maxBytes))} bytes)</label>
<input id="secret" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="${escapeHtml(String(input.maxBytes))}"></p>
<p class="muted">Your browser encrypts it to the host key above before anything is sent. This server stores only ciphertext and cannot read it; no chat or model ever sees it. Sending needs your passkey.</p>
<div class="row"><button class="primary" type="button" data-act="provide">Seal and send with passkey</button>
<button class="danger" type="button" data-act="deny">Deny with passkey</button></div></form>
<div id="status" role="status"></div>`
}
