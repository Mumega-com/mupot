import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface OrganismDecision {
  name: string
  decision: 'retire' | 'run'
  prior_yaml_status: string
  reason: string
}

interface OrganismsRegistry {
  decision: string
  path: string
  task_id: string
  github_issue: string
  archive_dir: string
  organisms: OrganismDecision[]
  scheduler_invariants: {
    organ_daemon_timer: string
    organ_daemon_service: string
    product_organism_cron: string
    mismatched_batch_invocation_forbidden: boolean
  }
}

const REQUIRED_ORGANISMS = [
  'dentalnearyou',
  'digid',
  'gaf',
  'letsbefrank',
  'musicalunicorn',
  'pecb',
  'prefrontal',
  'realm-of-patterns',
  'stemminds',
  'viamar',
] as const

const REGISTRY_URL = new URL('../docs/operations/organisms-decisions.json', import.meta.url)
const DECISION_DOC_URL = new URL(
  '../docs/operations/organisms-retirement-2026-08-04.md',
  import.meta.url,
)
const ARCHIVE_DIR = new URL('../docs/operations/archived-organisms/', import.meta.url)

function readRegistry(): OrganismsRegistry {
  return JSON.parse(readFileSync(REGISTRY_URL, 'utf8')) as OrganismsRegistry
}

describe('organisms redesign — path (c) retirement lock', () => {
  it('records path (c) retire for all ten product-organism configs', () => {
    const registry = readRegistry()

    expect(registry.path).toBe('c')
    expect(registry.decision).toBe('retire')
    expect(registry.task_id).toBe('938ca06d-ceda-458c-8399-e5cec398696b')
    expect(registry.github_issue).toContain('#595')

    const names = registry.organisms.map((organism) => organism.name).sort()
    expect(names).toEqual([...REQUIRED_ORGANISMS].sort())

    for (const organism of registry.organisms) {
      expect(organism.decision).toBe('retire')
      expect(organism.reason.length).toBeGreaterThan(10)
      expect(organism.prior_yaml_status.length).toBeGreaterThan(0)
    }

    expect(registry.scheduler_invariants.organ_daemon_timer).toBe('disabled')
    expect(registry.scheduler_invariants.organ_daemon_service).toBe('disabled')
    expect(registry.scheduler_invariants.product_organism_cron).toBe('removed')
    expect(registry.scheduler_invariants.mismatched_batch_invocation_forbidden).toBe(true)
  })

  it('archives each organism YAML beside the decision registry', () => {
    const registry = readRegistry()
    const archivePath = fileURLToPath(ARCHIVE_DIR)
    const archived = readdirSync(ARCHIVE_DIR).filter((name) => name.endsWith('.yaml')).sort()

    expect(registry.archive_dir).toBe('docs/operations/archived-organisms')
    expect(archivePath).toContain('docs/operations/archived-organisms')
    expect(archived).toEqual(REQUIRED_ORGANISMS.map((name) => `${name}.yaml`).sort())

    for (const name of REQUIRED_ORGANISMS) {
      const yaml = readFileSync(new URL(`${name}.yaml`, ARCHIVE_DIR), 'utf8')
      expect(yaml).toMatch(new RegExp(`^name:\\s*${name}\\b`, 'm'))
    }
  })

  it('decision doc rejects (a)/(b) and forbids mismatched batch scheduling', () => {
    const doc = readFileSync(DECISION_DOC_URL, 'utf8')

    expect(doc).toMatch(/path c|path \(c\)/i)
    expect(doc).toMatch(/explicit retirement/i)
    expect(doc).toContain('organ-daemon')
    expect(doc).toMatch(/Why not \(a\) or \(b\)/i)
    expect(doc).toMatch(/timeout=300|timeout of 300|300s/i)
    expect(doc).toMatch(/Do \*\*not\*\* schedule|must stay off|never organ-daemon/i)

    for (const name of REQUIRED_ORGANISMS) {
      expect(doc).toContain(name)
      expect(doc).toMatch(new RegExp(`${name}[\\s\\S]{0,120}?retire`, 'i'))
    }
  })

  it('keeps retired organ-daemon unit markers out of the active install path', () => {
    const retiredService = readFileSync(
      new URL('../deploy/retired/organ-daemon.service.retired', import.meta.url),
      'utf8',
    )
    const retiredTimer = readFileSync(
      new URL('../deploy/retired/organ-daemon.timer.retired', import.meta.url),
      'utf8',
    )
    const retiredReadme = readFileSync(
      new URL('../deploy/retired/README.md', import.meta.url),
      'utf8',
    )

    expect(retiredService).toMatch(/RETIRED/)
    expect(retiredService).toContain('timeout=300')
    expect(retiredTimer).toMatch(/RETIRED/)
    expect(retiredReadme).toMatch(/Do not enable/i)
    expect(retiredReadme).toContain('organisms-retirement-2026-08-04.md')
  })
})
