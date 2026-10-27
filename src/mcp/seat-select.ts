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
import { seatAttachEnabled } from '../members/seat-attach'
import { humanReadAuth } from '../workspaces/repo-project'
import { repoProjectAnswer } from './repo-project'
import { consentChoiceLabels, consentLabels } from './refusal-next-step'

/** The thread has no header or _meta: it carries its seat as an ordinary argument on every call. */
const SEAT_ARG_INSTRUCTION = (handle: string): string => `Pass \`seat: ${handle}\` on every call.`

const toolSeatSelect: ToolSpec = {
  name: 'seat_select',
  scope: 'Only for a chat with no agent yet (an unbound directory chat). Never call it from an attached chat or from an agent that already has a seat: self (find-or-create the agent seat for this harness + workspace)',
  min: 'authenticated',
  args: '{ project: string, folder?: string, thread?: string, squad?: string, repo?: string, branch?: string }  // all values are LABELS that key the seat; none grants authority',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Project / workspace name for this seat. Required. A label, not an access request.' },
      folder: { type: 'string', description: 'Working folder or worktree path. Normalised server-side; only a hash and the last segment are stored.' },
      thread: { type: 'string', description: 'Thread / conversation / bot identifier inside the harness, if the seat is per-thread.' },
      repo: { type: 'string', description: 'Output of `git remote get-url origin`. Optional. Answers repo_project: the one project your human can read that owns it, or null with a reason.' },
      branch: { type: 'string', description: 'Your current git branch. Optional.' },
      squad: { type: 'string', description: 'Squad label. Part of the seat key only; it never places the agent.' },
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
    })

    if (result.ok) {
      // Which project does this repo belong to? Read with the HUMAN's grants (a seat session carries none of its own).
      let repoProject: Record<string, unknown> | null = null
      if (typeof args.repo === 'string' && args.repo.trim() !== '' && auth.memberId) {
        try {
          // auth.memberId is the HUMAN behind the session; result.member_id is the new seat agent's own member.
          repoProject = await repoProjectAnswer(env, await humanReadAuth(env, auth.memberId), args.repo, args.branch)
        } catch {
          repoProject = { project: null, reason: 'unavailable' } // the seat is already made: never fail it over a read
        }
      }
      return done({
        ...(repoProject ? { repo_project: repoProject } : {}),
        disposition: result.disposition,
        // `seat` is THE value to pass back as the `seat` argument (the mseat_ handle); the DB row is `seat_row`
        // (a model that read `seat.id` as the thing to pass got a generic refusal).
        seat: result.seat_handle,
        seat_row: result.seat,
        harness: result.harness,
        agent: result.agent,
        member_id: result.member_id,
        seat_handle: result.seat_handle,
        // Lane C: the handle again under the name a thread passes back (`seat: <seat_id>`), the slug it acts
        // as, and the one-line instruction. Same value as seat_handle; shown once, never stored in clear.
        seat_id: result.seat_handle,
        acts_as: result.agent.slug,
        instruction: result.seat_handle ? SEAT_ARG_INSTRUCTION(result.seat_handle) : null,
        audit_id: result.audit_id,
        note: result.note,
      })
    }

    switch (result.error) {
      case 'seat_auto_enroll_disabled':
        return fail(403, result.error, 'Zero-touch seat enrolment is not enabled on this pot. Call boot_context: its available_doors lists what this session can do instead.')
      case 'not_unbound_directory_session':
        return fail(
          403,
          result.error,
          'seat_select only runs for a chat session that has no agent yet. This credential is already an agent (a workspace, agent or seat token, a seat handle you sent, or a conversation-keyed auto seat), so it cannot select another seat: use it as that agent, call boot_context to see which.'
            + (seatAttachEnabled(env) && auth.seatBinding && !auth.seatBinding.attached ? ' To act as an agent you already have instead, call seat_attach { agent, reason: "<why this chat should act as that agent>" } from this session.' : ''),
        )
      case 'harness_required':
        return fail(
          403,
          result.error,
          `This connection carries no verified harness. Your human re-consents this connector (remove and add it again) and picks ${consentLabels(consentChoiceLabels(env)).many} to register its harness; then call seat_select again.`,
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
        return fail(429, result.error, result.detail)
      case 'seat_cap_reached':
        return fail(409, result.error, result.detail)
      case 'seat_agent_inactive':
        return fail(409, result.error, result.detail)
      case 'seat_key_source_conflict':
        return fail(409, result.error, 'This seat key already belongs to a seat created by a different pool (explicit vs conversation-keyed auto). Choose a different project/thread.')
      case 'provisioning_failed':
        return fail(500, result.error, result.detail)
      /* c8 ignore next 2 -- SeatSelectFailure is exhaustively handled above; kept as a safety net. */
      default:
        return fail(500, 'internal_error')
    }
  },
}

export const SEAT_SELECT_TOOLS: ToolSpec[] = [toolSeatSelect]
