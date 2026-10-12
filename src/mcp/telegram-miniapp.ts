// mupot — moment_miniapp_link: ask the WORKER to send a pending secure moment to its human as a Telegram Mini App
// (secure moments W4, flag TELEGRAM_MINIAPP). The worker sends the web_app button itself, from the dedicated Mini App
// bot, to the target member's own bound private chat. The caller gets a DELIVERY RECEIPT only: no URL, no token, no
// button payload ever reaches an agent or a harness. Contract: docs/architecture/secure-moments.md (W4).
//
// AUTHZ: the caller must be the agent that filed the moment (or an org admin); anything else reads "not found". The
// target member must be an active human, bound to Telegram, and able to decide this moment right now.
import { requestMomentDelivery } from '../secure-moments/telegram-miniapp-launch'
import { type ToolSpec, fail, done } from './index'

const toolMomentMiniappLink: ToolSpec = {
  name: 'moment_miniapp_link',
  scope: 'ask the worker to send a pending secure moment you filed to a member as a Telegram Mini App button; returns a delivery receipt only, decides nothing',
  min: 'member',
  args: '{ moment_id: string, member_id?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      moment_id: { type: 'string', description: 'The id of a pending secure moment you filed (the <id> in its /m/<id>/<token> link).' },
      member_id: { type: 'string', description: 'The member who should decide it. Optional when the moment already names its decider.' },
    },
    required: ['moment_id'],
    additionalProperties: false,
  },
  // Sends one message but writes nothing the framework tracks as presence.
  shouldTouchPresence: () => false,
  async run(auth, env, args) {
    const id = typeof args.moment_id === 'string' ? args.moment_id.trim() : ''
    if (!id) return fail(400, 'invalid_args', 'moment_id is required')
    const member = typeof args.member_id === 'string' && args.member_id.trim() ? args.member_id.trim() : undefined
    const r = await requestMomentDelivery(env, auth, id, member)
    if (!r.ok) {
      switch (r.error) {
        case 'not_enabled': return fail(404, 'not_enabled', 'the Telegram Mini App channel is not enabled on this pot')
        case 'not_found': return fail(404, 'moment_not_found', 'no pending moment with that id that you filed')
        case 'kind_not_supported': return fail(409, 'kind_not_supported', 'this moment carries a secret; open it on a browser with a passkey')
        case 'moment_closed': return fail(409, 'moment_closed', 'that moment is no longer pending')
        case 'member_required': return fail(409, 'member_required', 'name the member who should decide it (member_id)')
        case 'target_not_reachable': return fail(409, 'target_not_reachable', 'that member cannot be reached through Telegram for this decision')
        case 'rate_limited': return fail(429, 'rate_limited', 'too many Mini App messages to that member just now; wait a few minutes')
        case 'chat_unreachable': return fail(409, 'chat_unreachable', 'Telegram refused the chat: the member must open the approvals bot and press Start once')
        default: return fail(502, 'send_failed', 'Telegram did not accept the message')
      }
    }
    return done({
      ok: true,
      moment_id: r.moment_id,
      expires_at: r.expires_at,
      delivery_id: r.delivery_id,
      status: r.status,
      sent_at: r.sent_at,
      note: 'The worker sent the button to the member\'s private chat. It decides nothing: the member must open it in Telegram and confirm with their device biometrics.',
    })
  },
}

export const TELEGRAM_MINIAPP_TOOLS: ToolSpec[] = [toolMomentMiniappLink]
