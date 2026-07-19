#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { parseAllDocuments } from 'yaml'

import { normalizeAgentProfile } from '../fleet-runtime/profile-contract.mjs'
import { validateConfig as validateInboxConfig } from '../fleet-runtime/inbox-handler.mjs'
import { validateConfig as validateDaemonConfig } from '../fleet-runtime/fleet-daemon.mjs'
import { PLUGIN_FILES, pluginBundleHash } from '../fleet-runtime/hermes-plugin-smoke.mjs'
import {
  HERMES_BASE_DIGEST,
  HERMES_IMAGE_PROVENANCE_TYPE,
  sourceContract,
} from './hermes-agent-host-image-provenance.mjs'
import { KUBERNETES_AGENT_HOST_CUTOVER_PREFLIGHT_TYPE } from './kubernetes-agent-host-cutover-preflight.mjs'
import {
  KUBERNETES_HERMES_PLUGIN_SMOKE_EVIDENCE_TYPE,
  immutablePluginConfigMapName,
  kubernetesJobExecutionContractHash,
  kubernetesPodExecutionContractHash,
} from './kubernetes-hermes-plugin-smoke-evidence.mjs'

export const KUBERNETES_AGENT_HOST_RECEIPT_TYPE = 'mupot-kubernetes-agent-host-receipt/v1'

const IMAGE_DIGEST_RE = /^sha256:[a-f0-9]{64}$/
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const SECRET_VALUE_RE = /Bearer\s+\S+|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i
const MUPOT_TOKEN_RE = /\bmupot_[a-z0-9_-]{16,}\b/
const CREDENTIAL_FIELD_RE = /(?:^|_)(?:api[_-]?key|access[_-]?key|authorization|client[_-]?secret|credential|credentials|password|passwd|private[_-]?key|secret|token)(?:_|$)/i
const PACKAGE_KEYS = ['schema', 'tenant', 'project_id', 'base_url', 'daemon', 'inbox']
const DAEMON_KEYS = ['base_url', 'tenant', 'state_file', 'interval_sec', 'agents']
const DAEMON_AGENT_KEYS = ['agent_id', 'type', 'runtime', 'lifecycle', 'probe', 'inbox']
const DAEMON_INBOX_KEYS = ['argv', 'limit', 'timeout_ms']
const INBOX_KEYS = ['spool_dir', 'command_timeout_ms', 'agents']
const INBOX_AGENT_KEYS = ['agent_id', 'profile']
const CONFIG_MAP_DATA_KEYS = ['daemon.json', 'inbox-handler.json']
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function readArtifact(path, role) {
  const source = readFileSync(path, 'utf8')
  return { source, evidence: { role, filename: basename(path), sha256: sha256(source) } }
}

function yamlDocuments(source) {
  const documents = parseAllDocuments(source)
  if (documents.some((document) => document.errors.length > 0)) throw new Error('invalid YAML document')
  return documents.map((document) => document.toJSON())
}

function exactJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function hasExactConfigSchema(config, configMap) {
  const daemonAgent = config?.daemon?.agents?.[0]
  const inboxAgent = config?.inbox?.agents?.[0]
  return hasExactKeys(config, PACKAGE_KEYS) &&
    hasExactKeys(config.daemon, DAEMON_KEYS) &&
    Array.isArray(config.daemon.agents) && config.daemon.agents.length === 1 &&
    hasExactKeys(daemonAgent, DAEMON_AGENT_KEYS) &&
    hasExactKeys(daemonAgent.inbox, DAEMON_INBOX_KEYS) &&
    hasExactKeys(config.inbox, INBOX_KEYS) &&
    Array.isArray(config.inbox.agents) && config.inbox.agents.length === 1 &&
    hasExactKeys(inboxAgent, INBOX_AGENT_KEYS) &&
    Boolean(normalizeAgentProfile(inboxAgent.profile)) &&
    hasExactKeys(configMap?.data, CONFIG_MAP_DATA_KEYS)
}

function credentialField(key) {
  if (typeof key !== 'string') return false
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
  return CREDENTIAL_FIELD_RE.test(normalized)
}

function containsCredentialMaterial(value) {
  if (typeof value === 'string') return SECRET_VALUE_RE.test(value) || MUPOT_TOKEN_RE.test(value)
  if (Array.isArray(value)) return value.some(containsCredentialMaterial)
  if (!value || typeof value !== 'object') return false
  if (typeof value.kty === 'string' && typeof value.d === 'string') return true
  return Object.entries(value).some(([key, nested]) => credentialField(key) || containsCredentialMaterial(nested))
}

function containsPluginSecretMaterial(value) {
  if (typeof value === 'string') {
    return MUPOT_TOKEN_RE.test(value) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value) ||
      /\b(?:sk|rk|pk)-(?:live|prod)-[A-Za-z0-9_-]{16,}\b/.test(value)
  }
  if (Array.isArray(value)) return value.some(containsPluginSecretMaterial)
  if (!value || typeof value !== 'object') return false
  if (typeof value.kty === 'string' && typeof value.d === 'string') return true
  if (value.kind === 'Secret' && [value.data, value.stringData].some((data) =>
    data && typeof data === 'object' && Object.keys(data).length > 0)) return true
  return Object.values(value).some(containsPluginSecretMaterial)
}

function containsYamlCredentialMaterial(value, path = []) {
  if (typeof value === 'string') {
    if (SECRET_VALUE_RE.test(value) || MUPOT_TOKEN_RE.test(value)) return true
    const trimmed = value.trim()
    if (trimmed.length > 65_536 || !(/^[{[]/.test(trimmed) && /[}\]]$/.test(trimmed))) return false
    try {
      return containsCredentialMaterial(JSON.parse(trimmed))
    } catch {
      return false
    }
  }
  if (Array.isArray(value)) {
    return value.some((nested, index) => containsYamlCredentialMaterial(nested, [...path, String(index)]))
  }
  if (!value || typeof value !== 'object') return false
  if (typeof value.kty === 'string' && typeof value.d === 'string') return true
  if (value.kind === 'Secret' && [value.data, value.stringData].some((data) =>
    data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length > 0)) return true
  const approvedDmeTokenFile = path.at(-6) === 'template' && path.at(-5) === 'spec' &&
    path.at(-4) === 'containers' && path.at(-2) === 'env' && exactJson(value, {
      name: 'MUPOT_AGENT_TOKEN_FILE', value: '/run/secrets/mupot-agent/token',
    })
  if (approvedDmeTokenFile) return false
  if (typeof value.name === 'string' && credentialField(value.name) &&
      (Object.hasOwn(value, 'value') || Object.hasOwn(value, 'valueFrom'))) return true
  return Object.entries(value).some(([key, nested]) => {
    const kubernetesSecretVolume = key === 'secret' &&
      path.at(-4) === 'template' && path.at(-3) === 'spec' && path.at(-2) === 'volumes'
    const kubernetesSecretName = key === 'secretName' &&
      path.at(-5) === 'template' && path.at(-4) === 'spec' &&
      path.at(-3) === 'volumes' && path.at(-1) === 'secret'
    const serviceAccountSetting = key === 'automountServiceAccountToken' &&
      path.at(-3) === 'spec' && path.at(-2) === 'template' && path.at(-1) === 'spec' && nested === false
    return (credentialField(key) && !kubernetesSecretVolume && !kubernetesSecretName && !serviceAccountSetting) ||
      containsYamlCredentialMaterial(nested, [...path, key])
  })
}

function parsedConfigMapValues(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return []
  return Object.values(data).map((value) => {
    if (typeof value !== 'string') return value
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  })
}

function check(checks, ok, name, code) {
  checks.push({ check: name, ok: Boolean(ok), ...(ok ? {} : { code }) })
}

function exactImageDigest(image) {
  if (typeof image !== 'string') return null
  const separator = image.lastIndexOf('@')
  if (separator < 1) return null
  const digest = image.slice(separator + 1)
  return IMAGE_DIGEST_RE.test(digest) ? digest : null
}

function validRef(value) {
  return typeof value === 'string' && REF_RE.test(value)
}

export function buildKubernetesAgentHostReceipt(input = {}) {
  const deploymentPath = resolve(input.deploymentPath ?? 'deploy/kubernetes/agent-host/deployment.yaml')
  const networkPolicyPath = resolve(input.networkPolicyPath ?? 'deploy/kubernetes/agent-host/network-policy.yaml')
  const configPath = resolve(input.configPath ?? 'deploy/kubernetes/agent-host/config.example.json')
  const pluginConfigMapPath = input.pluginConfigMapPath ? resolve(input.pluginConfigMapPath) : null
  const pluginSmokeJobPath = input.pluginSmokeJobPath ? resolve(input.pluginSmokeJobPath) : null
  const pluginSmokeNetworkPolicyPath = input.pluginSmokeNetworkPolicyPath
    ? resolve(input.pluginSmokeNetworkPolicyPath)
    : null
  const pluginSmokeEvidencePath = input.pluginSmokeEvidencePath ? resolve(input.pluginSmokeEvidencePath) : null
  const imageProvenancePath = input.imageProvenancePath ? resolve(input.imageProvenancePath) : null
  const cutoverPreflightPath = input.cutoverPreflightPath ? resolve(input.cutoverPreflightPath) : null
  const checks = []
  const artifacts = []
  let deploymentSource = ''
  let networkPolicySource = ''
  let configSource = ''
  let deployment
  let configMap
  let networkPolicy
  let config
  let pluginConfigMap
  let pluginSmokeJob
  let pluginSmokeNetworkPolicy
  let pluginSmokeEvidence
  let imageProvenance
  let cutoverPreflight
  let pluginConfigMapDocuments = []
  let pluginSmokeJobDocuments = []
  let pluginSmokeNetworkPolicyDocuments = []
  let deploymentDocuments = []
  let networkPolicyDocuments = []

  try {
    const artifact = readArtifact(deploymentPath, 'deployment')
    deploymentSource = artifact.source
    artifacts.push(artifact.evidence)
    deploymentDocuments = yamlDocuments(deploymentSource)
    deployment = deploymentDocuments.find((document) => document?.kind === 'Deployment')
    configMap = deploymentDocuments.find((document) => document?.kind === 'ConfigMap')
    const documentsExact = deploymentDocuments.length === 2 &&
      deploymentDocuments.filter((document) => document?.kind === 'Deployment').length === 1 &&
      deploymentDocuments.filter((document) => document?.kind === 'ConfigMap').length === 1
    check(checks, Boolean(deployment) && documentsExact, 'deployment_parseable', 'deployment_invalid')
    check(checks, Boolean(configMap) && documentsExact, 'config_map_parseable', 'config_map_invalid')
  } catch {
    check(checks, false, 'deployment_parseable', 'deployment_invalid')
  }
  try {
    const artifact = readArtifact(networkPolicyPath, 'network_policy')
    networkPolicySource = artifact.source
    artifacts.push(artifact.evidence)
    networkPolicyDocuments = yamlDocuments(networkPolicySource)
    networkPolicy = networkPolicyDocuments.find((document) => document?.kind === 'NetworkPolicy')
    check(
      checks,
      Boolean(networkPolicy) && networkPolicyDocuments.length === 1,
      'network_policy_parseable',
      'network_policy_invalid',
    )
  } catch {
    check(checks, false, 'network_policy_parseable', 'network_policy_invalid')
  }
  try {
    const artifact = readArtifact(configPath, 'agent_config')
    configSource = artifact.source
    artifacts.push(artifact.evidence)
    config = JSON.parse(configSource)
    check(checks, Boolean(config && typeof config === 'object'), 'agent_config_parseable', 'agent_config_invalid')
  } catch {
    check(checks, false, 'agent_config_parseable', 'agent_config_invalid')
  }
  try {
    const artifact = readArtifact(pluginConfigMapPath, 'hermes_plugin_config_map')
    artifacts.push(artifact.evidence)
    pluginConfigMapDocuments = yamlDocuments(artifact.source)
    pluginConfigMap = pluginConfigMapDocuments.length === 1 ? pluginConfigMapDocuments[0] : null
    check(checks, pluginConfigMap?.kind === 'ConfigMap', 'plugin_config_map_parseable', 'plugin_config_map_invalid')
  } catch {
    check(checks, false, 'plugin_config_map_parseable', 'plugin_config_map_invalid')
  }
  try {
    const artifact = readArtifact(pluginSmokeJobPath, 'hermes_plugin_smoke_job')
    artifacts.push(artifact.evidence)
    pluginSmokeJobDocuments = yamlDocuments(artifact.source)
    pluginSmokeJob = pluginSmokeJobDocuments.length === 1 ? pluginSmokeJobDocuments[0] : null
    check(checks, pluginSmokeJob?.kind === 'Job', 'plugin_smoke_job_parseable', 'plugin_smoke_job_invalid')
  } catch {
    check(checks, false, 'plugin_smoke_job_parseable', 'plugin_smoke_job_invalid')
  }
  try {
    const artifact = readArtifact(pluginSmokeNetworkPolicyPath, 'hermes_plugin_smoke_network_policy')
    artifacts.push(artifact.evidence)
    pluginSmokeNetworkPolicyDocuments = yamlDocuments(artifact.source)
    pluginSmokeNetworkPolicy = pluginSmokeNetworkPolicyDocuments.length === 1
      ? pluginSmokeNetworkPolicyDocuments[0]
      : null
    check(
      checks,
      pluginSmokeNetworkPolicy?.kind === 'NetworkPolicy',
      'plugin_smoke_network_policy_parseable',
      'plugin_smoke_network_policy_invalid',
    )
  } catch {
    check(checks, false, 'plugin_smoke_network_policy_parseable', 'plugin_smoke_network_policy_invalid')
  }
  try {
    const artifact = readArtifact(pluginSmokeEvidencePath, 'hermes_plugin_smoke_evidence')
    artifacts.push(artifact.evidence)
    pluginSmokeEvidence = JSON.parse(artifact.source)
    check(
      checks,
      pluginSmokeEvidence?.schema === KUBERNETES_HERMES_PLUGIN_SMOKE_EVIDENCE_TYPE,
      'plugin_smoke_evidence_parseable',
      'plugin_smoke_evidence_invalid',
    )
  } catch {
    check(checks, false, 'plugin_smoke_evidence_parseable', 'plugin_smoke_evidence_invalid')
  }
  try {
    const artifact = readArtifact(imageProvenancePath, 'hermes_image_provenance')
    artifacts.push(artifact.evidence)
    imageProvenance = JSON.parse(artifact.source)
    check(checks, imageProvenance?.schema === HERMES_IMAGE_PROVENANCE_TYPE, 'image_provenance_parseable', 'image_provenance_invalid')
  } catch {
    check(checks, false, 'image_provenance_parseable', 'image_provenance_invalid')
  }
  try {
    const artifact = readArtifact(cutoverPreflightPath, 'cutover_preflight')
    artifacts.push(artifact.evidence)
    cutoverPreflight = JSON.parse(artifact.source)
    check(
      checks,
      cutoverPreflight?.schema === KUBERNETES_AGENT_HOST_CUTOVER_PREFLIGHT_TYPE,
      'cutover_preflight_parseable',
      'cutover_preflight_invalid',
    )
  } catch {
    check(checks, false, 'cutover_preflight_parseable', 'cutover_preflight_invalid')
  }

  const pod = deployment?.spec?.template?.spec
  const containers = Array.isArray(pod?.containers) ? pod.containers : []
  const container = containers[0]
  const imageDigest = exactImageDigest(container?.image)
  check(checks, deployment?.spec?.replicas === 0, 'host_replica_inert', 'host_replica_not_inert')
  check(checks, containers.length === 1, 'single_host_container', 'container_contract_invalid')
  check(checks, Boolean(imageDigest), 'image_is_immutable', 'image_not_immutable')
  const expectedImageDigest = input.expectedImageDigest ?? null
  check(
    checks,
    expectedImageDigest === null || (IMAGE_DIGEST_RE.test(expectedImageDigest) && imageDigest === expectedImageDigest),
    'image_digest_matches',
    'image_digest_mismatch',
  )
  const reviewedSource = sourceContract(ROOT)
  const imageProvenanceValid = imageProvenance?.schema === HERMES_IMAGE_PROVENANCE_TYPE &&
    imageProvenance.status === 'pass' && imageProvenance.image_digest === imageDigest &&
    imageProvenance.base_image_digest === HERMES_BASE_DIGEST &&
    imageProvenance.dockerfile?.sha256 === reviewedSource.dockerfile_sha256 &&
    imageProvenance.runtime_bundle?.sha256 === reviewedSource.runtime_bundle_sha256 &&
    exactJson(imageProvenance.runtime_bundle?.files, reviewedSource.runtime_files) &&
    imageProvenance.runtime?.user === '10000:10000' &&
    imageProvenance.runtime?.hermes_version === '0.18.2' && imageProvenance.runtime?.adapter_imported === true &&
    imageProvenance.runtime?.stdin_bridge_contract_verified === true
  check(checks, imageProvenanceValid, 'image_provenance_bound', 'image_provenance_unbound')
  const preflightTime = Date.parse(cutoverPreflight?.observed_at ?? '')
  const preflightAge = Date.now() - preflightTime
  const preflightWorkloads = cutoverPreflight?.evidence?.workloads
  const preflightReplicaSets = cutoverPreflight?.evidence?.replica_sets
  const preflightPods = cutoverPreflight?.evidence?.pods
  const preflightHosts = Array.isArray(preflightWorkloads) ? preflightWorkloads.filter((entry) =>
    entry?.kind === 'Deployment' && entry?.name === 'dme-hermes-agent-host') : []
  const projectionValid = (entries) => Array.isArray(entries) && entries.every((entry) =>
    hasExactKeys(entry, ['kind', 'name', 'uid', 'resource_version', 'generation', 'containers', 'replicas']) &&
    typeof entry.kind === 'string' && typeof entry.name === 'string' &&
    typeof entry.uid === 'string' && typeof entry.resource_version === 'string' &&
    Array.isArray(entry.containers) && entry.containers.every((name) => typeof name === 'string'))
  const exactActivateChecks = [
    { check: 'namespace_exact', ok: true },
    { check: 'mode_valid', ok: true },
    { check: 'cluster_identity_observed', ok: true },
    { check: 'agent_host_inert', ok: true },
    { check: 'legacy_subscriber_absent', ok: true },
    { check: 'source_runtime_preserved', ok: true },
  ]
  const cutoverPreflightValid = cutoverPreflight?.schema === KUBERNETES_AGENT_HOST_CUTOVER_PREFLIGHT_TYPE &&
    cutoverPreflight?.status === 'pass' && cutoverPreflight?.namespace === 'dme-hermes' &&
    cutoverPreflight?.mode === 'activate' &&
    hasExactKeys(cutoverPreflight, [
      'schema', 'observed_at', 'status', 'namespace', 'mode', 'cluster', 'evidence', 'checks', 'failure_codes',
    ]) &&
    hasExactKeys(cutoverPreflight?.cluster, ['context', 'namespace_uid']) &&
    cutoverPreflight?.cluster?.context === input.expectedClusterContext &&
    cutoverPreflight?.cluster?.namespace_uid === input.expectedNamespaceUid &&
    hasExactKeys(cutoverPreflight?.evidence, [
      'workloads_sha256', 'replica_sets_sha256', 'pods_sha256', 'workload_count', 'replica_set_count', 'pod_count',
      'legacy_subscriber_absent', 'legacy_subscriber_restored', 'agent_host_inert', 'consumer_fence', 'workloads', 'pods',
      'replica_sets',
    ]) &&
    cutoverPreflight?.evidence?.consumer_fence === null &&
    projectionValid(preflightWorkloads) && projectionValid(preflightReplicaSets) && projectionValid(preflightPods) &&
    preflightHosts.length === 1 && preflightHosts[0]?.replicas === 0 &&
    exactJson(preflightHosts[0]?.containers, ['agent-host']) &&
    cutoverPreflight.evidence.workload_count === preflightWorkloads.length &&
    cutoverPreflight.evidence.replica_set_count === preflightReplicaSets.length &&
    cutoverPreflight.evidence.pod_count === preflightPods.length &&
    cutoverPreflight.evidence.workloads_sha256 === sha256(JSON.stringify(preflightWorkloads)) &&
    cutoverPreflight.evidence.replica_sets_sha256 === sha256(JSON.stringify(preflightReplicaSets)) &&
    cutoverPreflight.evidence.pods_sha256 === sha256(JSON.stringify(preflightPods)) &&
    exactJson(cutoverPreflight?.checks, exactActivateChecks) &&
    exactJson(cutoverPreflight?.failure_codes, []) &&
    Number.isFinite(preflightTime) && preflightAge >= 0 && preflightAge <= 5 * 60_000 &&
    cutoverPreflight?.evidence?.legacy_subscriber_absent === true &&
    cutoverPreflight?.evidence?.agent_host_inert === true &&
    /^[a-f0-9]{64}$/.test(cutoverPreflight?.evidence?.workloads_sha256 ?? '') &&
    /^[a-f0-9]{64}$/.test(cutoverPreflight?.evidence?.replica_sets_sha256 ?? '') &&
    /^[a-f0-9]{64}$/.test(cutoverPreflight?.evidence?.pods_sha256 ?? '')
  check(checks, cutoverPreflightValid, 'no_overlap_preflight_fresh', 'no_overlap_preflight_invalid')
  check(checks, pod?.automountServiceAccountToken === false, 'service_account_token_disabled', 'service_account_token_enabled')
  check(checks, pod?.securityContext?.runAsNonRoot === true && container?.securityContext?.runAsNonRoot === true, 'non_root_enforced', 'non_root_not_enforced')
  check(
    checks,
    pod?.securityContext?.runAsUser === 10000 &&
      pod?.securityContext?.runAsGroup === 10000 &&
      pod?.securityContext?.fsGroup === 10000 &&
      pod?.securityContext?.fsGroupChangePolicy === 'OnRootMismatch',
    'key_permission_model_exact',
    'key_permission_model_invalid',
  )
  check(checks, container?.securityContext?.readOnlyRootFilesystem === true, 'root_filesystem_read_only', 'root_filesystem_writable')
  check(checks, container?.securityContext?.allowPrivilegeEscalation === false, 'privilege_escalation_disabled', 'privilege_escalation_enabled')
  check(checks, JSON.stringify(container?.securityContext?.capabilities?.drop) === JSON.stringify(['ALL']), 'linux_capabilities_dropped', 'linux_capabilities_not_dropped')
  check(checks, Boolean(container?.resources?.requests?.cpu && container?.resources?.requests?.memory && container?.resources?.limits?.cpu && container?.resources?.limits?.memory), 'resources_bounded', 'resources_unbounded')
  check(checks, container?.livenessProbe?.httpGet?.path === '/live' && container?.readinessProbe?.httpGet?.path === '/ready', 'health_probes_configured', 'health_probes_missing')
  const containerEnv = Array.isArray(container?.env) ? container.env : []
  const expectedContainerEnv = [
    { name: 'HOME', value: '/home/mupot' },
    { name: 'MUPOT_DAEMON_CONFIG', value: '/etc/mupot/daemon.json' },
    { name: 'MUPOT_STATE_DIR', value: '/var/lib/mupot/state' },
    { name: 'MUPOT_HEALTH_PORT', value: '8080' },
    { name: 'MUPOT_REQUIRE_SIGNED_INBOX_READY', value: 'true' },
    { name: 'MUPOT_PLUGIN_MODE', value: 'operator' },
    { name: 'MUPOT_AGENT_TOKEN_FILE', value: '/run/secrets/mupot-agent/token' },
  ]
  check(
    checks,
    exactJson(containerEnv, expectedContainerEnv) &&
      (!Array.isArray(container?.envFrom) || container.envFrom.length === 0),
    'runtime_paths_exact',
    'runtime_paths_invalid',
  )
  check(checks, !containerEnv.some((entry) => entry?.name === 'MUPOT_CONTROL_CONFIG'), 'on_demand_mode_isolated', 'control_consumer_enabled')
  const pluginData = pluginConfigMap?.data
  const pluginKeysExact = pluginData && Object.keys(pluginData).sort().join('\0') === [...PLUGIN_FILES].sort().join('\0')
  const pluginBundle = pluginKeysExact ? pluginBundleHash(pluginData) : null
  const pluginConfigName = pluginKeysExact ? immutablePluginConfigMapName(pluginData) : null
  const volumes = Array.isArray(pod?.volumes) ? pod.volumes : []
  const volumeMounts = Array.isArray(container?.volumeMounts) ? container.volumeMounts : []
  const expectedVolumes = [
    { name: 'hermes-home', persistentVolumeClaim: { claimName: 'dme-hermes-data' } },
    { name: 'config', configMap: { name: 'dme-hermes-agent-host', defaultMode: 292 } },
    {
      name: 'agent-signing-key',
      secret: {
        secretName: 'dme-hermes-signing-key', defaultMode: 288,
        items: [{ key: 'dme-hermes-k8s.key', path: 'dme-hermes-k8s.key' }],
      },
    },
    { name: 'hermes-plugin', configMap: { name: pluginConfigName, defaultMode: 292 } },
    {
      name: 'agent-token',
      secret: { secretName: 'dme-mupot-agent-host', defaultMode: 288, items: [{ key: 'token', path: 'token' }] },
    },
    { name: 'runtime-state', emptyDir: {} },
    { name: 'temporary', emptyDir: {} },
  ]
  const expectedVolumeMounts = [
    { name: 'hermes-home', mountPath: '/home/mupot' },
    { name: 'config', mountPath: '/etc/mupot', readOnly: true },
    { name: 'hermes-plugin', mountPath: '/home/mupot/plugins/mupot', readOnly: true },
    { name: 'agent-signing-key', mountPath: '/home/mupot/.fleet/agents', readOnly: true },
    { name: 'agent-token', mountPath: '/run/secrets/mupot-agent', readOnly: true },
    { name: 'runtime-state', mountPath: '/var/lib/mupot' },
    { name: 'temporary', mountPath: '/tmp' },
  ]
  check(
    checks,
    exactJson(volumes, expectedVolumes) && exactJson(volumeMounts, expectedVolumeMounts),
    'volume_contract_exact',
    'volume_contract_invalid',
  )
  const signingKey = volumes.find((volume) => volume?.name === 'agent-signing-key')?.secret
  const signingMount = volumeMounts.find((mount) => mount?.name === 'agent-signing-key')
  check(
    checks,
    signingKey?.secretName === 'dme-hermes-signing-key' &&
      signingKey?.defaultMode === 288 &&
      exactJson(signingKey?.items, [{ key: 'dme-hermes-k8s.key', path: 'dme-hermes-k8s.key' }]) &&
      signingMount?.mountPath === '/home/mupot/.fleet/agents' && signingMount?.readOnly === true,
    'agent_signing_key_mounted',
    'agent_signing_key_missing',
  )
  const hermesHome = volumes.find((volume) => volume?.name === 'hermes-home')?.persistentVolumeClaim
  const hermesHomeMount = volumeMounts.find((mount) => mount?.name === 'hermes-home')
  const hermesPlugin = volumes.find((volume) => volume?.name === 'hermes-plugin')?.configMap
  const hermesPluginMount = volumeMounts.find((mount) => mount?.name === 'hermes-plugin')
  const agentToken = volumes.find((volume) => volume?.name === 'agent-token')?.secret
  const agentTokenMount = volumeMounts.find((mount) => mount?.name === 'agent-token')
  check(
    checks,
    hermesHome?.claimName === 'dme-hermes-data' && hermesHomeMount?.mountPath === '/home/mupot' &&
      hermesPlugin?.name === pluginConfigName && hermesPlugin?.defaultMode === 292 &&
      hermesPluginMount?.mountPath === '/home/mupot/plugins/mupot' && hermesPluginMount?.readOnly === true &&
      agentToken?.secretName === 'dme-mupot-agent-host' && agentToken?.defaultMode === 288 &&
      exactJson(agentToken?.items, [{ key: 'token', path: 'token' }]) &&
      agentTokenMount?.mountPath === '/run/secrets/mupot-agent' && agentTokenMount?.readOnly === true,
    'hermes_runtime_mounted',
    'hermes_runtime_missing',
  )

  const pluginArtifactValid = pluginConfigMap?.apiVersion === 'v1' && pluginConfigMap?.kind === 'ConfigMap' &&
    hasExactKeys(pluginConfigMap, ['apiVersion', 'kind', 'metadata', 'immutable', 'data']) &&
    exactJson(pluginConfigMap?.metadata, { name: pluginConfigName }) && pluginConfigMap?.immutable === true && pluginKeysExact &&
    /name:\s*mupot\b/.test(pluginData?.['plugin.yaml'] ?? '') &&
    /version:\s*["']?0\.3\.0/.test(pluginData?.['plugin.yaml'] ?? '') &&
    /MUPOT_PLUGIN_MODE/.test(pluginData?.['__init__.py'] ?? '') &&
    /["']mupot-operator["']/.test(pluginData?.['operator.py'] ?? '')
  check(checks, pluginArtifactValid, 'plugin_artifact_exact', 'plugin_artifact_invalid')
  const smokePod = pluginSmokeJob?.spec?.template?.spec
  const smokeContainers = Array.isArray(smokePod?.containers) ? smokePod.containers : []
  const smokeContainer = smokeContainers[0]
  let expectedSmokeJob = null
  try {
    expectedSmokeJob = yamlDocuments(readFileSync(resolve(ROOT, 'deploy/kubernetes/agent-host/plugin-smoke-job.yaml'), 'utf8'))[0]
    expectedSmokeJob.spec.template.spec.containers[0].image = container?.image
    expectedSmokeJob.spec.template.spec.volumes.find((volume) => volume?.name === 'hermes-plugin').configMap.name =
      pluginConfigName
  } catch {
    // Exact comparison below fails closed.
  }
  const smokeJobValid = smokeContainers.length === 1 && smokeContainer?.image === container?.image &&
    exactJson(pluginSmokeJob, expectedSmokeJob)
  check(checks, smokeJobValid, 'plugin_smoke_job_bound', 'plugin_smoke_job_unbound')
  let expectedSmokePolicy = null
  try {
    expectedSmokePolicy = yamlDocuments(readFileSync(
      resolve(ROOT, 'deploy/kubernetes/agent-host/plugin-smoke-network-policy.yaml'),
      'utf8',
    ))[0]
  } catch {
    // Exact comparison below fails closed.
  }
  const smokePolicyValid = exactJson(pluginSmokeNetworkPolicy, expectedSmokePolicy) &&
    exactJson(pluginSmokeNetworkPolicy?.spec?.podSelector?.matchLabels, {
      'app.kubernetes.io/name': 'mupot-agent-host-smoke',
      'app.kubernetes.io/instance': 'dme-hermes',
    }) && exactJson(pluginSmokeNetworkPolicy?.spec?.policyTypes, ['Ingress', 'Egress']) &&
    exactJson(pluginSmokeNetworkPolicy?.spec?.ingress, []) && exactJson(pluginSmokeNetworkPolicy?.spec?.egress, [])
  check(checks, smokePolicyValid, 'plugin_smoke_network_isolated', 'plugin_smoke_network_unrestricted')
  const smokeObservedAt = Date.parse(pluginSmokeEvidence?.observed_at ?? '')
  const smokeCompletionTime = Date.parse(pluginSmokeEvidence?.job?.completion_time ?? '')
  const smokeEvidenceAge = Date.now() - smokeObservedAt
  const smokeCompletionAge = Date.now() - smokeCompletionTime
  const expectedExecutionHash = pluginSmokeJob ? kubernetesJobExecutionContractHash(pluginSmokeJob) : null
  const expectedPodExecutionHash = pluginSmokeJob
    ? kubernetesPodExecutionContractHash(pluginSmokeJob?.spec?.template?.spec)
    : null
  const pluginSmokeValid = pluginSmokeEvidence?.schema === KUBERNETES_HERMES_PLUGIN_SMOKE_EVIDENCE_TYPE &&
    pluginSmokeEvidence?.status === 'pass' && pluginSmokeEvidence?.namespace === 'dme-hermes' &&
    pluginSmokeEvidence?.image_digest === imageDigest && pluginSmokeEvidence?.pod?.image_digest === imageDigest &&
    pluginSmokeEvidence?.pod?.phase === 'Succeeded' &&
    typeof pluginSmokeEvidence?.job?.uid === 'string' && pluginSmokeEvidence.job.uid.length > 0 &&
    typeof pluginSmokeEvidence?.pod?.uid === 'string' && pluginSmokeEvidence.pod.uid.length > 0 &&
    /^[a-f0-9]{64}$/.test(pluginSmokeEvidence?.pod?.image_id_sha256 ?? '') &&
    pluginSmokeEvidence?.pod?.execution_contract_sha256 === expectedPodExecutionHash &&
    pluginSmokeEvidence?.job?.name === pluginSmokeJob?.metadata?.name &&
    pluginSmokeEvidence?.job?.execution_contract_sha256 === expectedExecutionHash &&
    pluginSmokeEvidence?.plugin_bundle_sha256 === pluginBundle &&
    pluginSmokeEvidence?.plugin_config_map?.name === pluginConfigName &&
    typeof pluginSmokeEvidence?.plugin_config_map?.uid === 'string' &&
    pluginSmokeEvidence.plugin_config_map.uid.length > 0 &&
    typeof pluginSmokeEvidence?.plugin_config_map?.resource_version === 'string' &&
    pluginSmokeEvidence.plugin_config_map.resource_version.length > 0 &&
    exactJson(pluginSmokeEvidence?.plugin, { name: 'mupot', version: '0.3.0', enabled: true, toolset: 'mupot-operator' }) &&
    Number.isFinite(smokeObservedAt) && smokeEvidenceAge >= 0 && smokeEvidenceAge <= 15 * 60_000 &&
    Number.isFinite(smokeCompletionTime) && smokeCompletionAge >= 0 && smokeCompletionAge <= 15 * 60_000 &&
    Array.isArray(pluginSmokeEvidence?.failure_codes) && pluginSmokeEvidence.failure_codes.length === 0 &&
    Array.isArray(pluginSmokeEvidence?.checks) && pluginSmokeEvidence.checks.length > 0 &&
    pluginSmokeEvidence.checks.every((entry) => entry?.ok === true)
  check(checks, pluginSmokeValid, 'plugin_discovery_smoke_bound', 'plugin_discovery_smoke_unbound')

  const policy = networkPolicy?.spec
  check(checks, Array.isArray(policy?.ingress) && policy.ingress.length === 0, 'ingress_denied', 'ingress_not_denied')
  const egressText = JSON.stringify(policy?.egress ?? [])
  check(checks, Array.isArray(policy?.egress) && policy.egress.length === 2 && egressText.includes('trusted-egress') && !egressText.includes('0.0.0.0/0'), 'egress_restricted', 'egress_not_restricted')

  let inboxConfig = null
  let daemonConfig = null
  let mountedDaemon = null
  let mountedInbox = null
  try {
    inboxConfig = validateInboxConfig(config?.inbox)
  } catch {
    // The receipt reports only a stable failure code, never raw config errors.
  }
  try {
    daemonConfig = validateDaemonConfig(config?.daemon)
  } catch {
    // The receipt reports only a stable failure code, never raw config errors.
  }
  try {
    mountedDaemon = JSON.parse(configMap?.data?.['daemon.json'])
    mountedInbox = JSON.parse(configMap?.data?.['inbox-handler.json'])
  } catch {
    // Checked below without exposing the rendered configuration.
  }
  const profile = normalizeAgentProfile(config?.inbox?.agents?.[0]?.profile)
  const configSchemaExact = hasExactConfigSchema(config, configMap)
  const projectPolicyBound = validRef(config?.project_id) &&
    profile?.allowed_project_ids?.length === 1 &&
    profile.allowed_project_ids[0] === config.project_id
  check(checks, config?.schema === 'mupot.kubernetes-agent-host/v1' && config?.tenant === 'dme', 'dme_owned_config', 'dme_config_invalid')
  check(checks, configSchemaExact, 'config_schema_exact', 'config_schema_invalid')
  check(checks, validRef(config?.project_id) && !String(config?.project_id ?? '').includes('replace-with'), 'project_bound', 'project_placeholder')
  check(checks, projectPolicyBound, 'project_policy_bound', 'project_policy_mismatch')
  check(checks, inboxConfig?.agents?.size === 1 && inboxConfig.agents.get(profile?.agent_id)?.profile != null, 'inbox_config_valid', 'inbox_config_invalid')
  check(checks, Boolean(profile) && profile.agent_id === config?.inbox?.agents?.[0]?.agent_id, 'agent_profile_valid', 'agent_profile_invalid')
  check(
    checks,
    daemonConfig?.tenant === config?.tenant && daemonConfig?.baseUrl === config?.base_url &&
      daemonConfig?.agents?.length === 1 && daemonConfig.agents[0]?.agent_id === profile?.agent_id &&
      daemonConfig.agents[0]?.inbox?.timeoutMs === config?.daemon?.agents?.[0]?.inbox?.timeout_ms &&
      config?.daemon?.agents?.[0]?.inbox?.timeout_ms >= profile?.timeout_ms + 30_000,
    'daemon_config_valid',
    'daemon_config_invalid',
  )
  check(
    checks,
    exactJson(mountedDaemon, config?.daemon) && exactJson(mountedInbox, config?.inbox),
    'mounted_config_matches',
    'mounted_config_mismatch',
  )
  const manifestText = `${deploymentSource}\n${networkPolicySource}\n${configSource}`
  check(
    checks,
      !SECRET_VALUE_RE.test(manifestText) && !MUPOT_TOKEN_RE.test(manifestText) &&
      !containsCredentialMaterial(config) &&
      !containsCredentialMaterial(parsedConfigMapValues(configMap?.data)) &&
      !containsCredentialMaterial(pluginSmokeEvidence) &&
      !containsCredentialMaterial(imageProvenance) &&
      !containsCredentialMaterial(cutoverPreflight) &&
      !containsYamlCredentialMaterial(deploymentDocuments) &&
      !containsYamlCredentialMaterial(networkPolicyDocuments) &&
      !containsPluginSecretMaterial(pluginConfigMapDocuments) &&
      !containsYamlCredentialMaterial(pluginSmokeJobDocuments) &&
      !containsYamlCredentialMaterial(pluginSmokeNetworkPolicyDocuments),
    'literal_credentials_absent',
    'literal_credential_found',
  )

  const failed = checks.filter((entry) => !entry.ok)
  return {
    receipt_type: KUBERNETES_AGENT_HOST_RECEIPT_TYPE,
    generated_at: new Date().toISOString(),
    status: failed.length === 0 ? 'pass' : 'fail',
    target: {
      tenant: config?.tenant === 'dme' ? 'dme' : null,
      project_id: projectPolicyBound ? config.project_id : null,
      agent_id: profile?.agent_id ?? null,
      image_digest: imageDigest,
      profile_sha256: profile ? sha256(JSON.stringify(profile)) : null,
    },
    artifacts,
    checks,
    failure_codes: failed.map((entry) => entry.code),
    next_steps: failed.length === 0
      ? ['attach this redacted receipt to the DME project Evidence view']
      : ['render immutable DME-owned manifests and rerun the Kubernetes Agent Host receipt'],
  }
}

export function parseArgs(argv) {
  const opts = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[index]
    }
    if (arg === '--deployment') opts.deploymentPath = next()
    else if (arg === '--network-policy') opts.networkPolicyPath = next()
    else if (arg === '--config') opts.configPath = next()
    else if (arg === '--plugin-config-map') opts.pluginConfigMapPath = next()
    else if (arg === '--plugin-smoke-job') opts.pluginSmokeJobPath = next()
    else if (arg === '--plugin-smoke-network-policy') opts.pluginSmokeNetworkPolicyPath = next()
    else if (arg === '--plugin-smoke-evidence') opts.pluginSmokeEvidencePath = next()
    else if (arg === '--image-provenance') opts.imageProvenancePath = next()
    else if (arg === '--cutover-preflight') opts.cutoverPreflightPath = next()
    else if (arg === '--cluster-context') opts.expectedClusterContext = next()
    else if (arg === '--namespace-uid') opts.expectedNamespaceUid = next()
    else if (arg === '--image-digest') opts.expectedImageDigest = next()
    else if (arg === '--summary') opts.summary = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

function usage() {
  return [
    'Usage: node scripts/kubernetes-agent-host-receipt.mjs [options]',
    '  --deployment <path>       rendered Deployment YAML',
    '  --network-policy <path>   rendered NetworkPolicy YAML',
    '  --config <path>           sterile Agent Host config JSON',
    '  --plugin-config-map <path> exact rendered Hermes plugin ConfigMap',
    '  --plugin-smoke-job <path> rendered non-consuming plugin smoke Job',
    '  --plugin-smoke-network-policy <path> exact deny-all smoke NetworkPolicy',
    '  --plugin-smoke-evidence <path> cluster-bound plugin discovery evidence JSON',
    '  --image-provenance <path> source-bound image provenance JSON',
    '  --cutover-preflight <path> fresh no-overlap Kubernetes preflight JSON',
    '  --cluster-context <name>   expected kubectl context for activation',
    '  --namespace-uid <uid>      expected dme-hermes namespace UID',
    '  --image-digest <digest>   expected sha256 image digest',
    '  --summary                 print compact status',
  ].join('\n')
}

function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`kubernetes-agent-host-receipt: ${error?.message ?? error}`)
    process.exitCode = 2
    return
  }
  if (opts.help) {
    console.log(usage())
    return
  }
  const receipt = buildKubernetesAgentHostReceipt(opts)
  if (opts.summary) console.log(`${receipt.receipt_type}: ${receipt.status} (${receipt.checks.filter((entry) => entry.ok).length}/${receipt.checks.length} checks)`)
  else console.log(JSON.stringify(receipt, null, 2))
  if (receipt.status !== 'pass') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
