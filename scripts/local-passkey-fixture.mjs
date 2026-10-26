// Ephemeral authenticator for the isolated local evidence database, never a deployed pot.
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const LOCAL_PASSKEY_HOST = 'passkeys.mupot.test'

export function createLocalPasskeyFixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const credentialId = randomBytes(32)
  const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
  return {
    publicKey: spki,
    credential: {
      credentialId: credentialId.toString('base64'),
      privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      rpId: LOCAL_PASSKEY_HOST, isResidentCredential: false, signCount: 0,
    },
    sql: `INSERT INTO human_login_identities
      (id, tenant, provider, provider_subject, verified_email, member_id)
      VALUES ('hli-local-browser-passkey', 'local', 'local-test', 'local-owner@mupot.test',
        'local-owner@mupot.test', 'mbr-local-owner');
    INSERT INTO member_passkeys
      (id, tenant, member_id, login_identity_id, credential_id, public_key, sign_count, transports, created_at)
      VALUES ('passkey-local-browser', 'local', 'mbr-local-owner', 'hli-local-browser-passkey',
        '${credentialId.toString('base64url')}', '${spki}', 0, '["internal"]', datetime('now'));`,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2]
  if (!directory) throw new Error('usage: local-passkey-fixture.mjs <isolated-state-directory>')
  const fixture = createLocalPasskeyFixture()
  writeFileSync(resolve(directory, 'passkey.sql'), fixture.sql, { mode: 0o600 })
  writeFileSync(resolve(directory, 'passkey.json'), JSON.stringify(fixture.credential), { mode: 0o600 })
}
