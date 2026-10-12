// mupot — moment_miniapp_link: the launch payload a gateway/plugin sends to put a pending secure moment in front of its
// human as a Telegram Mini App (secure moments W4, flag TELEGRAM_MINIAPP). It makes NO Telegram call and decides
// nothing: it returns the https URL plus a ready web_app button for the harness that owns the bot to send into the
// member's own PRIVATE chat. Contract: docs/architecture/secure-moments.md (W4).
//
// AUTHZ: the caller must be the agent that filed the moment (or an org admin); anything else reads "not found". The
// payload carries the moment id only, never the passkey link token, and the id is not a bearer: the Mini App still
// needs a fresh signed initData of the member who may decide plus that member's biometric device secret.
import { momentMiniappLaunch } from '../secure-moments/telegram-miniapp-launch'
import { type ToolSpec, fail, done } from './index'

const toolMomentMiniappLink: ToolSpec = {
  name: 'moment_miniapp_link',
  scope: 'the Telegram Mini App launch payload (url + web_app button) for a pending secure moment you filed; sends nothing, decides nothing',
  min: 'member',
  args: '{ moment_id: string }',
  inputSchema: {
    type: 'object',
    properties: { moment_id: { type: 'string', description: 'The id of a pending secure moment you filed (the <id> in its /m/<id>/<token> link).' } },
    required: ['moment_id'],
    additionalProperties: false,
  },
  // Read-only: not even the framework's post-call presence bump.
  shouldTouchPresence: () => false,
  async run(auth, env, args) {
    const id = typeof args.moment_id === 'string' ? args.moment_id.trim() : ''
    if (!id) return fail(400, 'invalid_args', 'moment_id is required')
    const r = await momentMiniappLaunch(env, auth, id)
    if (!r.ok) {
      return r.error === 'not_enabled' ? fail(404, 'not_enabled', 'the Telegram Mini App channel is not enabled on this pot')
        : r.error === 'not_found' || r.error === 'not_requester' ? fail(404, 'moment_not_found', 'no pending moment with that id that you filed')
          : r.error === 'kind_not_supported' ? fail(409, 'kind_not_supported', 'this moment carries a secret; open it on a browser with a passkey')
            : fail(409, 'moment_closed', 'that moment is no longer pending')
    }
    return done({
      ok: true,
      moment_id: r.moment_id,
      expires_at: r.expires_at,
      ...r.launch,
      note: 'Send web_app_button to the member in their own private chat with the bot. It decides nothing: the member must open it in Telegram, be linked to this workspace, and confirm with their device biometrics.',
    })
  },
}

export const TELEGRAM_MINIAPP_TOOLS: ToolSpec[] = [toolMomentMiniappLink]
