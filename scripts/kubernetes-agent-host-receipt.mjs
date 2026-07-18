#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseAllDocuments } from 'yaml'

import { normalizeAgentProfile } from '../fleet-runtime/profile-contract.mjs'
import { validateConfig as validateInboxConfig } from '../fleet-runtime/inbox-handler.mjs'
import { validateConfig as validateDaemonConfig } from '../fleet-runtime/fleet-daemon.mjs'

export const KUBERNETES_AGENT_HOST_RECEIPT_TYPE = 'mupot-kubernetes-agent-host-receipt/v1'

const IMAGE_DIGEST_RE = /^sha256:[a-f0-9]{64}$/
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const SECRET_VALUE_RE = /Bearer\s+\S+|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i
const MUPOT_TOKEN_RE = /\bmupot_[a-z0-9_-]{16,}\b/
const CREDENTIAL_FIELD_RE = /(?:^|_)(?:api[_-]?key|access[_-]?key|authorization|client[_-]?secret|credential|credentials|password|passwd|private[_-]?key|secret|token)(?:_|$)/i
const PACKAGE_KEYS = ['schema', 'tenant', 'project_id', 'base_url', 'daemon', 'inbox']
const DAEMON_KEYS = ['base_url', 'tenant', 'state_file', 'interval_sec', 'agents']
const DAEMON_AGENT_KEYS = ['agent_id', 'type', 'runtime', 'lifecycle', 'probe', 'inbox']
const DAEMON_INBOX_KEYS = ['command', 'limit']
const INBOX_KEYS = ['spool_dir', 'command_timeout_ms', 'agents']
const INBOX_AGENT_KEYS = ['agent_id', 'profile']
const CONFIG_MAP_DATA_KEYS = ['daemon.json', 'inbox-handler.json']

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
  const checks = []
  const artifacts = []
  let deploymentSource = ''
  let networkPolicySource = ''
  let configSource = ''
  let deployment
  let configMap
  let networkPolicy
  let config
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

  const pod = deployment?.spec?.template?.spec
  const containers = Array.isArray(pod?.containers) ? pod.containers : []
  const container = containers[0]
  const imageDigest = exactImageDigest(container?.image)
  check(checks, containers.length === 1, 'single_host_container', 'container_contract_invalid')
  check(checks, Boolean(imageDigest), 'image_is_immutable', 'image_not_immutable')
  const expectedImageDigest = input.expectedImageDigest ?? null
  check(
    checks,
    expectedImageDigest === null || (IMAGE_DIGEST_RE.test(expectedImageDigest) && imageDigest === expectedImageDigest),
    'image_digest_matches',
    'image_digest_mismatch',
  )
  check(checks, pod?.automountServiceAccountToken === false, 'service_account_token_disabled', 'service_account_token_enabled')
  check(checks, pod?.securityContext?.runAsNonRoot === true && container?.securityContext?.runAsNonRoot === true, 'non_root_enforced', 'non_root_not_enforced')
  check(
    checks,
    pod?.securityContext?.runAsUser === 10001 &&
      pod?.securityContext?.runAsGroup === 10001 &&
      pod?.securityContext?.fsGroup === 10001,
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
  ]
  check(
    checks,
    exactJson(containerEnv, expectedContainerEnv) &&
      (!Array.isArray(container?.envFrom) || container.envFrom.length === 0),
    'runtime_paths_exact',
    'runtime_paths_invalid',
  )
  check(checks, !containerEnv.some((entry) => entry?.name === 'MUPOT_CONTROL_CONFIG'), 'on_demand_mode_isolated', 'control_consumer_enabled')
  const volumes = Array.isArray(pod?.volumes) ? pod.volumes : []
  const signingKey = volumes.find((volume) => volume?.name === 'agent-signing-key')?.secret
  const signingMount = (Array.isArray(container?.volumeMounts) ? container.volumeMounts : []).find((mount) => mount?.name === 'agent-signing-key')
  check(
    checks,
    signingKey?.secretName === 'dme-hermes-signing-key' &&
      signingKey?.defaultMode === 288 &&
      exactJson(signingKey?.items, [{ key: 'dme-hermes-k8s.key', path: 'dme-hermes-k8s.key' }]) &&
      signingMount?.mountPath === '/home/mupot/.fleet/agents' && signingMount?.readOnly === true,
    'agent_signing_key_mounted',
    'agent_signing_key_missing',
  )

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
      daemonConfig?.agents?.length === 1 && daemonConfig.agents[0]?.agent_id === profile?.agent_id,
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
      !containsYamlCredentialMaterial(deploymentDocuments) &&
      !containsYamlCredentialMaterial(networkPolicyDocuments),
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
