import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const runbook = readFileSync(new URL('../docs/production-runbook.md', import.meta.url), 'utf8')
const selfHost = readFileSync(new URL('../docs/SELF-HOST.md', import.meta.url), 'utf8')
const setup = readFileSync(new URL('../scripts/setup.sh', import.meta.url), 'utf8')
const provisionPot = readFileSync(new URL('../scripts/provision-pot.sh', import.meta.url), 'utf8')

describe('production self-hosting runbook', () => {
  it('is discoverable from the short self-hosting guide', () => {
    expect(selfHost).toContain('./production-runbook.md')
    expect(selfHost).toContain('`OAUTH_KV`')
  })

  it('documents every production binding required by the Worker config', () => {
    for (const binding of [
      'DB',
      'VEC',
      'BUS',
      'SESSIONS',
      'OAUTH_KV',
      'BLOBS',
      'AI',
      'AGENT',
      'SQUAD',
      'TASK_WORKFLOW',
    ]) {
      expect(runbook).toContain(`\`${binding}\``)
    }
  })

  it('covers deploy, upgrade, rollback, backup, restore, validation, and incidents', () => {
    for (const heading of [
      '## Initial deploy',
      '## Upgrade path',
      '## Backup',
      '## Restore',
      '## Rollback',
      '## Validation',
      '## Incident response',
    ]) {
      expect(runbook).toContain(heading)
    }
  })

  it('names safe explicit commands for production operations', () => {
    for (const command of [
      'scripts/provision-pot.sh "$POT"',
      'npx wrangler deploy --dry-run --config "$CONFIG"',
      'npx wrangler d1 migrations apply "$DB" --remote --config "$CONFIG"',
      'node scripts/mupot-update.mjs "$POT"',
      'npx wrangler d1 export "$DB" --remote --config "$CONFIG"',
      'npx wrangler d1 execute "$RESTORE_DB" --remote --config "$RESTORE_CONFIG" --file "$BACKUP_DIR/d1.sql" --yes',
      'npx wrangler rollback <VERSION_ID> --config "$CONFIG"',
      'npx wrangler secret list --config "$CONFIG"',
      'npx wrangler r2 object get "${BUCKET}/path/to/object" --remote --file "$BACKUP_DIR/r2/path/to/object"',
      'aws s3 sync "s3://${BUCKET}"',
    ]) {
      expect(runbook).toContain(command)
    }
  })

  it('separates local/dev validation from production validation', () => {
    expect(runbook).toContain('Local/dev validation proves the code path in the local test config')
    expect(runbook).toContain('Production validation proves the deployed pot and its real bindings')
    expect(runbook).toContain('npm run smoke:local')
    expect(runbook).toContain('curl -fsS "$BASE_URL/health"')
    expect(runbook).toContain('npx wrangler tail "$WORKER"')
  })

  it('covers the named incident classes from the tracker', () => {
    for (const incident of [
      '### Leaked Worker secret',
      '### Compromised runtime host',
      '### Broken webhooks',
      '### Bad agent output',
    ]) {
      expect(runbook).toContain(incident)
    }
  })
})

describe('self-hosting provisioning scripts', () => {
  it('bootstrap setup copies the checked-in template and provisions both KV bindings', () => {
    expect(setup).toContain('wrangler.example.toml')
    expect(setup).toContain('OAUTH_KV')
    expect(setup).toContain('<YOUR_OAUTH_KV_ID>')
  })

  it('per-pot provisioning points fresh operators at wrangler.example.toml and OAUTH_KV', () => {
    expect(provisionPot).toContain('cp wrangler.example.toml wrangler.${POT}.toml')
    expect(provisionPot).toContain('mupot-${POT}-oauth')
    expect(provisionPot).toContain('GOOGLE_CLIENT_ID')
  })
})
