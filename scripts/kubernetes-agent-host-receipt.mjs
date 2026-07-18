#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseAllDocuments } from 'yaml'

import { normalizeAgentProfile } from '../fleet-runtime/profile-contract.mjs'
import { validateConfig as validateInboxConfig } from '../fleet-runtime/inbox-handler.mjs'

export const KUBERNETES_AGENT_HOST_RECEIPT_TYPE = 'mupot-kubernetes-agent-host-receipt/v1'

const IMAGE_DIGEST_RE = /^sha256:[a-f0-9]{64}$/
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const SECRET_VALUE_RE = /Bearer\s+\S+|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i
const MUPOT_TOKEN_RE = /\bmupot_[a-z0-9_-]{16,}\b/

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function readArtifact(path, role) {
  const source = readFileSync(path, 'utf8')
  return { source, evidence: { role, filename: basename(path), sha256: sha256(source) } }
}

function yamlDocument(source, kind) {
  return parseAllDocuments(source).map((document) => document.toJSON()).find((document) => document?.kind === kind)
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
  let networkPolicy
  let config

  try {
    const artifact = readArtifact(deploymentPath, 'deployment')
    deploymentSource = artifact.source
    artifacts.push(artifact.evidence)
    deployment = yamlDocument(deploymentSource, 'Deployment')
    check(checks, Boolean(deployment), 'deployment_parseable', 'deployment_invalid')
  } catch {
    check(checks, false, 'deployment_parseable', 'deployment_invalid')
  }
  try {
    const artifact = readArtifact(networkPolicyPath, 'network_policy')
    networkPolicySource = artifact.source
    artifacts.push(artifact.evidence)
    networkPolicy = yamlDocument(networkPolicySource, 'NetworkPolicy')
    check(checks, Boolean(networkPolicy), 'network_policy_parseable', 'network_policy_invalid')
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
  check(checks, container?.securityContext?.readOnlyRootFilesystem === true, 'root_filesystem_read_only', 'root_filesystem_writable')
  check(checks, container?.securityContext?.allowPrivilegeEscalation === false, 'privilege_escalation_disabled', 'privilege_escalation_enabled')
  check(checks, JSON.stringify(container?.securityContext?.capabilities?.drop) === JSON.stringify(['ALL']), 'linux_capabilities_dropped', 'linux_capabilities_not_dropped')
  check(checks, Boolean(container?.resources?.requests?.cpu && container?.resources?.requests?.memory && container?.resources?.limits?.cpu && container?.resources?.limits?.memory), 'resources_bounded', 'resources_unbounded')
  check(checks, container?.livenessProbe?.httpGet?.path === '/live' && container?.readinessProbe?.httpGet?.path === '/ready', 'health_probes_configured', 'health_probes_missing')
  const secretNames = Array.isArray(pod?.volumes)
    ? pod.volumes.map((volume) => volume?.secret?.secretName).filter(Boolean)
    : []
  check(checks, secretNames.includes('dme-hermes-mupot'), 'dme_secret_referenced', 'dme_secret_missing')

  const policy = networkPolicy?.spec
  check(checks, Array.isArray(policy?.ingress) && policy.ingress.length === 0, 'ingress_denied', 'ingress_not_denied')
  const egressText = JSON.stringify(policy?.egress ?? [])
  check(checks, Array.isArray(policy?.egress) && policy.egress.length === 2 && egressText.includes('trusted-egress') && !egressText.includes('0.0.0.0/0'), 'egress_restricted', 'egress_not_restricted')

  let inboxConfig = null
  try {
    inboxConfig = validateInboxConfig(config?.inbox)
  } catch {
    // The receipt reports only a stable failure code, never raw config errors.
  }
  const profile = normalizeAgentProfile(config?.inbox?.agents?.[0]?.profile)
  check(checks, config?.schema === 'mupot.kubernetes-agent-host/v1' && config?.tenant === 'dme', 'dme_owned_config', 'dme_config_invalid')
  check(checks, validRef(config?.project_id) && !String(config?.project_id ?? '').includes('replace-with'), 'project_bound', 'project_placeholder')
  check(checks, inboxConfig?.agents?.size === 1 && inboxConfig.agents.get(profile?.agent_id)?.profile != null, 'inbox_config_valid', 'inbox_config_invalid')
  check(checks, Boolean(profile) && profile.agent_id === config?.inbox?.agents?.[0]?.agent_id, 'agent_profile_valid', 'agent_profile_invalid')
  const manifestText = `${deploymentSource}\n${networkPolicySource}\n${configSource}`
  check(checks, !SECRET_VALUE_RE.test(manifestText) && !MUPOT_TOKEN_RE.test(manifestText), 'literal_credentials_absent', 'literal_credential_found')

  const failed = checks.filter((entry) => !entry.ok)
  return {
    receipt_type: KUBERNETES_AGENT_HOST_RECEIPT_TYPE,
    generated_at: new Date().toISOString(),
    status: failed.length === 0 ? 'pass' : 'fail',
    target: {
      tenant: config?.tenant === 'dme' ? 'dme' : null,
      project_id: validRef(config?.project_id) ? config.project_id : null,
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
