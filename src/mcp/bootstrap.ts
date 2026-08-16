// mupot — bootstrap_self MCP tool (mupot#925). See src/members/bootstrap-self.ts
// for the full design (River's ruling, the atomic-batch argument, the adversarial
// review's five P0 fixes). This file is the thin MCP glue: schema, dispatch, and
// mapping BootstrapSelfResult onto the tool's fail()/done() contract.
//
// min: 'authenticated' — same posture as `connect` (src/mcp/index.ts toolConnect).
// A brand-new, unbound directory session carries ZERO ambient capability (B1,
// src/mcp/oauth-authorize.ts), so an AAGATE capability floor would make this tool
// permanently unreachable by the exact caller it exists for. The internal gate
// (auth.channel === 'directory' && !auth.boundAgentId, enforced inside
// bootstrapSelf) is what actually restricts this tool — not the floor.

import type { ToolSpec } from './index'
import { fail, done } from './index'
import { bootstrapSelf } from '../members/bootstrap-self'
import { createCredentialClaim } from '../auth/credential-claim'

const toolBootstrapSelf: ToolSpec = {
  name: 'bootstrap_self',
  scope: 'self (first-run identity mint for an unbound, verified directory session)',
  min: 'authenticated',
  args: '{ agent_name: string }  // required — the name you are giving your agent; naming is the witness act',
  inputSchema: {
    type: 'object',
    properties: {
      agent_name: {
        type: 'string',
        description:
          'The name you are giving your new agent. Required — there is no default or auto-generated name; naming your agent is what makes this a deliberate act.',
      },
    },
    required: ['agent_name'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const result = await bootstrapSelf(env, auth, args.agent_name)

    if (result.ok) {
      // mupot#987: result.token.raw is NEVER forwarded into the tool result — that
      // is the exact defect the issue names (mint_agent_token's old `token.raw`,
      // reproduced here at the self-bootstrap door). auth.memberId is the calling
      // HUMAN's own member id (bootstrapSelf requires an unbound directory session,
      // so it is never the freshly-created agent's dedicated member — see
      // result.member_id below, which IS the agent's) — that is who redeems the claim.
      const credentialClaim = await createCredentialClaim(
        env,
        result.token.raw,
        auth.memberId as string,
      )
      return done({
        disposition: result.disposition,
        department: result.department,
        squad: result.squad,
        agent: result.agent,
        member_id: result.member_id,
        token: {
          id: result.token.id,
          capability: result.token.capability,
        },
        credential_claim: credentialClaim,
        // Serialized because directory_session_note tells the human to "see
        // founder_grant" — a field this payload did not previously carry, so the
        // note pointed at nothing. It also carries disposition:'existing' when an
        // adopted home squad already held a capability row for this member, which
        // is the difference between "you can bind this session" and "you cannot".
        founder_grant: result.founder_grant,
        audit_id: result.audit_id,
        note:
          `${result.directory_session_note} The raw token is NOT in this result — call `
          + 'reveal_credential_claim { claim_id: credential_claim.claim_id } to redeem it '
          + 'once, as this same caller, before it expires.',
      })
    }

    switch (result.error) {
      case 'agent_name_required':
        return fail(
          400,
          result.error,
          result.detail ?? 'agent_name is required and must be non-empty — naming your agent is the witness act',
        )
      case 'not_unbound_directory_session':
        return fail(
          403,
          result.error,
          'bootstrap_self only runs for an unbound directory-channel session. An agent-bound token, or any '
            + 'other connection channel, already has a voice and does not need this tool.',
        )
      case 'rate_limited':
        return fail(403, result.error, result.detail)
      case 'already_bootstrapped':
        return fail(
          409,
          result.error,
          {
            ...(typeof result.detail === 'object' && result.detail !== null ? result.detail : {}),
            note: 'This member already bootstrapped an agent. bootstrap_self is idempotent-once per member, not per token. '
              + 'The founder grant (squad:admin on the home squad) landed in the SAME atomic batch as that bootstrap, so '
              + 'this caller can proceed via the normal /oauth/consent flow to bind THIS session to that agent instead.',
          },
        )
      case 'provisioning_failed':
        return fail(500, result.error, result.detail)
      /* c8 ignore next 2 -- BootstrapSelfFailure is exhaustively handled above; kept as a safety net. */
      default:
        return fail(500, 'internal_error')
    }
  },
}

export const BOOTSTRAP_TOOLS: ToolSpec[] = [toolBootstrapSelf]
