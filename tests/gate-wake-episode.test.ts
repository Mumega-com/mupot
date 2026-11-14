import {readFileSync} from 'node:fs'
import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {createSqliteD1,type SqliteD1Harness} from './helpers/sqlite-d1'
import {applyAllMigrations} from './helpers/migrations'
import {persistGateWakeNotice} from '../src/gates/grants'
import {sweepStalledGateReviews} from '../src/gates/stall-watchdog'
import type {Env} from '../src/types'
let h:SqliteD1Harness,env:Env
beforeEach(()=>{
 h=createSqliteD1();applyAllMigrations(h.sqlite);env={DB:h.db,TENANT_SLUG:'episode'} as Env
 h.sqlite.exec(`INSERT INTO departments(id,slug,name) VALUES('d','d','D');INSERT INTO squads(id,department_id,slug,name) VALUES('s','d','s','S');
 INSERT INTO agents(id,squad_id,slug,name,status) VALUES('g','s','g','G','active');
 INSERT INTO gate_grants(id,capability,principal_type,principal_id,granted_by,created_at) VALUES('gg','gate:g','agent','g','owner','2026-01-01');
 INSERT INTO tasks(id,squad_id,title,status,gate_owner,done_when,updated_at) VALUES('t','s','T','review','gate:g','reviewed','2026-01-01T00:00:00.000Z');`)
})
afterEach(()=>h.close())
describe('episode-stamped gate delivery',()=>{
 it.each([null,'2020-01-01T00:00:00.000Z'])('does not trust an old or unproven delivery timestamp (%s)',async at=>{
  h.sqlite.prepare("UPDATE tasks SET gate_wake_notice='Gate wake delivered: gate:g -> agent g (bus=sent, inbox=sent).',gate_wake_notice_at=? WHERE id='t'").run(at)
  expect(await sweepStalledGateReviews(env)).toMatchObject({rewoken:1})
  expect(h.sqlite.prepare("SELECT count(*) AS n FROM agent_messages WHERE to_agent='g'").get()).toEqual({n:1})
 })
 it('does not trust a delivery proof when the review clock is unknown',async()=>{
  await persistGateWakeNotice(env,'t','Gate wake delivered: gate:g -> agent g (bus=sent, inbox=sent).')
  h.sqlite.exec("UPDATE tasks SET review_entered_at=NULL WHERE id='t'")
  expect(await sweepStalledGateReviews(env)).toMatchObject({rewoken:1})
 })
 it('clears proof on every review entry even when the approval clock is carried',async()=>{
  expect(await persistGateWakeNotice(env,'t','delivered')).toBe(true)
  h.sqlite.exec("UPDATE tasks SET status='in_progress' WHERE id='t';UPDATE tasks SET status='review' WHERE id='t'")
  expect(h.sqlite.prepare("SELECT gate_wake_notice,gate_wake_notice_at FROM tasks WHERE id='t'").get()).toEqual({gate_wake_notice:'delivered',gate_wake_notice_at:null})
 })
 it('does not stamp a delayed old snapshot onto a newer task version',async()=>{
  h.sqlite.exec("UPDATE tasks SET updated_at='2026-02-01T00:00:00.000Z' WHERE id='t'")
  expect(await persistGateWakeNotice(env,'t','stale delivered','2026-01-01T00:00:00.000Z')).toBe(false)
  expect(h.sqlite.prepare("SELECT gate_wake_notice,gate_wake_notice_at FROM tasks WHERE id='t'").get()).toEqual({gate_wake_notice:null,gate_wake_notice_at:null})
 })
 it('a delayed first-wake result cannot attest delivery for a newer task snapshot',async()=>{
  const {wakeGateOwnerOnReview}=await import('../src/mcp')
  const task=h.sqlite.prepare("SELECT * FROM tasks WHERE id='t'").get() as unknown as import('../src/types').Task
  h.sqlite.prepare("UPDATE tasks SET updated_at=? WHERE id='t'").run(new Date().toISOString())
  expect(await wakeGateOwnerOnReview(env,task,{kind:'member',id:'owner'},'owner')).toMatchObject({status:'delivered',notice_persisted:false})
  expect(h.sqlite.prepare("SELECT gate_wake_notice_at FROM tasks WHERE id='t'").get()).toEqual({gate_wake_notice_at:null})
 })
 it('rollback removes only the additive proof metadata and keeps the notice',async()=>{
  await persistGateWakeNotice(env,'t','keep this notice')
  h.sqlite.exec(readFileSync(new URL('../docs/rollback/0274_gate_wake_notice_stamp.sql',import.meta.url),'utf8'))
  const cols=h.sqlite.prepare('PRAGMA table_info(tasks)').all() as Array<{name:string}>
  expect(cols.some(c=>c.name==='gate_wake_notice_at')).toBe(false)
  expect(h.sqlite.prepare("SELECT gate_wake_notice FROM tasks WHERE id='t'").get()).toEqual({gate_wake_notice:'keep this notice'})
 })
})
