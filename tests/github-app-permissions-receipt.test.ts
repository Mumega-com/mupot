import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  APP_FILE,
  CHECK_RECEIPT_TYPE,
  INSTALLATION_FILE,
  REQUIRED_APP_PERMISSIONS,
  checkBundle,
  createAppJwt,
  exportAppDefinition,
  formatPlan,
  parseArgs,
  redactAppDefinition,
  redactInstallationDefinition,
} from '../scripts/github-app-permissions-receipt.mjs'

const INSTALLATION_ID = '789012'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'mupot-github-app-permissions-'))
}

function writeApp(
  dir: string,
  permissions: Record<string, unknown> = REQUIRED_APP_PERMISSIONS,
  installationPermissions: Record<string, unknown> = permissions,
) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, APP_FILE), JSON.stringify({
    id: 123456,
    slug: 'mupot',
    html_url: 'https://github.com/apps/mupot',
    owner: { login: 'Mumega-com', id: 999, type: 'Organization' },
    permissions,
  }, null, 2))
  writeFileSync(join(dir, INSTALLATION_FILE), JSON.stringify({
    id: Number(INSTALLATION_ID),
    app_id: 123456,
    app_slug: 'mupot',
    account: { login: 'Mumega-com', id: 999, type: 'Organization' },
    repository_selection: 'all',
    permissions: installationPermissions,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-10T00:00:00.000Z',
    suspended_at: null,
  }, null, 2))
}

describe('GitHub App permissions receipt checker', () => {
  it('parses plan and check arguments', () => {
    expect(parseArgs(['--plan', '--app', 'mupot']).plan).toBe(true)
    expect(parseArgs(['--check', '--out-dir', './tmp/github-app-permissions/mupot']).check).toBe(true)
    const exportOpts = parseArgs(['--export-app', '--app-id', '123', '--private-key-file', './key.pem'])
    expect(exportOpts.exportApp).toBe(true)
    expect(exportOpts.appId).toBe('123')
  })

  it('prints the #151 evidence plan', () => {
    const plan = formatPlan({
      outDir: 'tmp/github-app-permissions/mupot',
      app: 'mupot',
    })

    expect(plan).toContain('Mupot v0.23 GitHub App least-privilege evidence plan')
    expect(plan).toContain('GET /app')
    expect(plan).toContain('--export-app')
    expect(plan).toContain('github-app.json')
    expect(plan).toContain('github-installation.json')
    expect(plan).toContain('--installation-id')
    expect(plan).toContain('github-app-permissions-check.json')
    expect(plan).toContain('workflows: none')
  })

  it('creates an App JWT with bounded lifetime', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    const now = 1_700_000_000
    const jwt = createAppJwt('123456', pem, now)
    const parts = jwt.split('.')
    expect(parts).toHaveLength(3)
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'))

    expect(payload.iss).toBe('123456')
    expect(payload.iat).toBe(now - 60)
    expect(payload.exp).toBe(now + 8 * 60)
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600)
  })

  it('redacts a raw GitHub App definition to safe evidence fields', () => {
    const redacted = redactAppDefinition({
      id: 123456,
      slug: 'mupot',
      name: 'mupot',
      html_url: 'https://github.com/apps/mupot',
      pem: 'do not keep',
      owner: {
        login: 'Mumega-com',
        id: 999,
        type: 'Organization',
        private_email: 'hidden@example.test',
      },
      permissions: REQUIRED_APP_PERMISSIONS,
    })

    expect(redacted).toEqual({
      id: 123456,
      slug: 'mupot',
      name: 'mupot',
      html_url: 'https://github.com/apps/mupot',
      owner: {
        login: 'Mumega-com',
        id: 999,
        type: 'Organization',
      },
      permissions: REQUIRED_APP_PERMISSIONS,
    })
  })

  it('redacts an installed App to safe effective-permission evidence', () => {
    const redacted = redactInstallationDefinition({
      id: Number(INSTALLATION_ID),
      app_id: 123456,
      app_slug: 'mupot',
      target_id: 999,
      target_type: 'Organization',
      repository_selection: 'all',
      account: { login: 'Mumega-com', id: 999, type: 'Organization', private_email: 'drop' },
      permissions: REQUIRED_APP_PERMISSIONS,
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-10T00:00:00.000Z',
      suspended_at: null,
      access_tokens_url: 'drop',
    })

    expect(redacted).toEqual({
      id: Number(INSTALLATION_ID),
      app_id: 123456,
      app_slug: 'mupot',
      target_id: 999,
      target_type: 'Organization',
      repository_selection: 'all',
      account: { login: 'Mumega-com', id: 999, type: 'Organization' },
      permissions: REQUIRED_APP_PERMISSIONS,
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-10T00:00:00.000Z',
      suspended_at: null,
    })
  })

  it('exports a redacted github-app.json using an App private key', async () => {
    const dir = tempDir()
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const privateKeyFile = join(dir, 'app-key.pem')
    writeFileSync(privateKeyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }).toString())
    const calls: Array<{ url: string, auth: string }> = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const requestedUrl = String(url)
      calls.push({
        url: requestedUrl,
        auth: String((init?.headers as Record<string, string>).Authorization ?? ''),
      })
      const payload = requestedUrl.endsWith(`/app/installations/${INSTALLATION_ID}`)
        ? {
            id: Number(INSTALLATION_ID),
            app_id: 123456,
            app_slug: 'mupot',
            account: { login: 'Mumega-com', id: 999, type: 'Organization', extra: 'drop' },
            repository_selection: 'all',
            permissions: REQUIRED_APP_PERMISSIONS,
            created_at: '2026-07-01T00:00:00.000Z',
            updated_at: '2026-07-10T00:00:00.000Z',
            suspended_at: null,
          }
        : {
            id: 123456,
            slug: 'mupot',
            name: 'mupot',
            html_url: 'https://github.com/apps/mupot',
            owner: { login: 'Mumega-com', id: 1, type: 'Organization', extra: 'drop' },
            permissions: REQUIRED_APP_PERMISSIONS,
            private_key: 'drop this field',
          }
      return new Response(JSON.stringify(payload), { status: 200 })
    }) as unknown as typeof fetch

    const result = await exportAppDefinition({
      outDir: dir,
      app: 'mupot',
      appId: '123456',
      installationId: INSTALLATION_ID,
      privateKeyFile,
      nowSeconds: 1_700_000_000,
    }, fetchImpl)

    expect(calls).toHaveLength(2)
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.github.com/app',
      `https://api.github.com/app/installations/${INSTALLATION_ID}`,
    ])
    expect(calls.every((call) => /^Bearer .+\..+\..+$/.test(call.auth))).toBe(true)
    const exported = JSON.parse(readFileSync(result.path, 'utf8'))
    expect(exported.slug).toBe('mupot')
    expect(exported.permissions).toEqual(REQUIRED_APP_PERMISSIONS)
    expect(exported.private_key).toBeUndefined()
    expect(exported.owner.extra).toBeUndefined()
    const installation = JSON.parse(readFileSync(result.installationPath, 'utf8'))
    expect(installation.id).toBe(Number(INSTALLATION_ID))
    expect(installation.permissions).toEqual(REQUIRED_APP_PERMISSIONS)
    expect(installation.account.extra).toBeUndefined()
  })

  it('passes when the App has only the v0.23 least-privilege set', () => {
    const dir = tempDir()
    writeApp(dir)

    const receipt = checkBundle({ outDir: dir, app: 'mupot', installationId: INSTALLATION_ID })

    expect(receipt.receipt_type).toBe(CHECK_RECEIPT_TYPE)
    expect(receipt.status).toBe('pass')
    expect(receipt.summary.required_app_permissions).toBe(Object.keys(REQUIRED_APP_PERMISSIONS).length)
  })

  it('fails when workflows permission is still enabled', () => {
    const dir = tempDir()
    writeApp(dir, {
      ...REQUIRED_APP_PERMISSIONS,
      workflows: 'write',
    })

    const receipt = checkBundle({ outDir: dir, app: 'mupot', installationId: INSTALLATION_ID })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'github_app_workflows_disabled',
      actual: 'write',
    }))
  })

  it('fails when extra organization admin permissions are present', () => {
    const dir = tempDir()
    writeApp(dir, {
      ...REQUIRED_APP_PERMISSIONS,
      organization_secrets: 'write',
    })

    const receipt = checkBundle({ outDir: dir, app: 'mupot', installationId: INSTALLATION_ID })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'github_app_has_no_extra_permissions',
      extras: [{ permission: 'organization_secrets', actual: 'write' }],
    }))
  })

  it('fails when the exported App slug is not the expected App', () => {
    const dir = tempDir()
    writeApp(dir)
    writeFileSync(join(dir, 'github-app.json'), JSON.stringify({
      id: 654321,
      slug: 'wrong-app',
      permissions: REQUIRED_APP_PERMISSIONS,
    }, null, 2))

    const receipt = checkBundle({ outDir: dir, app: 'mupot', installationId: INSTALLATION_ID })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'github_app_slug_matches',
      expected: 'mupot',
      actual: 'wrong-app',
    }))
  })

  it('rejects unknown and explicitly disabled extra permission entries', () => {
    const dir = tempDir()
    writeApp(dir, {
      ...REQUIRED_APP_PERMISSIONS,
      workflows: 'admin',
      members: 'none',
    })

    const receipt = checkBundle({ outDir: dir, app: 'mupot', installationId: INSTALLATION_ID })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ ok: false, check: 'github_app_permission_values_valid' }),
      expect.objectContaining({ ok: false, check: 'github_app_workflows_disabled', actual: 'admin' }),
      expect.objectContaining({ ok: false, check: 'github_app_has_no_extra_permissions' }),
    ]))
  })

  it('fails when the installed App retained broader effective permissions', () => {
    const dir = tempDir()
    writeApp(dir, REQUIRED_APP_PERMISSIONS, {
      ...REQUIRED_APP_PERMISSIONS,
      organization_secrets: 'write',
    })

    const receipt = checkBundle({ outDir: dir, app: 'mupot', installationId: INSTALLATION_ID })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'github_installation_has_no_extra_permissions',
      extras: [{ permission: 'organization_secrets', actual: 'write' }],
    }))
  })

  it('fails when the installed App identity does not match the requested installation', () => {
    const dir = tempDir()
    writeApp(dir)
    const installation = JSON.parse(readFileSync(join(dir, INSTALLATION_FILE), 'utf8'))
    installation.id = 42
    writeFileSync(join(dir, INSTALLATION_FILE), JSON.stringify(installation, null, 2))

    const receipt = checkBundle({ outDir: dir, app: 'mupot', installationId: INSTALLATION_ID })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'github_installation_id_matches',
      expected: INSTALLATION_ID,
      actual: 42,
    }))
  })

  it('rejects raw unredacted GitHub API exports', () => {
    const dir = tempDir()
    writeApp(dir)
    const installation = JSON.parse(readFileSync(join(dir, INSTALLATION_FILE), 'utf8'))
    installation.access_tokens_url = 'https://api.github.test/installations/789012/access_tokens'
    installation.account.private_email = 'hidden@example.test'
    writeFileSync(join(dir, INSTALLATION_FILE), JSON.stringify(installation, null, 2))

    const receipt = checkBundle({ outDir: dir, app: 'mupot', installationId: INSTALLATION_ID })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'github_installation_export_redacted',
      extra_fields: ['access_tokens_url'],
      account_extra_fields: ['private_email'],
    }))
  })
})
