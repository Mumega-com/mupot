#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { fetchConsumerFenceFromSecret } from './kubernetes-agent-host-consumer-fence.mjs'
import { agentHostPods } from './kubernetes-agent-host-pod-identity.mjs'

export const KUBERNETES_AGENT_HOST_CUTOVER_PREFLIGHT_TYPE = 'mupot.kubernetes-agent-host-cutover-preflight/v1'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function podSpecFor(item) {
  if (item?.kind === 'CronJob') return item?.spec?.jobTemplate?.spec?.template?.spec
  if (item?.kind === 'Pod') return item?.spec
  return item?.spec?.template?.spec
}

function containers(item) {
  const spec = podSpecFor(item)
  return [...(spec?.initContainers ?? []), ...(spec?.containers ?? []), ...(spec?.ephemeralContainers ?? [])]
}

function identityProjection(items) {
  return items.map((item) => ({
    kind: item?.kind ?? null,
    name: item?.metadata?.name ?? null,
    uid: item?.metadata?.uid ?? null,
    resource_version: item?.metadata?.resourceVersion ?? null,
    generation: item?.metadata?.generation ?? null,
    containers: containers(item).map((container) => container?.name ?? null),
    replicas: item?.kind === 'Deployment' ? Number(item?.spec?.replicas ?? 1) : null,
  })).sort((left, right) => `${left.kind}/${left.name}`.localeCompare(`${right.kind}/${right.name}`))
}

function check(checks, ok, name, code) {
  checks.push({ check: name, ok: Boolean(ok), ...(ok ? {} : { code }) })
}

export function buildCutoverPreflight({
  namespace, workloads = [], replicaSets = [], pods = [], now = new Date(), mode = 'activate', clusterContext, namespaceUid,
  consumerFence = null,
}) {
  const checks = []
  const workloadProjection = identityProjection(workloads)
  const replicaSetProjection = identityProjection(replicaSets)
  const podProjection = identityProjection(pods)
  const all = [...workloads, ...pods]
  const legacyConsumers = all.filter((item) =>
    containers(item).some((container) => container?.name === 'mupot-subscriber'))
  const legacyWorkloads = workloads.filter((item) =>
    containers(item).some((container) => container?.name === 'mupot-subscriber'))
  const legacyPods = pods.filter((item) =>
    containers(item).some((container) => container?.name === 'mupot-subscriber'))
  const legacyAbsent = legacyConsumers.length === 0
  const hostWorkloads = workloads.filter((item) => item?.kind === 'Deployment' && item?.metadata?.name === 'dme-hermes-agent-host')
  const hostDeployment = hostWorkloads.length === 1 ? hostWorkloads[0] : null
  const hostPods = agentHostPods({ deployment: hostDeployment, replicaSets, pods })
  const hostInert = hostWorkloads.length <= 1 && hostWorkloads.every((item) => Number(item?.spec?.replicas ?? 1) === 0) && hostPods.length === 0
  const dme = workloads.find((item) => item?.kind === 'Deployment' && item?.metadata?.name === 'dme-hermes')
  const dmeContainers = containers(dme).map((container) => container?.name).sort()
  const sourceRuntimeStable = JSON.stringify(dmeContainers) === JSON.stringify(['hermes', 'telegram-gateway'])
  const sourceRuntimeRestored = JSON.stringify(dmeContainers) ===
    JSON.stringify(['hermes', 'mupot-subscriber', 'telegram-gateway'])
  const dmeReplicas = Number(dme?.spec?.replicas ?? 1)
  const dmeRolloutReady = dmeReplicas > 0 && Number(dme?.status?.availableReplicas ?? 0) === dmeReplicas &&
    Number(dme?.status?.readyReplicas ?? 0) === dmeReplicas && Number(dme?.status?.updatedReplicas ?? 0) === dmeReplicas
  const legacyPodsReady = legacyPods.length === dmeReplicas && legacyPods.every((item) =>
    item?.status?.phase === 'Running' &&
    item?.status?.conditions?.some((condition) => condition?.type === 'Ready' && condition?.status === 'True'))
  const rollbackComplete = legacyWorkloads.length === 1 && legacyWorkloads[0] === dme &&
    legacyPods.every((item) => item?.metadata?.labels?.['app.kubernetes.io/name'] === 'dme-hermes') &&
    sourceRuntimeRestored && dmeRolloutReady && legacyPodsReady
  const validMode = ['activate', 'rollback-ready', 'rollback-complete'].includes(mode)
  check(checks, namespace === 'dme-hermes', 'namespace_exact', 'namespace_invalid')
  check(checks, validMode, 'mode_valid', 'mode_invalid')
  check(
    checks,
    typeof clusterContext === 'string' && clusterContext.length > 0 && clusterContext.length <= 256 &&
      typeof namespaceUid === 'string' && namespaceUid.length > 0 && namespaceUid.length <= 128,
    'cluster_identity_observed',
    'cluster_identity_missing',
  )
  check(checks, hostInert, 'agent_host_inert', 'agent_host_not_inert')
  if (mode === 'rollback-complete') {
    check(checks, rollbackComplete, 'legacy_subscriber_restored', 'legacy_subscriber_not_restored')
    check(checks, sourceRuntimeRestored, 'source_runtime_restored', 'source_runtime_not_restored')
    check(
      checks,
      consumerFence?.agent_id === 'dme-hermes-k8s' && consumerFence?.mode === 'bearer_only' &&
        Number.isInteger(consumerFence?.generation) && consumerFence.generation > 0 &&
        consumerFence?.key_fingerprint === null,
      'consumer_fence_bearer_only',
      'consumer_fence_not_bearer_only',
    )
  } else {
    check(checks, legacyAbsent, 'legacy_subscriber_absent', 'legacy_subscriber_present')
    check(checks, sourceRuntimeStable, 'source_runtime_preserved', 'source_runtime_changed')
  }
  const failed = checks.filter((entry) => !entry.ok)
  return {
    schema: KUBERNETES_AGENT_HOST_CUTOVER_PREFLIGHT_TYPE,
    observed_at: now.toISOString(),
    status: failed.length === 0 ? 'pass' : 'fail',
    namespace: namespace === 'dme-hermes' ? namespace : null,
    mode: validMode ? mode : null,
    cluster: {
      context: typeof clusterContext === 'string' && clusterContext.length <= 256 ? clusterContext : null,
      namespace_uid: typeof namespaceUid === 'string' && namespaceUid.length <= 128 ? namespaceUid : null,
    },
    evidence: {
      workloads_sha256: sha256(JSON.stringify(workloadProjection)),
      replica_sets_sha256: sha256(JSON.stringify(replicaSetProjection)),
      pods_sha256: sha256(JSON.stringify(podProjection)),
      workload_count: workloadProjection.length,
      replica_set_count: replicaSetProjection.length,
      pod_count: podProjection.length,
      legacy_subscriber_absent: legacyAbsent,
      legacy_subscriber_restored: rollbackComplete,
      agent_host_inert: hostInert,
      consumer_fence: consumerFence && typeof consumerFence === 'object' ? {
        agent_id: consumerFence.agent_id ?? null,
        mode: consumerFence.mode ?? null,
        generation: Number.isInteger(consumerFence.generation) ? consumerFence.generation : null,
        key_fingerprint: consumerFence.key_fingerprint ?? null,
      } : null,
      workloads: workloadProjection,
      replica_sets: replicaSetProjection,
      pods: podProjection,
    },
    checks,
    failure_codes: failed.map((entry) => entry.code),
  }
}

function kubectlJson(namespace, resources) {
  return JSON.parse(execFileSync('kubectl', ['-n', namespace, 'get', resources, '-o', 'json'], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  }))?.items ?? []
}

function kubectlValue(args) {
  return execFileSync('kubectl', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim()
}

function kubectlObject(namespace, resource, name) {
  return JSON.parse(execFileSync('kubectl', ['-n', namespace, 'get', resource, name, '-o', 'json'], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  }))
}

async function main(argv = process.argv.slice(2)) {
  let namespace = 'dme-hermes'
  let mode = 'activate'
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--namespace') {
      index += 1
      if (index >= argv.length) throw new Error('--namespace requires a value')
      namespace = argv[index]
    } else if (argv[index] === '--mode') {
      index += 1
      if (index >= argv.length) throw new Error('--mode requires a value')
      mode = argv[index]
    } else if (argv[index] === '--help' || argv[index] === '-h') {
      console.log('Usage: node scripts/kubernetes-agent-host-cutover-preflight.mjs [--namespace dme-hermes] [--mode activate|rollback-ready|rollback-complete]')
      return
    } else throw new Error(`unknown argument: ${argv[index]}`)
  }
  const workloads = kubectlJson(namespace, 'deployments,statefulsets,daemonsets,jobs,cronjobs')
  const replicaSets = kubectlJson(namespace, 'replicasets')
  let consumerFence = null
  if (mode === 'rollback-complete') {
    const configMap = kubectlObject(namespace, 'configmap', 'dme-hermes-agent-host')
    let daemon
    try {
      daemon = JSON.parse(configMap?.data?.['daemon.json'])
    } catch {
      throw new Error('Host daemon ConfigMap invalid')
    }
    const secret = kubectlObject(namespace, 'secret', 'dme-mupot-agent-host')
    consumerFence = await fetchConsumerFenceFromSecret({ baseUrl: daemon?.base_url, secret })
  }
  const receipt = buildCutoverPreflight({
    namespace,
    mode,
    workloads,
    replicaSets,
    pods: kubectlJson(namespace, 'pods'),
    clusterContext: kubectlValue(['config', 'current-context']),
    namespaceUid: kubectlValue(['get', 'namespace', namespace, '-o', 'jsonpath={.metadata.uid}']),
    consumerFence,
  })
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
  if (receipt.status !== 'pass') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
