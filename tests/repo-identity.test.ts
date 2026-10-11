// tests/repo-identity.test.ts — repoIdentity / sameRepository (src/projects/urls.ts): every spelling of
// one repository folds to one identity, because the deploy policy refuses on a match and an
// unmatched spelling would be a bypass. Unsure cases must err toward MATCHING.

import { describe, expect, it } from 'vitest'
import { repoIdentity, sameRepository } from '../src/projects/urls'

const BASE = 'https://github.com/example-org/example-site'

describe('repoIdentity — spellings of the SAME GitHub repository all match', () => {
  const same: Array<[string, string]> = [
    ['plain', BASE],
    ['.git', `${BASE}.git`],
    ['.git/', `${BASE}.git/`],
    ['trailing slashes', `${BASE}///`],
    ['.git.git', `${BASE}.git.git`],
    ['.GIT mixed case', `${BASE}.GIT`],
    ['.git.git/', `${BASE}.git.git//`],
    ['host case', 'https://GitHub.COM/example-org/example-site'],
    ['path case', 'https://github.com/Example-Org/EXAMPLE-site'],
    ['trailing-dot host', 'https://github.com./example-org/example-site'],
    ['double trailing-dot host', 'https://github.com../example-org/example-site'],
    ['www host', 'https://www.github.com/example-org/example-site'],
    ['api host', 'https://api.github.com/repos/example-org/example-site'],
    ['codeload host', 'https://codeload.github.com/example-org/example-site/legacy.zip/refs/heads/main'],
    ['percent-encoded letter', 'https://github.com/example-org/%65xample-site'],
    ['percent-encoded dot git', 'https://github.com/example-org/example-site%2Egit'],
    ['encoded slash is a separator', 'https://github.com/example-org%2Fexample-site'],
    ['double-encoded slash', 'https://github.com/example-org%252Fexample-site'],
    ['percent-encoded host letter', 'https://%67ithub.com/example-org/example-site'],
    ['ssh scheme', 'ssh://git@github.com/example-org/example-site.git'],
    ['scp style', 'git@github.com:example-org/example-site.git'],
    ['userinfo', 'https://user:pass@github.com/example-org/example-site'],
    ['port', 'https://github.com:443/example-org/example-site'],
    ['http scheme', 'http://github.com/example-org/example-site'],
    ['/tree/main', `${BASE}/tree/main`],
    ['/tree/main/ with .git repo', `${BASE}.git/tree/main/`],
    ['query and fragment', `${BASE}?tab=readme#top`],
    ['backslashes', 'https://github.com\\example-org\\example-site'],
    ['surrounding whitespace', `  ${BASE}  `],
  ]
  for (const [label, url] of same) {
    it(`${label}: ${url}`, () => expect(sameRepository(url, BASE), url).toBe(true))
  }
})

describe('repoIdentity — different repositories do NOT match', () => {
  const different = [
    'https://github.com/example-org/other-site',
    'https://github.com/other-org/example-site',
    'https://github.com/example-org/example-site-2',
    'https://gitlab.com/example-org/example-site',
    'https://github.com.evil.test/example-org/example-site',
    'https://notgithub.com/example-org/example-site',
  ]
  for (const url of different) it(url, () => expect(sameRepository(url, BASE), url).toBe(false))
})

describe('repoIdentity — unsure errs toward MATCH', () => {
  it('an owner-only GitHub URL matches every repository of that owner (and not another owner)', () => {
    expect(sameRepository('https://github.com/example-org', BASE)).toBe(true)
    expect(sameRepository('https://github.com/example-org/', BASE)).toBe(true)
    expect(sameRepository('https://github.com/other-org', BASE)).toBe(false)
  })
  it('an unparseable value has no identity (the caller validates URLs first)', () => {
    expect(repoIdentity('not a url')).toBeNull()
    expect(repoIdentity('')).toBeNull()
    expect(repoIdentity(null)).toBeNull()
  })
})

describe('repoIdentity — non-GitHub hosts compare by host + path', () => {
  const base = 'https://git.example.com/org/site'
  for (const url of ['https://GIT.example.com/org/site/', 'https://git.example.com./org/site.git', 'https://git.example.com:8443/org/site.git.git', 'ssh://git@git.example.com/org/site.git', 'https://git.example.com/org/%73ite', 'ssh://git@git.example.com/org\\site.git']) {
    it(url, () => expect(sameRepository(url, base)).toBe(true))
  }
  it('a different path or host does not match', () => {
    expect(sameRepository('https://git.example.com/org/site2', base)).toBe(false)
    expect(sameRepository('https://git2.example.com/org/site', base)).toBe(false)
  })
})

describe('repoIdentity — a bad escape never undoes the folding of the rest, and is UNSURE (matches)', () => {
  const BASE = 'https://github.com/acme/widget'
  const bad = [
    'https://github.com/%61cme/widget/tree/%',
    'https://github.com/%61cme/widget/%zz',
    'https://github.com/%61cme/widget/%e0%a4%a',
    'https://github.com/%61cme/widget/tree/main/%',
    'https://github.com/acme/widget/%',
    'https://github.com/acme/%zzwidget',
    'https://github.com/%zz/%61cme/widget',
  ]
  for (const url of bad) {
    it(`${url} matches a GitHub project (refuse), whatever else it names`, () => {
      expect(repoIdentity(url)?.kind).toBe('github-unsure')
      expect(sameRepository(url, BASE)).toBe(true)
      expect(sameRepository(BASE, url)).toBe(true)
      expect(sameRepository(url, 'https://github.com/other/thing')).toBe(true) // coarse on purpose
      expect(sameRepository(url, 'https://gitlab.com/acme/widget')).toBe(false)
    })
  }
  it('a segment still changing after 3 passes is unsure too', () => {
    expect(repoIdentity('https://github.com/acme/wid%252525252567et')?.kind).toBe('github-unsure')
  })
  it('a clean URL is unaffected (precise identity, no false match)', () => {
    expect(repoIdentity(BASE)).toEqual({ kind: 'github', owner: 'acme', repo: 'widget' })
    expect(repoIdentity('https://github.com/%61cme/widget/tree/main')).toEqual({ kind: 'github', owner: 'acme', repo: 'widget' })
    expect(sameRepository('https://github.com/%61cme/widget/tree/main', 'https://github.com/other/thing')).toBe(false)
  })
  it('a non-GitHub host with a bad escape matches only that host', () => {
    const base = 'https://git.example.com/org/site'
    expect(sameRepository('https://git.example.com/%6frg/site/%zz', base)).toBe(true)
    expect(sameRepository('https://git.example.com/%6frg/site/%zz', 'https://git.example.com/another/repo')).toBe(true)
    expect(sameRepository('https://git.example.com/%6frg/site/%zz', 'https://other.example.com/org/site')).toBe(false)
  })
})
