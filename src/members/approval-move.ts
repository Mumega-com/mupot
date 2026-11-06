// Explicit human move of an existing seat approval. Called only after the
// dashboard's fresh web-session check; tool requests can only offer its link.
import type { Env } from '../types'
import { CAPABILITY_LIVE_PREDICATE, resolveCapabilities, canOnSquad } from '../auth/capability'
import { TOKEN_LIVE_PREDICATE } from '../auth/token-lifecycle'
import { mintRawToken, sha256Hex } from './service'
import { loadAdmission, loadHumanSeat, resolveAttachableAgent, prepareAttachStatements, seatAttachEnabled, attachDesignatedClause } from './seat-attach'
import { vipLaneEnabled } from './vip-lane'

export interface ApprovalMoveRequest { admissionId:string; agentId:string; harnessId:string; seatId:string; humanMemberId:string }
export interface ApprovalMoveOffer {
  admission_id:string; agent_id:string; agent_name:string; agent_slug:string; harness_id:string
  old_seat_id:string|null; old_seat_name:string; new_seat_id:string; new_seat_name:string
  ceiling:'member'|'lead'|'full'; gate_authority:number
}
type MoveFailure={ok:false;error:'admission_not_found'|'attach_refused'}

/** Preview is read-only and scoped just as narrowly as confirmation. */
export async function loadApprovalMoveOffer(env:Env,p:ApprovalMoveRequest):Promise<ApprovalMoveOffer|null>{
  if(!seatAttachEnabled(env))return null
  const adm=await loadAdmission(env,p.admissionId)
  if(!adm||adm.human_member_id!==p.humanMemberId||adm.agent_id!==p.agentId||adm.harness_id!==p.harnessId||adm.status!=='live'||adm.scope!=='seat'||adm.requested_seat_id===p.seatId)return null
  const seat=await loadHumanSeat(env,p.humanMemberId,p.seatId)
  if(!seat||seat.harness_id!==adm.harness_id||(vipLaneEnabled(env)&&seat.admission_status==='held'))return null
  const agent=await resolveAttachableAgent(env,p.humanMemberId,p.agentId)
  if(!agent.ok)return null
  const owner=await env.DB.prepare('SELECT 1 FROM agents WHERE id=?1 AND owner_member_id=?2').bind(p.agentId,p.humanMemberId).first()
  if(!owner)return null
  const human=await env.DB.prepare("SELECT 1 FROM members WHERE id=?1 AND tenant=?2 AND status='active'").bind(p.humanMemberId,env.TENANT_SLUG).first()
  if(!human)return null
  const current=await env.DB.prepare('SELECT 1 FROM agent_seat_attachments WHERE tenant=?1 AND seat_id=?2 AND detached_at IS NULL').bind(env.TENANT_SLUG,p.seatId).first()
  if(current)return null
  const names=await env.DB.prepare(`SELECT COALESCE(tl.label,s.label_basename) AS name FROM agent_seats s
    LEFT JOIN agent_seat_thread_labels tl ON tl.tenant=s.tenant AND tl.seat_id=s.id AND tl.human_member_id=s.member_id
    WHERE s.id=?1 AND s.tenant=?2 AND s.member_id=?3`).bind(adm.requested_seat_id,env.TENANT_SLUG,p.humanMemberId).first<{name:string}>()
  return {admission_id:adm.id,agent_id:agent.agent.id,agent_name:agent.agent.name,agent_slug:agent.agent.slug,harness_id:adm.harness_id,
    old_seat_id:adm.requested_seat_id,old_seat_name:names?.name??'Unavailable chat',new_seat_id:seat.id,new_seat_name:seat.label_basename,ceiling:adm.ceiling,gate_authority:adm.gate_authority}
}

/** Commit-time counterpart of the human's current admin standing. No role/directory inheritance. */
function moveAuthoritySql(env:Env,ownAttachment?:string):string{
 return `EXISTS (SELECT 1 FROM agents ag JOIN squads sq ON sq.id=ag.squad_id
    JOIN members hm ON hm.id=?3 AND hm.tenant=?2 AND hm.status='active'
    JOIN harnesses hr ON hr.id=?5 AND hr.tenant=?2 AND hr.member_id=?3
    JOIN agent_seats ns ON ns.id=?6 AND ns.tenant=?2 AND ns.member_id=?3 AND ns.harness_id=hr.id
    JOIN agent_member_bindings b ON b.agent_id=ag.id AND b.tenant=?2
    JOIN members am ON am.id=b.member_id AND am.tenant=?2 AND am.status='active'
    WHERE ag.id=?4 AND ag.owner_member_id=?3 AND ag.status='active' AND ns.retired_at IS NULL
      ${vipLaneEnabled(env)?"AND ns.admission_status IS NOT 'held'":''}
      AND NOT EXISTS (SELECT 1 FROM agent_seats managed WHERE managed.agent_id=ag.id)
      AND NOT EXISTS (SELECT 1 FROM agent_seat_attachments current WHERE current.tenant=?2 AND current.seat_id=?6 AND current.detached_at IS NULL ${ownAttachment?`AND current.id<>${ownAttachment}`:''})
      AND EXISTS (SELECT 1 FROM member_tokens st WHERE st.id=ns.seat_token_id AND st.tenant=?2 AND st.agent_id=ns.agent_id AND st.channel='directory' AND ${TOKEN_LIVE_PREDICATE('?7','st')})
      ${attachDesignatedClause(env,'ag','?3')}
      AND (EXISTS (SELECT 1 FROM capabilities c WHERE c.member_id=?3 AND c.capability IN ('admin','owner')
        AND ${CAPABILITY_LIVE_PREDICATE('c','?7')}
        AND ((c.scope_type='squad' AND c.scope_id=sq.id) OR (sq.kind<>'home' AND (c.scope_type='org' OR (c.scope_type='department' AND c.scope_id=sq.department_id)))))
        OR (sq.kind<>'home' AND EXISTS (SELECT 1 FROM channel_capability_grants ccg WHERE ccg.member_id=?3 AND ccg.squad_id=sq.id AND ccg.capability IN ('admin','owner')))))`
}

export async function moveSeatApproval(env:Env,p:ApprovalMoveRequest,nowMs=Date.now()):Promise<{ok:true;old_admission_id:string;admission_id:string;attachment_id:string}|MoveFailure>{
 const offer=await loadApprovalMoveOffer(env,p)
 if(!offer)return {ok:false,error:'admission_not_found'}
 // Reuse the same human scope checker before the atomic SQL revocation check.
 const grants=await resolveCapabilities(env,p.humanMemberId)
 const agent=await resolveAttachableAgent(env,p.humanMemberId,p.agentId)
 if(!agent.ok||!(await canOnSquad(env,grants,agent.agent.squad_id,'admin')))return {ok:false,error:'attach_refused'}
 const now=new Date(nowMs).toISOString(),id=crypto.randomUUID(),att=crypto.randomUUID(),tokenId=crypto.randomUUID()
 const tokenHash=await sha256Hex(mintRawToken()) // server-held; raw value is never returned or logged
 const common=[p.admissionId,env.TENANT_SLUG,p.humanMemberId,p.agentId,p.harnessId,p.seatId,now]
 const after=JSON.stringify({old_admission_id:p.admissionId,admission_id:id,attachment_id:att,seat_id:p.seatId,harness_id:p.harnessId,human_member_id:p.humanMemberId,ceiling:offer.ceiling,gate_authority:offer.gate_authority})
 try{
  await env.DB.batch([
   env.DB.prepare(`UPDATE agent_seat_admissions SET status='revoked',revoked_at=?7,revoked_by_member_id=?3
     WHERE id=?1 AND tenant=?2 AND human_member_id=?3 AND agent_id=?4 AND harness_id=?5
       AND status='live' AND scope='seat' AND requested_seat_id IS NOT ?6 AND ${moveAuthoritySql(env)}`).bind(...common),
   // changes() ties the new row to THIS batch's revocation. A conflict throws and rolls the whole move back.
   env.DB.prepare(`INSERT INTO agent_seat_admissions(id,tenant,agent_id,human_member_id,harness_id,status,gates,gate_authority,ceiling,requested_via,requested_seat_id,created_at,decided_at,decided_by_member_id,decided_via,scope,reason)
     SELECT ?8,tenant,agent_id,human_member_id,harness_id,'live',gates,gate_authority,ceiling,'dashboard',?6,?7,?7,?3,'dashboard','seat',reason
     FROM agent_seat_admissions WHERE id=?1 AND tenant=?2 AND human_member_id=?3 AND agent_id=?4 AND harness_id=?5
       AND status='revoked' AND revoked_at=?7 AND revoked_by_member_id=?3 AND changes()=1`).bind(...common,id),
   ...prepareAttachStatements(env,{attachmentId:att,tokenId,tokenHash,nowIso:now,admissionId:id,agent:{id:p.agentId,slug:offer.agent_slug},seat:{id:p.seatId,harnessId:p.harnessId},humanMemberId:p.humanMemberId,requireNoLiveAttachment:true,promotedAt:now,grantTokenId:null,humanAction:true}),
   // A zero-row insertion, changed scope or failed attachment must roll back the old revocation too.
   // agent_audit.action is NOT NULL, so this is the same fail-closed audit fence as other atomic writers.
   env.DB.prepare(`INSERT INTO agent_audit(id,agent_id,actor_id,actor_type,action,fields_changed,before_state,after_state)
     VALUES(?10,?4,?3,'user',CASE WHEN
       EXISTS(SELECT 1 FROM agent_seat_admissions old WHERE old.id=?1 AND old.tenant=?2 AND old.status='revoked' AND old.revoked_at=?7 AND old.revoked_by_member_id=?3)
       AND EXISTS(SELECT 1 FROM agent_seat_admissions next WHERE next.id=?8 AND next.tenant=?2 AND next.status='live' AND next.agent_id=?4 AND next.human_member_id=?3 AND next.harness_id=?5 AND next.requested_seat_id=?6)
       AND EXISTS(SELECT 1 FROM agent_seat_attachments a JOIN member_tokens t ON t.id=a.seat_token_id WHERE a.id=?9 AND a.admission_id=?8 AND a.seat_id=?6 AND a.detached_at IS NULL AND ${TOKEN_LIVE_PREDICATE('?7')})
       AND ${moveAuthoritySql(env,'?9')}
       THEN 'seat_approval_move' ELSE NULL END,'["seat"]','{}',?11)`).bind(...common,id,att,crypto.randomUUID(),after),
  ])
 }catch{return {ok:false,error:'attach_refused'}}
 return {ok:true,old_admission_id:p.admissionId,admission_id:id,attachment_id:att}
}
