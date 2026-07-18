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
    const pod = deployment.spec.template.spec
    const container = pod.containers[0]
    const secret = pod.volumes.find((volume: any) => volume.name === 'agent-signing-key')

    expect(pod.securityContext).toMatchObject({ runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001 })

    expect(secret.secret).toMatchObject({
      secretName: 'dme-hermes-signing-key',
      defaultMode: 0o440,
      items: [{ key: 'dme-hermes-k8s.key', path: 'dme-hermes-k8s.key' }],
    })
    expect(container.volumeMounts).toContainEqual(expect.objectContaining({
      name: 'agent-signing-key',
      mountPath: '/home/mupot/.fleet/agents',
      readOnly: true,
    }))
    expect(container.env).toContainEqual({ name: 'HOME', value: '/home/mupot' })
    expect(container.env.map((entry: any) => entry.name)).not.toContain('MUPOT_CONTROL_CONFIG')
    expect(source).not.toMatch(/Bearer\s+\S+|private[_-]?key\s*:/i)
    expect(source).not.toMatch(/\bmupot_[a-z0-9_-]{16,}\b/)
    expect(source).not.toContain('mupot.mumega.com')
  })

  it('mounts the exact daemon and inbox configs consumed by the on-demand runtime', () => {
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    const configMap = documents(deploymentPath).find((doc) => doc.kind === 'ConfigMap')!
    const daemon = JSON.parse(configMap.data['daemon.json'])
    const inbox = JSON.parse(configMap.data['inbox-handler.json'])

    expect(config.credential_file).toBeUndefined()
    expect(daemon).toEqual(config.daemon)
    expect(inbox).toEqual(config.inbox)
    expect(daemon.agents[0]).toMatchObject({
      agent_id: 'dme-hermes-k8s',
      lifecycle: 'on_demand',
      inbox: {
        command: 'node /opt/mupot/inbox-handler.mjs /etc/mupot/inbox-handler.json',
      },
    })
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
    const profile = normalizeAgentProfile(config.inbox.agents[0].profile)
    expect(profile?.allowed_project_ids).toEqual([config.project_id])
    expect(config.daemon.base_url).toBe(config.base_url)
    expect(config.daemon.tenant).toBe(config.tenant)
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
    writeFileSync(deployment, readFileSync(deploymentPath, 'utf8')
      .replace('registry.example/mupot-agent-host-hermes:0.23.0', `registry.example/mupot-agent-host-hermes@${imageDigest}`)
      .replaceAll('replace-with-dme-project-id', 'dme-delivery-project')
      .replaceAll('https://mupot.dme.example', 'https://pot.dme.example'))
    writeFileSync(policy, readFileSync(networkPolicyPath, 'utf8'))
    writeFileSync(config, readFileSync(configPath, 'utf8')
      .replaceAll('replace-with-dme-project-id', 'dme-delivery-project')
      .replaceAll('https://mupot.dme.example', 'https://pot.dme.example'))

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

  it('fails when the trusted Kubernetes key group differs from runtime GID 10001', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mupot-k8s-agent-host-'))
    const deployment = join(dir, 'deployment.yaml')
    writeFileSync(deployment, readFileSync(deploymentPath, 'utf8').replace('runAsGroup: 10001', 'runAsGroup: 20001'))

    const receipt = buildKubernetesAgentHostReceipt({ deploymentPath: deployment, networkPolicyPath, configPath })

    expect(receipt.failure_codes).toContain('key_permission_model_invalid')
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

  it('fails when the declared project differs from the enforced profile project', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mupot-k8s-agent-host-'))
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    config.project_id = 'declared-project'
    config.inbox.agents[0].profile.allowed_project_ids = ['different-project']
    const configFile = join(dir, 'config.json')
    writeFileSync(configFile, JSON.stringify(config))

    const receipt = buildKubernetesAgentHostReceipt({
      deploymentPath,
      networkPolicyPath,
      configPath: configFile,
    })

    expect(receipt.failure_codes).toContain('project_policy_mismatch')
    expect(receipt.target.project_id).toBeNull()
  })

  it('recursively rejects private JWKs and credential-bearing fields without exposing values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mupot-k8s-agent-host-'))
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    const privateScalar = 'private-scalar-must-not-appear'
    const passwordValue = 'password-value-must-not-appear'
    config.inbox.agents[0].profile.metadata = {
      nested: [{ signing: { kty: 'OKP', crv: 'Ed25519', d: privateScalar, x: 'public' } }],
      database_password: passwordValue,
    }
    const configFile = join(dir, 'config.json')
    writeFileSync(configFile, JSON.stringify(config))

    const receipt = buildKubernetesAgentHostReceipt({
      deploymentPath,
      networkPolicyPath,
      configPath: configFile,
    })
    const serialized = JSON.stringify(receipt)

    expect(receipt.failure_codes).toContain('config_schema_invalid')
    expect(receipt.failure_codes).toContain('literal_credential_found')
    expect(serialized).not.toContain(privateScalar)
    expect(serialized).not.toContain(passwordValue)
  })

  it('rejects extra keys at every rendered config boundary', () => {
    const mutators = [
      (config: any) => { config.unexpected = true },
      (config: any) => { config.daemon.unexpected = true },
      (config: any) => { config.daemon.agents[0].unexpected = true },
      (config: any) => { config.daemon.agents[0].inbox.unexpected = true },
      (config: any) => { config.inbox.unexpected = true },
      (config: any) => { config.inbox.agents[0].unexpected = true },
    ]

    for (const mutate of mutators) {
      const dir = mkdtempSync(join(tmpdir(), 'mupot-k8s-agent-host-'))
      const config = JSON.parse(readFileSync(configPath, 'utf8'))
      mutate(config)
      const configFile = join(dir, 'config.json')
      writeFileSync(configFile, JSON.stringify(config))
      const receipt = buildKubernetesAgentHostReceipt({ deploymentPath, networkPolicyPath, configPath: configFile })
      expect(receipt.failure_codes).toContain('config_schema_invalid')
    }
  })

  it('recursively rejects a private JWK in an extra rendered ConfigMap entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mupot-k8s-agent-host-'))
    const deployment = join(dir, 'deployment.yaml')
    const privateScalar = 'rendered-private-scalar-must-not-appear'
    writeFileSync(
      deployment,
      readFileSync(deploymentPath, 'utf8').replace(
        '  daemon.json: |',
        `  extra.json: |\n    {"nested":{"kty":"OKP","crv":"Ed25519","d":"${privateScalar}","x":"public"}}\n  daemon.json: |`,
      ),
    )

    const receipt = buildKubernetesAgentHostReceipt({ deploymentPath: deployment, networkPolicyPath, configPath })
    const serialized = JSON.stringify(receipt)

    expect(receipt.failure_codes).toContain('config_schema_invalid')
    expect(receipt.failure_codes).toContain('literal_credential_found')
    expect(serialized).not.toContain(privateScalar)
  })

  it('recursively rejects an embedded private JWK in any rendered Kubernetes document', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mupot-k8s-agent-host-'))
    const deployment = join(dir, 'deployment.yaml')
    const privateScalar = 'deployment-private-scalar-must-not-appear'
    writeFileSync(
      deployment,
      readFileSync(deploymentPath, 'utf8').replace(
        `kind: Deployment\nmetadata:\n  name: dme-hermes-agent-host`,
        `kind: Deployment\nmetadata:\n  name: dme-hermes-agent-host\n  annotations:\n    opaque: '{"kty":"OKP","crv":"Ed25519","d":"${privateScalar}","x":"public"}'`,
      ),
    )

    const receipt = buildKubernetesAgentHostReceipt({ deploymentPath: deployment, networkPolicyPath, configPath })

    expect(receipt.failure_codes).toContain('literal_credential_found')
    expect(JSON.stringify(receipt)).not.toContain(privateScalar)
  })

  it('rejects unapproved container environment entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mupot-k8s-agent-host-'))
    const deployment = join(dir, 'deployment.yaml')
    const secretScalar = 'opaque-environment-value-must-not-appear'
    writeFileSync(
      deployment,
      readFileSync(deploymentPath, 'utf8').replace(
        `          env:\n            - name: HOME`,
        `          env:\n            - name: API_TOKEN\n              value: ${secretScalar}\n            - name: HOME`,
      ),
    )

    const receipt = buildKubernetesAgentHostReceipt({ deploymentPath: deployment, networkPolicyPath, configPath })

    expect(receipt.failure_codes).toEqual(expect.arrayContaining([
      'runtime_paths_invalid',
      'literal_credential_found',
    ]))
    expect(JSON.stringify(receipt)).not.toContain(secretScalar)
  })

  it('rejects credential data in an additional rendered Kubernetes Secret', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mupot-k8s-agent-host-'))
    const deployment = join(dir, 'deployment.yaml')
    const secretScalar = 'rendered-secret-value-must-not-appear'
    writeFileSync(
      deployment,
      `${readFileSync(deploymentPath, 'utf8')}\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: forbidden-inline-secret\nstringData:\n  API_KEY: ${secretScalar}\n`,
    )

    const receipt = buildKubernetesAgentHostReceipt({ deploymentPath: deployment, networkPolicyPath, configPath })

    expect(receipt.failure_codes).toEqual(expect.arrayContaining([
      'deployment_invalid',
      'config_map_invalid',
      'literal_credential_found',
    ]))
    expect(JSON.stringify(receipt)).not.toContain(secretScalar)
  })

  it('normalizes camelCase credential field names in rendered annotations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mupot-k8s-agent-host-'))
    const deployment = join(dir, 'deployment.yaml')
    const secretScalar = 'camel-case-secret-value-must-not-appear'
    writeFileSync(
      deployment,
      readFileSync(deploymentPath, 'utf8').replace(
        `kind: Deployment\nmetadata:\n  name: dme-hermes-agent-host`,
        `kind: Deployment\nmetadata:\n  name: dme-hermes-agent-host\n  annotations:\n    clientSecret: ${secretScalar}`,
      ),
    )

    const receipt = buildKubernetesAgentHostReceipt({ deploymentPath: deployment, networkPolicyPath, configPath })

    expect(receipt.failure_codes).toContain('literal_credential_found')
    expect(JSON.stringify(receipt)).not.toContain(secretScalar)
  })

  it('limits Kubernetes credential-field exemptions to their pod-spec paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mupot-k8s-agent-host-'))
    const deployment = join(dir, 'deployment.yaml')
    writeFileSync(
      deployment,
      readFileSync(deploymentPath, 'utf8').replace(
        `kind: Deployment\nmetadata:\n  name: dme-hermes-agent-host`,
        `kind: Deployment\nmetadata:\n  name: dme-hermes-agent-host\n  annotations:\n    automountServiceAccountToken: forbidden-here`,
      ),
    )

    const receipt = buildKubernetesAgentHostReceipt({ deploymentPath: deployment, networkPolicyPath, configPath })

    expect(receipt.failure_codes).toContain('literal_credential_found')
  })

  it('allows the service-account token field only when the pod spec disables it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mupot-k8s-agent-host-'))
    const deployment = join(dir, 'deployment.yaml')
    writeFileSync(
      deployment,
      readFileSync(deploymentPath, 'utf8').replace(
        '      automountServiceAccountToken: false',
        '      automountServiceAccountToken: true',
      ),
    )

    const receipt = buildKubernetesAgentHostReceipt({ deploymentPath: deployment, networkPolicyPath, configPath })

    expect(receipt.failure_codes).toEqual(expect.arrayContaining([
      'service_account_token_enabled',
      'literal_credential_found',
    ]))
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
