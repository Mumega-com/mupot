import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Release-truth policy.
 *
 * Release documentation drifts because nothing checks it. #1255 was blocked
 * post-merge for naming a pre-merge commit as current `main`; #1265 corrected
 * the values and was falsified by its own merge seconds later. Correcting
 * values is not a fix, because the falsifier is the merge itself.
 *
 * The invariant this enforces:
 *
 *   A claim in a version-controlled document is durable only if nothing but
 *   editing that document can falsify it.
 *
 * A `main` commit fails that invariant absolutely — the commit that writes the
 * SHA changes the SHA — so it is banned outright. Values that move on a rare,
 * deliberate act (the package version, the latest tag) are permitted but must
 * agree with the repository right now. A production SHA is permitted only when
 * labelled as a record of a past deploy rather than asserted as current.
 *
 * Rules, all hard failures:
 *   R1 no-main-sha       A line asserting current `main` may not carry a commit SHA.
 *   R2 version-agrees    An asserted source version must equal package.json.
 *   R3 tag-agrees        An asserted latest tag must equal the newest semver tag.
 *   R4 prod-sha-labelled A production SHA must be labelled as a recorded past deploy.
 *
 * FAIL-CLOSED. This checker never reports clean because it could not look.
 * Every declared document must exist and be readable, package.json must parse,
 * and R3 requires real tags — a shallow clone with no tags is a hard failure,
 * not a skip. See #1178: two existing scanners pass vacuously when git is
 * absent, and that is the failure mode this file must not reproduce.
 */

/** Documents that carry release-truth claims. Missing file = hard failure. */
export const DECLARED_DOCS = [
  'CHANGELOG.md',
  'ROADMAP.md',
  'docs/releases/next-flights.md',
  'docs/releases/v0.30.0.md',
]

const SHA_RE = /\b[0-9a-f]{7,40}\b/
const SEMVER_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/

/** A line is about `main` when it names main in a currency assertion. */
const MAIN_ASSERTION_RE = /(current\s+(source\s+version|`?main`?)|on\s+`main`\s+at|`main`\s+is\s+(at|currently))/i

/** A line is about production when it makes a deployment claim. */
const PROD_ASSERTION_RE = /(current\s+production|production\s+(deployment|version|is\s+at)|deployed\s+at)/i

/** Wording that marks a SHA as a record of the past rather than a live claim. */
const RECORD_LABEL_RE = /(last\s+recorded|most\s+recent\s+recorded|recorded\s+deploy|historical|as\s+of\s+(?:the\s+)?\d{4}-\d{2}-\d{2})/i

const VERSION_CLAIM_RE = /current\s+source\s+version[:*\s|]*`?(\d+\.\d+\.\d+)`?/i
const TAG_CLAIM_RE = /latest\s+tagged\s+(?:stable\s+)?release[:*\s|]*`?(v\d+\.\d+\.\d+)`?/i

/**
 * Ancestry statements are monotonic DAG invariants: once X is an ancestor of a
 * commit it is one forever. They carry SHAs legitimately and are exempt from R4.
 */
const ANCESTRY_RE = /\bancestor\b/i

export function compareSemverTags(a, b) {
  const ma = SEMVER_TAG_RE.exec(a)
  const mb = SEMVER_TAG_RE.exec(b)
  if (!ma || !mb) throw new Error(`not a semver tag: ${!ma ? a : b}`)
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(ma[i]) - Number(mb[i])
    if (d !== 0) return d
  }
  return 0
}

export function newestSemverTag(tags) {
  const semver = tags.filter((t) => SEMVER_TAG_RE.test(t))
  if (semver.length === 0) return null
  return semver.reduce((best, t) => (compareSemverTags(t, best) > 0 ? t : best))
}

/**
 * Pure rule engine. `docs` is a Map of path -> file contents.
 * Returns findings; empty means the artifact satisfies the invariant.
 */
export function checkReleaseTruth({ docs, packageVersion, tags }) {
  const findings = []

  if (!packageVersion) {
    findings.push('release-truth: package version unavailable — refusing to report clean')
    return findings
  }

  const newestTag = newestSemverTag(tags)
  if (newestTag === null) {
    findings.push(
      'release-truth: no semver tags visible — R3 cannot be evaluated. ' +
        'This is a hard failure, not a skip: a shallow checkout without tags must not pass vacuously (#1178). ' +
        'Fetch tags in CI (actions/checkout with fetch-depth: 0, or git fetch --tags).',
    )
    return findings
  }

  for (const [path, contents] of docs) {
    const lines = contents.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      const at = `${path}:${i + 1}`

      // Markdown wraps sentences across lines, so a statement's qualifiers may
      // sit on the neighbouring line. Every exemption is evaluated over that window.
      const window = [lines[i - 1] ?? '', line, lines[i + 1] ?? ''].join(' ')
      const isAncestry = ANCESTRY_RE.test(window)

      // R1 — a current-`main` assertion may never carry a SHA.
      if (MAIN_ASSERTION_RE.test(line) && SHA_RE.test(line) && !isAncestry) {
        findings.push(
          `${at} R1 no-main-sha: a line asserting current \`main\` carries a commit SHA. ` +
            'The commit that writes this SHA changes it, so the statement is false the moment it merges. ' +
            'Point at `git rev-parse origin/main` instead of copying its value.',
        )
      }

      // R2 — an asserted source version must match package.json today.
      const versionClaim = VERSION_CLAIM_RE.exec(line)
      if (versionClaim && versionClaim[1] !== packageVersion) {
        findings.push(
          `${at} R2 version-agrees: document says source version ${versionClaim[1]}, package.json says ${packageVersion}.`,
        )
      }

      // R3 — an asserted latest tag must match the newest semver tag today.
      const tagClaim = TAG_CLAIM_RE.exec(line)
      if (tagClaim && tagClaim[1] !== newestTag) {
        findings.push(
          `${at} R3 tag-agrees: document says latest tag ${tagClaim[1]}, repository's newest semver tag is ${newestTag}.`,
        )
      }

      // R4 — a production SHA must be labelled as a record, not asserted as current.
      if (PROD_ASSERTION_RE.test(line) && SHA_RE.test(line) && !isAncestry) {
        if (!RECORD_LABEL_RE.test(window)) {
          findings.push(
            `${at} R4 prod-sha-labelled: a production SHA is stated without a record label. ` +
              'Production moves on deploy, so an unlabelled SHA silently becomes false. ' +
              'Label it "last recorded deploy" and name live /health as authoritative.',
          )
        }
      }
    }
  }

  return findings
}

function readDeclaredDocs(root) {
  const docs = new Map()
  for (const rel of DECLARED_DOCS) {
    const abs = resolve(root, rel)
    if (!existsSync(abs)) {
      throw new Error(
        `declared release document is missing: ${rel}. ` +
          'The document list is explicit precisely so that a missing file fails instead of shrinking the scan.',
      )
    }
    docs.set(rel, readFileSync(abs, 'utf8'))
  }
  return docs
}

function readTags(root) {
  try {
    return execFileSync('git', ['-C', root, 'tag', '--list'], { encoding: 'utf8' })
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function parseRoot(argv) {
  const flag = argv.indexOf('--root')
  return flag === -1 ? process.cwd() : resolve(argv[flag + 1])
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('release-truth-policy.mjs')

if (invokedDirectly) {
  try {
    const root = parseRoot(process.argv.slice(2))
    const docs = readDeclaredDocs(root)
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    const findings = checkReleaseTruth({ docs, packageVersion: pkg.version, tags: readTags(root) })

    console.log(`release-truth policy: scanned ${docs.size} declared documents`)

    if (findings.length > 0) {
      for (const f of findings) console.error(f)
      console.error(`release-truth policy violations: ${findings.length}`)
      process.exitCode = 1
    } else {
      console.log('release-truth policy: ok')
      process.exitCode = 0
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`release-truth policy failed: ${message}`)
    process.exitCode = 2
  }
}
