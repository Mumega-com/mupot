#!/usr/bin/env node
// check-branch-staleness — a PR may not modify a file that the merge target has ALSO
// modified since the branch point, without rebasing first.
//
// THE TRAP THIS EXISTS FOR
//
// On 2026-08-13 a 26-PR triage found #834: 244 commits behind main, +15553/-234, and its
// content was the OLDER copy of work that had already landed. Merging it would have deleted
// `principalCanMutateRoutinePolicy` (reverting #811 and #813, restoring the state where a
// squad-B admin can rewrite a squad-A routine) and dropped three cancellation-fence guards
// from the scheduler's run-claim path.
//
// It did not present as a conflict. `git` reported CONFLICTING on some files, but the
// dangerous ones auto-merged: taking the branch's older `service.ts` wholesale is a clean
// merge that happens to be a revert. **"Already on main, but OLDER" is more dangerous than
// CONFLICTING, because a conflict announces itself and this does not.**
//
// Same shape, smaller, in #738 (113 behind) and #688 (113 behind): both rewrote the tail of
// `interface AuthContext` where main had since landed a different field, and in #688's case
// git auto-merged the *binds array* while the SQL text stayed conflicted, so either naive
// resolution silently misaligns query parameters with no compile error.
//
// THE RULE
//
//   For every file this PR MODIFIES, that file must not have changed on the merge target
//   since the merge base. If it has, the branch is standing on a world that moved: rebase,
//   then the diff is against what is actually there.
//
// Files the PR only ADDS are exempt — a file that does not exist on the target cannot have
// moved under it. This matters: the noisiest PRs are usually the ones adding new modules,
// and failing those would make the guard something people route around.
//
// WHAT THIS DOES NOT CHECK, deliberately:
//   - Commit distance alone. A branch 200 commits behind that touches nothing contested is
//     fine, and failing it would train everyone to ignore the guard. Distance is REPORTED
//     for context but never decides the verdict.
//   - Whether the overlap is semantically a revert. Deciding that needs content analysis
//     this cannot do reliably; the remedy (rebase) is the same either way, so the guard asks
//     for the remedy rather than guessing the severity.
//   - Conflicts. Git already reports those, and they are the LESS dangerous half.

import { execFileSync } from 'node:child_process'

// PRs are not always against main. Same convention as check-migration-numbering.mjs: CI
// passes the real base, and a verdict computed against the wrong branch would be unrelated
// to what actually merges — which is the exact failure mode this guard exists to catch, one
// level up.
const TARGET_REF = process.env.BASE_REF ? `origin/${process.env.BASE_REF}` : 'origin/main'

/** Run git, returning trimmed stdout, or null when the command fails. */
function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

/** Split git's newline output into a list, dropping the empty-string artifact of ''.split(). */
function lines(out) {
  return out === null ? null : out.split('\n').filter((l) => l.length > 0)
}

/**
 * Decide the verdict from already-gathered facts. Pure — no git — so the self-tests can
 * drive every branch directly, including the git states that are expensive to stage.
 *
 * @param {string[]|null} prModified   files the PR MODIFIES (not adds) — null if unreadable
 * @param {string[]|null} targetMoved  files changed on the target since the merge base —
 *                                     null if unreadable
 * @param {number|null}   behind       commits the branch is behind, for reporting only
 * @returns {{ok: boolean, reason: string, detail?: object}}
 */
export function evaluate(prModified, targetMoved, behind) {
  // CANNOT VERIFY IS NOT PASS, and it has two sides — same discipline as
  // check-migration-numbering.mjs, which shipped fail-open on one of its two arguments for
  // four hours because the rule was written once and applied to only one input. A guard that
  // shrugs and exits 0 is worse than absent: the green tick reads as "staleness verified".
  if (prModified === null) return { ok: false, reason: 'pr_files_unreadable' }
  if (targetMoved === null) return { ok: false, reason: 'target_diff_unreadable' }

  if (prModified.length === 0) {
    return { ok: true, reason: 'no_modified_files', detail: { behind } }
  }

  const movedSet = new Set(targetMoved)
  const contested = prModified.filter((f) => movedSet.has(f)).sort()

  if (contested.length === 0) {
    return { ok: true, reason: 'no_contested_files', detail: { behind } }
  }
  return { ok: false, reason: 'files_moved_under_branch', detail: { contested, behind } }
}

function main() {
  const base = git(['merge-base', 'HEAD', TARGET_REF])
  if (base === null) {
    console.error(
      `check-branch-staleness: cannot compute merge-base against ${TARGET_REF}.\n` +
        'A shallow clone will do this — the workflow needs fetch-depth: 0.',
    )
    process.exit(1)
  }

  // --diff-filter=M: files MODIFIED on this branch. Additions are exempt by design (a file
  // absent from the target cannot have moved under the branch), and deletions are their own
  // problem, out of scope rather than half-covered.
  const prModified = lines(git(['diff', '--name-only', '--diff-filter=M', `${base}...HEAD`]))
  const targetMoved = lines(git(['diff', '--name-only', `${base}..${TARGET_REF}`]))
  const behindRaw = git(['rev-list', '--count', `HEAD..${TARGET_REF}`])
  const behind = behindRaw === null ? null : Number.parseInt(behindRaw, 10)

  const verdict = evaluate(prModified, targetMoved, behind)

  if (verdict.ok) {
    const n = verdict.detail?.behind
    console.log(
      `check-branch-staleness: OK (${verdict.reason}` +
        (typeof n === 'number' ? `, ${n} behind ${TARGET_REF}` : '') +
        ')',
    )
    return
  }

  if (verdict.reason === 'files_moved_under_branch') {
    const { contested, behind: n } = verdict.detail
    console.error(
      `check-branch-staleness: this branch is ${n} commits behind ${TARGET_REF}, and ` +
        `${contested.length} file(s) it MODIFIES have changed on ${TARGET_REF} since the ` +
        'branch point:\n' +
        contested.map((f) => `  ${f}`).join('\n') +
        '\n\nThe diff is against a version that no longer exists. Merging can be a clean ' +
        'merge that is also a REVERT — that is what happened in mupot#834, which silently ' +
        'restored an RBAC hole and dropped three audit guards while looking mergeable.\n\n' +
        `Fix: rebase onto ${TARGET_REF}, re-read those files, then re-push.`,
    )
  } else {
    console.error(`check-branch-staleness: FAILED (${verdict.reason}) — refusing to pass unverified.`)
  }
  process.exit(1)
}

// Only run when invoked directly, so the self-tests can import `evaluate` cleanly.
if (process.argv[1] && process.argv[1].endsWith('check-branch-staleness.mjs')) {
  main()
}
