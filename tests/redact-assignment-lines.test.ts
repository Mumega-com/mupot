import { describe, expect, it } from 'vitest'
import { redactSecretPatterns } from '../src/lib/redact'

// Obviously fake values only.
const EOLS: Array<[string, string]> = [['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r']]

describe('redact: chained sensitive keys with empty values', () => {
  for (const [label, eol] of EOLS) {
    it(`${label}: 2-chain with indented value`, () => {
      const out = redactSecretPatterns(`password=${eol}token=${eol}  hunter2-fake`)
      expect(out).not.toContain('hunter2-fake')
    })
    it(`${label}: colon chain, unindented value`, () => {
      const out = redactSecretPatterns(`password:${eol}token:${eol}SECRET-fake`)
      expect(out).not.toContain('SECRET-fake')
    })
    it(`${label}: 4-chain`, () => {
      const out = redactSecretPatterns(`password=${eol}token=${eol}api_key=${eol}client_secret=${eol}\tdeep-fake-value`)
      expect(out).not.toContain('deep-fake-value')
    })
    it(`${label}: inner sensitive key with a same-line value`, () => {
      const out = redactSecretPatterns(`password=${eol}token=inner-fake-1${eol}secret: inner-fake-2`)
      expect(out).not.toContain('inner-fake-1')
      expect(out).not.toContain('inner-fake-2')
    })
    it(`${label}: quoted-JSON inner keys`, () => {
      const out = redactSecretPatterns(`"password":${eol}"token":${eol}  "json-fake-value"`)
      expect(out).not.toContain('json-fake-value')
      const out2 = redactSecretPatterns(`"secret":${eol}"token": "json-fake-2"`)
      expect(out2).not.toContain('json-fake-2')
    })
  }

  it('exact output for the chain case', () => {
    expect(redactSecretPatterns('password=\ntoken=\n  hunter2-fake')).toBe('password=\ntoken=\n  [redacted]')
  })

  it('inner sensitive head glued after a prefix on the next line is still scanned', () => {
    for (const [, eol] of EOLS) {
      const out = redactSecretPatterns(`db.password:${eol}AccountKey : ${eol}[x]api-key:${eol}  adm-fake:hunter-fake`)
      expect(out).not.toContain('hunter-fake')
      const out2 = redactSecretPatterns(`password=${eol}[x]token=${eol}  deep-fake-2`)
      expect(out2).not.toContain('deep-fake-2')
    }
  })

  it('a next line that is not a sensitive key head keeps whole-line behaviour', () => {
    expect(redactSecretPatterns('password=\nstatus=ok')).toBe('password=\n[redacted]')
    expect(redactSecretPatterns('password:\nhunter2-fake')).not.toContain('hunter2-fake')
    expect(redactSecretPatterns('password:\n\n  hunter2-fake')).not.toContain('hunter2-fake')
    expect(redactSecretPatterns('password: \n  hunter2-fake')).not.toContain('hunter2-fake')
  })
})

describe('redact: values continuing onto the next line stay redacted', () => {
  // Values shaped like `word:` / `word=` / URLs that a key-head exclusion would have let through.
  const shapes: Array<[string, string, string]> = [
    ['cookie fold', 'Cookie:\n  sid=fakesession123; theme=dark', 'fakesession123'],
    ['admin pair', 'credentials:\n  admin:FAKEpass99', 'FAKEpass99'],
    ['padded base64', 'AccountKey:\n  ZmFrZWFjY291bnRrZXkxMjM0NQ==', 'ZmFrZWFjY291bnRrZXkxMjM0NQ'],
    ['url', 'secret:\n  https://hooks.example.test/services/FAKE0/FAKE1/FAKEXYZ', 'FAKEXYZ'],
    ['quoted user:pass', 'password:\n  "user:FAKEpass"', 'FAKEpass'],
    ['quoted pair', "token:\n  'abc=fakedef'", 'fakedef'],
    ['tab dotted', 'token =\n\tFAKE.tok.en:part2', 'part2'],
    ['indented plain', 'password:\n  hunter2-fake', 'hunter2-fake'],
    ['tab plain', 'token=\n\tfake-tab-value', 'fake-tab-value'],
    ['json pretty', '"secret":\n  "fake-json-value"', 'fake-json-value'],
    ['trailing space', 'password: \n  hunter2-fake', 'hunter2-fake'],
    ['blank gap', 'password:\n\n  hunter2-fake', 'hunter2-fake'],
  ]
  for (const [name, input, secret] of shapes) {
    for (const [label, eol] of EOLS) {
      it(`${name} (${label})`, () => {
        expect(redactSecretPatterns(input.replace(/\n/g, eol))).not.toContain(secret)
      })
    }
  }
})

describe('redact: same-line behaviour', () => {
  it('two consecutive same-line values are both removed', () => {
    for (const [, eol] of EOLS) {
      const out = redactSecretPatterns(`password=FAKE-aaa${eol}token=FAKE-bbb`)
      expect(out).not.toContain('FAKE-aaa')
      expect(out).not.toContain('FAKE-bbb')
    }
  })
  it('handles a value at end of input', () => {
    expect(redactSecretPatterns('password=FAKE-aaa')).not.toContain('FAKE-aaa')
    expect(redactSecretPatterns('password=')).toBe('password=')
  })
  it('leaves ordinary prose unchanged', () => {
    const prose = 'The token was refreshed. Status: ok.\nNote: the password policy changed; see docs.\nTime: 10:30'
    expect(redactSecretPatterns(prose)).toBe(prose)
  })
})
