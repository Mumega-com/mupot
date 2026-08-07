#!/usr/bin/env node
// check-migration-numbering — a migration a PR adds must sort ABOVE everything on the
// merge target. mupot#729.
//
// THE TRAP THIS EXISTS FOR
//
// `wrangler d1 migrations apply` runs only the files ABOVE the applied head. A PR that adds
// `migrations/0076_foo.sql` while production's head is 0079 therefore merges green, deploys
// green, and its schema NEVER RUNS. The feature ships without its tables and the first
// symptom is a runtime error against a column that does not exist. This already cost one
// production incident (#594, v0.25 partially applied).
//
// It is not an author mistake. Every one of the twelve colliding branches measured on
// 2026-08-06 was numerically correct ON THE DAY IT WAS WRITTEN. The number is claimed at
// branch time and never re-checked at merge time, so correctness decays silently while the
// branch sits. Slot 0076 alone had four independent claimants (#696, #657, #656, #484) and
// 0068 — which already carries two files on main — had two more.
//
// Same family as the test-schema ratchet (#684/#703/#711/#720/#721): correct when written,
// silently wrong later, invisible to every existing check. And `wrangler d1 migrations list`
// will not tell you either — it reports only on files the local checkout can see, so a stale
// branch gets a confident "No migrations to apply!" (#594's second lesson).
//
// THE RULE
//
//   Every migrations/NNNN_*.sql file that this PR ADDS must have NNNN strictly greater than
//   the highest NNNN on the merge target.
//
// Compared against the merge TARGET, never against a number written down in the PR — a
// baseline the PR can edit is a baseline the PR can raise. Same discipline as the schema
// ratchet, for the same reason.
//
// WHAT THIS DOES NOT CHECK, deliberately:
//   - Existing duplicates on main (0068 has two files). Pre-existing debt is not this PR's
//     to fix, and failing on it would make the guard unmergeable on day one. Only files the
//     PR adds are judged.
//   - Whether a migration is CORRECT, idempotent, or safe. The `D1 migration chain check`
//     job already executes the whole chain against sqlite3. This guard is about ORDERING.
//   - Deleting or rewriting an already-applied migration. That is a distinct and worse
//     defect (the file is gone locally but applied remotely) and deserves its own check; it
//     is out of scope here rather than half-covered.

import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = 'migrations'
// The chain that will actually be applied. Every added migration must clear THIS head,
// whatever branch the PR happens to declare as its base.
const MAIN_REF = 'origin/main'

// A migration filename is EXACTLY four digits, an underscore, a name, `.sql`. Anchored at
// both ends: a loose /^(\d+)/ would accept `007_x.sql` and `00760_x.sql` and silently
// compare them as 7 and 760, which is how an ordering guard produces a confident wrong
// answer. Anything that does not match is a hard failure when the PR adds it, because a
// file this cannot parse is a file whose position in the chain nobody can reason about.
const MIGRATION_RE = /^(\d{4})_[A-Za-z0-9][A-Za-z0-9_-]*\.sql$/

/** Parse a filename to its number, or null when it is not a well-formed migration name. */
export function migrationNumber(filename) {
  const m = MIGRATION_RE.exec(filename)
  return m ? Number.parseInt(m[1], 10) : null
}

/**
 * Decide the verdict from already-gathered facts. Pure — no git, no fs — so the self-tests
 * can drive every branch directly, including the ones that need a git state that is
 * expensive or impossible to stage.
 *
 * @param {string[]|null} targetFiles  migration filenames on the merge target, or null when
 *                                     the target could not be read at all
 * @param {string[]|null} localFiles   migration filenames in the working tree, or null when
 *                                     the working tree's migrations/ could not be listed
 * @returns {{ok: boolean, reason: string, detail?: object}}
 */
export function evaluate(targetFiles, localFiles) {
  // CANNOT VERIFY IS NOT PASS — and it has TWO sides. The rule is not "the target must be
  // readable", it is "every input this verdict rests on must be readable". Both sides get the
  // same answer, because a guard that shrugs and exits 0 is worse than absent: the green tick
  // reads as "ordering verified".
  //
  // This file shipped with only the target side (c43b35b) and was still fail-open on the
  // local side for four hours. Both bugs are one sentence written down once and then applied
  // to one of its two arguments. If a third input is ever added, it gets a null case too.

  // LOCAL side. Checked first because it needs no target to be decidable. Treating an
  // unlistable migrations/ as "this PR added nothing" is the same fail-open as the target
  // side, reached from the opposite direction — a sparse checkout omitting the directory
  // disables the guard and the check reports success.
  if (localFiles === null) {
    return { ok: false, reason: 'local_unreadable' }
  }
  // TARGET side. A shallow clone, a missing base ref, or an unreadable tree.
  if (targetFiles === null) {
    return { ok: false, reason: 'target_unreadable' }
  }

  // Bootstrap: no migrations directory on the target yet. Nothing to sort above.
  if (targetFiles.length === 0) {
    return { ok: true, reason: 'bootstrap_no_target_migrations' }
  }

  const targetSet = new Set(targetFiles)
  const added = localFiles.filter((f) => !targetSet.has(f))
  if (added.length === 0) {
    return { ok: true, reason: 'no_migrations_added' }
  }

  // Unparseable ADDED files fail. Unparseable files already on the target are ignored on
  // purpose — pre-existing debt, and refusing to compute a max because of one legacy name
  // would disengage the guard for every future PR.
  const malformed = added.filter((f) => migrationNumber(f) === null)
  if (malformed.length > 0) {
    return { ok: false, reason: 'malformed_migration_name', detail: { malformed } }
  }

  const targetNumbers = targetFiles.map(migrationNumber).filter((n) => n !== null)
  if (targetNumbers.length === 0) {
    // Every file on the target is unparseable, so there is no ordering to be above. Refuse
    // rather than invent one — Math.max of an empty list is -Infinity, and comparing against
    // that would pass EVERY added file while looking like a real comparison.
    return { ok: false, reason: 'target_has_no_parseable_migrations' }
  }
  const head = Math.max(...targetNumbers)

  const below = added
    .map((file) => ({ file, number: migrationNumber(file) }))
    .filter((entry) => entry.number <= head)
  if (below.length > 0) {
    return { ok: false, reason: 'below_target_head', detail: { head, below } }
  }

  // Two added files claiming the same number. Both are above the head, so the rule above
  // passes them, but only one ordering is real and D1 applies them alphabetically — which
  // means the tie is broken by the part of the name after the digits, silently. Caught
  // separately because it is a different mistake with a different fix (renumber one of
  // yours, rather than renumber above main).
  const seen = new Map()
  const collisions = []
  for (const file of added) {
    const n = migrationNumber(file)
    if (seen.has(n)) collisions.push({ number: n, files: [seen.get(n), file] })
    else seen.set(n, file)
  }
  if (collisions.length > 0) {
    return { ok: false, reason: 'duplicate_number_within_pr', detail: { collisions } }
  }

  return { ok: true, reason: 'above_target_head', detail: { head, added } }
}

/**
 * Resolve the merge-target ref from BASE_REF, or origin/main.
 *
 * BASE_REF comes from `github.base_ref` in CI, which is PR-author-influenced. It never
 * reaches a shell — every git call here uses execFileSync with an argument array — but it is
 * still validated to a conservative branch-name charset, because an unexpected value should
 * become a loud refusal rather than a ref that resolves to something nobody intended.
 * Empty (push events, where github.base_ref is unset) falls through to origin/main.
 */
function mergeTargetRef() {
  const base = process.env.BASE_REF
  if (!base) return { ref: MAIN_REF }
  if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(base) || base.includes('..')) {
    return { ref: null, bad: base }
  }
  return { ref: `origin/${base}` }
}

/** Migration filenames on the merge target, or null when the ref cannot be read. */
function targetMigrations(ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: ROOT, stdio: 'ignore' })
  } catch {
    return null
  }
  try {
    const raw = execFileSync('git', ['ls-tree', '-r', '--name-only', ref, `${DIR}/`], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    })
    return raw
      .split('\n')
      .filter((line) => line.startsWith(`${DIR}/`))
      .map((line) => line.slice(DIR.length + 1))
      .filter((name) => name.endsWith('.sql'))
  } catch {
    // FAIL, not bootstrap. The first version of this returned [] here on the belief that a
    // ref with no migrations/ tree makes ls-tree throw. It does not: `git ls-tree -r
    // --name-only <ref> migrations/` against a ref with no such path exits 0 with EMPTY
    // STDOUT, which the success path above already turns into []. So this catch is reachable
    // ONLY when git actually failed — and returning [] there made a git failure look
    // identical to a genuine bootstrap, which `evaluate` passes.
    //
    // Measured, not theorised (Athena, diverse gate on this PR, pin 51aa9b1): with a PATH
    // git wrapper failing only `ls-tree`, a below-head migration exited 0 as
    // `bootstrap_no_target_migrations`. The guard against silent disengagement had one.
    //
    // The three-state discipline this file argues for was correct; the bug was that the
    // git layer mislabelled state 1 as state 2 before `evaluate` ever saw it. Keeping
    // `evaluate` pure is what let it hide — its own bootstrap test drives `evaluate([], …)`
    // directly and can never exercise this line.
    return null
  }
}

// The LOCAL side of the same cannot-read-is-not-pass rule. Returns null when the working
// tree's migrations/ cannot be listed at all, so `evaluate` can refuse instead of reading
// the absence as "this PR added nothing".
//
// Found by Prime's bypass review AFTER the target-side fix shipped (c43b35b) — the mirror
// image of that bug, in the mirror-image function, which neither Athena's bypass sweep nor
// 21 self-tests caught because everyone (me included) was looking at the target side.
// Measured on merged main: `mv migrations /tmp` then run the guard → exit 0,
// `no_migrations_added`. A sparse checkout that omits migrations/ disables the guard
// silently, and the check that is supposed to notice reports success.
function localMigrations() {
  // TWO ORACLES, UNIONED — and the union IS the fix, not belt-and-braces.
  //
  // This read used to be readdirSync alone, i.e. the WORKING TREE, while the target side reads
  // GIT. Two different oracles for the two halves of one comparison. Athena's re-gate named the
  // asymmetry; measured immediately after: commit a below-head 0076, delete only that file from
  // the working tree, and the guard prints `no_migrations_added` and exits 0 — while the commit
  // under review contains it.
  //
  // The earlier `local_unreadable` fix only caught a TOTAL readdir failure. A PARTIAL working
  // tree returns a short list with no error at all, so the guard under-reports what the PR adds
  // and calls the shortfall "added nothing". Fourth defect in this file, same seam every time:
  // the verdict resting on an input read from the wrong place.
  //
  // HEAD is what CI actually judges, so it is authoritative. The working tree is unioned in so a
  // developer running this before committing is still warned about a file git has not seen yet.
  // The union fails SAFE — it can only add files to the set being checked, never remove them.
  // Null only when BOTH oracles fail.
  const fromGit = (() => {
    try {
      return execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', `${DIR}/`], {
        cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      })
        .split('\n')
        .filter((line) => line.startsWith(`${DIR}/`))
        .map((line) => line.slice(DIR.length + 1))
        .filter((name) => name.endsWith('.sql'))
    } catch {
      return null
    }
  })()

  const fromDisk = (() => {
    try {
      return readdirSync(join(ROOT, DIR)).filter((name) => name.endsWith('.sql'))
    } catch {
      // Found by Prime after the target-side fix shipped (c43b35b) — the mirror image of that
      // bug in the mirror-image function. Measured on merged main: `mv migrations /tmp`, run the
      // guard, exit 0 with `no_migrations_added`.
      return null
    }
  })()

  if (fromGit === null && fromDisk === null) return null
  return [...new Set([...(fromGit ?? []), ...(fromDisk ?? [])])]
}

function main() {
  const target = mergeTargetRef()
  if (target.ref === null) {
    console.error(
      `MIGRATION NUMBERING CHECK FAILED\n\nBASE_REF is not a plausible branch name: ${JSON.stringify(target.bad)}`,
    )
    process.exitCode = 1
    return
  }
  const ref = target.ref
  const local = localMigrations()
  let verdict = evaluate(targetMigrations(ref), local)

  // STACKED PRs: the declared base is not the constraint. A migration number is claimed
  // against the chain that will EVENTUALLY be applied — production's — so clearing an
  // intermediate branch's head proves nothing.
  //
  // Measured, not theorised (Prime, bypass review of the merged guard): PR #398 declares base
  // `codex/project-routines-v025` (head 0061) and adds 0062. Against that base the guard
  // printed "migration numbering OK". Against main, head 0079, that migration can never run —
  // and 0062_routine_cancellation_events also collides semantically with main's already-
  // applied 0074_routine_cancellation_events. The guard said "ordering verified" about an
  // ordering that does not exist.
  //
  // So when the base is not main, added files must clear BOTH heads. The base check stays (it
  // catches collisions inside the stack) and main is checked as well; main's verdict wins when
  // it is the one with something to say, so the author gets one clear reason.
  if (verdict.ok && ref !== MAIN_REF) {
    const mainVerdict = evaluate(targetMigrations(MAIN_REF), local)
    if (!mainVerdict.ok) {
      verdict = {
        ...mainVerdict,
        detail: { ...(mainVerdict.detail ?? {}), comparedAgainst: MAIN_REF, declaredBase: ref },
      }
    }
  }

  if (verdict.ok) {
    // Name the ref that was actually compared. "migration numbering OK" with no ref reads as
    // "verified", full stop — which is exactly how #398 passed.
    if (verdict.reason === 'above_target_head') {
      const names = verdict.detail.added.join(', ')
      const also = ref === MAIN_REF ? '' : ` (and above ${MAIN_REF})`
      console.log(`migration numbering OK — ${names} sort above ${ref} head ${verdict.detail.head}${also}`)
    } else {
      console.log(`migration numbering OK — ${verdict.reason} (vs ${ref})`)
    }
    return
  }

  console.error('MIGRATION NUMBERING CHECK FAILED\n')
  switch (verdict.reason) {
    case 'local_unreadable':
      console.error(
        `Could not list ${DIR}/ in the working tree. This check cannot tell "this PR added\n` +
        'no migrations" from "I could not look", so it refuses rather than passing.\n\n' +
        'Usually a sparse checkout that omits the directory. Check out the full tree.',
      )
      break
    case 'target_unreadable':
      console.error(
        `Could not read ${ref}. This check compares against the merge target, so it cannot\n` +
        'verify anything without it — and it fails rather than passing, because a green\n' +
        'check here means "ordering verified".\n\n' +
        'In CI: the job needs actions/checkout with fetch-depth: 0.\n' +
        'Locally: git fetch origin, or set BASE_REF to your PR base branch.',
      )
      break
    case 'malformed_migration_name':
      console.error(
        'These added files are not named NNNN_name.sql with exactly four digits:\n' +
        verdict.detail.malformed.map((f) => `  ${DIR}/${f}`).join('\n') +
        '\n\nThe chain is ordered by that prefix. A name this cannot parse is a file whose\n' +
        'position in the chain nobody can reason about.',
      )
      break
    case 'target_has_no_parseable_migrations':
      console.error(
        `Every migration on ${ref} has an unparseable name, so there is no head to sort\n` +
        'above. Refusing rather than inventing an ordering.',
      )
      break
    case 'below_target_head':
      console.error(
        (verdict.detail.comparedAgainst
          ? `Your declared base is ${verdict.detail.declaredBase}, but these must ALSO clear\n` +
            `${verdict.detail.comparedAgainst} — a migration number is claimed against the chain that\n` +
            'will eventually be applied, not against an intermediate branch.\n\n'
          : '') +
        `Merge-target head is ${String(verdict.detail.head).padStart(4, '0')}. These added ` +
        'migrations are at or below it:\n' +
        verdict.detail.below
          .map((e) => `  ${DIR}/${e.file}  (${String(e.number).padStart(4, '0')})`)
          .join('\n') +
        '\n\nwrangler d1 migrations apply runs only files ABOVE the applied head, so these\n' +
        'would merge green and never run — the feature ships without its schema (#594).\n\n' +
        `Fix: renumber to ${String(verdict.detail.head + 1).padStart(4, '0')} or higher and ` +
        'rebase onto the merge target.',
      )
      break
    case 'duplicate_number_within_pr':
      console.error(
        'This PR adds two migrations with the same number:\n' +
        verdict.detail.collisions
          .map((c) => `  ${String(c.number).padStart(4, '0')}: ${c.files.join(', ')}`)
          .join('\n') +
        '\n\nD1 would break the tie alphabetically on the rest of the filename. Give each\n' +
        'one its own number so the order is the one you chose.',
      )
      break
    default:
      console.error(`Unhandled verdict: ${verdict.reason}`)
  }
  process.exitCode = 1
}

// Importable for the self-tests; runs only when invoked directly.
if (process.argv[1] && process.argv[1].endsWith('check-migration-numbering.mjs')) {
  main()
}
