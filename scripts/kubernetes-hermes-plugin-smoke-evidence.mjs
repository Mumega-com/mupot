#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseAllDocuments } from 'yaml'

import { HERMES_PLUGIN_SMOKE_TYPE, PLUGIN_FILES, pluginBundleHash } from '../fleet-runtime/hermes-plugin-smoke.mjs'

export const KUBERNETES_HERMES_PLUGIN_SMOKE_EVIDENCE_TYPE =
  'mupot.kubernetes-hermes-plugin-smoke-evidence/v1'

const IMAGE_DIGEST_RE = /^sha256:[a-f0-9]{64}$/

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]))
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value))
}

function exact(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function check(checks, ok, name, code) {
  checks.push({ check: name, ok: Boolean(ok), ...(ok ? {} : { code }) })
}

function imageDigest(value) {
  if (typeof value !== 'string') return null
  const match = value.match(/sha256:[a-f0-9]{64}(?:$|\b)/)
  return match?.[0] ?? null
}

export function immutablePluginConfigMapName(data) {
  return `dme-mupot-plugin-${pluginBundleHash(data)}`
}

export function renderImmutablePluginConfigMap(source) {
  const data = source?.data
  const keys = data && typeof data === 'object' ? Object.keys(data).sort() : []
  if (!exact(keys, [...PLUGIN_FILES].sort())) throw new Error('plugin ConfigMap files invalid')
  return {
    apiVersion: 'v1', kind: 'ConfigMap',
    metadata: { name: immutablePluginConfigMapName(data) },
    immutable: true,
    data,
  }
}

function pluginConfigMapContract(configMap) {
  return {
    apiVersion: configMap?.apiVersion ?? null,
    kind: configMap?.kind ?? null,
    metadata: { name: configMap?.metadata?.name ?? null },
    immutable: configMap?.immutable ?? null,
    data: configMap?.data ?? null,
    binaryData: configMap?.binaryData ?? null,
  }
}

export function kubernetesJobExecutionContract(job) {
  const value = job && typeof job === 'object' ? structuredClone(job) : {}
  delete value.status
  value.metadata = {
    name: value.metadata?.name ?? null,
    labels: value.metadata?.labels ?? null,
  }
  const spec = value.spec ?? {}
  delete spec.selector
  delete spec.manualSelector
  for (const [key, defaultValue] of Object.entries({
    completionMode: 'NonIndexed', completions: 1, parallelism: 1,
    podReplacementPolicy: 'TerminatingOrFailed', suspend: false,
  })) {
    if (exact(spec[key], defaultValue)) delete spec[key]
  }
  const template = spec.template ?? {}
  if (template.metadata?.labels) {
    for (const key of [
      'batch.kubernetes.io/controller-uid', 'batch.kubernetes.io/job-name', 'controller-uid', 'job-name',
    ]) delete template.metadata.labels[key]
  }
  template.metadata = { labels: template.metadata?.labels ?? null }
  const pod = template.spec ?? {}
  for (const [key, defaultValue] of Object.entries({
    dnsPolicy: 'ClusterFirst', schedulerName: 'default-scheduler', terminationGracePeriodSeconds: 30,
  })) {
    if (exact(pod[key], defaultValue)) delete pod[key]
  }
  for (const container of [...(pod.initContainers ?? []), ...(pod.containers ?? [])]) {
    if (container.terminationMessagePath === '/dev/termination-log') delete container.terminationMessagePath
    if (container.terminationMessagePolicy === 'File') delete container.terminationMessagePolicy
  }
  spec.template = template
  value.spec = spec
  return value
}

export function kubernetesJobExecutionContractHash(job) {
  return sha256(canonicalJson(kubernetesJobExecutionContract(job)))
}

function normalizedPodSpec(raw) {
  const pod = raw && typeof raw === 'object' ? structuredClone(raw) : {}
  delete pod.nodeName
  for (const [key, defaultValue] of Object.entries({
    dnsPolicy: 'ClusterFirst', schedulerName: 'default-scheduler', terminationGracePeriodSeconds: 30,
    serviceAccount: 'default', serviceAccountName: 'default', preemptionPolicy: 'PreemptLowerPriority', priority: 0,
    restartPolicy: 'Always',
  })) {
    if (exact(pod[key], defaultValue)) delete pod[key]
  }
  if (Array.isArray(pod.tolerations)) {
    pod.tolerations = pod.tolerations.filter((entry) => ![
      'node.kubernetes.io/not-ready', 'node.kubernetes.io/unreachable',
    ].includes(entry?.key) || entry?.effect !== 'NoExecute' || entry?.tolerationSeconds !== 300)
    if (pod.tolerations.length === 0) delete pod.tolerations
  }
  for (const container of [
    ...(pod.initContainers ?? []), ...(pod.containers ?? []), ...(pod.ephemeralContainers ?? []),
  ]) {
    if (container.terminationMessagePath === '/dev/termination-log') delete container.terminationMessagePath
    if (container.terminationMessagePolicy === 'File') delete container.terminationMessagePolicy
    for (const probe of [container.livenessProbe, container.readinessProbe, container.startupProbe]) {
      if (!probe || typeof probe !== 'object') continue
      if (probe.successThreshold === 1) delete probe.successThreshold
      if (probe.httpGet?.scheme === 'HTTP') delete probe.httpGet.scheme
    }
  }
  return pod
}

export function kubernetesPodExecutionContractHash(podSpec) {
  return sha256(canonicalJson(normalizedPodSpec(podSpec)))
}

function parseSmokeLog(logs) {
  const lines = String(logs ?? '').trim().split(/\r?\n/).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index])
      if (value?.schema === HERMES_PLUGIN_SMOKE_TYPE) return value
    } catch {
      // Non-JSON process output is not evidence.
    }
  }
  return null
}

export function buildKubernetesHermesPluginSmokeEvidence(input = {}) {
  const checks = []
  const expectedJob = input.expectedJob
  const observedJob = input.observedJob
  const pods = Array.isArray(input.pods) ? input.pods : []
  const expectedPluginConfigMap = input.expectedPluginConfigMap
  const observedPluginConfigMap = input.observedPluginConfigMap
  const pluginData = expectedPluginConfigMap?.data
  const expectedDigest = input.expectedImageDigest
  const expectedContract = kubernetesJobExecutionContract(expectedJob)
  const observedContract = kubernetesJobExecutionContract(observedJob)
  const smoke = parseSmokeLog(input.logs)
  const pod = pods.length === 1 ? pods[0] : null
  const containerStatuses = Array.isArray(pod?.status?.containerStatuses) ? pod.status.containerStatuses : []
  const status = containerStatuses.length === 1 ? containerStatuses[0] : null
  const observedDigest = imageDigest(status?.imageID)
  const expectedContainer = expectedJob?.spec?.template?.spec?.containers?.[0]
  const bundle = pluginData && typeof pluginData === 'object' ? pluginBundleHash(pluginData) : null
  const pluginName = pluginData && typeof pluginData === 'object' ? immutablePluginConfigMapName(pluginData) : null
  const expectedPluginVolume = expectedJob?.spec?.template?.spec?.volumes?.find((volume) =>
    volume?.configMap?.name === pluginName)
  const completionTime = Date.parse(observedJob?.status?.completionTime ?? '')
  const observedAt = input.now instanceof Date ? input.now : new Date(input.now ?? Date.now())
  const ageMs = observedAt.getTime() - completionTime

  check(checks, input.namespace === 'dme-hermes', 'namespace_exact', 'namespace_invalid')
  check(checks, IMAGE_DIGEST_RE.test(expectedDigest ?? ''), 'expected_image_digest_valid', 'expected_image_digest_invalid')
  check(checks, exact(expectedContract, observedContract), 'job_execution_contract_exact', 'job_execution_contract_changed')
  check(
    checks,
    pluginName && expectedPluginConfigMap?.metadata?.name === pluginName && expectedPluginConfigMap?.immutable === true &&
      expectedPluginVolume?.name === 'hermes-plugin' &&
      exact(pluginConfigMapContract(expectedPluginConfigMap), pluginConfigMapContract(observedPluginConfigMap)) &&
      typeof observedPluginConfigMap?.metadata?.uid === 'string' && observedPluginConfigMap.metadata.uid.length > 0 &&
      typeof observedPluginConfigMap?.metadata?.resourceVersion === 'string' &&
      observedPluginConfigMap.metadata.resourceVersion.length > 0,
    'immutable_plugin_config_bound',
    'immutable_plugin_config_unbound',
  )
  check(checks, imageDigest(expectedContainer?.image) === expectedDigest, 'job_image_digest_bound', 'job_image_digest_unbound')
  check(checks, pods.length === 1, 'single_smoke_pod', 'smoke_pod_count_invalid')
  const expectedPodHash = kubernetesPodExecutionContractHash(expectedJob?.spec?.template?.spec)
  const observedPodHash = kubernetesPodExecutionContractHash(pod?.spec)
  check(checks, expectedPodHash === observedPodHash, 'pod_admission_contract_exact', 'pod_admission_contract_changed')
  const owners = Array.isArray(pod?.metadata?.ownerReferences) ? pod.metadata.ownerReferences : []
  check(
    checks,
    owners.length === 1 && owners[0]?.apiVersion === 'batch/v1' && owners[0]?.kind === 'Job' &&
      owners[0]?.name === observedJob?.metadata?.name && owners[0]?.uid === observedJob?.metadata?.uid &&
      owners[0]?.controller === true,
    'smoke_pod_owned_by_job',
    'smoke_pod_owner_invalid',
  )
  check(checks, pod?.status?.phase === 'Succeeded', 'smoke_pod_succeeded', 'smoke_pod_not_succeeded')
  check(checks, containerStatuses.length === 1 && status?.name === 'plugin-smoke', 'single_smoke_container', 'smoke_container_invalid')
  check(checks, observedDigest === expectedDigest, 'runtime_image_digest_bound', 'runtime_image_digest_unbound')
  check(
    checks,
    Number.isFinite(completionTime) && ageMs >= 0 && ageMs <= 15 * 60_000,
    'smoke_observation_fresh',
    'smoke_observation_stale',
  )
  check(
    checks,
    smoke?.status === 'pass' && smoke?.plugin_bundle_sha256 === bundle &&
      exact(smoke?.plugin, { name: 'mupot', version: '0.3.0', enabled: true, toolset: 'mupot-operator' }) &&
      smoke?.exit_code === 0,
    'plugin_discovery_passed',
    'plugin_discovery_failed',
  )
  const failed = checks.filter((entry) => !entry.ok)
  return {
    schema: KUBERNETES_HERMES_PLUGIN_SMOKE_EVIDENCE_TYPE,
    observed_at: observedAt.toISOString(),
    status: failed.length === 0 ? 'pass' : 'fail',
    namespace: input.namespace === 'dme-hermes' ? input.namespace : null,
    image_digest: IMAGE_DIGEST_RE.test(expectedDigest ?? '') ? expectedDigest : null,
    job: {
      name: expectedContract.metadata.name,
      uid: typeof observedJob?.metadata?.uid === 'string' ? observedJob.metadata.uid : null,
      execution_contract_sha256: kubernetesJobExecutionContractHash(expectedJob),
      completion_time: Number.isFinite(completionTime) ? new Date(completionTime).toISOString() : null,
    },
    pod: {
      name: typeof pod?.metadata?.name === 'string' ? pod.metadata.name : null,
      uid: typeof pod?.metadata?.uid === 'string' ? pod.metadata.uid : null,
      phase: pod?.status?.phase ?? null,
      image_id_sha256: typeof status?.imageID === 'string' ? sha256(status.imageID) : null,
      image_digest: observedDigest,
      execution_contract_sha256: expectedPodHash,
    },
    plugin: smoke?.plugin ?? null,
    plugin_bundle_sha256: smoke?.plugin_bundle_sha256 ?? null,
    plugin_config_map: {
      name: pluginName,
      uid: typeof observedPluginConfigMap?.metadata?.uid === 'string' ? observedPluginConfigMap.metadata.uid : null,
      resource_version: typeof observedPluginConfigMap?.metadata?.resourceVersion === 'string'
        ? observedPluginConfigMap.metadata.resourceVersion
        : null,
    },
    checks,
    failure_codes: failed.map((entry) => entry.code),
  }
}

function yamlDocument(path) {
  const documents = parseAllDocuments(readFileSync(path, 'utf8'))
  if (documents.length !== 1 || documents[0].errors.length > 0) throw new Error(`invalid YAML: ${path}`)
  return documents[0].toJSON()
}

function kubectlJson(namespace, args) {
  return JSON.parse(execFileSync('kubectl', ['-n', namespace, ...args, '-o', 'json'], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  }))
}

function parseArgs(argv) {
  const options = { namespace: 'dme-hermes', jobName: 'dme-hermes-plugin-smoke' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[index]
    }
    if (arg === '--namespace') options.namespace = next()
    else if (arg === '--job') options.jobName = next()
    else if (arg === '--job-manifest') options.jobManifest = next()
    else if (arg === '--plugin-config-map') options.pluginConfigMap = next()
    else if (arg === '--image-digest') options.imageDigest = next()
    else if (arg === '--render-plugin-config-map') options.renderPluginConfigMap = next()
    else if (arg === '--output') options.output = next()
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log('Usage: node scripts/kubernetes-hermes-plugin-smoke-evidence.mjs (--render-plugin-config-map SOURCE | --job-manifest FILE --plugin-config-map FILE --image-digest SHA256) [--namespace dme-hermes] [--job NAME] [--output FILE]')
    return
  }
  if (options.renderPluginConfigMap) {
    const rendered = renderImmutablePluginConfigMap(yamlDocument(resolve(options.renderPluginConfigMap)))
    const output = `${JSON.stringify(rendered, null, 2)}\n`
    if (options.output) writeFileSync(resolve(options.output), output, { mode: 0o600 })
    else process.stdout.write(output)
    return
  }
  if (!options.jobManifest || !options.pluginConfigMap || !options.imageDigest) {
    throw new Error('--job-manifest, --plugin-config-map, and --image-digest are required')
  }
  const expectedJob = yamlDocument(resolve(options.jobManifest))
  const pluginConfigMap = yamlDocument(resolve(options.pluginConfigMap))
  const observedPluginConfigMap = kubectlJson(options.namespace, [
    'get', 'configmap', pluginConfigMap?.metadata?.name,
  ])
  const observedJob = kubectlJson(options.namespace, ['get', 'job', options.jobName])
  const podList = kubectlJson(options.namespace, ['get', 'pods', '-l', `job-name=${options.jobName}`])
  const logs = execFileSync('kubectl', ['-n', options.namespace, 'logs', `job/${options.jobName}`, '-c', 'plugin-smoke'], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  })
  const evidence = buildKubernetesHermesPluginSmokeEvidence({
    namespace: options.namespace,
    expectedJob,
    observedJob,
    pods: podList?.items,
    logs,
    expectedPluginConfigMap: pluginConfigMap,
    observedPluginConfigMap,
    expectedImageDigest: options.imageDigest,
  })
  const output = `${JSON.stringify(evidence, null, 2)}\n`
  if (options.output) writeFileSync(resolve(options.output), output, { mode: 0o600 })
  else process.stdout.write(output)
  if (evidence.status !== 'pass') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
