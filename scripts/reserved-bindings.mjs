import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Binding names the runtime does NOT own, even though a wrangler config may freely
// declare them. `@cloudflare/workers-oauth-provider` injects its helpers object into
// env.OAUTH_PROVIDER — but ONLY into an empty slot:
//
//   if (!env.OAUTH_PROVIDER) env.OAUTH_PROVIDER = this.createOAuthHelpers(env)
//
// A [vars] entry of the same name is truthy, so injection is skipped and every caller
// gets the string instead of the helpers. There is no type error, no startup warning,
// and no failing test — the worker deploys green and /authorize throws
// `TypeError: <x>.parseAuthRequest is not a function` on the first real request.
//
// This is not hypothetical. It cost us twice:
//   #699  (2026-08-05) — /auth/login 500 for as long as the wrapper had been mounted:
//         src/auth/index.ts read the name as a string, got the helpers object, fell into
//         the unsupported_provider branch, then threw `Converting circular structure to
//         JSON` while serialising the helpers into the error body. Fixed in code by
//         renaming the config var to IDP_PROVIDER.
//   P0-0  (2026-08-13) — /authorize 400 on EVERY fresh OAuth registration, which also
//         made the /oauth/consent agent-binding path unreachable. The #699 code fix was
//         correct and had been deployed for eight days. The defect survived because it
//         lives in a wrangler config, and the real per-pot configs are gitignored: no PR
//         could review them and no test read them. wrangler.example.toml — the template
//         every new pot is forked from — never got the rename at all, so each of
//         digid/house/viamar/alpha/acctest inherited a poisoned OAuth door at creation.
//
// The lesson this guard encodes: a fix that lands in code but not in deploy config is
// not a fix. Config is the one input to the running worker that neither review nor the
// type system sees, so it needs its own gate.
const RESERVED = [
  {
    name: 'OAUTH_PROVIDER',
    owner: '@cloudflare/workers-oauth-provider',
    use: 'IDP_PROVIDER',
    breaks: '/authorize and /auth/login throw at runtime; the worker still deploys green',
  },
]

// `KEY = value` at the start of a line, tolerating whitespace around the `=`. Commented
// lines are excluded by the leading-anchor: a `#` prefix means the name is being TALKED
// about, not declared, and this file plus every config's own explanatory comment do
// exactly that. Matching those would make the guard unable to document itself.
function declarationPattern(name) {
  return new RegExp(`^[ \\t]*${name}[ \\t]*=`, 'm')
}

function parseRoot(args) {
  if (args.length === 0) return process.cwd()
  if (args.length === 2 && args[0] === '--root' && args[1]) return resolve(args[1])
  throw new Error('usage: node scripts/reserved-bindings.mjs [--root <repository>]')
}

// Scan TRACKED configs only. The gitignored per-pot files (wrangler.digid.toml et al)
// are the ones that actually broke production, but they are by definition invisible to
// CI — a scan that silently found nothing in them would be a false green. They are the
// operator's responsibility at deploy time; what CI can own is that the TEMPLATE never
// teaches the mistake again. See the deploy-preflight note in docs.
function trackedConfigs(root) {
  const out = execFileSync('git', ['ls-files', '-z', '--', '*.toml'], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024,
  })
  return out
    .toString('utf8')
    .split('\0')
    .filter((path) => path.length > 0 && /wrangler.*\.toml$/.test(path))
}

function scan(root) {
  const findings = []
  for (const path of trackedConfigs(root)) {
    let text
    try {
      text = readFileSync(resolve(root, path), 'utf8')
    } catch {
      continue // deleted-but-still-indexed; nothing to read
    }
    for (const reserved of RESERVED) {
      if (!declarationPattern(reserved.name).test(text)) continue
      findings.push(
        `${path}: declares ${reserved.name}, a binding name reserved by ${reserved.owner}. ` +
          `Use ${reserved.use} instead. Left as-is, ${reserved.breaks}.`,
      )
    }
  }
  return findings
}

try {
  const root = parseRoot(process.argv.slice(2))
  const findings = scan(root)
  if (findings.length > 0) {
    for (const finding of findings) console.error(finding)
    console.error(`reserved binding name declared in ${findings.length} config(s)`)
    process.exitCode = 1
  } else {
    console.log('no reserved binding names declared')
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`reserved-bindings scan failed: ${message}`)
  process.exitCode = 2
}
