// tests/seo-meta-fix-proposer.test.ts — mupot Flight 2 slice 1.
//
// Unit coverage for proposeSeoMetaFix (departments/collectors/seo-meta-fix.ts):
// the producer that turns a meta-fix intent into a gated seo-meta-fix proposal.
//
//   1. Fail-closed: an invalid intent (missing slug/title/content) throws
//      SeoMetaFixProposeError BEFORE any gate record is persisted — a human is
//      never asked to approve something structurally broken.
//   2. requiredCapability='lead' (channels/seo-channel.ts) is enforced — a
//      'member'-only ctx is denied.
//   3. A valid intent proposes successfully and returns a gateId; the persisted
//      payload always carries overwrite:true regardless of the intent shape.
//   4. executor defaults to 'inkwell-content' when the intent omits it.
//
// The full propose→approve→execute→real-write loop against REAL SQLite lives in
// tests/seo-meta-fix-loop-sqlite.test.ts (the hard-constraint deliverable) — this
// file is narrower unit coverage of the producer's own contract.

import { describe, it, expect } from 'vitest'
import type { D1Database } from '@cloudflare/workers-types'
import { proposeSeoMetaFix, SeoMetaFixProposeError } from '../src/departments/collectors/seo-meta-fix'
import '../src/departments/modules/growth' // trigger GrowthModule registration

const TENANT = 'mumega'
let _idCtr = 0
const makeId = () => `smf-${++_idCtr}`

/** Minimal D1 stub: records every department_proposals INSERT it sees. */
function makeStubDb(): { db: D1Database; proposalInserts: unknown[][] } {
  const proposalInserts: unknown[][] = []
  const db = {
    prepare(sql: string) {
      const upper = sql.trim().toUpperCase()
      const args: unknown[] = []
      const stmt = {
        bind(...a: unknown[]) {
          args.push(...a)
          return stmt
        },
        async run() {
          if (upper.includes('INSERT') && upper.includes('DEPARTMENT_PROPOSALS')) {
            proposalInserts.push([...args])
          }
          return { success: true, meta: { changes: 1 } }
        },
        async all() {
          return { results: [], success: true }
        },
        async first() {
          return null
        },
      }
      return stmt
    },
    async batch() {
      return []
    },
  } as unknown as D1Database
  return { db, proposalInserts }
}

const validIntent = {
  slug: 'existing-post',
  title: 'Better Title for AEO',
  content: 'unchanged body',
  description: 'better meta description',
  tags: ['seo', 'geo'],
}

describe('proposeSeoMetaFix — fail-closed validation before propose', () => {
  it('missing slug → SeoMetaFixProposeError, no gate record persisted', async () => {
    const { db, proposalInserts } = makeStubDb()
    await expect(
      proposeSeoMetaFix(
        { db },
        TENANT,
        { title: 't', content: 'c' } as unknown as Parameters<typeof proposeSeoMetaFix>[2],
        { idGen: makeId },
      ),
    ).rejects.toMatchObject({ reason: 'invalid_meta_fix_intent' })
    expect(proposalInserts.length).toBe(0)
  })

  it('empty-string slug → rejected, no gate record persisted', async () => {
    const { db, proposalInserts } = makeStubDb()
    await expect(
      proposeSeoMetaFix({ db }, TENANT, { ...validIntent, slug: '' }, { idGen: makeId }),
    ).rejects.toBeInstanceOf(SeoMetaFixProposeError)
    expect(proposalInserts.length).toBe(0)
  })

  it('missing content → rejected, no gate record persisted', async () => {
    const { db, proposalInserts } = makeStubDb()
    await expect(
      proposeSeoMetaFix(
        { db },
        TENANT,
        { slug: 's', title: 't' } as unknown as Parameters<typeof proposeSeoMetaFix>[2],
        { idGen: makeId },
      ),
    ).rejects.toMatchObject({ reason: 'invalid_meta_fix_intent' })
    expect(proposalInserts.length).toBe(0)
  })
})

describe('proposeSeoMetaFix — requiredCapability=lead enforced', () => {
  it("capabilities:['member'] → capability_denied, no gate record persisted", async () => {
    const { db, proposalInserts } = makeStubDb()
    await expect(
      proposeSeoMetaFix({ db }, TENANT, validIntent, { capabilities: ['member'], idGen: makeId }),
    ).rejects.toThrow(/capability_denied/)
    expect(proposalInserts.length).toBe(0)
  })

  it("capabilities:['lead'] (the default) succeeds", async () => {
    const { db } = makeStubDb()
    const result = await proposeSeoMetaFix({ db }, TENANT, validIntent, { idGen: makeId })
    expect(typeof result.gateId).toBe('string')
    expect(result.gateId.length).toBeGreaterThan(0)
  })
})

describe('proposeSeoMetaFix — persisted payload contract', () => {
  it('persists overwrite:true even when not asked for; defaults executor to inkwell-content', async () => {
    const { db, proposalInserts } = makeStubDb()
    await proposeSeoMetaFix({ db }, TENANT, validIntent, { idGen: makeId })
    expect(proposalInserts.length).toBe(1)
    // department_proposals INSERT bind order: (gate_id, tenant_id, department_key, action, payload_json)
    const [, , , action, payloadJson] = proposalInserts[0] as [string, string, string, string, string]
    expect(action).toBe('seo-meta-fix')
    const payload = JSON.parse(payloadJson as string)
    expect(payload).toMatchObject({
      executor: 'inkwell-content',
      slug: 'existing-post',
      title: 'Better Title for AEO',
      overwrite: true,
      status: 'draft',
    })
  })

  it('honours an explicit executor:"mcpwp" (caller opts in knowingly — see SCOPE note)', async () => {
    const { db, proposalInserts } = makeStubDb()
    await proposeSeoMetaFix({ db }, TENANT, { ...validIntent, executor: 'mcpwp' }, { idGen: makeId })
    const payload = JSON.parse(proposalInserts[0][4] as string)
    expect(payload.executor).toBe('mcpwp')
    expect(payload.overwrite).toBe(true) // still forced, regardless of adapter
  })

  it('two proposals produce distinct gateIds', async () => {
    const { db } = makeStubDb()
    const r1 = await proposeSeoMetaFix({ db }, TENANT, validIntent, { idGen: makeId })
    const r2 = await proposeSeoMetaFix({ db }, TENANT, validIntent, { idGen: makeId })
    expect(r1.gateId).not.toBe(r2.gateId)
  })
})
