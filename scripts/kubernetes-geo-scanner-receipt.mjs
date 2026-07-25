#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAllDocuments } from 'yaml'

import { validateScannerConfig } from '../fleet-runtime/geo-scanner/contract.mjs'

export const KUBERNETES_GEO_SCANNER_RECEIPT_TYPE =
  'mupot-kubernetes-geo-scanner-receipt/v1'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IMAGE_DIGEST_RE = /^sha256:[a-f0-9]{64}$/
const UNRESOLVED_PROJECT_ID = '00000000-0000-4000-8000-000000000000'
const SECRET_MATERIAL_RE =
  /Bearer\s+\S+|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bmupot_[A-Za-z0-9_-]{16,}\b/
const RUNTIME_FILES = [
  'contract.mjs',
  'budget.mjs',
  'vertex.mjs',
  'sinks.mjs',
  'scanner.mjs',
  'cli.mjs',
]

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function readArtifact(path, role) {
  const source = readFileSync(path, 'utf8')
  return {
    source,
    evidence: { role, filename: basename(path), sha256: sha256(source) },
  }
}

function yamlDocuments(source) {
  const parsed = parseAllDocuments(source)
  if (parsed.some((document) => document.errors.length > 0)) throw new Error('invalid_yaml')
  return parsed.map((document) => document.toJSON())
}

function addCheck(checks, ok, check, code) {
  checks.push({ check, ok: Boolean(ok), ...(ok ? {} : { code }) })
}

function exactImageDigest(image) {
  if (typeof image !== 'string') return null
  const separator = image.lastIndexOf('@')
  if (separator < 1) return null
  const digest = image.slice(separator + 1)
  return IMAGE_DIGEST_RE.test(digest) ? digest : null
}

function credentialFree(documents, sources) {
  if (sources.some((source) => SECRET_MATERIAL_RE.test(source))) return false
  return documents.every((document) => {
    if (document?.kind === 'Secret') return false
    if (document?.data || document?.stringData) {
      if (document.kind !== 'ConfigMap') return false
    }
    return true
  })
}

function expectedRuntimePackaged(dockerfile) {
  return RUNTIME_FILES.every((name) =>
    dockerfile.includes(`fleet-runtime/geo-scanner/${name}`))
    && !dockerfile.includes('fleet-runtime/geo-scanner/contract.test.mjs')
}

export function buildKubernetesGeoScannerReceipt(input = {}) {
  const root = resolve(input.root ?? ROOT)
  const cronjobPath = resolve(input.cronjobPath
    ?? resolve(root, 'deploy/kubernetes/geo-scanner/viamar-cronjob.yaml'))
  const networkPolicyPath = resolve(input.networkPolicyPath
    ?? resolve(root, 'deploy/kubernetes/geo-scanner/network-policy.yaml'))
  const profilePath = resolve(input.profilePath
    ?? resolve(root, 'deploy/kubernetes/geo-scanner/viamar-profile.json'))
  const dockerfilePath = resolve(input.dockerfilePath
    ?? resolve(root, 'deploy/kubernetes/agent-host/Dockerfile.hermes'))
  const checks = []
  const artifacts = []
  let cronjobSource = ''
  let networkPolicySource = ''
  let profileSource = ''
  let dockerfileSource = ''
  let documents = []
  let networkDocuments = []
  let profile

  try {
    const artifact = readArtifact(cronjobPath, 'project_cell')
    cronjobSource = artifact.source
    artifacts.push(artifact.evidence)
    documents = yamlDocuments(cronjobSource)
    addCheck(
      checks,
      ['ServiceAccount', 'ConfigMap', 'PersistentVolumeClaim', 'CronJob']
        .every((kind) => documents.filter((document) => document?.kind === kind).length === 1)
        && documents.length === 4,
      'project_cell_parseable',
      'project_cell_invalid',
    )
  } catch {
    addCheck(checks, false, 'project_cell_parseable', 'project_cell_invalid')
  }
  try {
    const artifact = readArtifact(networkPolicyPath, 'network_policy')
    networkPolicySource = artifact.source
    artifacts.push(artifact.evidence)
    networkDocuments = yamlDocuments(networkPolicySource)
    addCheck(
      checks,
      networkDocuments.length === 1 && networkDocuments[0]?.kind === 'NetworkPolicy',
      'network_policy_parseable',
      'network_policy_invalid',
    )
  } catch {
    addCheck(checks, false, 'network_policy_parseable', 'network_policy_invalid')
  }
  try {
    const artifact = readArtifact(profilePath, 'profile')
    profileSource = artifact.source
    artifacts.push(artifact.evidence)
    profile = validateScannerConfig(JSON.parse(profileSource))
    addCheck(checks, true, 'profile_valid', 'profile_invalid')
  } catch {
    addCheck(checks, false, 'profile_valid', 'profile_invalid')
  }
  try {
    const artifact = readArtifact(dockerfilePath, 'dockerfile')
    dockerfileSource = artifact.source
    artifacts.push(artifact.evidence)
    addCheck(
      checks,
      expectedRuntimePackaged(dockerfileSource),
      'runtime_packaged',
      'runtime_files_missing',
    )
  } catch {
    addCheck(checks, false, 'runtime_packaged', 'runtime_files_missing')
  }

  const serviceAccount = documents.find((document) => document?.kind === 'ServiceAccount')
  const configMap = documents.find((document) => document?.kind === 'ConfigMap')
  const claim = documents.find((document) => document?.kind === 'PersistentVolumeClaim')
  const cronjob = documents.find((document) => document?.kind === 'CronJob')
  const pod = cronjob?.spec?.jobTemplate?.spec?.template?.spec
  const container = pod?.containers?.[0]
  const policy = networkDocuments[0]
  let embeddedProfile
  try {
    embeddedProfile = validateScannerConfig(JSON.parse(configMap?.data?.['profile.json']))
  } catch {
    embeddedProfile = null
  }
  addCheck(
    checks,
    Boolean(profile && embeddedProfile && JSON.stringify(profile) === JSON.stringify(embeddedProfile)),
    'profile_matches_config_map',
    'profile_config_map_drift',
  )
  addCheck(
    checks,
    serviceAccount?.metadata?.name === 'viamar-geo-scanner'
      && serviceAccount?.metadata?.annotations?.['iam.gke.io/gcp-service-account']
        === 'mumega-agent@mumegaproject.iam.gserviceaccount.com'
      && pod?.serviceAccountName === 'viamar-geo-scanner'
      && pod?.automountServiceAccountToken === true,
    'workload_identity_scoped',
    'workload_identity_invalid',
  )
  addCheck(
    checks,
    cronjob?.spec?.suspend === true
      && cronjob?.spec?.concurrencyPolicy === 'Forbid'
      && cronjob?.spec?.jobTemplate?.spec?.backoffLimit === 0
      && cronjob?.spec?.jobTemplate?.spec?.activeDeadlineSeconds === 600,
    'execution_bounded',
    'execution_unbounded',
  )
  const volumes = Array.isArray(pod?.volumes) ? pod.volumes : []
  const mounts = Array.isArray(container?.volumeMounts) ? container.volumeMounts : []
  addCheck(
    checks,
    ['posthog-token', 'mupot-token'].every((name) => {
      const volume = volumes.find((candidate) => candidate.name === name)
      const mount = mounts.find((candidate) => candidate.name === name)
      return Boolean(volume?.secret?.secretName && mount?.readOnly === true)
    })
      && volumes.some((volume) =>
        volume.name === 'budget-state'
        && volume.persistentVolumeClaim?.claimName === 'viamar-geo-scanner-state')
      && claim?.metadata?.name === 'viamar-geo-scanner-state',
    'project_secrets_and_budget_scoped',
    'project_scope_invalid',
  )
  addCheck(
    checks,
    pod?.securityContext?.runAsNonRoot === true
      && pod?.securityContext?.runAsUser === 10000
      && container?.securityContext?.readOnlyRootFilesystem === true
      && container?.securityContext?.allowPrivilegeEscalation === false
      && JSON.stringify(container?.securityContext?.capabilities?.drop) === '["ALL"]'
      && Boolean(container?.resources?.requests?.cpu)
      && Boolean(container?.resources?.limits?.memory),
    'container_hardened',
    'container_security_invalid',
  )
  addCheck(
    checks,
    policy?.spec?.ingress?.length === 0
      && policy?.spec?.egress?.length === 3
      && JSON.stringify(policy).includes('169.254.169.254/32')
      && JSON.stringify(policy).includes('trusted-egress')
      && !JSON.stringify(policy).includes('0.0.0.0/0'),
    'network_confined',
    'network_policy_open',
  )
  addCheck(
    checks,
    credentialFree([...documents, ...networkDocuments], [
      cronjobSource,
      networkPolicySource,
      profileSource,
      dockerfileSource,
    ]),
    'credential_free',
    'credential_material_present',
  )
  const imageDigest = exactImageDigest(container?.image)
  addCheck(
    checks,
    Boolean(profile?.projectId && profile.projectId !== UNRESOLVED_PROJECT_ID),
    'project_id_resolved',
    'project_id_unresolved',
  )
  addCheck(
    checks,
    Boolean(imageDigest),
    'image_digest_pinned',
    'image_digest_unresolved',
  )

  const failed = checks.filter((entry) => !entry.ok)
  const planOnly = failed.length > 0
    && failed.every((entry) =>
      entry.check === 'image_digest_pinned' || entry.check === 'project_id_resolved')
  return {
    schema: KUBERNETES_GEO_SCANNER_RECEIPT_TYPE,
    status: failed.length === 0 ? 'pass' : planOnly ? 'plan' : 'fail',
    project_id: profile?.projectId ?? null,
    image_digest: imageDigest,
    checks,
    artifacts,
  }
}

async function main() {
  const receipt = buildKubernetesGeoScannerReceipt()
  console.log(JSON.stringify(receipt, null, 2))
  process.exitCode = receipt.status === 'fail' ? 1 : 0
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
