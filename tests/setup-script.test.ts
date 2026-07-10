import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function fakeNpxScript() {
  return `#!/usr/bin/env bash
set -euo pipefail
args="$*"
printf '%s\\n' "$args" >> "$FAKE_NPX_LOG"

case "$args" in
  *" --version"*|*" whoami") exit 0 ;;
  *"d1 create"*) printf 'database_id = "11111111-1111-4111-8111-111111111111"\\n' ;;
  *"vectorize create"*|*"queues create"*|*"r2 bucket create"*|*"d1 migrations apply"*|*"secret put"*) printf 'ok\\n' ;;
  *"kv namespace create"*)
    if [[ "$args" == *"-sessions"* ]]; then
      printf 'id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\\n'
    else
      printf 'id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"\\n'
    fi
    ;;
  *) printf 'unexpected fake npx invocation: %s\\n' "$args" >&2; exit 1 ;;
esac
`
}

describe('per-pot setup script', () => {
  it('creates an isolated config and applies migrations through that config', () => {
    const temp = mkdtempSync(join(tmpdir(), 'mupot-setup-script-'))
    const fakeNpx = join(temp, 'npx')
    const log = join(temp, 'npx.log')
    const pot = `contract-${process.pid}`
    const config = join(repoRoot, `wrangler.${pot}.toml`)
    writeFileSync(fakeNpx, fakeNpxScript())
    chmodSync(fakeNpx, 0o755)

    try {
      execFileSync('bash', ['scripts/setup.sh', '--pot', pot], {
        cwd: repoRoot,
        env: { ...process.env, PATH: `${temp}:${process.env.PATH}`, FAKE_NPX_LOG: log },
        stdio: 'pipe',
      })

      const written = readFileSync(config, 'utf8')
      expect(written).toContain(`name = "mupot-${pot}"`)
      expect(written).toContain(`TENANT_SLUG = "${pot}"`)
      expect(written).toContain(`database_name = "mupot-${pot}"`)
      expect(written).toContain(`index_name = "mupot-${pot}-vec"`)
      expect(written).toContain(`queue = "mupot-${pot}-events"`)
      expect(written).toContain(`dead_letter_queue = "mupot-${pot}-events-dlq"`)
      expect(written).toContain(`bucket_name = "mupot-${pot}-blobs"`)
      expect(written).toContain(`name = "mupot-${pot}-task-workflow"`)
      expect(written).toContain('database_id = "11111111-1111-4111-8111-111111111111"')
      expect(written).toContain('id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"')
      expect(written).toContain('id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"')
      expect(written).not.toMatch(/database_id = "(?:<YOUR_D1_DATABASE_ID>|REPLACE_WITH_YOUR_D1_ID)"/)
      expect(written).not.toMatch(/id = "(?:<YOUR_SESSIONS_KV_ID>|<YOUR_OAUTH_KV_ID>|REPLACE_WITH_YOUR_KV_ID)"/)

      const calls = readFileSync(log, 'utf8')
      expect(calls).toContain(`d1 migrations apply mupot-${pot} --remote --config ${config}`)

      execFileSync('bash', ['scripts/secrets.sh', '--pot', pot], {
        cwd: repoRoot,
        env: { ...process.env, PATH: `${temp}:${process.env.PATH}`, FAKE_NPX_LOG: log },
        input: 'test-client-id\ntest-client-secret\n\n\n',
        stdio: 'pipe',
      })

      const callsAfterSecrets = readFileSync(log, 'utf8')
      expect(callsAfterSecrets).toContain(`secret put OAUTH_CLIENT_ID --config ${config}`)
      expect(callsAfterSecrets).toContain(`secret put OAUTH_CLIENT_SECRET --config ${config}`)
    } finally {
      rmSync(config, { force: true })
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('keeps the wrapper pointed at the automated per-pot path', () => {
    const wrapper = readFileSync(join(repoRoot, 'scripts/provision-pot.sh'), 'utf8')
    expect(wrapper).toContain('setup.sh" --pot "${POT}"')
  })

  it('exposes help without contacting Cloudflare', () => {
    const setupHelp = execFileSync('bash', ['scripts/setup.sh', '--help'], { cwd: repoRoot, encoding: 'utf8' })
    const secretsHelp = execFileSync('bash', ['scripts/secrets.sh', '--help'], { cwd: repoRoot, encoding: 'utf8' })
    expect(setupHelp).toContain('wrangler.<slug>.toml')
    expect(secretsHelp).toContain('wrangler.<slug>.toml')
  })
})
