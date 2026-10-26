import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createLocalPasskeyFixture } from '../scripts/local-passkey-fixture.mjs'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

describe('local browser passkey fixture', () => {
  it('binds the virtual credential to the seeded owner and a live login identity', () => {
    const db = createSqliteD1()
    try {
      applyAllMigrations(db.sqlite)
      db.sqlite.exec(readFileSync(new URL('../scripts/local-test-seed.sql', import.meta.url), 'utf8'))
      const fixture = createLocalPasskeyFixture()
      db.sqlite.exec(fixture.sql)
      expect(db.sqlite.prepare(`SELECT p.member_id, p.credential_id, p.public_key, p.sign_count,
        i.provider, i.provider_subject, i.revoked_at FROM member_passkeys p
        JOIN human_login_identities i ON i.id = p.login_identity_id AND i.member_id = p.member_id`).get()).toEqual({
        member_id: 'mbr-local-owner', credential_id: Buffer.from(fixture.credential.credentialId, 'base64').toString('base64url'),
        public_key: fixture.publicKey, sign_count: 0, provider: 'local-test',
        provider_subject: 'local-owner@mupot.test', revoked_at: null,
      })
      const payload = Buffer.from('local smoke assertion')
      const key = createPrivateKey({ key: Buffer.from(fixture.credential.privateKey, 'base64'), format: 'der', type: 'pkcs8' })
      const pub = createPublicKey({ key: Buffer.from(fixture.publicKey, 'base64url'), format: 'der', type: 'spki' })
      expect(verify('sha256', payload, pub, sign('sha256', payload, key))).toBe(true)
      expect(fixture.credential.rpId).toBe('passkeys.mupot.test')
      expect(fixture.credential.signCount).toBe(0)
    } finally { db.close() }
  })

  it('creates a fresh key and credential for each isolated evidence run', () => {
    const a = createLocalPasskeyFixture()
    const b = createLocalPasskeyFixture()
    expect(a.publicKey).not.toBe(b.publicKey)
    expect(a.credential.credentialId).not.toBe(b.credential.credentialId)
  })
})
