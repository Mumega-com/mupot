import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAllDocuments } from 'yaml'
import { normalizeAgentProfile } from '../fleet-runtime/profile-contract.mjs'
import {
  KUBERNETES_AGENT_HOST_RECEIPT_TYPE,
  buildKubernetesAgentHostReceipt,
  parseArgs,
} from '../scripts/kubernetes-agent-host-receipt.mjs'

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

  it('emits a redacted passing receipt for an immutable rendered DME deployment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mupot-k8s-agent-host-'))
    const deployment = join(dir, 'deployment.yaml')
    const policy = join(dir, 'network-policy.yaml')
    const config = join(dir, 'config.json')
    const imageDigest = `sha256:${'a'.repeat(64)}`
    writeFileSync(deployment, readFileSync(deploymentPath, 'utf8').replace(
      'registry.example/mupot-agent-host-hermes:0.23.0',
      `registry.example/mupot-agent-host-hermes@${imageDigest}`,
    ))
    writeFileSync(policy, readFileSync(networkPolicyPath, 'utf8'))
    writeFileSync(config, readFileSync(configPath, 'utf8')
      .replace('replace-with-dme-project-id', 'dme-delivery-project')
      .replace('https://mupot.dme.example', 'https://pot.dme.example'))

    const receipt = buildKubernetesAgentHostReceipt({
      deploymentPath: deployment,
      networkPolicyPath: policy,
      configPath: config,
      expectedImageDigest: imageDigest,
    })

    expect(receipt).toMatchObject({
      receipt_type: KUBERNETES_AGENT_HOST_RECEIPT_TYPE,
      status: 'pass',
      target: {
        tenant: 'dme',
        project_id: 'dme-delivery-project',
        agent_id: 'dme-hermes-k8s',
        image_digest: imageDigest,
      },
    })
    expect(receipt.artifacts).toHaveLength(3)
    expect(receipt.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256))).toBe(true)
    expect(JSON.stringify(receipt)).not.toMatch(/agent-token|allowed_senders|\/usr\/local\/bin\/hermes/)
  })

  it('fails closed on mutable images, weakened policy, placeholders, and digest mismatch', () => {
    const mutable = buildKubernetesAgentHostReceipt({
      deploymentPath,
      networkPolicyPath,
      configPath,
      expectedImageDigest: `sha256:${'b'.repeat(64)}`,
    })
    expect(mutable.status).toBe('fail')
    expect(mutable.failure_codes).toEqual(expect.arrayContaining([
      'image_not_immutable',
      'project_placeholder',
      'image_digest_mismatch',
    ]))

    const dir = mkdtempSync(join(tmpdir(), 'mupot-k8s-agent-host-'))
    const weakPolicy = join(dir, 'network-policy.yaml')
    writeFileSync(weakPolicy, readFileSync(networkPolicyPath, 'utf8').replace('ingress: []', 'ingress:\n  - {}'))
    const weak = buildKubernetesAgentHostReceipt({
      deploymentPath,
      networkPolicyPath: weakPolicy,
      configPath,
    })
    expect(weak.failure_codes).toContain('ingress_not_denied')
  })

  it('fails when the Kubernetes inbox adds an unverified agent or legacy command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mupot-k8s-agent-host-'))
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    config.inbox.agents[0].command = 'sh -c unverified'
    config.inbox.agents.push({ agent_id: 'unverified-agent', command: 'true' })
    const configFile = join(dir, 'config.json')
    writeFileSync(configFile, JSON.stringify(config))

    const receipt = buildKubernetesAgentHostReceipt({
      deploymentPath,
      networkPolicyPath,
      configPath: configFile,
    })

    expect(receipt.failure_codes).toContain('inbox_config_invalid')
    expect(JSON.stringify(receipt)).not.toContain('sh -c unverified')
  })

  it('parses the receipt CLI without accepting credential arguments', () => {
    const opts = parseArgs([
      '--deployment', deploymentPath,
      '--network-policy', networkPolicyPath,
      '--config', configPath,
      '--image-digest', `sha256:${'c'.repeat(64)}`,
    ])
    expect(opts.expectedImageDigest).toBe(`sha256:${'c'.repeat(64)}`)
    expect(() => parseArgs(['--token', 'nope'])).toThrow(/unknown argument/)
  })
})
