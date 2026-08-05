// tests/task-ranking-parity.test.ts — mupot#713.
//
// THE DEFECT: the MCP path ranked correctly and the human path did not.
//
// migrations/0079 added `priority` and `parent_task_id`. #710 updated the projections and
// ORDER BY clauses in src/mcp/index.ts and shipped. It did not update:
//
//   src/tasks/index.ts      three queries — the REST /api/tasks surface
//   src/dashboard/index.ts  the squad board, which ordered by updated_at DESC
//
// So an agent asking "what is next" got a ranked answer and a human opening the board got
// "most recently touched", presented identically. Comments in both files claimed parity.
// Nothing failed. It was found by a diverse gate attacking the one claim I asked it to
// attack — on a surface I had never looked at.
//
// The class: a projection and an ordering duplicated across surfaces is a divergence
// waiting for its next column. Both now live in src/tasks/ranking.ts, beside the
// comparator they must agree with, and this file fails if anyone re-inlines them.

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { TASK_SELECT_COLUMNS, priorityOrderSql, PRIORITY_RANK } from '../src/tasks/ranking'

const SRC = join(__dirname, '..', 'src')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

/** A hand-written task column list: names several task columns inline instead of using the constant. */
const INLINE_TASK_PROJECTION = /SELECT\s+id,\s*squad_id,\s*project_id,\s*title,\s*body/i

describe('every task read uses the SHARED projection', () => {
  it('no file inlines its own task column list', () => {
    const offenders = walk(SRC)
      .filter((f) => !f.endsWith(join('tasks', 'ranking.ts')))
      .filter((f) => INLINE_TASK_PROJECTION.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length + 1))

    // If this fails, a surface has forked its own projection and will silently miss the
    // next column added to `tasks` — exactly how the human board lost priority.
    expect(offenders, `inline task projections found in: ${offenders.join(', ')}`).toEqual([])
  })

  it('the shared projection actually carries the ranking columns', () => {
    // Guards the trivial-pass: an empty or truncated constant would satisfy the test above
    // while carrying nothing.
    expect(TASK_SELECT_COLUMNS).toContain('priority')
    expect(TASK_SELECT_COLUMNS).toContain('parent_task_id')
    expect(TASK_SELECT_COLUMNS.split(',').length).toBeGreaterThan(10)
  })
})

describe('every ranked task query orders by priority', () => {
  // ASSERTS THE CLAUSES, NOT THE FILE. The first version of this test checked
  // `source.toContain('priorityOrderSql')` — which stays true if the import line survives,
  // so deleting priorityOrderSql from an actual ORDER BY left it green. Both mutations that
  // reproduce #713 exactly (REST drops it, dashboard reverts to updated_at DESC) passed
  // 6/6 against that version. A guard written to catch a vacuous claim, making a vacuous
  // claim. Now every ORDER BY on a tasks query is extracted and checked individually.

  /** Every `ORDER BY …` belonging to a SQL string that reads FROM tasks. */
  function taskOrderByClauses(source: string): string[] {
    const clauses: string[] = []
    // Template literals are the only way these queries are written in this codebase.
    for (const literal of source.match(/`[^`]*`/g) ?? []) {
      if (!/FROM\s+tasks/i.test(literal)) continue
      for (const m of literal.matchAll(/ORDER BY([\s\S]*?)(?:LIMIT|`|$)/gi)) {
        clauses.push(m[1].trim())
      }
    }
    return clauses
  }

  const RANKED_SURFACES = ['mcp/index.ts', 'tasks/index.ts', 'dashboard/index.ts']

  it.each(RANKED_SURFACES)('%s: EVERY task ORDER BY includes priority', (rel) => {
    const source = readFileSync(join(SRC, rel), 'utf8')
    const clauses = taskOrderByClauses(source)

    // Guard the vacuous pass: if no clauses are found the assertion below is trivially
    // satisfied, which is how the previous version hid the defect.
    expect(clauses.length, `${rel}: no task ORDER BY clauses found — the extractor is wrong`).toBeGreaterThan(0)

    const unranked = clauses.filter((c) => !c.includes('priorityOrderSql'))
    expect(
      unranked,
      `${rel} has task ORDER BY clauses that ignore priority: ${JSON.stringify(unranked)}`,
    ).toEqual([])
  })
})

describe('the SQL ordering agrees with the in-memory comparator', () => {
  it('priorityOrderSql ranks P0..P3 then untriaged, matching PRIORITY_RANK', () => {
    // The two must agree or the SQL drops rows the comparator would have ranked highest,
    // and the comparator then returns a perfectly-ordered list of the wrong tasks.
    const sql = priorityOrderSql()
    for (const [label, rank] of Object.entries(PRIORITY_RANK)) {
      if (label === 'untriaged') continue
      expect(sql).toContain(`WHEN '${label}' THEN ${rank}`)
    }
    // NULL/unknown falls to the untriaged rank via ELSE.
    expect(sql).toContain(`ELSE ${PRIORITY_RANK.untriaged}`)
  })
})
