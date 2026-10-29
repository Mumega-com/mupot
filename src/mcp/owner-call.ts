import { type ToolSpec, done, fail } from './index'
import { ownerCall, OWNER_CALL_SCHEMA } from '../owner-call/service'

export const toolOwnerCall: ToolSpec = {
  name: 'owner_call',
  scope: 'self (live effective agent). Stores an owner/action projection only; no action or notification is sent in slice 1.',
  min: 'authenticated',
  args: '{ ask_key: string (1–96), kind: access|credential|reauth|money, action_ref: { type, id }, reason_code: fixed enum }',
  inputSchema: OWNER_CALL_SCHEMA,
  shouldTouchPresence: () => false,
  async run(auth, env, args) {
    const result = await ownerCall(env, auth, args)
    return result.ok ? done(result.result) : fail(result.error === 'invalid_args' ? 400 : result.error === 'ask_key_conflict' ? 409 : result.error === 'owner_call_limit' ? 429 : 403,
      result.error, result.retry_after ? { retry_after: result.retry_after } : undefined)
  },
}
