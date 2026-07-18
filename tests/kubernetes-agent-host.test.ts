import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAllDocuments } from 'yaml'
import { normalizeAgentProfile } from '../fleet-runtime/profile-contract.mjs'

const ROOT = join(__dirname, '..')
const deploymentPath = join(ROOT, 'deploy/kubernetes/agent-host/deployment.yaml')
const networkPolicyPath = join(ROOT, 'deploy/kubernetes/agent-host/network-policy.yaml')
const configPath = join(ROOT, 'deploy/kubernetes/agent-host/config.example.json')
const dockerfilePath = join(ROOT, 'fleet-runtime/Dockerfile.agent-host')

function documents(path: string): Array<Record<string, any>> {
  return parseAllDocuments(readFileSync(path, 'utf8')).map((document) => document.toJSON())
}

describe('Kubernetes Agent Host deployment contract', () => {
  it('runs one non-root read-only host container with bounded resources and health probes', () => {
    const deployment = documents(deploymentPath).find((doc) => doc.kind === 'Deployment')!
    const pod = deployment.spec.template.spec
    const container = pod.containers[0]

    expect(pod.containers).toHaveLength(1)
    expect(pod.automountServiceAccountToken).toBe(false)
    expect(pod.securityContext.runAsNonRoot).toBe(true)
    expect(container.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      capabilities: { drop: ['ALL'] },
    })
    expect(container.resources.requests).toMatchObject({ cpu: expect.any(String), memory: expect.any(String) })
    expect(container.resources.limits).toMatchObject({ cpu: expect.any(String), memory: expect.any(String) })
    expect(container.livenessProbe.httpGet.path).toBe('/live')
    expect(container.readinessProbe.httpGet.path).toBe('/ready')
    expect(container.command).toEqual(['/usr/local/bin/node', '/opt/mupot/container-entrypoint.mjs'])
  })

  it('references a DME-owned Secret and never embeds credential material', () => {
    const source = readFileSync(deploymentPath, 'utf8')
    const deployment = documents(deploymentPath).find((doc) => doc.kind === 'Deployment')!
    const secret = deployment.spec.template.spec.volumes.find((volume: any) => volume.name === 'agent-credential')

    expect(secret.secret.secretName).toBe('dme-hermes-mupot')
    expect(source).not.toMatch(/Bearer\s+\S+|private[_-]?key\s*:/i)
    expect(source).not.toMatch(/\bmupot_[a-z0-9_-]{16,}\b/)
    expect(source).not.toContain('mupot.mumega.com')
  })

  it('allows egress only to cluster DNS and a labeled trusted egress gateway', () => {
    const policy = documents(networkPolicyPath).find((doc) => doc.kind === 'NetworkPolicy')!
    expect(policy.spec.policyTypes).toEqual(['Ingress', 'Egress'])
    expect(policy.spec.ingress).toEqual([])
    expect(policy.spec.egress).toHaveLength(2)
    expect(JSON.stringify(policy.spec.egress)).toContain('trusted-egress')
    expect(JSON.stringify(policy.spec.egress)).not.toContain('0.0.0.0/0')
  })

  it('ships a sterile project-bound Hermes profile with no token values', () => {
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(config.tenant).toBe('dme')
    expect(config.project_id).toBe('replace-with-dme-project-id')
    expect(normalizeAgentProfile(config.inbox.agents[0].profile)).not.toBeNull()
    expect(JSON.stringify(config)).not.toMatch(/Bearer\s+\S+|mupot_[A-Za-z0-9_-]{8,}/i)
  })

  it('builds the Agent Host runtime as an unprivileged credential-free base image', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf8')
    expect(dockerfile).toContain('USER 10001:10001')
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/node", "/opt/mupot/container-entrypoint.mjs"]')
    expect(dockerfile).not.toMatch(/COPY\s+.*(?:token|secret|credential|\.env)/i)
    expect(dockerfile).not.toMatch(/Bearer\s+\S+/i)
  })
})
