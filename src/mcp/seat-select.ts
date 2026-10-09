// mupot#1794 W1 — seat_select MCP tool. Thin glue over src/members/seat-select.ts (read that file
// for the design, the gate and the atomicity argument).
//
// min: 'authenticated' — the same posture as bootstrap_self: an unbound directory seat carries ZERO
// ambient capability by design (B1), so a capability floor would make the tool unreachable by the
// only caller it exists for. The real gate lives inside seatSelect (SEAT_AUTO_ENROLL flag, unbound
// directory session, a harness pointer that verifies against the harnesses table).

import type { ToolSpec } from './index'
import { fail, done } from './index'
import { seatSelect } from '../members/seat-select'

const toolSeatSelect: ToolSpec = {
  name: 'seat_select',
  scope: 'self (find-or-create the agent seat for this harness + workspace; unbound directory session only)',
  min: 'authenticated',
  args: '{ project: string, folder?: string, thread?: string, squad?: string, harness_kind?: string }  // all values are LABELS that key the seat; none grants authority',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Project / workspace name for this seat. Required. A label, not an access request.' },
      folder: { type: 'string', description: 'Working folder or worktree path. Normalised server-side; only a hash and the last segment are stored.' },
      thread: { type: 'string', description: 'Thread / conversation / bot identifier inside the harness, if the seat is per-thread.' },
      squad: { type: 'string', description: 'Squad label. Part of the seat key only; it never places the agent.' },
      harness_kind: { type: 'string', description: 'Display hint for the harness kind (e.g. cursor). The server derives the real kind from the OAuth client.' },
    },
    required: ['project'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const result = await seatSelect(env, auth, {
      project: args.project,
      folder: args.folder,
      thread: args.thread,
      squad: args.squad,
      harness_kind: args.harness_kind,
    })

    if (result.ok) {
      return done({
        disposition: result.disposition,
        seat: result.seat,
        harness: result.harness,
        agent: result.agent,
        member_id: result.member_id,
        seat_handle: result.seat_handle,
        audit_id: result.audit_id,
        note: result.note,
      })
    }

    switch (result.error) {
      case 'seat_auto_enroll_disabled':
        return fail(403, result.error, 'Zero-touch seat enrolment is not enabled on this pot.')
      case 'not_unbound_directory_session':
        return fail(
          403,
          result.error,
          'seat_select only runs for an unbound directory-channel session. An agent-bound token already has an identity.',
        )
      case 'harness_required':
        return fail(
          403,
          result.error,
          'This connection carries no verified harness. Reconnect this connector to register its harness, then retry.',
        )
      case 'member_not_active':
        return fail(403, result.error)
      case 'invalid_args':
        return fail(400, result.error, result.detail)
      case 'home_rank_insufficient':
        return fail(
          403,
          result.error,
          'You do not hold admin on your own home squad, so a seat agent cannot be placed there. Ask an org admin to restore your home squad grant.',
        )
      case 'rate_limited':
        return fail(403, result.error, result.detail)
      case 'seat_cap_reached':
        return fail(409, result.error, result.detail)
      case 'seat_agent_inactive':
        return fail(409, result.error, result.detail)
      case 'provisioning_failed':
        return fail(500, result.error, result.detail)
      /* c8 ignore next 2 -- SeatSelectFailure is exhaustively handled above; kept as a safety net. */
      default:
        return fail(500, 'internal_error')
    }
  },
}

export const SEAT_SELECT_TOOLS: ToolSpec[] = [toolSeatSelect]
