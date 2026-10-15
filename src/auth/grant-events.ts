// src/auth/grant-events.ts — append-only history for standing access grants.
//
// Controls: ISO 27001 A.5.18, SOC 2 CC6.2 / CC6.3. Migration 0223.
//
// `capabilities` revoke is a hard DELETE; the live table keeps that (every read
// of "is this still granted" is unchanged). History lives in `grant_events`, so
// an AFTER-the-fact reader can answer "who held what, who granted it, why, and
// when did it end".
//
// HOW THE EVENTS GET WRITTEN — by trigger, in the same transaction as the change
// (migration 0223):
//
//   AFTER INSERT                       -> 'granted'
//   AFTER UPDATE (capability/expiry/   -> 'granted'  (a re-grant, an upgrade, a
//     provenance changed)                              widened or shortened horizon)
//   BEFORE DELETE                      -> 'revoked' (or 'expired' for the sweeper)
//
// Why a trigger instead of a statement every writer must remember to append:
//
//  * `capabilities` has ~12 INSERT sites, ~8 DELETE sites, an ON DELETE CASCADE
//    from members, and an upsert that keeps the EXISTING row's id. A writer that
//    forgets an event statement is a silent audit hole; a trigger cannot be
//    forgotten, and fires for the cascade and for a console DELETE too.
//  * It anchors on the row by construction: an INSERT OR IGNORE / ON CONFLICT DO
//    NOTHING that wrote no row fires no trigger, and a DELETE that matched nothing
//    fires none, so an event can never exist without its change or the reverse
//    (D1 rolls a batch back on a thrown error only — see
//    feedback_d1_batch_rolls_back_on_error_only_anchor_on_the_row).
//  * A no-op upsert (same capability, same horizon, same provenance) is silent.
//
// WHO. A grant row carries its own granted_by / granted_via / reason, so the
// 'granted' event takes them from the row. A DELETE carries no actor, so a revoke
// that knows who is revoking sets a one-row context (grant_event_context) in the
// SAME batch, immediately before the DELETE, and clears it immediately after;
// the trigger reads it, and ignores a context older than 60 seconds so a context
// that somehow outlived its batch can never mis-attribute a later revoke. A revoke
// with no context is still recorded, with a NULL actor.

import type { D1PreparedStatement } from '@cloudflare/workers-types'
import type { Env } from '../types'

/** The surface a grant came through. NULL on a row means "legacy / unknown". */
export type GrantVia =
  | 'dashboard'
  | 'mcp'
  | 'http'
  | 'elevation'
  | 'delegated_operator'
  | 'squad_join'
  | 'squad_seed'
  | 'invite'
  | 'project_invite'
  | 'bootstrap'
  | 'team_bootstrap'
  | 'sso'
  | 'door'
  | 'token_mint'
  | 'pot_provision'
  | 'project_start'
  | 'agent_connection'
  | 'member_capability'
  | 'home_provision'
  | 'squad_move'
  | 'migration'

export interface GrantProvenance {
  /** member or agent id that made (or revoked) the grant; null when the path has none. */
  grantedBy: string | null
  grantedVia: GrantVia
  reason?: string | null
}

export type RevokeProvenance = Pick<GrantProvenance, 'grantedBy' | 'reason'>

/** How a grant ended, as the event kind the trigger records. */
export type GrantEndKind = 'revoked' | 'expired'

/**
 * The pair of statements that bracket a DELETE: place `set` immediately BEFORE it
 * and `clear` immediately AFTER, in the same batch. The BEFORE DELETE trigger
 * reads the context `set` wrote.
 */
export function revokeContextStatements(
  env: Env,
  provenance: RevokeProvenance,
  kind: GrantEndKind = 'revoked',
): [set: D1PreparedStatement, clear: D1PreparedStatement] {
  return [
    env.DB.prepare(
      `INSERT OR REPLACE INTO grant_event_context (id, tenant, actor, reason, event, at)
       VALUES (1, ?, ?, ?, ?, ?)`,
    ).bind(env.TENANT_SLUG, provenance.grantedBy, provenance.reason ?? null, kind, new Date().toISOString()),
    env.DB.prepare('DELETE FROM grant_event_context WHERE id = 1'),
  ]
}

/** One 'reviewed' event per capabilities row matching `where` (anonymous `?`
 *  placeholders, bare column names), snapshotting the row as it is now. Place it
 *  BEFORE the statement that acts on those rows, in the same batch. Writes
 *  nothing when no row matches. Used where a human review decision is itself the
 *  fact to record (onboarding-door crystallize / restore). */
export function capabilityReviewedEvents(
  env: Env,
  where: string,
  binds: ReadonlyArray<string | number | null>,
  provenance: RevokeProvenance,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO grant_events (id, tenant, grant_table, grant_id, event, actor, reason, at, snapshot_json)
     SELECT lower(hex(randomblob(16))), ?, 'capabilities', id, 'reviewed', ?, ?, ?,
            json_object(
              'id', id, 'member_id', member_id, 'scope_type', scope_type, 'scope_id', scope_id,
              'capability', capability, 'expires_at', expires_at, 'reason', reason,
              'granted_by', granted_by, 'granted_via', granted_via, 'created_at', created_at)
       FROM capabilities
      WHERE ${where}`,
  ).bind(env.TENANT_SLUG, provenance.grantedBy, provenance.reason ?? null, new Date().toISOString(), ...binds)
}
