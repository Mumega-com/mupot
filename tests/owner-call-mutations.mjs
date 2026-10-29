// Run from an isolated builder worktree; always restores the exact input bytes. No production credentials or outbound calls.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const dir=resolve(process.argv[2] ?? 'tmp/owner-call-mutations')
mkdirSync(dir,{recursive:true})
const service='src/owner-call/service.ts', migration='migrations/0269_owner_calls.sql'
const originals=new Map([service,migration].map(p=>[p,readFileSync(p,'utf8')]))
const replace=(text,from,to)=>{if(!text.includes(from))throw new Error(`mutation anchor absent: ${from}`);return text.replace(from,to)}
const mutants=[
  ['live-actor-commit',service,s=>replace(s,'(SELECT stamp FROM owner_call_actor)=${stampP}','1=1'),'actor credential revocation with independent source'],
  ['live-admission-commit',service,s=>replace(s,'(SELECT stamp FROM owner_call_actor)=${stampP}','1=1'),'admitted authority is reasserted at commit'],
  ['canonical-dispatch-owner',service,s=>replace(s,' || source.delivery_owner !== who.owner_id',''),'blocks a missing or different-owner canonical dispatch'],
  ['live-owner-commit',service,s=>replace(s,'AND ${ownerLive} AND','AND 1=1 AND'),'owner human predicate is checked at commit'],
  ['source-version-commit',service,s=>replace(s,'(SELECT stamp FROM owner_call_source)=${sourceStampP}','1=1'),'refuses change between read and commit: UPDATE elevation_requests'],
  ['capability-expiry-commit',service,s=>replace(s,"${CAPABILITY_LIVE_PREDICATE('', '?10')}","1"),'a capability expiring'],
  ['source-owner-aba',service,s=>s.replaceAll('sa.owner_call_owner_revision','0'),'source owner revision ABA'],
  ['source-owner-invalidation',migration,s=>replace(s,"UPDATE owner_calls SET state='closed' WHERE source_agent_id=NEW.id AND state='pending';",'SELECT 1;'),'source owner change closes'],
  ['natural-source-expiry',service,s=>replace(s,"CASE WHEN e.status='pending' AND julianday(e.decision_expires_at)>julianday(?3) THEN 1 ELSE 0 END",'1'),'natural source expiry'],
  ['source-credential-commit',service,s=>replace(replace(s,"${TOKEN_LIVE_PREDICATE('?3', 'ct')}",'1=1'),'ct.id,ct.created_at,ct.revoked_at,ct.expires_at,ct.channel','ct.id,ct.created_at,ct.channel'),'source credential revocation'],
  ['source-member-commit',service,s=>replace(replace(s,"AND sm.status='active' AND sm.archived_at IS NULL",''),'sm.id,sm.status,sm.archived_at,sm.tenant','sm.id,sm.tenant'),'source welded member suspension'],
  ['active-action-unique',migration,s=>replace(s,'CREATE UNIQUE INDEX owner_call_active_action','CREATE INDEX owner_call_active_action'),'database active-action uniqueness'],
  ['key-history-conflict',migration,s=>replace(s,"BEGIN SELECT RAISE(ABORT,'ask_key_conflict'); END;",'BEGIN SELECT 1; END;'),'database key-history conflict'],
  ['agent-creation-limit',migration,s=>replace(s,">= 5\nBEGIN SELECT RAISE(ABORT,'owner_call_agent_rate')",">= 500\nBEGIN SELECT RAISE(ABORT,'owner_call_agent_rate')"),'atomic agent creation ceiling'],
  ['owner-creation-limit',migration,s=>replace(s,">= 20\nBEGIN SELECT RAISE(ABORT,'owner_call_owner_rate')",">= 2000\nBEGIN SELECT RAISE(ABORT,'owner_call_owner_rate')"),'atomic owner creation ceiling'],
  ['agent-unresolved-limit',migration,s=>replace(s,"c.state='pending') >= 10","c.state='pending') >= 1000"),'joined associations count'],
  ['ordinary-owner-limit',migration,s=>replace(s,">= 40\nBEGIN SELECT RAISE(ABORT,'owner_call_owner_pending')",">= 4000\nBEGIN SELECT RAISE(ABORT,'owner_call_owner_pending')"),'ordinary owner queue stops'],
  ['owner-revision-aba',migration,s=>replace(s,'SET owner_call_owner_revision = OLD.owner_call_owner_revision + 1','SET owner_call_owner_revision = OLD.owner_call_owner_revision'),'owner revision catches'],
  ['requester-isolation',migration,s=>replace(s,"BEGIN SELECT RAISE(ABORT,'owner_call_requester_immutable'); END;",'BEGIN SELECT 1; END;').replace("CREATE TRIGGER owner_call_requesters_no_delete BEFORE DELETE ON owner_call_requesters BEGIN SELECT RAISE(ABORT,'owner_call_requester_immutable'); END;","CREATE TRIGGER owner_call_requesters_no_delete BEFORE DELETE ON owner_call_requesters BEGIN SELECT 1; END;"),'a requester cannot remove'],
  ['creation-flag',service,s=>replace(s,"if (env.OWNER_CALL !== '1')",'if (false)'),'flag off hides tool'],
  ['disabled-kinds',service,s=>replace(s,"return { ok: false, error: 'owner_call_kind_disabled' }","return { ok: true, result: { ask_id: 'fake', state: 'pending', delivery_state: 'inert', next_step: 'wait', retry: false } }"),'keeps .* disabled'],
]
let failed=false
const baseline=spawnSync('npx',['vitest','run','tests/owner-call.test.ts','--maxWorkers=2'],{encoding:'utf8',timeout:120_000,maxBuffer:8*1024*1024})
writeFileSync(resolve(dir,'baseline.log'),(baseline.stdout??'')+(baseline.stderr??''))
if(baseline.status!==0)throw new Error('baseline is not green; refusing to claim mutation kills')
console.log('baseline: PASS (exit 0)')
try{
 const selected=new Set(process.argv.slice(3))
 for(const name of selected)if(!mutants.some(m=>m[0]===name))throw new Error(`unknown mutation: ${name}`)
 for(const[name,path,mutate,pattern] of mutants.filter(m=>selected.size===0||selected.has(m[0]))){
  for(const[p,s]of originals)writeFileSync(p,s)
  writeFileSync(path,mutate(originals.get(path)))
  const r=spawnSync('npx',['vitest','run','tests/owner-call.test.ts','--maxWorkers=2','-t',pattern],{encoding:'utf8',timeout:120_000,maxBuffer:8*1024*1024})
  const output=(r.stdout??'')+(r.stderr??'')
  writeFileSync(resolve(dir,`${name}.log`),output)
  const killed=r.status!==0 && r.status!==null && /AssertionError/.test(output)
  console.log(`${name}: ${killed?'KILLED':'UNPROVEN'} (exit ${r.status})`)
  if(!killed)failed=true
 }
}finally{for(const[p,s]of originals)writeFileSync(p,s)}
if(failed)process.exitCode=1
