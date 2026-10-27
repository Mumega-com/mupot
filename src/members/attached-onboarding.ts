// mupot — the onboarding block an ATTACHED chat reads in boot_context, from mupot itself (nothing the human has to relay).
//
// Shown while the attachment is young (ONBOARDING_WINDOW_MS after it was made), so the chat's FIRST boot_context after the human's approval
// carries it, and a chat that boots twice in a row is not left without it. Built only from server rows for the attached agent
// (never from request input). Reuses the claim welcome's facts (claim-welcome.ts) as live data in the response; the welcome message in the
// inbox stays as the durable copy. Member-authored text (task titles, names) is bounded and control-stripped: data, not instruction.

import type { Env } from '../types'
import { TASK_NOT_ARCHIVED_SQL } from '../hygiene/filters'
import { cleanReported } from '../fleet/reported-values'

export const ONBOARDING_WINDOW_MS = 24 * 60 * 60 * 1000

export interface AttachedOnboarding {
  who_you_are: { name: string; slug: string; role: string }
  squad: { name: string } | null
  projects: Array<{ slug: string; name: string }>
  first_task: { id: string; title: string; status: string } | null
  how_you_are_woken: string
  first_steps: string[]
  next: string
}

const clean = (v: string | null | undefined, n = 120): string => cleanReported(v ?? '', n) ?? ''

export async function attachedOnboarding(
  env: Env,
  p: { attachmentId: string; agentId: string },
  nowMs: number = Date.now(),
): Promise<AttachedOnboarding | null> {
  const att = await env.DB.prepare(`SELECT created_at FROM agent_seat_attachments WHERE id = ?1 AND tenant = ?2 AND agent_id = ?3 AND detached_at IS NULL LIMIT 1`)
    .bind(p.attachmentId, env.TENANT_SLUG, p.agentId).first<{ created_at: string }>()
  if (!att) return null
  const created = Date.parse(att.created_at)
  if (!Number.isFinite(created) || nowMs - created > ONBOARDING_WINDOW_MS) return null
  const agent = await env.DB.prepare(`SELECT a.name AS name, a.slug AS slug, a.role AS role, a.squad_id AS squad_id, s.name AS squad_name
      FROM agents a LEFT JOIN squads s ON s.id = a.squad_id WHERE a.id = ?1 LIMIT 1`)
    .bind(p.agentId).first<{ name: string; slug: string; role: string | null; squad_id: string | null; squad_name: string | null }>()
  if (!agent) return null
  const projects = agent.squad_id
    ? ((await env.DB.prepare(`SELECT pr.slug AS slug, pr.name AS name FROM project_squad_access pa JOIN projects pr ON pr.id = pa.project_id
          WHERE pa.squad_id = ?1 AND pr.status = 'active' ORDER BY pr.name LIMIT 5`).bind(agent.squad_id).all<{ slug: string; name: string }>().catch(() => null))?.results ?? [])
    : []
  const task = await env.DB.prepare(`SELECT t.id, t.title, t.status FROM tasks t WHERE t.assignee_agent_id = ?1 AND t.status IN ('open','in_progress','blocked','review') AND ${TASK_NOT_ARCHIVED_SQL('t')} ORDER BY t.created_at ASC LIMIT 1`)
    .bind(p.agentId).first<{ id: string; title: string; status: string }>()
  return {
    who_you_are: { name: clean(agent.name, 64), slug: clean(agent.slug, 64), role: clean(agent.role, 64) },
    squad: agent.squad_name ? { name: clean(agent.squad_name, 64) } : null,
    projects: projects.map((x) => ({ slug: clean(x.slug, 64), name: clean(x.name, 64) })),
    first_task: task ? { id: task.id, title: clean(task.title, 160), status: task.status } : null,
    how_you_are_woken: 'You are an attached chat, so mupot cannot wake you: it reaches you in your inbox. Start each session with boot_context, then inbox {peek:true}; record what you handled with inbox_mark_handled. Your human opening this chat is the wake-up.',
    first_steps: [
      'Run connection_check now and tell your human its summary line (send, receive, wake). If receive is pending, follow its next step (inbox {peek:true}, inbox_mark_handled, then connection_check again).',
      'Then follow next below.',
    ],
    next: task
      ? `Start with your first task (${task.id}): task_get it, then do it. Call orient for the full briefing.`
      : 'No task is assigned to you yet. Call orient for your briefing, read your inbox with inbox {peek:true}, and ask your human what to pick up first. Mupot talks to you directly from here on; you do not need your human to relay it.',
  }
}
