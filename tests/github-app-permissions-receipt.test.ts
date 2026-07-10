import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CHECK_RECEIPT_TYPE,
  REQUIRED_APP_PERMISSIONS,
  checkBundle,
  createAppJwt,
  exportAppDefinition,
  formatPlan,
  parseArgs,
  redactAppDefinition,
} from '../scripts/github-app-permissions-receipt.mjs'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'mupot-github-app-permissions-'))
}

function writeApp(dir: string, permissions: Record<string, string> = REQUIRED_APP_PERMISSIONS) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'github-app.json'), JSON.stringify({
    id: 123456,
    slug: 'mupot',
    html_url: 'https://github.com/apps/mupot',
    permissions,
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

  it('exports a redacted github-app.json using an App private key', async () => {
    const dir = tempDir()
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const privateKeyFile = join(dir, 'app-key.pem')
    writeFileSync(privateKeyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }).toString())
    let auth = ''
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      auth = String((init?.headers as Record<string, string>).Authorization ?? '')
      return new Response(JSON.stringify({
        id: 123456,
        slug: 'mupot',
        name: 'mupot',
        html_url: 'https://github.com/apps/mupot',
        owner: { login: 'Mumega-com', id: 1, type: 'Organization', extra: 'drop' },
        permissions: REQUIRED_APP_PERMISSIONS,
        private_key: 'drop this field',
      }), { status: 200 })
    }) as unknown as typeof fetch

    const result = await exportAppDefinition({
      outDir: dir,
      app: 'mupot',
      appId: '123456',
      privateKeyFile,
      nowSeconds: 1_700_000_000,
    }, fetchImpl)

    expect(auth).toMatch(/^Bearer .+\..+\..+$/)
    const exported = JSON.parse(readFileSync(result.path, 'utf8'))
    expect(exported.slug).toBe('mupot')
    expect(exported.permissions).toEqual(REQUIRED_APP_PERMISSIONS)
    expect(exported.private_key).toBeUndefined()
    expect(exported.owner.extra).toBeUndefined()
  })

  it('passes when the App has only the v0.23 least-privilege set', () => {
    const dir = tempDir()
    writeApp(dir)

    const receipt = checkBundle({ outDir: dir, app: 'mupot' })

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

    const receipt = checkBundle({ outDir: dir, app: 'mupot' })

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

    const receipt = checkBundle({ outDir: dir, app: 'mupot' })

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

    const receipt = checkBundle({ outDir: dir, app: 'mupot' })

    expect(receipt.status).toBe('fail')
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      ok: false,
      check: 'github_app_slug_matches',
      expected: 'mupot',
      actual: 'wrong-app',
    }))
  })
})
