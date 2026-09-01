import { beforeEach, describe, expect, it } from 'vitest'
import type { AuthContext, Capability, CapabilityGrant, Env } from '../src/types'
import {
  decideVerdict,
  pathsFromDiff,
  reviewPullRequest,
  type GateCheck,
} from '../src/athena/reviewer'
import { TOOLS, invokeTool } from '../src/mcp/index'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'

let harness: ReturnType<typeof createSqliteD1>

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'user-1',
    email: 'athena@pot.test',
    role: 'member',
    tenant: 'test',
    channel: 'workspace',
    memberId: 'member-athena',
    capabilities: [{
      member_id: 'member-athena',
      scope_type: 'squad',
      scope_id: 'squad-core',
      capability: 'member',
    } as CapabilityGrant],
    boundAgentId: 'agent-athena',
    ...overrides,
  }
}

function grant(capability: Capability): CapabilityGrant {
  return { member_id: 'member-athena', scope_type: 'squad', scope_id: 'squad-core', capability }
}

const CLEAN_DIFF = `diff --git a/src/greet.ts b/src/greet.ts
--- a/src/greet.ts
+++ b/src/greet.ts
@@ -1,3 +1,4 @@
+export const token = process.env.API_TOKEN
 export function greet(name: string) {
   return 'hi ' + name
 }
diff --git a/tests/greet.test.ts b/tests/greet.test.ts
--- /dev/null
+++ b/tests/greet.test.ts
@@ -0,0 +1,6 @@
+import { greet } from '../src/greet'
+import { expect, it } from 'vitest'
+it('greets', () => {
+  expect(greet('ada')).toBe('hi ada')
+})
`

const SYNTHETIC_OPENAI_KEY = ['sk', 'abcdefghijklmnopqrstuvwxyz123456'].join('-')

const SECRET_DIFF = `diff --git a/src/client.ts b/src/client.ts
--- a/src/client.ts
+++ b/src/client.ts
@@ -1,2 +1,3 @@
+const API_KEY = "${SYNTHETIC_OPENAI_KEY}"
 export const url = 'https://api.example.com'
`

const RBAC_DIFF = `diff --git a/src/mcp/index.ts b/src/mcp/index.ts
--- a/src/mcp/index.ts
+++ b/src/mcp/index.ts
@@ -10,7 +10,6 @@
-  if (!hasCapability(auth.capabilities, 'org', null, 'admin')) return fail(403, 'forbidden')
+  const AUTH_DISABLED = true
   return done({ ok: true })
`

const SCHEMA_DIFF = `diff --git a/migrations/0079_drop_tasks.sql b/migrations/0079_drop_tasks.sql
--- /dev/null
+++ b/migrations/0079_drop_tasks.sql
@@ -0,0 +1,2 @@
+-- replay of a production-head number; this must never ship
+DROP TABLE tasks;
`

describe('Athena gate reviewer — safety rules', () => {
  it('APPROVED when the diff is clean and tests are present', () => {
    const review = reviewPullRequest({
      title: 'Greet helper',
      diff: CLEAN_DIFF,
      testsPresent: true,
      testsPassed: 1,
      testsFailed: 0,
    })
    expect(review.verdict).toBe('APPROVED')
    expect(review.checks).toHaveLength(4)
    expect(review.checks.every((check) => check.passed)).toBe(true)
    expect(review.summary).toContain('APPROVED')
    expect(pathsFromDiff(CLEAN_DIFF)).toEqual(expect.arrayContaining(['src/greet.ts', 'tests/greet.test.ts']))
  })

  it('BLOCKED on hardcoded secret literals', () => {
    const review = reviewPullRequest({
      title: 'Leak',
      diff: SECRET_DIFF,
      testsPresent: true,
      testsFailed: 0,
    })
    expect(review.verdict).toBe('BLOCKED')
    const secrets = review.checks.find((check) => check.id === 'no_hardcoded_secrets')
    expect(secrets?.passed).toBe(false)
    expect(secrets?.severity).toBe('blocker')
    expect(secrets?.detail).toMatch(/openai_key|assignment_literal/)
  })

  it('does not flag env-referenced credentials as secrets', () => {
    const review = reviewPullRequest({
      title: 'Env token',
      diff: CLEAN_DIFF,
      testsPresent: true,
    })
    expect(review.checks.find((check) => check.id === 'no_hardcoded_secrets')?.passed).toBe(true)
  })

  it('CHANGES_REQUESTED when unit tests are missing', () => {
    const review = reviewPullRequest({
      title: 'No tests',
      diff: `diff --git a/src/only.ts b/src/only.ts
--- /dev/null
+++ b/src/only.ts
@@ -0,0 +1,2 @@
+export const n = 1
`,
    })
    expect(review.verdict).toBe('CHANGES_REQUESTED')
    const tests = review.checks.find((check) => check.id === 'verified_unit_tests')
    expect(tests).toMatchObject({ passed: false, severity: 'warning' })
  })

  it('BLOCKED when the supplied test receipt is red', () => {
    const review = reviewPullRequest({
      title: 'Red suite',
      diff: CLEAN_DIFF,
      testsPresent: true,
      testsFailed: 3,
    })
    expect(review.verdict).toBe('BLOCKED')
    expect(review.checks.find((check) => check.id === 'verified_unit_tests')).toMatchObject({
      passed: false,
      severity: 'blocker',
    })
  })

  it('BLOCKED when RBAC primitives are stripped or bypassed', () => {
    const review = reviewPullRequest({
      title: 'Skip auth',
      diff: RBAC_DIFF,
      testsPresent: true,
    })
    expect(review.verdict).toBe('BLOCKED')
    const rbac = review.checks.find((check) => check.id === 'rbac_compliance')
    expect(rbac?.passed).toBe(false)
    expect(rbac?.detail).toMatch(/hasCapability|AUTH_DISABLED|bypass/i)
  })

  it('BLOCKED on ≤0079 migrations and DROP TABLE', () => {
    const review = reviewPullRequest({
      title: 'Silent migration',
      diff: SCHEMA_DIFF,
      files: [{ path: 'migrations/0079_drop_tasks.sql', patch: SCHEMA_DIFF }],
      testsPresent: true,
    })
    expect(review.verdict).toBe('BLOCKED')
    const schema = review.checks.find((check) => check.id === 'schema_backward_compatibility')
    expect(schema?.passed).toBe(false)
    expect(schema?.detail).toMatch(/0079|DROP TABLE/)
  })

  it('decideVerdict prefers blockers over warnings', () => {
    const checks: GateCheck[] = [
      { id: 'verified_unit_tests', name: 't', passed: false, severity: 'warning', detail: 'missing' },
      { id: 'no_hardcoded_secrets', name: 's', passed: false, severity: 'blocker', detail: 'key' },
      { id: 'rbac_compliance', name: 'r', passed: true, severity: 'blocker', detail: 'ok' },
      { id: 'schema_backward_compatibility', name: 'c', passed: true, severity: 'blocker', detail: 'ok' },
    ]
    expect(decideVerdict(checks)).toBe('BLOCKED')
    expect(decideVerdict(checks.slice(0, 1))).toBe('CHANGES_REQUESTED')
    expect(decideVerdict(checks.slice(2))).toBe('APPROVED')
  })
})

describe('athena_review_pr MCP tool', () => {
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: 'test', DB: harness.db } as unknown as Env
  })

  it('registers on the MCP surface with additionalProperties:false', () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual(expect.arrayContaining(['athena_review_pr']))
    const tool = TOOLS.find((candidate) => candidate.name === 'athena_review_pr')
    expect(tool?.min).toBe('member')
    expect(tool?.inputSchema.additionalProperties).toBe(false)
    expect(tool?.inputSchema.required).toEqual(['diff'])
  })

  it('returns the structured gate verdict for a council caller', async () => {
    const outcome = await invokeTool(auth(), env, 'athena_review_pr', {
      title: 'Greet helper',
      diff: CLEAN_DIFF,
      tests_present: true,
      tests_passed: 1,
      tests_failed: 0,
    }, 'https://pot.test')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result).toMatchObject({
      verdict: 'APPROVED',
      summary: expect.stringContaining('APPROVED'),
    })
    const result = outcome.result as { checks: Array<{ id: string; passed: boolean }> }
    expect(result.checks.map((check) => check.id)).toEqual([
      'no_hardcoded_secrets',
      'verified_unit_tests',
      'rbac_compliance',
      'schema_backward_compatibility',
    ])
  })

  it('BLOCKED through the MCP seam when the diff leaks a key', async () => {
    const outcome = await invokeTool(auth(), env, 'athena_review_pr', {
      diff: SECRET_DIFF,
      tests_present: true,
    }, 'https://pot.test')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result).toMatchObject({ verdict: 'BLOCKED' })
  })

  it('rejects a grantless caller at the capability floor', async () => {
    const outcome = await invokeTool(
      auth({ capabilities: [] }),
      env,
      'athena_review_pr',
      { diff: CLEAN_DIFF },
      'https://pot.test',
    )
    expect(outcome).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
  })

  it('rejects unknown fields', async () => {
    const outcome = await invokeTool(
      auth({ capabilities: [grant('member')] }),
      env,
      'athena_review_pr',
      { diff: CLEAN_DIFF, actor_id: 'spoof' },
      'https://pot.test',
    )
    expect(outcome).toMatchObject({ ok: false, status: 400, error: 'invalid_args' })
  })
})
