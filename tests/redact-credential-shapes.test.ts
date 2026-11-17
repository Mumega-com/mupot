import { describe, expect, it } from 'vitest'
import { redactSecretPatterns, redactStructuredDetail } from '../src/lib/redact'

const BODY = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7zZ9kQ1xYt3Lm'
const BODY2 = 'q8Rw2Vn5Hc0PdE4uJfXgB7sKaT1oYiZ6lMeNvC9rWbUh3DyAx8SjQ5tGkFpL2OnI'
const PEM = `-----BEGIN PRIVATE KEY-----\n${BODY}\n${BODY2}\n-----END PRIVATE KEY-----`

describe('redact: PEM-first ordering', () => {
  const prefixes = [
    'Bearer ', 'Basic ', 'Token ', 'Bot ', 'auth: ', 'Authorization: Bearer ',
    'password: ', 'password=', 'private_key=', 'private_key: ', 'token: ', 'deploy_token=', 'pwd=', '"private_key": "',
  ]
  for (const prefix of prefixes) {
    it(`removes a multi-line PEM after ${JSON.stringify(prefix)}`, () => {
      const out = redactSecretPatterns(`${prefix}${PEM}`)
      expect(out).not.toContain(BODY)
      expect(out).not.toContain(BODY2)
      expect(out).not.toContain('BEGIN')
    })
    it(`removes a PEM after ${JSON.stringify(prefix)} inside surrounding text`, () => {
      const out = redactSecretPatterns(`before ${prefix}${PEM} after`)
      expect(out).not.toContain(BODY)
      expect(out).not.toContain(BODY2)
    })
  }

  it('removes RSA, EC, OPENSSH and encrypted key blocks', () => {
    for (const kind of ['RSA ', 'EC ', 'OPENSSH ', 'ENCRYPTED ', '']) {
      const out = redactSecretPatterns(`-----BEGIN ${kind}PRIVATE KEY-----\n${BODY}\n-----END ${kind}PRIVATE KEY-----`)
      expect(out).not.toContain(BODY)
    }
  })

  it('removes an unterminated block', () => {
    const out = redactSecretPatterns(`password: -----BEGIN PRIVATE KEY-----\n${BODY}`)
    expect(out).not.toContain(BODY)
  })

  it('removes a PEM nested in structured detail', () => {
    const out = JSON.stringify(redactStructuredDetail({ note: `Bearer ${PEM}`, list: [`token: ${PEM}`] }))
    expect(out).not.toContain(BODY)
    expect(out).not.toContain(BODY2)
  })
})

describe('redact: scheme words in prose', () => {
  it('leaves prose unchanged', () => {
    for (const text of ['Add basic pagination', 'basic authentication', 'ApiKey required', 'ApiKey authentication-required', 'Basic paginationsettings', 'Basic configuration overview here', 'ApiKey rotation-2026-plan drafted', 'Add basic authentication/authorization checks']) {
      expect(redactSecretPatterns(text)).toBe(text)
    }
  })
})

describe('redact: audit-style strings', () => {
  it('passes a string with an ApiKey-like phrase through unchanged', () => {
    const text = 'ApiKey rotation-2026-q4 scheduled'
    expect(redactSecretPatterns(text)).toBe(text)
  })
})

describe('redact: pwd key', () => {
  it('redacts pwd= and pwd:', () => {
    expect(redactSecretPatterns('connect pwd=hunter2hunter2 ok')).not.toContain('hunter2hunter2')
    expect(redactSecretPatterns('db_pwd: hunter2hunter2')).not.toContain('hunter2hunter2')
    expect(redactSecretPatterns('https://x.test/?pwd=hunter2hunter2')).not.toContain('hunter2hunter2')
  })
  it('redacts the pwd key in structured detail', () => {
    expect(JSON.stringify(redactStructuredDetail({ pwd: 'hunter2hunter2' }))).not.toContain('hunter2hunter2')
  })
})

describe('redact: URL passwords', () => {
  it('redacts the password and keeps scheme, user and host', () => {
    const out = redactSecretPatterns('connect postgres://appuser:s3cr3tPassw0rd@db.example.com:5432/app failed')
    expect(out).not.toContain('s3cr3tPassw0rd')
    expect(out).toContain('postgres://appuser:')
    expect(out).toContain('@db.example.com:5432/app')
  })
  it('handles an empty user and other schemes', () => {
    expect(redactSecretPatterns('redis://:s3cr3tPassw0rd@cache.local')).not.toContain('s3cr3tPassw0rd')
    expect(redactSecretPatterns('https://bob:s3cr3tPassw0rd@x.test/a')).not.toContain('s3cr3tPassw0rd')
  })
  it('leaves URLs without a password unchanged', () => {
    for (const url of [
      'https://example.com/path?x=1',
      'https://user@example.com/path',
      'http://host.test:8080/a?email=a@b.co',
      'see https://example.com:443/docs for details',
    ]) {
      expect(redactSecretPatterns(url)).toBe(url)
    }
  })
})

describe('redact: ordinary text is unchanged', () => {
  it('does not alter plain prose', () => {
    for (const text of [
      'Request completed in 120ms',
      'basic usage of the api',
      'The key ring is in the drawer',
      'BEGIN the migration, END of file',
      'error: connection refused at 10.0.0.1:5432',
    ]) {
      expect(redactSecretPatterns(text)).toBe(text)
    }
  })
})

describe('redact: delimiters and structure', () => {
  it('removes a JSON password after a url field', () => {
    const out = redactSecretPatterns('{"url":"http://db:5432","password":"hunter@2025tail"}')
    expect(out).not.toContain('hunter')
    expect(out).not.toContain('2025tail')
    expect(out).toContain('http://db:5432')
  })
  it('keeps a url field followed by an email field intact', () => {
    const text = '{"url":"http://db:5432/x","email":"a@b.co"}'
    expect(redactSecretPatterns(text)).toBe(text)
  })
  it('handles an uppercase scheme', () => {
    expect(redactSecretPatterns('HTTPS://bob:s3cr3tPassw0rd@x.test/a')).not.toContain('s3cr3tPassw0rd')
  })
  it('removes a key glued to a PEM end marker', () => {
    const out = redactSecretPatterns(`${PEM}token:GLUEDSECRETVALUE`)
    expect(out).not.toContain('GLUEDSECRETVALUE')
    expect(out).not.toContain(BODY)
  })
  it('removes a PGP block private key', () => {
    const out = redactSecretPatterns(`-----BEGIN PGP PRIVATE KEY BLOCK-----\n${BODY}\n-----END PGP PRIVATE KEY BLOCK-----`)
    expect(out).not.toContain(BODY)
  })
  it('stays fast on large pathological input', () => {
    for (const unit of ['a.', 'com.example.', 'word-']) {
      const input = unit.repeat(Math.ceil(100_000 / unit.length))
      const start = performance.now()
      redactSecretPatterns(input)
      expect(performance.now() - start).toBeLessThan(50)
    }
  })
})
