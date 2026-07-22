// tests/review-worker-safety.test.ts — #460 must-fix before REVIEW_AUTOMERGE=1.
//
// Port 2 (santa-loop gate-driver) auto-merge stays flag-gated OFF until these
// two invariants hold. The pure classify/dedupe helpers live in
// scripts/review-worker.py; we exercise them via a short Python child so the
// vitest suite gates the same code the operator runs.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, chmodSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REVIEW_WORKER = join(REPO_ROOT, 'scripts/review-worker.py')

function pyClassify(files: string[]): { sensitive: boolean; reason: string } {
  const script = `
import json, sys, importlib.util
spec = importlib.util.spec_from_file_location("review_worker", ${JSON.stringify(REVIEW_WORKER)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
files = json.loads(sys.argv[1])
sensitive, reason = mod.classify_sensitive(files)
print(json.dumps({"sensitive": sensitive, "reason": reason}))
`
  const out = execFileSync('python3', ['-c', script, JSON.stringify(files)], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  })
  return JSON.parse(out.trim()) as { sensitive: boolean; reason: string }
}

function pyAlreadyReviewed(opts: {
  statePath: string
  taskId: string
  headSha: string
  seedState: Record<string, string[]> | null
}): boolean {
  const script = `
import json, os, sys, importlib.util, pathlib
state_path = pathlib.Path(sys.argv[1])
task_id = sys.argv[2]
head_sha = sys.argv[3]
seed = json.loads(sys.argv[4])
os.environ["REVIEWED_STATE_PATH"] = str(state_path)
spec = importlib.util.spec_from_file_location("review_worker", ${JSON.stringify(REVIEW_WORKER)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod.REVIEWED_STATE_PATH = state_path
if seed is not None:
    mod._save_reviewed_state(seed)
print(json.dumps({"already": mod.already_reviewed(task_id, head_sha)}))
`
  const out = execFileSync(
    'python3',
    ['-c', script, opts.statePath, opts.taskId, opts.headSha, JSON.stringify(opts.seedState)],
    { encoding: 'utf8', cwd: REPO_ROOT },
  )
  return (JSON.parse(out.trim()) as { already: boolean }).already
}

describe('review-worker #460 allow-list anchoring', () => {
  it('classifies attacker-named source under README/LICENSE/test as SENSITIVE', () => {
    for (const evil of [
      'src/README_evil.ts',
      'src/LICENSE_backdoor.ts',
      'src/CHANGELOG_pwn.ts',
      'src/test/pwn.ts',
      'lib/test/helper.ts',
    ]) {
      const r = pyClassify([evil])
      expect(r.sensitive, evil).toBe(true)
    }
  })

  it('still allows the intended safe surfaces', () => {
    for (const safe of [
      'docs/architecture/x.md',
      'content/blog/post.md',
      'tests/foo.ts',
      'packages/a/tests/bar.ts',
      'src/foo.test.ts',
      'src/foo.spec.tsx',
      'README.md',
      'CHANGELOG.md',
      'LICENSE.md',
      'LICENSE',
      'docs/nested/README',
    ]) {
      const r = pyClassify([safe])
      expect(r.sensitive, safe).toBe(false)
    }
  })

  it('fails closed when no changed files are reported', () => {
    const r = pyClassify([])
    expect(r.sensitive).toBe(true)
  })
})

describe('review-worker #460 forgeable body-marker suppression', () => {
  it('does NOT skip without local state — forged body markers cannot suppress', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rw-safety-'))
    const statePath = join(dir, 'reviewed.json')
    try {
      // Empty local state: skip must be false regardless of any body text a
      // PR author could have forged (already_reviewed no longer takes body).
      expect(
        pyAlreadyReviewed({
          statePath,
          taskId: 'task-1',
          headSha: 'abc123deadbeef',
          seedState: null,
        }),
      ).toBe(false)

      expect(
        pyAlreadyReviewed({
          statePath,
          taskId: 'task-1',
          headSha: 'abc123deadbeef',
          seedState: { 'task-1': ['abc123deadbeef'] },
        }),
      ).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists state under owner-only file mode when mark_reviewed runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rw-mark-'))
    const statePath = join(dir, 'state', 'reviewed.json')
    mkdirSync(dirname(statePath), { recursive: true })
    chmodSync(dirname(statePath), 0o700)
    try {
      const script = `
import importlib.util, json, os, sys, pathlib
state_path = pathlib.Path(sys.argv[1])
os.environ["REVIEWED_STATE_PATH"] = str(state_path)
spec = importlib.util.spec_from_file_location("review_worker", ${JSON.stringify(REVIEW_WORKER)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod.REVIEWED_STATE_PATH = state_path
mod.mark_reviewed("task-9", "sha-fff")
mode = state_path.stat().st_mode & 0o777
print(json.dumps({"mode": mode, "already": mod.already_reviewed("task-9", "sha-fff")}))
`
      const out = execFileSync('python3', ['-c', script, statePath], {
        encoding: 'utf8',
        cwd: REPO_ROOT,
      })
      const result = JSON.parse(out.trim()) as { mode: number; already: boolean }
      expect(result.already).toBe(true)
      expect(result.mode).toBe(0o600)
      expect(statSync(dirname(statePath)).mode & 0o777).toBe(0o700)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
