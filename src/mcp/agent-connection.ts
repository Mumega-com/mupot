import { verifyAgentConnection } from '../members/agent-connection-verification'
import {
  done,
  fail,
  str,
  type ToolSpec,
} from './index'

const STRING_SCHEMA = { type: 'string' }

const toolVerifyAgentConnection: ToolSpec = {
  name: 'verify_agent_connection',
  scope: 'issued agent credential and receipt',
  min: 'authenticated',
  args: '{ receipt_id: string, challenge: string }',
  inputSchema: {
    type: 'object',
    properties: {
      receipt_id: STRING_SCHEMA,
      challenge: STRING_SCHEMA,
    },
    required: ['receipt_id', 'challenge'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const receiptId = str(args.receipt_id)
    const challenge = str(args.challenge)
    if (!receiptId || !challenge) return fail(400, 'invalid_verification_input')

    // The credential itself is the proof-bearing principal. None of these
    // identity fields exists in the tool schema, and tokenId/boundAgentId were
    // re-read from the exact live member_tokens row by the authentication seam.
    if (
      !auth.memberId
      || !auth.tokenId
      || !auth.boundAgentId
      || auth.channel === 'directory'
    ) {
      return fail(403, 'agent_bound_credential_required')
    }

    const outcome = await verifyAgentConnection(
      env,
      {
        tenant: auth.tenant,
        tokenId: auth.tokenId,
        memberId: auth.memberId,
        agentId: auth.boundAgentId,
      },
      { receiptId, challenge },
    )
    if (outcome.status === 'messaging_verified') return done(outcome)

    switch (outcome.error) {
      case 'invalid_verification_input':
        return fail(400, outcome.error)
      case 'verification_not_found':
        return fail(404, outcome.error)
      case 'challenge_mismatch':
        return fail(409, outcome.error)
      case 'challenge_expired':
      case 'challenge_exhausted':
        return fail(410, outcome.error)
      case 'verification_state_failed':
        return fail(500, outcome.error)
      default:
        return fail(outcome.retryable ? 503 : 409, outcome.error)
    }
  },
}

export const AGENT_CONNECTION_TOOLS: ToolSpec[] = [
  toolVerifyAgentConnection,
]
