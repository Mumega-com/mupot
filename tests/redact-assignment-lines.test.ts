import { describe, expect, it } from 'vitest'
import { redactSecretPatterns } from '../src/lib/redact'

// Obviously fake values only.
const A = 'FAKEVALUE-aaa-111'
const B = 'FAKEVALUE-bbb-222'
const C = 'FAKEVALUE-ccc-333'

describe('redact: assignment values stop at end of line', () => {
  const pairs: Array<[string, string, string]> = [
    ['equals', 'password=', 'token='],
    ['colon', 'password: ', 'token: '],
    ['json-ish', '"secret": "', '"token": "'],
  ]
  const close = (p: string): string => (p.endsWith('"') ? '"' : '')
  for (const [name, k1, k2] of pairs) {
    for (const eol of ['\n', '\r\n']) {
      const label = `${name} ${eol === '\n' ? 'LF' : 'CRLF'}`
      it(`${label}: both consecutive values are removed`, () => {
        const out = redactSecretPatterns(`${k1}${A}${close(k1)}${eol}${k2}${B}${close(k2)}`)
        expect(out).not.toContain(A)
        expect(out).not.toContain(B)
      })
      it(`${label}: empty first value does not hide the next line's key`, () => {
        const out = redactSecretPatterns(`${k1.replace(/"$/, '')}${eol}${k2}${B}${close(k2)}${eol}${k1}${C}${close(k1)}`)
        expect(out).not.toContain(B)
        expect(out).not.toContain(C)
        expect(out).toContain('token')
      })
      it(`${label}: key glued after ] is still redacted on the next line`, () => {
        const out = redactSecretPatterns(`[x]${k1.replace(/"$/, '')}${eol}[y]${k2}${B}${close(k2)}${eol}${k1}${C}${close(k1)}`)
        expect(out).not.toContain(B)
        expect(out).not.toContain(C)
      })
    }
  }

  it('keeps a non-sensitive next-line value intact', () => {
    for (const eol of ['\n', '\r\n']) {
      const out = redactSecretPatterns(`password=${eol}status=ok-visible${eol}token=${B}`)
      expect(out).toContain('status=ok-visible')
      expect(out).not.toContain(B)
    }
    const out2 = redactSecretPatterns(`password=${A}\nname: visible-name\ntoken: ${B}`)
    expect(out2).not.toContain(A)
    expect(out2).not.toContain(B)
    expect(out2).toContain('name: visible-name')
  })

  it('handles a value at end of input', () => {
    expect(redactSecretPatterns(`password=${A}`)).not.toContain(A)
    expect(redactSecretPatterns(`ok=1\ntoken: ${B}`)).not.toContain(B)
    expect(redactSecretPatterns('password=')).toBe('password=')
  })

  describe('indented continuation of an empty sensitive value', () => {
    const cases: Array<[string, string]> = [
      ['password:{E}  hunter2-fake', 'hunter2-fake'],
      ['token={E}\tfake-tab-value', 'fake-tab-value'],
      ['"secret":{E}  "fake-json-value"', 'fake-json-value'],
    ]
    for (const [tpl, secret] of cases) {
      for (const eol of ['\n', '\r\n']) {
        it(`redacts ${JSON.stringify(tpl)} with ${eol === '\n' ? 'LF' : 'CRLF'}`, () => {
          expect(redactSecretPatterns(tpl.replace('{E}', eol))).not.toContain(secret)
        })
      }
    }
    for (const eol of ['\n', '\r\n']) {
      it(`indented key head is its own head (${eol === '\n' ? 'LF' : 'CRLF'})`, () => {
        const out = redactSecretPatterns(`password:${eol}  token=fake2`)
        expect(out).not.toContain('fake2')
        expect(out).toContain('token')
      })
      it(`non-sensitive empty key leaves indented line intact (${eol === '\n' ? 'LF' : 'CRLF'})`, () => {
        const out = redactSecretPatterns(`name:${eol}  visible`)
        expect(out).toBe(`name:${eol}  visible`)
      })
    }
    it('does not continue onto a non-indented line', () => {
      expect(redactSecretPatterns('password:\nvisible-plain')).toBe('password:\nvisible-plain')
    })
  })

  it('leaves ordinary prose unchanged', () => {
    const prose = 'The token was refreshed. Status: ok.\nNote: the password policy changed; see docs.\nTime: 10:30'
    expect(redactSecretPatterns(prose)).toBe(prose)
  })
})
