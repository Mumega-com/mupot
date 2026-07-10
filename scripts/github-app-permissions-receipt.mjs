#!/usr/bin/env node
// Mupot v0.23 GitHub App least-privilege evidence checker.
//
// This checker turns #151 into a falsifiable release receipt: after the live
// GitHub App definition is remediated and the installation is re-accepted, a
// redacted GET /app export must show only the permissions v0.23 needs.

import { createHash, createSign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CHECK_RECEIPT_TYPE = 'mupot-github-app-permissions/v1'
export const APP_FILE = 'github-app.json'
export const INSTALLATION_FILE = 'github-installation.json'

export const REQUIRED_APP_PERMISSIONS = {
  metadata: 'read',
  contents: 'write',
  issues: 'write',
  pull_requests: 'write',
  organization_projects: 'read',
}

const SECRET_VALUE_PATTERNS = [
  ['bearer_token', /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i],
  ['mupot_token', /\bmupot_[A-Za-z0-9._-]{12,}\b/],
  ['openai_api_key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['github_token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
]

export function parseArgs(argv) {
  const opts = {
    outDir: '',
    app: '',
    appId: '',
    installationId: '',
    privateKeyFile: '',
    apiUrl: 'https://api.github.com/app',
    exportApp: false,
    exportGh: false,
    organization: '',
    plan: false,
    check: false,
    summary: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[i]
    }

    if (arg === '--out-dir') opts.outDir = resolve(next())
    else if (arg === '--app') opts.app = next()
    else if (arg === '--app-id') opts.appId = next()
    else if (arg === '--installation-id') opts.installationId = next()
    else if (arg === '--private-key-file') opts.privateKeyFile = resolve(next())
    else if (arg === '--api-url') opts.apiUrl = next()
    else if (arg === '--export-app') opts.exportApp = true
    else if (arg === '--export-gh') opts.exportGh = true
    else if (arg === '--organization') opts.organization = next()
    else if (arg === '--plan') opts.plan = true
    else if (arg === '--check') opts.check = true
    else if (arg === '--summary') opts.summary = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }

  return opts
}

export function usage() {
  return [
    'Usage: node scripts/github-app-permissions-receipt.mjs --plan|--export-app|--export-gh|--check [options]',
    '',
    'Options:',
    '  --plan              print the GitHub App least-privilege evidence plan',
    '  --export-app        fetch GET /app and write a redacted github-app.json',
    '  --export-gh         fetch GET /apps/:slug plus the org installation through authenticated gh',
    '  --check             check a completed GitHub App evidence directory',
    '  --summary           with --check, print a compact text summary',
    '  --out-dir <path>    evidence directory',
    '  --app <slug>        expected GitHub App slug, for example mupot',
    '  --app-id <id>       GitHub App ID for --export-app',
    '  --organization <login> organization that owns the installed App, for --export-gh',
    '  --installation-id <id> installed GitHub App ID for export and check',
    '  --private-key-file <path> PKCS#8 GitHub App private key PEM for --export-app',
    '  --api-url <url>     GitHub App API URL for --export-app; default https://api.github.com/app',
    '  -h, --help          show this help',
  ].join('\n')
}

function shellQuote(value) {
  const raw = String(value)
  if (/^[A-Za-z0-9_./:=@%+~,#-]+$/.test(raw)) return raw
  return `'${raw.replace(/'/g, `'\\''`)}'`
}

function commandLine(parts, suffix = '') {
  return `${parts.map(shellQuote).join(' ')}${suffix}`
}

function defaultOutDir(opts) {
  return opts.outDir || `tmp/github-app-permissions/${opts.app || '<app-slug>'}`
}

function installationIdValid(value) {
  return /^[1-9]\d*$/.test(String(value || ''))
}

export function formatPlan(opts = {}) {
  const app = opts.app || '<app-slug>'
  const outDir = defaultOutDir(opts)
  const lines = []

  lines.push('Mupot v0.23 GitHub App least-privilege evidence plan')
  lines.push('')
  lines.push('Goal: prove #151 is fixed by checking the live GitHub App definition after permissions are reduced and the installation is re-accepted.')
  lines.push('')
  lines.push('Required live App permissions:')
  for (const [permission, level] of Object.entries(REQUIRED_APP_PERMISSIONS)) {
    lines.push(`- ${permission}: ${level}`)
  }
  lines.push('- workflows: none')
  lines.push('- every other repository or organization permission: none')
  lines.push('')
  lines.push(commandLine(['mkdir', '-p', outDir]))
  lines.push('')
  lines.push('Export the live App definition and installed App with one App-authentication JWT. The script writes only redacted metadata plus effective permissions:')
  lines.push(commandLine([
    'node',
    'scripts/github-app-permissions-receipt.mjs',
    '--export-app',
    '--out-dir',
    outDir,
    '--app',
    app,
    '--app-id',
    '<github-app-id>',
    '--installation-id',
    '<github-app-installation-id>',
    '--private-key-file',
    '<path-to-pkcs8-private-key.pem>',
  ]))
  lines.push('')
  lines.push(`The export writes ${join(outDir, APP_FILE)} from GET /app and ${join(outDir, INSTALLATION_FILE)} from GET /app/installations/<installation-id>.`)
  lines.push('')
  lines.push('If the App private key is correctly confined to a Worker secret, use the GitHub CLI path instead. It reads the configured permission object with gh api apps/<slug> and the organization installation through the authenticated GitHub CLI; no private key is copied or generated:')
  lines.push(commandLine([
    'node',
    'scripts/github-app-permissions-receipt.mjs',
    '--export-gh',
    '--out-dir',
    outDir,
    '--app',
    app,
    '--organization',
    '<organization-login>',
    '--installation-id',
    '<github-app-installation-id>',
  ]))
  lines.push('')
  lines.push('Check the evidence:')
  lines.push(commandLine([
    'node',
    'scripts/github-app-permissions-receipt.mjs',
    '--check',
    '--out-dir',
    outDir,
    '--app',
    app,
    '--installation-id',
    '<github-app-installation-id>',
  ], ` > ${shellQuote(join(outDir, 'github-app-permissions-check.json'))}`))
  lines.push(commandLine([
    'node',
    'scripts/github-app-permissions-receipt.mjs',
    '--check',
    '--summary',
    '--out-dir',
    outDir,
    '--app',
    app,
    '--installation-id',
    '<github-app-installation-id>',
  ]))
  return `${lines.join('\n')}\n`
}

function pushCheck(checks, ok, check, detail = {}) {
  checks.push({ ok: Boolean(ok), check, ...detail })
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

export function createAppJwt(appId, privateKeyPem, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!appId) throw new Error('--app-id is required')
  if (!privateKeyPem) throw new Error('--private-key-file is required')
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = {
    iat: nowSeconds - 60,
    exp: nowSeconds + 8 * 60,
    iss: String(appId),
  }
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`
  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  signer.end()
  return `${signingInput}.${signer.sign(privateKeyPem).toString('base64url')}`
}

export function redactAppDefinition(app) {
  return {
    id: app?.id ?? null,
    slug: app?.slug ?? null,
    name: app?.name ?? null,
    html_url: app?.html_url ?? null,
    owner: app?.owner && typeof app.owner === 'object'
      ? {
          login: app.owner.login ?? null,
          id: app.owner.id ?? null,
          type: app.owner.type ?? null,
        }
      : null,
    permissions: appPermissions(app),
  }
}

export function redactInstallationDefinition(installation) {
  return {
    id: installation?.id ?? null,
    app_id: installation?.app_id ?? null,
    app_slug: installation?.app_slug ?? null,
    target_id: installation?.target_id ?? null,
    target_type: installation?.target_type ?? null,
    repository_selection: installation?.repository_selection ?? null,
    account: installation?.account && typeof installation.account === 'object'
      ? {
          login: installation.account.login ?? null,
          id: installation.account.id ?? null,
          type: installation.account.type ?? null,
        }
      : null,
    permissions: appPermissions(installation),
    created_at: installation?.created_at ?? null,
    updated_at: installation?.updated_at ?? null,
    suspended_at: installation?.suspended_at ?? null,
  }
}

function installationApiUrl(apiUrl, installationId) {
  const url = new URL(apiUrl)
  if (!/\/app\/?$/.test(url.pathname)) throw new Error('--api-url must end with /app')
  url.pathname = url.pathname.replace(/\/app\/?$/, `/app/installations/${encodeURIComponent(installationId)}`)
  return url.toString()
}

async function fetchGitHubJson(fetchImpl, url, jwt) {
  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'mupot-release-evidence',
    },
  })
  if (!res.ok) throw new Error(`GET ${new URL(url).pathname} failed with HTTP ${res.status}`)
  return res.json()
}

function organizationValid(value) {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(String(value || ''))
}

function ghApiJson(args, ghExec, errorMessage) {
  let raw
  try {
    raw = ghExec('gh', ['api', ...args], { encoding: 'utf8' })
  } catch {
    throw new Error(errorMessage)
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('gh api returned invalid JSON')
  }
}

function installationFromGh(organization, installationId, ghExec) {
  const pages = ghApiJson(
    ['--paginate', '--slurp', `orgs/${encodeURIComponent(organization)}/installations`],
    ghExec,
    'gh api could not read the organization installations; authenticate gh as an organization owner or App manager',
  )
  const installations = (Array.isArray(pages) ? pages : [pages])
    .flatMap((page) => Array.isArray(page?.installations) ? page.installations : [])
  const matches = installations.filter((installation) => String(installation?.id ?? '') === String(installationId))
  if (matches.length !== 1) {
    throw new Error(`organization installation ${installationId} was not found exactly once under ${organization}`)
  }
  return matches[0]
}

function writeExportedDefinitions(outDir, app, installation) {
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, APP_FILE)
  const installationPath = join(outDir, INSTALLATION_FILE)
  writeFileSync(outPath, `${JSON.stringify(app, null, 2)}\n`)
  writeFileSync(installationPath, `${JSON.stringify(installation, null, 2)}\n`)
  return { path: outPath, installationPath }
}

export async function exportAppDefinition(opts = {}, fetchImpl = fetch) {
  if (!opts.outDir) throw new Error('--out-dir is required for --export-app')
  if (!opts.appId) throw new Error('--app-id is required for --export-app')
  if (!installationIdValid(opts.installationId)) throw new Error('--installation-id must be a positive numeric GitHub installation ID')
  if (!opts.privateKeyFile) throw new Error('--private-key-file is required for --export-app')

  const privateKeyPem = readFileSync(opts.privateKeyFile, 'utf8')
  const jwt = createAppJwt(opts.appId, privateKeyPem, opts.nowSeconds ?? Math.floor(Date.now() / 1000))
  const apiUrl = opts.apiUrl || 'https://api.github.com/app'
  const app = redactAppDefinition(await fetchGitHubJson(fetchImpl, apiUrl, jwt))
  if (opts.app && app.slug !== opts.app) {
    throw new Error(`GET /app returned slug ${app.slug ?? '<missing>'}, expected ${opts.app}`)
  }
  const installationUrl = installationApiUrl(apiUrl, opts.installationId)
  const installation = redactInstallationDefinition(await fetchGitHubJson(fetchImpl, installationUrl, jwt))
  if (String(installation.id ?? '') !== String(opts.installationId)) {
    throw new Error(`GET /app/installations returned id ${installation.id ?? '<missing>'}, expected ${opts.installationId}`)
  }
  if (String(installation.app_id ?? '') !== String(app.id ?? '')) {
    throw new Error(`installation app_id ${installation.app_id ?? '<missing>'} does not match App id ${app.id ?? '<missing>'}`)
  }
  if (installation.app_slug !== app.slug) {
    throw new Error(`installation app_slug ${installation.app_slug ?? '<missing>'} does not match App slug ${app.slug ?? '<missing>'}`)
  }
  return { ...writeExportedDefinitions(opts.outDir, app, installation), app, installation }
}

/**
 * Export the same redacted evidence without reading or rotating an App private
 * key. `gh` supplies the operator authentication for both GitHub reads.
 */
export async function exportGhAppDefinition(opts = {}, deps = {}) {
  if (!opts.outDir) throw new Error('--out-dir is required for --export-gh')
  if (!opts.app) throw new Error('--app is required for --export-gh')
  if (!organizationValid(opts.organization)) throw new Error('--organization must be a valid GitHub organization login')
  if (!installationIdValid(opts.installationId)) throw new Error('--installation-id must be a positive numeric GitHub installation ID')

  const ghExec = deps.ghExec ?? execFileSync
  const app = redactAppDefinition(ghApiJson(
    [`apps/${encodeURIComponent(opts.app)}`],
    ghExec,
    'gh api could not read the GitHub App definition; authenticate gh as an App manager',
  ))
  if (app.slug !== opts.app) {
    throw new Error(`gh api apps/${opts.app} returned slug ${app.slug ?? '<missing>'}`)
  }

  const installation = redactInstallationDefinition(
    installationFromGh(opts.organization, opts.installationId, ghExec),
  )
  if (String(installation.id ?? '') !== String(opts.installationId)) {
    throw new Error(`organization installation returned id ${installation.id ?? '<missing>'}, expected ${opts.installationId}`)
  }
  if (String(installation.app_id ?? '') !== String(app.id ?? '')) {
    throw new Error(`installation app_id ${installation.app_id ?? '<missing>'} does not match App id ${app.id ?? '<missing>'}`)
  }
  if (installation.app_slug !== app.slug) {
    throw new Error(`installation app_slug ${installation.app_slug ?? '<missing>'} does not match App slug ${app.slug ?? '<missing>'}`)
  }

  return {
    ...writeExportedDefinitions(opts.outDir, app, installation),
    app,
    installation,
    source: {
      app: `gh api apps/${opts.app}`,
      installation: `gh api orgs/${opts.organization}/installations`,
    },
  }
}

function scanSecretText(text, path) {
  const findings = []
  for (const [kind, re] of SECRET_VALUE_PATTERNS) {
    if (re.test(text)) findings.push({ path, kind })
  }
  return findings
}

function readJson(checks, path, label) {
  if (!existsSync(path)) {
    pushCheck(checks, false, 'file_present', { label, path })
    return null
  }
  pushCheck(checks, true, 'file_present', { label, path })
  const text = readFileSync(path, 'utf8')
  const secretFindings = scanSecretText(text, path)
  pushCheck(checks, secretFindings.length === 0, 'file_has_no_secret_material', { label, path, findings: secretFindings })
  try {
    const parsed = JSON.parse(text)
    pushCheck(checks, true, 'file_json_parseable', { label, path })
    return parsed
  } catch (err) {
    pushCheck(checks, false, 'file_json_parseable', { label, path, reason: err instanceof Error ? err.message : String(err) })
    return null
  }
}

function artifactMeta(path, parsed) {
  if (!existsSync(path)) return { path, exists: false }
  const text = readFileSync(path)
  return {
    path,
    exists: true,
    bytes: text.byteLength,
    sha256: createHash('sha256').update(text).digest('hex'),
    app_slug: parsed?.slug ?? parsed?.app_slug ?? null,
  }
}

function unexpectedKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['<not-an-object>']
  return Object.keys(value).filter((key) => !allowed.has(key))
}

function appPermissions(parsed) {
  if (parsed?.permissions && typeof parsed.permissions === 'object' && !Array.isArray(parsed.permissions)) {
    return parsed.permissions
  }
  return {}
}

function permissionDisplay(value) {
  if (value === undefined) return 'none'
  return typeof value === 'string' ? value.toLowerCase() : String(value)
}

export function inspectPermissionSet(parsed) {
  const permissions = appPermissions(parsed)
  const entries = Object.entries(permissions)
  return {
    permissions,
    entries,
    invalid: entries
      .filter(([, value]) => value !== 'read' && value !== 'write')
      .map(([permission, value]) => ({ permission, actual: permissionDisplay(value) })),
    extras: entries
      .filter(([permission]) => !(permission in REQUIRED_APP_PERMISSIONS))
      .map(([permission, value]) => ({ permission, actual: permissionDisplay(value) })),
    workflows_present: Object.hasOwn(permissions, 'workflows'),
    workflows_actual: permissionDisplay(permissions.workflows),
  }
}

function checkPermissionSet(checks, parsed, prefix) {
  const inspected = inspectPermissionSet(parsed)
  pushCheck(checks, inspected.entries.length > 0, `${prefix}_permissions_exported`, { count: inspected.entries.length })
  pushCheck(checks, inspected.invalid.length === 0, `${prefix}_permission_values_valid`, { invalid: inspected.invalid })
  for (const [permission, expected] of Object.entries(REQUIRED_APP_PERMISSIONS)) {
    const actual = permissionDisplay(inspected.permissions[permission])
    pushCheck(checks, actual === expected, `${prefix}_permission_matches`, {
      permission,
      expected,
      actual,
    })
  }
  pushCheck(checks, !inspected.workflows_present, `${prefix}_workflows_disabled`, {
    actual: inspected.workflows_actual,
  })
  pushCheck(checks, inspected.extras.length === 0, `${prefix}_has_no_extra_permissions`, { extras: inspected.extras })
  return inspected
}

export function checkBundle(opts = {}) {
  const outDir = resolve(defaultOutDir(opts))
  const checks = []
  const appPath = join(outDir, APP_FILE)
  const installationPath = join(outDir, INSTALLATION_FILE)
  const appJson = readJson(checks, appPath, 'github_app')
  const installationJson = readJson(checks, installationPath, 'github_installation')

  pushCheck(checks, existsSync(outDir), 'evidence_directory_present', { out_dir: outDir })
  pushCheck(checks, installationIdValid(opts.installationId), 'github_installation_id_expected', { expected: opts.installationId || null })
  if (opts.app) {
    pushCheck(checks, appJson?.slug === opts.app, 'github_app_slug_matches', {
      expected: opts.app,
      actual: appJson?.slug ?? null,
    })
  }
  const appExtraFields = unexpectedKeys(appJson, new Set(['id', 'slug', 'name', 'html_url', 'owner', 'permissions']))
  const appOwnerExtraFields = unexpectedKeys(appJson?.owner, new Set(['login', 'id', 'type']))
  pushCheck(checks, appExtraFields.length === 0 && appOwnerExtraFields.length === 0, 'github_app_export_redacted', {
    extra_fields: appExtraFields,
    owner_extra_fields: appOwnerExtraFields,
  })
  const installationExtraFields = unexpectedKeys(installationJson, new Set([
    'id',
    'app_id',
    'app_slug',
    'target_id',
    'target_type',
    'repository_selection',
    'account',
    'permissions',
    'created_at',
    'updated_at',
    'suspended_at',
  ]))
  const installationAccountExtraFields = unexpectedKeys(installationJson?.account, new Set(['login', 'id', 'type']))
  pushCheck(checks, installationExtraFields.length === 0 && installationAccountExtraFields.length === 0, 'github_installation_export_redacted', {
    extra_fields: installationExtraFields,
    account_extra_fields: installationAccountExtraFields,
  })

  pushCheck(checks, String(installationJson?.id ?? '') === String(opts.installationId ?? ''), 'github_installation_id_matches', {
    expected: opts.installationId || null,
    actual: installationJson?.id ?? null,
  })
  pushCheck(checks, String(installationJson?.app_id ?? '') === String(appJson?.id ?? ''), 'github_installation_app_id_matches', {
    expected: appJson?.id ?? null,
    actual: installationJson?.app_id ?? null,
  })
  pushCheck(checks, Boolean(appJson?.slug) && installationJson?.app_slug === appJson?.slug, 'github_installation_app_slug_matches', {
    expected: appJson?.slug ?? null,
    actual: installationJson?.app_slug ?? null,
  })
  pushCheck(checks, Boolean(installationJson?.account?.login && installationJson?.account?.id), 'github_installation_account_present', {
    account: installationJson?.account ?? null,
  })
  pushCheck(checks, installationJson?.suspended_at === null, 'github_installation_active', {
    suspended_at: installationJson?.suspended_at ?? null,
  })
  pushCheck(checks, Number.isFinite(Date.parse(String(installationJson?.updated_at ?? ''))), 'github_installation_updated_at_parseable', {
    updated_at: installationJson?.updated_at ?? null,
  })
  checkPermissionSet(checks, appJson, 'github_app')
  checkPermissionSet(checks, installationJson, 'github_installation')

  const failed = checks.filter((check) => check.ok === false)
  const passed = checks.filter((check) => check.ok === true)
  return {
    receipt_type: CHECK_RECEIPT_TYPE,
    status: failed.length === 0 ? 'pass' : 'fail',
    checked_at: new Date().toISOString(),
    out_dir: outDir,
    app: {
      expected_slug: opts.app || null,
      slug: appJson?.slug ?? null,
      id: appJson?.id ?? null,
      html_url: appJson?.html_url ?? null,
    },
    installation: {
      expected_id: opts.installationId || null,
      id: installationJson?.id ?? null,
      account: installationJson?.account ?? null,
      repository_selection: installationJson?.repository_selection ?? null,
      updated_at: installationJson?.updated_at ?? null,
    },
    summary: {
      passed: passed.length,
      failed: failed.length,
      total: checks.length,
      required_app_permissions: Object.keys(REQUIRED_APP_PERMISSIONS).length,
    },
    required: {
      app_permissions: REQUIRED_APP_PERMISSIONS,
      forbidden: ['workflows', 'members', 'organization_secrets', 'organization_personal_access_tokens', 'organization_self_hosted_runners', 'organization_custom_org_roles', 'actions', 'hooks', 'organization_plan'],
    },
    artifacts: {
      [APP_FILE]: artifactMeta(appPath, appJson),
      [INSTALLATION_FILE]: artifactMeta(installationPath, installationJson),
    },
    checks,
    next_steps: failed.length === 0
      ? [`attach github-app-permissions-check.json, ${APP_FILE}, and ${INSTALLATION_FILE} to #151, then close #151`]
      : ['fix the live GitHub App permissions, re-accept the installation, export GET /app again, then rerun this check'],
  }
}

export function formatSummary(receipt) {
  const lines = []
  lines.push(`${receipt.receipt_type}: ${receipt.status}`)
  lines.push(`checks: ${receipt.summary.passed}/${receipt.summary.total} passed`)
  if (receipt.app.slug) lines.push(`app: ${receipt.app.slug}`)
  if (receipt.status !== 'pass') {
    for (const check of receipt.checks.filter((entry) => entry.ok === false).slice(0, 12)) {
      lines.push(`FAIL ${check.check}${check.path ? ` ${basename(check.path)}` : ''}${check.permission ? ` ${check.permission}` : ''}`)
    }
  }
  return `${lines.join('\n')}\n`
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help || (!opts.plan && !opts.check && !opts.exportApp && !opts.exportGh)) {
    console.log(usage())
    return
  }
  if (opts.plan) {
    process.stdout.write(formatPlan(opts))
    return
  }
  if (opts.exportApp) {
    exportAppDefinition(opts)
      .then((result) => {
        console.log(JSON.stringify({
          ok: true,
          path: result.path,
          app: {
            slug: result.app.slug,
            id: result.app.id,
            html_url: result.app.html_url,
          },
          installation: {
            path: result.installationPath,
            id: result.installation.id,
            account: result.installation.account,
          },
          next_step: `run this script again with --check --installation-id ${result.installation.id} to validate both exports`,
        }, null, 2))
      })
      .catch((err) => {
        console.error(`github-app-permissions-receipt: ${err && err.message ? err.message : err}`)
        process.exitCode = 1
      })
    return
  }
  if (opts.exportGh) {
    exportGhAppDefinition(opts)
      .then((result) => {
        console.log(JSON.stringify({
          ok: true,
          path: result.path,
          source: result.source,
          app: {
            slug: result.app.slug,
            id: result.app.id,
            html_url: result.app.html_url,
          },
          installation: {
            path: result.installationPath,
            id: result.installation.id,
            account: result.installation.account,
          },
          next_step: `run this script again with --check --installation-id ${result.installation.id} to validate both exports`,
        }, null, 2))
      })
      .catch((err) => {
        console.error(`github-app-permissions-receipt: ${err && err.message ? err.message : err}`)
        process.exitCode = 1
      })
    return
  }
  const receipt = checkBundle(opts)
  if (opts.summary) process.stdout.write(formatSummary(receipt))
  else process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
  if (receipt.status !== 'pass') process.exitCode = 1
}

const entry = process.argv[1] ? resolve(process.argv[1]) : ''
if (entry && entry === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (err) {
    console.error(`github-app-permissions-receipt: ${err && err.message ? err.message : err}`)
    process.exitCode = 1
  }
}
