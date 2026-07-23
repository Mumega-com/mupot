// /agents/byoa — Bring Your Own Agent (Hermes) attach surface.
// Admin provisions hermes_api connector + member binding; members get Open WebUI instructions.

import { html } from 'hono/html'
import { emptyState, pageHeader, sectionPanel } from './ui'
import type { Html } from './ui'
import type { Env } from '../types'
import { architectCeremonyPlan } from '../hermes-surfaces/architect'

export interface ByoaPageModel {
  canAdmin: boolean
  potOrigin: string
  flash: string | null
  error: string | null
  binding: { member_id: string; agent_id: string } | null
}

export function byoaBody(env: Env, model: ByoaPageModel): Html {
  void env
  const plan = architectCeremonyPlan({
    departmentSlug: 'my-dept',
    squadSlug: 'my-squad',
    agentSlug: 'my-hermes',
    requesterMemberId: '<your-member-id>',
  })

  const flash = model.flash
    ? html`<p class="ui-sub" style="color:var(--ok,#16a34a)">${model.flash}</p>`
    : model.error
      ? html`<p class="ui-sub" style="color:var(--danger)">${model.error}</p>`
      : ''

  const owui = html`
    ${sectionPanel({
      title: 'Open WebUI (members)',
      body: html`
        <p class="ui-sub">Point Open WebUI at this pot's member Hermes proxy (cookie or member bearer). Never use the owner KayHermes API key.</p>
        <ul style="font-family:var(--font-mono);font-size:13px;line-height:1.6">
          <li>Base URL: <code>${model.potOrigin}/api/member-hermes/v1</code></li>
          <li>Auth: same-origin session cookie, or <code>Authorization: Bearer &lt;member_token&gt;</code></li>
          <li>Requires: <code>seat_member_on_squad</code> / bind + agent-scoped <code>hermes_api</code> connector</li>
        </ul>
        ${model.binding
          ? html`<p class="ui-sub">Your binding: member <code>${model.binding.member_id}</code> → agent <code>${model.binding.agent_id}</code></p>`
          : html`<p class="ui-sub">You are not bound to a Hermes agent yet.</p>`}
      `,
    })}`

  const adminForm = model.canAdmin
    ? sectionPanel({
        title: 'Attach Hermes API to an agent',
        body: html`
          <p class="ui-sub">Stores <code>hermes_api</code> in the connector vault (secret = API_SERVER_KEY; meta.api_url = public HTTPS origin).</p>
          <form method="post" action="/agents/byoa/attach" style="display:flex;flex-direction:column;gap:10px;max-width:520px">
            <label>Agent ID (UUID)
              <input name="agent_id" required pattern="[0-9a-fA-F-]{36}" style="width:100%" />
            </label>
            <label>Hermes API URL (https)
              <input name="api_url" required placeholder="https://hermes-….example.com" style="width:100%" />
            </label>
            <label>API key
              <input name="api_key" type="password" required autocomplete="new-password" style="width:100%" />
            </label>
            <label>Bind member ID (optional UUID)
              <input name="member_id" pattern="[0-9a-fA-F-]{36}" style="width:100%" placeholder="leave blank to skip bind" />
            </label>
            <button class="btn" type="submit">Provision + bind</button>
          </form>
        `,
      })
    : emptyState({
        title: 'Admin required to attach',
        detail: 'Ask KayHermes (or an org admin) to run the architect ceremony and seat you on the squad.',
      })

  const ceremony = sectionPanel({
    title: 'Ask KayHermes ceremony',
    body: html`
      <p class="ui-sub">${plan.rule}</p>
      <ol style="font-size:13px;line-height:1.55">
        ${plan.steps.map((s) => html`<li><code>${s}</code></li>`)}
      </ol>
      <p class="ui-sub">MCP: ${plan.tools.join(', ')}</p>
    `,
  })

  return html`
    ${pageHeader({
      crumbs: 'Agents / BYOA',
      title: 'Bring Your Own Hermes',
      sub: 'Vault your agent API, bind your member identity, chat via Open WebUI or Telegram IM.',
    })}
    ${flash}
    ${owui}
    ${adminForm}
    ${ceremony}
  `
}
