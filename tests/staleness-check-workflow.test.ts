// tests/staleness-check-workflow.test.ts — regression coverage for mupot#571
// hotfix follow-up.
//
// The bug this guards against lives in the WORKFLOW YAML's shell semantics,
// not in scripts/staleness-check.mjs's logic (that script already computes
// its exit code correctly — see staleness-check.test.ts for its unit
// coverage). GitHub Actions' IMPLICIT default shell on Linux runners is
// `bash -e {0}` — WITHOUT `pipefail` — so a step that pipes a node script
// into `tee` (to also write the human-readable report to
// $GITHUB_STEP_SUMMARY) silently reports `tee`'s exit code (always 0)
// instead of the node script's. A drifted/unstamped/unreachable pot would
// tee its ✘ report into the step summary and the CI run would still go
// green. Declaring `shell: bash` explicitly switches to
// `bash --noprofile --norc -eo pipefail {0}`, which DOES set pipefail and
// propagates the real (node) exit code.
//
// This is a static YAML assertion (parses the workflow the same way
// tests/kubernetes-agent-host.test.ts already parses Kubernetes manifests
// with the `yaml` package) rather than an actual GitHub Actions run, since
// spinning up a real Actions runner is out of scope here — but the specific
// shell-selection property that fixes the bug is fully checkable statically
// and this locks it down so a future edit can't silently drop `shell: bash`
// and regress the swallowed-exit-code bug.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const ROOT = join(__dirname, '..')
const WORKFLOWS_DIR = join(ROOT, '.github', 'workflows')

type WorkflowStep = {
  name?: string
  run?: string
  shell?: string
}

type WorkflowJob = {
  steps?: WorkflowStep[]
}

type Workflow = {
  jobs?: Record<string, WorkflowJob>
}

function loadWorkflow(file: string): Workflow {
  return parse(readFileSync(join(WORKFLOWS_DIR, file), 'utf8')) as Workflow
}

/**
 * True iff `run` pipes one command's output into another (a bare `|`, not
 * the boolean-or `||`). This is intentionally a simple heuristic — it is a
 * static guard over this repo's own workflow files, not a general shell
 * parser, and every current workflow step is a plain single-line or
 * heredoc-free `run:` block so the heuristic holds.
 */
function hasShellPipe(run: string | undefined): boolean {
  if (typeof run !== 'string') return false
  return run
    .split('\n')
    .some((line) => /[^|]\|[^|]/.test(line) || /^\|[^|]/.test(line.trimStart()))
}

/** True iff `shell` is a value GitHub Actions resolves to a pipefail-enabled bash invocation. */
function isPipefailShell(shell: string | undefined): boolean {
  return shell === 'bash' || (typeof shell === 'string' && shell.includes('pipefail'))
}

describe('staleness-check.yml — exit code propagation (mupot#571 hotfix)', () => {
  const workflow = loadWorkflow('staleness-check.yml')
  const steps = workflow.jobs?.check?.steps ?? []
  const compareStep = steps.find((s) => s.name === 'Compare live pots vs main HEAD')

  it('has the "Compare live pots vs main HEAD" step', () => {
    expect(compareStep).toBeDefined()
  })

  it('still pipes the node script into tee (guards the test itself from going stale)', () => {
    expect(hasShellPipe(compareStep?.run)).toBe(true)
  })

  it('declares shell: bash so the pipe does not swallow the node script exit code', () => {
    // Regression check: GitHub Actions' implicit default shell for `run:`
    // steps on Linux is `bash -e {0}` WITHOUT pipefail. Only an EXPLICIT
    // `shell: bash` (or an equivalent explicitly-pipefail shell) makes
    // `node ... | tee ...` propagate node's exit code instead of tee's.
    expect(isPipefailShell(compareStep?.shell)).toBe(true)
  })
})

describe('all workflow steps — no unguarded pipe can swallow a real exit code', () => {
  // Broader guard than just the one step above: enumerate every step in
  // every workflow file, not just the one instance that was already found
  // broken, so the same class of bug can't reappear in a step added later.
  const files = ['ci.yml', 'staleness-check.yml']

  for (const file of files) {
    const workflow = loadWorkflow(file)
    const jobs = workflow.jobs ?? {}
    for (const [jobName, job] of Object.entries(jobs)) {
      const steps = job.steps ?? []
      steps.forEach((step, index) => {
        const label = step.name ?? `step #${index}`
        it(`${file} / ${jobName} / ${label} — no unguarded pipe`, () => {
          if (hasShellPipe(step.run)) {
            expect(isPipefailShell(step.shell)).toBe(true)
          }
        })
      })
    }
  }
})
