import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAllDocuments, stringify } from 'yaml'
import { PLUGIN_FILES, pluginBundleHash } from '../fleet-runtime/hermes-plugin-smoke.mjs'
import { normalizeAgentProfile } from '../fleet-runtime/profile-contract.mjs'
import { HERMES_BASE_DIGEST, sourceContract } from '../scripts/hermes-agent-host-image-provenance.mjs'
import { buildCutoverPreflight } from '../scripts/kubernetes-agent-host-cutover-preflight.mjs'
import {
  buildKubernetesHermesPluginSmokeEvidence,
  immutablePluginConfigMapName,
} from '../scripts/kubernetes-hermes-plugin-smoke-evidence.mjs'
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
const hermesDockerfilePath = join(ROOT, 'deploy/kubernetes/agent-host/Dockerfile.hermes')

function documents(path: string): Array<Record<string, any>> {
  return parseAllDocuments(readFileSync(path, 'utf8')).map((document) => document.toJSON())
}

function containerRuntimeMounts(deployment: Record<string, any>) {
  const pod = deployment.spec.template.spec
  const container = pod.containers[0]
  const volumes = new Map(pod.volumes.map((volume: any) => [volume.name, volume]))
  const mounts = new Map(container.volumeMounts.map((mount: any) => [mount.name, mount]))
  return {
    homeClaim: (volumes.get('hermes-home') as any)?.persistentVolumeClaim?.claimName,
    homePath: (mounts.get('hermes-home') as any)?.mountPath,
    pluginConfigMap: (volumes.get('hermes-plugin') as any)?.configMap?.name,
    pluginPath: (mounts.get('hermes-plugin') as any)?.mountPath,
  }
}

function writeReleaseEvidence(dir: string, imageDigest: string) {
  const pluginData = Object.fromEntries(PLUGIN_FILES.map((name) => [name, `content for ${name}`]))
  pluginData['plugin.yaml'] = 'name: mupot\nversion: "0.3.0"\n'
  pluginData['__init__.py'] = 'mode = os.environ.get("MUPOT_PLUGIN_MODE")\n'
  pluginData['operator.py'] = 'TOOLSET = "mupot-operator"\n'
  const pluginConfigName = immutablePluginConfigMapName(pluginData)
  const pluginConfig = {
    apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: pluginConfigName }, immutable: true, data: pluginData,
  }
  const pluginConfigMap = join(dir, 'plugin-config-map.yaml')
  writeFileSync(pluginConfigMap, stringify(pluginConfig))
  const pluginSmokeJob = join(dir, 'plugin-smoke-job.yaml')
  writeFileSync(pluginSmokeJob, readFileSync(join(ROOT, 'deploy/kubernetes/agent-host/plugin-smoke-job.yaml'), 'utf8')
    .replace('registry.example/mupot-agent-host-hermes:0.23.0', `registry.example/mupot-agent-host-hermes@${imageDigest}`)
    .replace('replace-with-immutable-plugin-config-map', pluginConfigName))
  const expectedJob = documents(pluginSmokeJob)[0]
  const now = new Date()
  const observedJob = structuredClone(expectedJob)
  observedJob.metadata.uid = 'smoke-job-uid'
  observedJob.status = { completionTime: new Date(now.getTime() - 60_000).toISOString() }
  const rawSmoke = JSON.stringify({
    schema: 'mupot.hermes-plugin-smoke/v1', status: 'pass',
    plugin: { name: 'mupot', version: '0.3.0', enabled: true, toolset: 'mupot-operator' },
    plugin_bundle_sha256: pluginBundleHash(pluginData), exit_code: 0,
  })
  const pluginSmokeEvidence = join(dir, 'plugin-smoke-evidence.json')
  writeFileSync(pluginSmokeEvidence, JSON.stringify(buildKubernetesHermesPluginSmokeEvidence({
    namespace: 'dme-hermes', expectedJob, observedJob,
    pods: [{
      metadata: {
        name: 'dme-hermes-plugin-smoke-test', uid: 'smoke-pod-uid',
        ownerReferences: [{
          apiVersion: 'batch/v1', kind: 'Job', name: 'dme-hermes-plugin-smoke',
          uid: 'smoke-job-uid', controller: true,
        }],
      },
      spec: structuredClone(expectedJob.spec.template.spec),
      status: {
        phase: 'Succeeded',
        containerStatuses: [{
          name: 'plugin-smoke', imageID: `docker-pullable://registry.example/host@${imageDigest}`,
        }],
      },
    }],
    logs: rawSmoke,
    expectedPluginConfigMap: pluginConfig,
    observedPluginConfigMap: {
      ...pluginConfig, metadata: { ...pluginConfig.metadata, uid: 'plugin-config-uid', resourceVersion: '42' },
    },
    expectedImageDigest: imageDigest,
    now,
  })))
  const pluginSmokeNetworkPolicy = join(dir, 'plugin-smoke-network-policy.yaml')
  writeFileSync(
    pluginSmokeNetworkPolicy,
    readFileSync(join(ROOT, 'deploy/kubernetes/agent-host/plugin-smoke-network-policy.yaml'), 'utf8'),
  )
  const source = sourceContract(ROOT)
  const imageProvenance = join(dir, 'image-provenance.json')
  writeFileSync(imageProvenance, JSON.stringify({
    schema: 'mupot.hermes-agent-host-image-provenance/v1', status: 'pass', image_digest: imageDigest,
    base_image_digest: HERMES_BASE_DIGEST,
    dockerfile: { filename: 'Dockerfile.hermes', sha256: source.dockerfile_sha256 },
    runtime_bundle: { sha256: source.runtime_bundle_sha256, files: source.runtime_files },
    runtime: {
      user: '10000:10000', hermes_version: '0.18.2', adapter_imported: true,
      stdin_bridge_contract_verified: true,
    },
  }))
  const cutoverPreflight = join(dir, 'cutover-preflight.json')
  writeFileSync(cutoverPreflight, JSON.stringify(buildCutoverPreflight({
    namespace: 'dme-hermes', mode: 'activate', now: new Date(),
    clusterContext: 'test-cluster', namespaceUid: 'test-namespace-uid',
    workloads: [{
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'dme-hermes', uid: 'dme-uid', resourceVersion: '42', generation: 3 },
      spec: { replicas: 1, template: { spec: { containers: [{ name: 'hermes' }, { name: 'telegram-gateway' }] } } },
    }, {
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'dme-hermes-agent-host', uid: 'host-uid', resourceVersion: '43', generation: 1 },
      spec: { replicas: 0, template: { spec: { containers: [{ name: 'agent-host' }] } } },
    }],
    pods: [],
  })))
  return {
    pluginConfigMap, pluginConfigName, pluginSmokeJob, pluginSmokeNetworkPolicy, pluginSmokeEvidence,
    imageProvenance, cutoverPreflight,
  }
}

describe('Kubernetes Agent Host deployment contract', () => {
  it('runs one non-root read-only host container with bounded resources and health probes', () => {
    const deployment = documents(deploymentPath).find((doc) => doc.kind === 'Deployment')!
    const pod = deployment.spec.template.spec
    const container = pod.containers[0]

    expect(pod.containers).toHaveLength(1)
    expect(deployment.spec.replicas).toBe(0)
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

    expect(pod.securityContext).toMatchObject({
      runAsUser: 10000, runAsGroup: 10000, fsGroup: 10000, fsGroupChangePolicy: 'OnRootMismatch',
    })

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
    expect(container.env).toContainEqual({ name: 'MUPOT_PLUGIN_MODE', value: 'operator' })
    expect(container.env).toContainEqual({ name: 'MUPOT_REQUIRE_SIGNED_INBOX_READY', value: 'true' })
    expect(container.env).toContainEqual({ name: 'MUPOT_AGENT_TOKEN_FILE', value: '/run/secrets/mupot-agent/token' })
    expect(container.env.map((entry: any) => entry.name)).not.toContain('MUPOT_AGENT_TOKEN')
    expect(container.env.map((entry: any) => entry.name)).not.toContain('MUPOT_CONTROL_CONFIG')
    expect(source).not.toMatch(/Bearer\s+\S+|private[_-]?key\s*:/i)
    expect(source).not.toMatch(/\bmupot_[a-z0-9_-]{16,}\b/)
    expect(source).not.toContain('mupot.mumega.com')
  })

  it('mounts the exact daemon and inbox configs consumed by the on-demand runtime', () => {
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    const deployment = documents(deploymentPath).find((doc) => doc.kind === 'Deployment')!
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
        argv: ['/usr/local/bin/node', '/opt/mupot/inbox-handler.mjs', '/etc/mupot/inbox-handler.json'],
        timeout_ms: 150000,
      },
    })
    expect(inbox.agents[0].profile.inherited_env).toEqual(['MUPOT_AGENT_TOKEN_FILE', 'MUPOT_PLUGIN_MODE'])
    expect(daemon.agents[0].inbox.timeout_ms).toBeGreaterThanOrEqual(
      inbox.agents[0].profile.timeout_ms + 30_000,
    )
    expect(containerRuntimeMounts(deployment)).toEqual({
      homeClaim: 'dme-hermes-data',
      homePath: '/home/mupot',
      pluginConfigMap: 'replace-with-immutable-plugin-config-map',
      pluginPath: '/home/mupot/plugins/mupot',
    })
    const pod = deployment.spec.template.spec
    expect(pod.volumes.find((volume: any) => volume.name === 'config').configMap.defaultMode).toBe(292)
    expect(pod.volumes.find((volume: any) => volume.name === 'hermes-plugin').configMap.defaultMode).toBe(292)
  })

  it('allows egress only to cluster DNS and a labeled trusted egress gateway', () => {
    const policy = documents(networkPolicyPath).find((doc) => doc.kind === 'NetworkPolicy')!
    expect(policy.spec.policyTypes).toEqual(['Ingress', 'Egress'])
    expect(policy.spec.ingress).toEqual([])
    expect(policy.spec.egress).toHaveLength(2)
    expect(JSON.stringify(policy.spec.egress)).toContain('trusted-egress')
    expect(JSON.stringify(policy.spec.egress)).not.toContain('0.0.0.0/0')
  })

  it('runs plugin discovery without a token, customer PVC, or network path', () => {
    const job = documents(join(ROOT, 'deploy/kubernetes/agent-host/plugin-smoke-job.yaml'))[0]
    const policy = documents(join(ROOT, 'deploy/kubernetes/agent-host/plugin-smoke-network-policy.yaml'))[0]
    const pod = job.spec.template.spec

    expect(pod.volumes.find((volume: any) => volume.name === 'hermes-home')).toEqual({
      name: 'hermes-home', emptyDir: {},
    })
    expect(JSON.stringify(job)).not.toContain('persistentVolumeClaim')
    expect(pod.volumes.some((volume: any) => volume.secret || volume.projected)).toBe(false)
    expect(pod.containers[0].env.map((entry: any) => entry.name)).not.toContain('MUPOT_AGENT_TOKEN')
    expect(pod.containers[0].envFrom).toBeUndefined()
    expect(policy.spec.podSelector.matchLabels).toEqual(job.spec.template.metadata.labels)
    expect(policy.spec.ingress).toEqual([])
    expect(policy.spec.egress).toEqual([])
  })

  it('ships a sterile project-bound Hermes profile with no token values', () => {
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(config.tenant).toBe('dme')
    expect(config.project_id).toBe('replace-with-dme-project-id')
    const profile = normalizeAgentProfile(config.inbox.agents[0].profile)
    expect(profile?.allowed_project_ids).toEqual([config.project_id])
    expect(config.daemon.base_url).toBe(config.base_url)
    expect(config.daemon.tenant).toBe(config.tenant)
    expect(JSON.stringify(config)).not.toMatch(/Bearer\s+\S+|mupot_[a-z0-9_-]{16,}/)
  })

  it('builds the Agent Host runtime as an unprivileged credential-free base image', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf8')
    expect(dockerfile).toContain('USER 10001:10001')
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/node", "/opt/mupot/container-entrypoint.mjs"]')
    expect(dockerfile).not.toMatch(/COPY\s+.*(?:token|secret|credential|\.env)/i)
    expect(dockerfile).not.toMatch(/Bearer\s+\S+/i)
  })

  it('builds a digest-pinned unprivileged Hermes-derived Agent Host image', () => {
    const dockerfile = readFileSync(hermesDockerfilePath, 'utf8')
    expect(dockerfile).toContain('nousresearch/hermes-agent@sha256:8d56cd839ad76b0fc2c9202f39a7ffe1b464c247059a17bc3c72ba6b4ae57616')
    expect(dockerfile).toContain('USER 10000:10000')
    expect(dockerfile).toContain('HERMES_HOME=/home/mupot')
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/node", "/opt/mupot/container-entrypoint.mjs"]')
    expect(dockerfile).not.toContain('fleet-runtime/*.mjs')
    expect(dockerfile).not.toContain('.test.mjs')
    expect(dockerfile).not.toMatch(/(?:TOKEN|SECRET|PASSWORD)=\S+/)
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
    const evidence = writeReleaseEvidence(dir, imageDigest)
    writeFileSync(
      deployment,
      readFileSync(deployment, 'utf8').replaceAll(
        'replace-with-immutable-plugin-config-map',
        evidence.pluginConfigName,
      ),
    )

    const receiptInput = {
      deploymentPath: deployment,
      networkPolicyPath: policy,
      configPath: config,
      expectedImageDigest: imageDigest,
      pluginConfigMapPath: evidence.pluginConfigMap,
      pluginSmokeJobPath: evidence.pluginSmokeJob,
      pluginSmokeNetworkPolicyPath: evidence.pluginSmokeNetworkPolicy,
      pluginSmokeEvidencePath: evidence.pluginSmokeEvidence,
      imageProvenancePath: evidence.imageProvenance,
      cutoverPreflightPath: evidence.cutoverPreflight,
      expectedClusterContext: 'test-cluster',
      expectedNamespaceUid: 'test-namespace-uid',
    }
    const receipt = buildKubernetesAgentHostReceipt(receiptInput)

    expect(receipt, JSON.stringify(receipt.failure_codes)).toMatchObject({
      receipt_type: KUBERNETES_AGENT_HOST_RECEIPT_TYPE,
      status: 'pass',
      target: {
        tenant: 'dme',
        project_id: 'dme-delivery-project',
        agent_id: 'dme-hermes-k8s',
        image_digest: imageDigest,
      },
    })
    expect(receipt.artifacts).toHaveLength(9)
    expect(receipt.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256))).toBe(true)
    expect(JSON.stringify(receipt)).not.toMatch(/agent-token|allowed_senders|\/usr\/local\/bin\/hermes/)

    const staleEvidence = JSON.parse(readFileSync(evidence.pluginSmokeEvidence, 'utf8'))
    staleEvidence.observed_at = '2026-01-01T00:00:00.000Z'
    staleEvidence.job.completion_time = '2026-01-01T00:00:00.000Z'
    writeFileSync(evidence.pluginSmokeEvidence, JSON.stringify(staleEvidence))
    expect(buildKubernetesAgentHostReceipt(receiptInput).failure_codes)
      .toContain('plugin_discovery_smoke_unbound')

    writeFileSync(
      evidence.pluginSmokeNetworkPolicy,
      readFileSync(evidence.pluginSmokeNetworkPolicy, 'utf8').replace('egress: []', 'egress:\n  - {}'),
    )
    expect(buildKubernetesAgentHostReceipt(receiptInput).failure_codes)
      .toContain('plugin_smoke_network_unrestricted')
  })

  it('fails closed on mutable images, weakened policy, placeholders, and digest mismatch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mupot-k8s-agent-host-'))
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

    const activeDeployment = join(dir, 'active-deployment.yaml')
    writeFileSync(activeDeployment, readFileSync(deploymentPath, 'utf8').replace('replicas: 0', 'replicas: 1'))
    expect(buildKubernetesAgentHostReceipt({
      deploymentPath: activeDeployment, networkPolicyPath, configPath,
    }).failure_codes).toContain('host_replica_not_inert')

    const weakPolicy = join(dir, 'network-policy.yaml')
    writeFileSync(weakPolicy, readFileSync(networkPolicyPath, 'utf8').replace('ingress: []', 'ingress:\n  - {}'))
    const weak = buildKubernetesAgentHostReceipt({
      deploymentPath,
      networkPolicyPath: weakPolicy,
      configPath,
    })
    expect(weak.failure_codes).toContain('ingress_not_denied')
  })

  it('fails when the trusted Kubernetes key group differs from runtime GID 10000', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mupot-k8s-agent-host-'))
    const deployment = join(dir, 'deployment.yaml')
    writeFileSync(deployment, readFileSync(deploymentPath, 'utf8').replace('runAsGroup: 10000', 'runAsGroup: 20000'))

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

  it('rejects a changed DME agent-token mount or a literal token environment', () => {
    const mutations = [
      (source: string) => source.replace('secretName: dme-mupot-agent-host', 'secretName: other-agent-secret'),
      (source: string) => source.replace(
        `            - name: MUPOT_AGENT_TOKEN_FILE\n              value: /run/secrets/mupot-agent/token`,
        `            - name: MUPOT_AGENT_TOKEN\n              value: mupot_forbidden_literal_value`,
      ),
    ]

    for (const [index, mutate] of mutations.entries()) {
      const dir = mkdtempSync(join(tmpdir(), 'mupot-k8s-agent-host-'))
      const deployment = join(dir, 'deployment.yaml')
      writeFileSync(deployment, mutate(readFileSync(deploymentPath, 'utf8')))
      const receipt = buildKubernetesAgentHostReceipt({ deploymentPath: deployment, networkPolicyPath, configPath })
      expect(receipt.failure_codes).toContain(index === 0 ? 'hermes_runtime_missing' : 'runtime_paths_invalid')
      if (index === 1) expect(receipt.failure_codes).toContain('literal_credential_found')
    }
  })

  it('rejects duplicate, subPath, or extra runtime mounts', () => {
    const mutations = [
      (source: string) => source.replace(
        `            - name: hermes-plugin\n              mountPath: /home/mupot/plugins/mupot\n              readOnly: true`,
        `            - name: hermes-plugin\n              mountPath: /home/mupot/plugins/mupot\n              readOnly: true\n              subPath: plugin.yaml`,
      ),
      (source: string) => source.replace(
        `            - name: temporary\n              mountPath: /tmp`,
        `            - name: temporary\n              mountPath: /tmp\n            - name: temporary\n              mountPath: /other-tmp`,
      ),
    ]
    for (const mutate of mutations) {
      const dir = mkdtempSync(join(tmpdir(), 'mupot-k8s-agent-host-'))
      const deployment = join(dir, 'deployment.yaml')
      writeFileSync(deployment, mutate(readFileSync(deploymentPath, 'utf8')))
      const receipt = buildKubernetesAgentHostReceipt({ deploymentPath: deployment, networkPolicyPath, configPath })
      expect(receipt.failure_codes).toContain('volume_contract_invalid')
    }
  })

  it('fails when the DME Hermes home or plugin mount is removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mupot-k8s-agent-host-'))
    const deployment = join(dir, 'deployment.yaml')
    writeFileSync(
      deployment,
      readFileSync(deploymentPath, 'utf8').replace('claimName: dme-hermes-data', 'claimName: other-home'),
    )

    const receipt = buildKubernetesAgentHostReceipt({ deploymentPath: deployment, networkPolicyPath, configPath })

    expect(receipt.failure_codes).toContain('hermes_runtime_missing')
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
