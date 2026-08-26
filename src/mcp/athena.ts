// mupot — Athena autonomous gate-review MCP tools.
//
// athena_review_pr lets a synthetic council agent (Athena, or any member-tier
// seat acting as her) submit a PR diff for the structured gate audit. The
// engine is pure (src/athena/reviewer.ts); this file is the MCP seam.

import { reviewPullRequest, type ReviewFile } from '../athena/reviewer'
import { type ToolSpec, done, fail, str } from './index'

const STRING_SCHEMA = { type: 'string' }
const NUMBER_SCHEMA = { type: 'number' }

function readFiles(value: unknown): ReviewFile[] | null {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return null
  const files: ReviewFile[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
    const path = str((item as { path?: unknown }).path)
    if (!path) return null
    const patch = (item as { patch?: unknown }).patch
    const status = (item as { status?: unknown }).status
    files.push({
      path,
      ...(typeof patch === 'string' ? { patch } : {}),
      ...(typeof status === 'string' ? { status } : {}),
    })
  }
  return files
}

export const toolAthenaReviewPr: ToolSpec = {
  name: 'athena_review_pr',
  scope: 'org (synthetic council gate audit — Athena reviews a PR diff)',
  min: 'member',
  args: '{ diff: string, title?: string, body?: string, files?: {path, patch?, status?}[], tests_present?: boolean, tests_passed?: number, tests_failed?: number, pr_url?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      diff: STRING_SCHEMA,
      title: STRING_SCHEMA,
      body: STRING_SCHEMA,
      files: { type: 'array' },
      tests_present: { type: 'boolean' },
      tests_passed: NUMBER_SCHEMA,
      tests_failed: NUMBER_SCHEMA,
      pr_url: STRING_SCHEMA,
    },
    required: ['diff'],
    additionalProperties: false,
  },
  async run(_auth, _env, args) {
    const diff = typeof args.diff === 'string' ? args.diff : null
    if (diff === null) return fail(400, 'invalid_args', 'diff must be a string')

    if (args.tests_present !== undefined && typeof args.tests_present !== 'boolean') {
      return fail(400, 'invalid_args', 'tests_present must be a boolean')
    }
    if (args.tests_passed !== undefined && (typeof args.tests_passed !== 'number' || !Number.isFinite(args.tests_passed))) {
      return fail(400, 'invalid_args', 'tests_passed must be a number')
    }
    if (args.tests_failed !== undefined && (typeof args.tests_failed !== 'number' || !Number.isFinite(args.tests_failed))) {
      return fail(400, 'invalid_args', 'tests_failed must be a number')
    }

    const files = readFiles(args.files)
    if (!files) return fail(400, 'invalid_args', 'files must be an array of { path, patch?, status? }')

    const review = reviewPullRequest({
      diff,
      title: str(args.title) ?? undefined,
      body: str(args.body) ?? undefined,
      files,
      testsPresent: args.tests_present === true,
      testsPassed: typeof args.tests_passed === 'number' ? args.tests_passed : undefined,
      testsFailed: typeof args.tests_failed === 'number' ? args.tests_failed : undefined,
      prUrl: str(args.pr_url) ?? undefined,
    })

    return done({
      verdict: review.verdict,
      checks: review.checks,
      summary: review.summary,
    })
  },
}

export const ATHENA_TOOLS: ToolSpec[] = [toolAthenaReviewPr]
