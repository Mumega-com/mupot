// mupot — GitHub webhook → ProjectOffice Notice (Phase 1, slice 1 of docs/plan-project-back-office-20261022).
//
// Called by the existing, signature-verified, delivery-deduplicated GitHub App webhook
// (src/integrations/github-routes.ts). There is no second endpoint. This file decides ONE thing: which project's
// office, if any, should be told that a pull request or issue changed, and then tells it.
//
// What is trusted, and what is not:
//   - The payload is data. It never selects the tenant or the project. The tenant is this pot's TENANT_SLUG; the
//     connection is the installation recorded in D1 (github_installations) for that tenant; the project is whichever
//     live project D1 says owns the repository (projects.repo_url or project_repos). The payload's installation id
//     is only compared against that row (the pin that matters: the webhook secret is shared by every installation of
//     the app, so a valid signature does not say whose event this is) and its repository name only looked up.
//   - A repository no project claims, or more than one project claims, is DROPPED and counted. The webhook answers
//     the same as always, so a sender learns nothing about which repositories are connected.
//   - Everything sits behind PROJECT_OFFICE (default off). With the flag off this returns before reading D1.
//
// It does not create tasks, assign, brief, dispatch, wake or write back. The existing webhook behaviour is unchanged.
//
// Delivery is AT-MOST-ONCE until reconcile lands: the route runs this in waitUntil after the delivery is claimed, so
// a notice the office could not take (counted as office_error, office_refused) is not retried by anything yet. What
// IS idempotent is the office: a replayed delivery id, or an older version, changes nothing.

import type { Env } from '../types'
import { repoKeyFromUrl } from '../workspaces/repo-key'
import { followsGithubAction, githubNotice } from './office-notice-map'
import { isProjectOfficeEnabled, type NoticeOutcome } from './office-core'
import { getProjectOffice } from './office-handle'
import { projectsOwningRepo } from './office-repo-owner'

export const INTAKE_EVENTS = ['pull_request', 'issues'] as const

export type IntakeDropReason =
  | 'no_installation'
  | 'installation_mismatch'
  | 'bad_repo'
  | 'unknown_repo'
  | 'ambiguous_repo'
  | 'unmappable'
  | 'office_refused'
  | 'office_error'

export type IntakeResult =
  | { routed: true; project_id: string; outcome: NoticeOutcome }
  | { routed: false; reason: 'flag_off' | 'event_ignored' | IntakeDropReason }

type Rec = Record<string, unknown>

function rec(v: unknown): Rec | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : null // narrowed by the typeof/array checks
}

const FULL_NAME_RE = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/

const COUNTER_TTL_SECONDS = 35 * 24 * 60 * 60

/**
 * Best-effort daily counter of a dropped delivery, in KV (no migration). Read-modify-write, so a burst can undercount;
 * it exists so a silent drop is visible, not to be exact. A failure here never changes the webhook's answer.
 */
export async function countIntakeDrop(env: Pick<Env, 'SESSIONS'>, reason: IntakeDropReason, nowMs: number): Promise<void> {
  try {
    const key = `office-intake-drop:${reason}:${new Date(nowMs).toISOString().slice(0, 10)}`
    const current = Number((await env.SESSIONS.get(key)) ?? '0')
    await env.SESSIONS.put(key, String(Number.isFinite(current) ? current + 1 : 1), { expirationTtl: COUNTER_TTL_SECONDS })
  } catch {
    // a counter outage is not a reason to fail a webhook
  }
}

interface InstallationRow {
  installation_id: string
}

/**
 * The single live project of this pot that owns `repoKey`, from D1 (office-repo-owner.ts: stored canonical key, so every
 * spelling of the URL matches and no row limit can hide the owner). Archived projects do not own anything. More than
 * one owner is ambiguous and resolves to none: a notice is never fanned out. A D1 failure throws (the caller counts it
 * as office_error) rather than answering "unknown repository".
 */
export async function resolveRepoProject(
  env: Pick<Env, 'DB'>,
  repoKey: string,
): Promise<{ ok: true; projectId: string } | { ok: false; reason: 'unknown_repo' | 'ambiguous_repo' }> {
  const found = await projectsOwningRepo(env.DB, repoKey)
  if (!found.ok) throw new Error('repo_owner_lookup_unavailable')
  if (found.owners.length === 0) return { ok: false, reason: 'unknown_repo' }
  if (found.owners.length > 1) return { ok: false, reason: 'ambiguous_repo' }
  return { ok: true, projectId: found.owners[0] as string } // length is exactly 1 here
}

/**
 * Turn one verified GitHub delivery into a Notice and hand it to the owning project's office.
 * Never throws: every failure is a counted drop. The office dedups on the delivery id and refuses to let an older
 * version overwrite a newer one, so calling this twice for one delivery is a no-op. Events and actions the office
 * does not follow return 'event_ignored' before any D1 or KV access and are not counted: only real drops are.
 */
export async function routeGitHubNoticeToOffice(
  env: Env,
  eventName: string,
  payload: unknown,
  deliveryId: string,
  nowMs: number = Date.now(),
): Promise<IntakeResult> {
  if (!isProjectOfficeEnabled(env)) return { routed: false, reason: 'flag_off' }
  if (!(INTAKE_EVENTS as readonly string[]).includes(eventName)) return { routed: false, reason: 'event_ignored' }
  if (!followsGithubAction(eventName, rec(payload)?.action)) return { routed: false, reason: 'event_ignored' }

  const drop = async (reason: IntakeDropReason): Promise<IntakeResult> => {
    await countIntakeDrop(env, reason, nowMs)
    return { routed: false, reason }
  }

  try {
    const p = rec(payload)
    const install = await env.DB
      .prepare('SELECT installation_id FROM github_installations WHERE tenant = ?1')
      .bind(env.TENANT_SLUG)
      .first<InstallationRow>()
    if (!install) return await drop('no_installation')

    // The payload's installation must BE this pot's installation. The webhook secret is shared by every
    // installation of the app, so a signature alone does not say whose event this is.
    const claimed = rec(p?.installation)?.id
    if (typeof claimed !== 'number' && typeof claimed !== 'string') return await drop('installation_mismatch')
    if (String(claimed) !== install.installation_id) return await drop('installation_mismatch')

    const fullName = rec(p?.repository)?.full_name
    const m = typeof fullName === 'string' ? FULL_NAME_RE.exec(fullName) : null
    if (!m) return await drop('bad_repo')
    const repoKey = repoKeyFromUrl(`https://github.com/${fullName as string}`)
    if (!repoKey) return await drop('bad_repo')

    const project = await resolveRepoProject(env, repoKey)
    if (!project.ok) return await drop(project.reason)

    const notice = await githubNotice(
      { tenant: env.TENANT_SLUG, connection: install.installation_id, eventId: deliveryId, repoKey },
      eventName,
      payload,
    )
    if (!notice) return await drop('unmappable')

    const office = getProjectOffice(env, project.projectId)
    if (!office) return { routed: false, reason: 'flag_off' }
    const res = await office.notice(notice)
    if (!res.ok) return await drop('office_refused')
    return { routed: true, project_id: project.projectId, outcome: res.outcome }
  } catch {
    return await drop('office_error')
  }
}
