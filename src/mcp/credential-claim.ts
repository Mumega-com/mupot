// mupot — reveal_credential_claim MCP tool (mupot#987).
//
// The counterpart to createCredentialClaim (src/auth/credential-claim.ts). Every
// mint tool (mint_agent_token, bootstrap_self, provision_agent_connection) now
// returns a claim handle instead of a raw secret. This tool is the ONLY way to
// redeem one — exactly once, within CLAIM_TTL_SECONDS, and only by the same
// member who minted it. See credential-claim.ts for why this is the honest scope
// of a server-side fix (it bounds exposure; it cannot make the reveal call's own
// result invisible to a persisting MCP client — that requires a protocol/client
// change, tracked separately).
//
// This tool's result carries NOTHING but `raw` — no id, no label, no metadata —
// so a claim_id never round-trips back out alongside the secret, and so a client
// that wants to special-case "this call's result is a bare secret, do not log it"
// has a single, minimal, unambiguous shape to match against.

import { type ToolSpec, fail, done, str } from './index'
import { revealCredentialClaim } from '../auth/credential-claim'

const STRING_SCHEMA = { type: 'string' }

const toolRevealCredentialClaim: ToolSpec = {
  name: 'reveal_credential_claim',
  scope: 'own credential claim (single-use, short-lived; see mint_agent_token / bootstrap_self / provision_agent_connection)',
  min: 'authenticated',
  args: '{ claim_id: string }',
  inputSchema: {
    type: 'object',
    properties: { claim_id: STRING_SCHEMA },
    required: ['claim_id'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (!auth.memberId) return fail(403, 'unauthenticated')
    const claimId = str(args.claim_id)
    if (!claimId) return fail(400, 'invalid_args', 'claim_id required')

    const result = await revealCredentialClaim(env, claimId, auth.memberId)
    if (!result.ok) {
      // Deliberately the SAME error for "never existed", "already consumed", and
      // "belongs to someone else" — an id oracle would let a caller distinguish
      // "this claim_id is real but not mine" from "this claim_id is garbage",
      // which leaks information about a credential that isn't theirs.
      return fail(
        410,
        'claim_not_found_or_consumed',
        'the claim does not exist, was already redeemed, expired, or does not belong to you',
      )
    }
    return done({ raw: result.raw })
  },
}

export const CREDENTIAL_CLAIM_TOOLS: ToolSpec[] = [toolRevealCredentialClaim]
