#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseAllDocuments } from 'yaml'

import { pluginBundleHash } from '../fleet-runtime/hermes-plugin-smoke.mjs'
import { buildCutoverPreflight } from './kubernetes-agent-host-cutover-preflight.mjs'
import {
  fetchConsumerFenceFromSecret,
  fetchConsumerFenceStatus,
} from './kubernetes-agent-host-consumer-fence.mjs'
import { agentHostPods } from './kubernetes-agent-host-pod-identity.mjs'

export { fetchConsumerFenceStatus } from './kubernetes-agent-host-consumer-fence.mjs'
export { agentHostPods as hostPodsForRollback } from './kubernetes-agent-host-pod-identity.mjs'
import { KUBERNETES_AGENT_HOST_RECEIPT_TYPE } from './kubernetes-agent-host-receipt.mjs'
import {
  KUBERNETES_HERMES_PLUGIN_SMOKE_EVIDENCE_TYPE,
  kubernetesPodExecutionContractHash,
} from './kubernetes-hermes-plugin-smoke-evidence.mjs'

export const KUBERNETES_AGENT_HOST_ACTIVATION_TYPE = 'mupot.kubernetes-agent-host-activation/v1'

function exact(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

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

function containers(item) {
  const spec = item?.kind === 'Pod' ? item?.spec : item?.spec?.template?.spec
  return [...(spec?.initContainers ?? []), ...(spec?.containers ?? []), ...(spec?.ephemeralContainers ?? [])]
}

function check(checks, ok, name, code) {
  checks.push({ check: name, ok: Boolean(ok), ...(ok ? {} : { code }) })
}

export function kubernetesDeploymentExecutionContractHash(deployment) {
  const value = deployment && typeof deployment === 'object' ? structuredClone(deployment) : {}
  delete value.status
  value.metadata = { name: value.metadata?.name ?? null, labels: value.metadata?.labels ?? null }
  const spec = value.spec ?? {}
  delete spec.replicas
  if (spec.progressDeadlineSeconds === 600) delete spec.progressDeadlineSeconds
  if (spec.revisionHistoryLimit === 10) delete spec.revisionHistoryLimit
  const template = spec.template ?? {}
  template.metadata = { labels: template.metadata?.labels ?? null }
  template.spec = { execution_contract_sha256: kubernetesPodExecutionContractHash(template.spec) }
  spec.template = template
  value.spec = spec
  return sha256(canonicalJson(value))
}

export function evaluateActivationGuard({
  preflight, smokeEvidence, releaseReceipt, expectedDeployment, expectedDeploymentSha256, snapshot,
  now = new Date(),
}) {
  const checks = []
  const live = buildCutoverPreflight({
    namespace: 'dme-hermes', mode: 'activate', workloads: snapshot?.workloads,
    replicaSets: snapshot?.replicaSets, pods: snapshot?.pods,
    clusterContext: snapshot?.clusterContext, namespaceUid: snapshot?.namespaceUid, now,
  })
  const hosts = (snapshot?.workloads ?? []).filter((item) =>
    item?.kind === 'Deployment' && item?.metadata?.name === 'dme-hermes-agent-host')
  const host = hosts[0]
  const plugin = snapshot?.pluginConfigMap
  const deploymentArtifact = releaseReceipt?.artifacts?.find((entry) => entry?.role === 'deployment')
  check(
    checks,
    releaseReceipt?.receipt_type === KUBERNETES_AGENT_HOST_RECEIPT_TYPE && releaseReceipt?.status === 'pass' &&
      Array.isArray(releaseReceipt?.failure_codes) && releaseReceipt.failure_codes.length === 0 &&
      Array.isArray(releaseReceipt?.checks) && releaseReceipt.checks.length > 0 &&
      releaseReceipt.checks.every((entry) => entry?.ok === true) &&
      deploymentArtifact?.sha256 === expectedDeploymentSha256 &&
      releaseReceipt?.target?.image_digest === smokeEvidence?.image_digest,
    'release_receipt_bound',
    'release_receipt_unbound',
  )
  check(checks, preflight?.status === 'pass' && preflight?.mode === 'activate', 'authorization_preflight_passed', 'authorization_preflight_failed')
  check(
    checks,
    smokeEvidence?.schema === KUBERNETES_HERMES_PLUGIN_SMOKE_EVIDENCE_TYPE && smokeEvidence?.status === 'pass' &&
      Array.isArray(smokeEvidence?.failure_codes) && smokeEvidence.failure_codes.length === 0 &&
      Array.isArray(smokeEvidence?.checks) && smokeEvidence.checks.length > 0 &&
      smokeEvidence.checks.every((entry) => entry?.ok === true),
    'smoke_evidence_passed',
    'smoke_evidence_failed',
  )
  check(
    checks,
    kubernetesDeploymentExecutionContractHash(host) ===
      kubernetesDeploymentExecutionContractHash(expectedDeployment),
    'live_deployment_contract_exact',
    'live_deployment_contract_changed',
  )
  check(
    checks,
    live.status === 'pass' && exact(live.cluster, preflight?.cluster) && exact(live.evidence, preflight?.evidence) &&
      exact(live.checks, preflight?.checks) && exact(preflight?.failure_codes, []),
    'cluster_snapshot_unchanged',
    'cluster_snapshot_changed',
  )
  check(
    checks,
    hosts.length === 1 && Number(host?.spec?.replicas ?? 1) === 0 &&
      exact(containers(host).map((container) => container?.name), ['agent-host']) &&
      containers(host)[0]?.image?.endsWith(`@${smokeEvidence?.image_digest}`),
    'host_inert_and_unique',
    'host_not_inert',
  )
  check(
    checks,
    plugin?.immutable === true && plugin?.metadata?.name === smokeEvidence?.plugin_config_map?.name &&
      plugin?.metadata?.uid === smokeEvidence?.plugin_config_map?.uid &&
      plugin?.metadata?.resourceVersion === smokeEvidence?.plugin_config_map?.resource_version &&
      plugin?.binaryData == null &&
      pluginBundleHash(plugin?.data ?? {}) === smokeEvidence?.plugin_bundle_sha256,
    'immutable_plugin_identity_unchanged',
    'immutable_plugin_identity_changed',
  )
  return { checks, live, hostResourceVersion: host?.metadata?.resourceVersion ?? null }
}

export function evaluatePostActivation({ preflight, smokeEvidence, expectedDeployment, snapshot }) {
  const checks = []
  const workloads = snapshot?.workloads ?? []
  const pods = snapshot?.pods ?? []
  const replicaSets = snapshot?.replicaSets ?? []
  const dme = workloads.find((item) => item?.kind === 'Deployment' && item?.metadata?.name === 'dme-hermes')
  const host = workloads.find((item) => item?.kind === 'Deployment' && item?.metadata?.name === 'dme-hermes-agent-host')
  const priorDme = preflight?.evidence?.workloads?.find((item) => item?.kind === 'Deployment' && item?.name === 'dme-hermes')
  const priorHost = preflight?.evidence?.workloads?.find((item) => item?.kind === 'Deployment' && item?.name === 'dme-hermes-agent-host')
  const legacyAbsent = ![...workloads, ...pods].some((item) =>
    containers(item).some((container) => container?.name === 'mupot-subscriber'))
  const hostPods = agentHostPods({ deployment: host, replicaSets, pods })
  const hostPodReady = hostPods.length === 1 && hostPods[0]?.status?.phase === 'Running' &&
    hostPods[0]?.status?.conditions?.some((condition) => condition?.type === 'Ready' && condition?.status === 'True')
  const plugin = snapshot?.pluginConfigMap
  check(checks, snapshot?.clusterContext === preflight?.cluster?.context && snapshot?.namespaceUid === preflight?.cluster?.namespace_uid, 'cluster_identity_unchanged', 'cluster_identity_changed')
  check(checks, legacyAbsent && exact(containers(dme).map((container) => container?.name).sort(), ['hermes', 'telegram-gateway']), 'legacy_remains_absent', 'legacy_consumer_returned')
  check(checks, dme?.metadata?.uid === priorDme?.uid && dme?.metadata?.resourceVersion === priorDme?.resource_version, 'source_runtime_unchanged', 'source_runtime_changed')
  check(
    checks,
    host?.metadata?.uid === priorHost?.uid && Number(host?.spec?.replicas) === 1 &&
      Number(host?.status?.availableReplicas) === 1 && hostPodReady,
    'host_active_and_unique',
    'host_activation_incomplete',
  )
  check(
    checks,
    hostPods.length === 1 && kubernetesPodExecutionContractHash(hostPods[0]?.spec) ===
      kubernetesPodExecutionContractHash(expectedDeployment?.spec?.template?.spec),
    'host_pod_admission_contract_exact',
    'host_pod_admission_contract_changed',
  )
  check(
    checks,
    plugin?.immutable === true && plugin?.metadata?.uid === smokeEvidence?.plugin_config_map?.uid &&
      plugin?.metadata?.resourceVersion === smokeEvidence?.plugin_config_map?.resource_version &&
      plugin?.binaryData == null &&
      pluginBundleHash(plugin?.data ?? {}) === smokeEvidence?.plugin_bundle_sha256,
    'immutable_plugin_still_bound',
    'immutable_plugin_changed',
  )
  return checks
}

export async function runGuardedActivation({
  preflight, smokeEvidence, releaseReceipt, expectedDeployment, expectedDeploymentSha256,
}, deps) {
  const startedAt = new Date().toISOString()
  let scaleAttempted = false
  let rollbackPerformed = false
  let overlapMonitor = null
  let overlapObservation = null
  const checks = []
  let failureCode = null
  const stopOverlapMonitor = async () => {
    if (!overlapMonitor) return
    overlapObservation = await overlapMonitor.stop()
    overlapMonitor = null
    check(
      checks,
      overlapObservation?.healthy === true &&
        Array.isArray(overlapObservation?.legacy_consumer_events) &&
        overlapObservation.legacy_consumer_events.length === 0,
      'no_transient_consumer_overlap_observed',
      'transient_consumer_overlap_or_monitor_failure',
    )
  }
  try {
    const before = await deps.snapshot()
    const guard = evaluateActivationGuard({
      preflight, smokeEvidence, releaseReceipt, expectedDeployment, expectedDeploymentSha256,
      snapshot: before, now: deps.now?.() ?? new Date(),
    })
    checks.push(...guard.checks)
    if (guard.checks.some((entry) => !entry.ok)) throw new Error('activation_guard_failed')
    if (typeof deps.verifyConsumerFence !== 'function') throw new Error('consumer_fence_verifier_unavailable')
    const fence = await deps.verifyConsumerFence()
    check(
      checks,
      fence?.agent_id === releaseReceipt?.target?.agent_id &&
        fence?.mode === 'signed_only' && Number.isInteger(fence?.generation) && fence.generation > 0 &&
        /^[a-f0-9]{64}$/.test(fence?.key_fingerprint ?? '') &&
        fence?.active_key_present === true && fence?.key_matches === true,
      'live_consumer_fence_signed_only',
      'consumer_fence_not_signed_only',
    )
    if (checks.some((entry) => entry.code === 'consumer_fence_not_signed_only')) {
      throw new Error('activation_guard_failed')
    }
    if (typeof deps.startOverlapMonitor !== 'function') throw new Error('overlap_monitor_unavailable')
    overlapMonitor = await deps.startOverlapMonitor(before)
    scaleAttempted = true
    await deps.scale(1, guard.hostResourceVersion)
    await deps.waitReady()
    const postFence = await deps.verifyConsumerFence()
    check(
      checks,
      postFence?.agent_id === fence.agent_id && postFence?.mode === 'signed_only' &&
        postFence?.generation === fence.generation && postFence?.key_fingerprint === fence.key_fingerprint &&
        postFence?.active_key_present === true && postFence?.key_matches === true,
      'consumer_fence_stable_during_activation',
      'consumer_fence_changed_during_activation',
    )
    const after = await deps.snapshot()
    const postChecks = evaluatePostActivation({ preflight, smokeEvidence, expectedDeployment, snapshot: after })
    checks.push(...postChecks)
    await stopOverlapMonitor()
    if (postChecks.some((entry) => !entry.ok) || checks.some((entry) => entry.code === 'consumer_fence_changed_during_activation')) {
      throw new Error('post_activation_guard_failed')
    }
    if (checks.some((entry) => entry.code === 'transient_consumer_overlap_or_monitor_failure')) {
      throw new Error('post_activation_guard_failed')
    }
  } catch (error) {
    failureCode = error?.message === 'activation_guard_failed' || error?.message === 'post_activation_guard_failed'
      ? error.message
      : 'activation_runtime_failed'
    try {
      await stopOverlapMonitor()
    } catch {
      checks.push({
        check: 'no_transient_consumer_overlap_observed', ok: false,
        code: 'transient_consumer_overlap_or_monitor_failure',
      })
    }
    if (scaleAttempted) {
      try {
        await deps.scale(0)
        if (typeof deps.waitStopped !== 'function') throw new Error('zero Host pod confirmation unavailable')
        await deps.waitStopped()
        rollbackPerformed = true
        check(checks, true, 'automatic_rollback_zero_host_pods', 'automatic_rollback_not_quiescent')
      } catch {
        check(checks, false, 'automatic_rollback_zero_host_pods', 'automatic_rollback_not_quiescent')
        failureCode = 'automatic_rollback_failed'
      }
    }
  }
  const failed = checks.filter((entry) => !entry.ok)
  const status = !failureCode && failed.length === 0 ? 'pass' : 'fail'
  return {
    schema: KUBERNETES_AGENT_HOST_ACTIVATION_TYPE,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    status,
    namespace: 'dme-hermes',
    rollback_performed: rollbackPerformed,
    overlap_monitor: overlapObservation,
    checks,
    failure_codes: [...failed.map((entry) => entry.code), ...(failureCode ? [failureCode] : [])],
  }
}

function kubectlJson(args) {
  return JSON.parse(execFileSync('kubectl', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }))
}

function kubectlValue(args) {
  return execFileSync('kubectl', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim()
}

async function liveConsumerFenceStatus({ baseUrl, secretName }) {
  const secret = kubectlJson(['-n', 'dme-hermes', 'get', 'secret', secretName, '-o', 'json'])
  return fetchConsumerFenceFromSecret({ baseUrl, secret })
}

async function snapshot(pluginName) {
  const podList = kubectlJson(['-n', 'dme-hermes', 'get', 'pods', '-o', 'json'])
  return {
    workloads: kubectlJson(['-n', 'dme-hermes', 'get', 'deployments,statefulsets,daemonsets,jobs,cronjobs', '-o', 'json']).items ?? [],
    replicaSets: kubectlJson(['-n', 'dme-hermes', 'get', 'replicasets', '-o', 'json']).items ?? [],
    pods: podList.items ?? [],
    podListResourceVersion: podList?.metadata?.resourceVersion ?? null,
    pluginConfigMap: kubectlJson(['-n', 'dme-hermes', 'get', 'configmap', pluginName, '-o', 'json']),
    clusterContext: kubectlValue(['config', 'current-context']),
    namespaceUid: kubectlValue(['get', 'namespace', 'dme-hermes', '-o', 'jsonpath={.metadata.uid}']),
  }
}

function validResourceVersion(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}

function podWatchPath(resourceVersion) {
  const query = new URLSearchParams({
    watch: '1',
    allowWatchBookmarks: 'true',
    sendInitialEvents: 'true',
    resourceVersionMatch: 'NotOlderThan',
    resourceVersion,
  })
  return `/api/v1/namespaces/dme-hermes/pods?${query}`
}

function legacyConsumerEvent(eventType, pod) {
  if (!containers({ kind: 'Pod', spec: pod?.spec }).some((container) => container?.name === 'mupot-subscriber')) {
    return null
  }
  return {
    event_type: eventType ?? null,
    pod_uid: pod?.metadata?.uid ?? null,
    pod_name: pod?.metadata?.name ?? null,
    resource_version: pod?.metadata?.resourceVersion ?? null,
  }
}

function createPodWatch(resourceVersion, {
  kubectlCommand, readyTimeoutMs, shutdownTimeoutMs, timeoutCode,
}) {
  const child = spawn(kubectlCommand, ['get', '--raw', podWatchPath(resourceVersion)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const failureCodes = new Set()
  const events = []
  let buffer = ''
  let stderr = ''
  let requestedStop = false
  let readySettled = false
  let catchupResourceVersion = null
  let resolveReady
  let rejectReady
  const ready = new Promise((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise
    rejectReady = rejectPromise
  })
  const fail = (code) => {
    failureCodes.add(code)
    if (!readySettled) {
      readySettled = true
      rejectReady(new Error(code))
    }
  }
  const timer = setTimeout(() => fail(timeoutCode), readyTimeoutMs)
  const processLine = (line) => {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      fail('pod_watch_invalid_json')
      return
    }
    if (event?.type === 'ERROR') {
      const code = Number(event?.object?.code) === 410 || ['Expired', 'Gone'].includes(event?.object?.reason)
        ? 'pod_watch_compacted'
        : 'pod_watch_error'
      fail(code)
      return
    }
    const pod = event?.object
    const legacy = legacyConsumerEvent(event?.type, pod)
    if (legacy) events.push(legacy)
    const initialEventsEnded = event?.type === 'BOOKMARK' &&
      (pod?.metadata?.annotations?.['k8s.io/initial-events-end'] === 'true' ||
        pod?.metadata?.annotations?.['k8s.io/initial-events-end'] === true)
    if (initialEventsEnded) {
      const bookmarkResourceVersion = pod?.metadata?.resourceVersion
      if (!validResourceVersion(bookmarkResourceVersion)) {
        fail('pod_watch_invalid_bookmark')
      } else {
        catchupResourceVersion = bookmarkResourceVersion
        if (!readySettled) {
          readySettled = true
          clearTimeout(timer)
          resolveReady(bookmarkResourceVersion)
        }
      }
    }
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim().length > 0) processLine(line)
    }
  })
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8192) })
  child.once('error', () => fail('pod_watch_spawn_failed'))
  child.on('exit', () => {
    if (!requestedStop) fail('pod_watch_unexpected_exit')
  })

  const stop = async () => {
    requestedStop = true
    clearTimeout(timer)
    await new Promise((resolvePromise) => {
      if (child.exitCode != null || child.signalCode != null) return resolvePromise()
      const shutdownTimer = setTimeout(() => {
        failureCodes.add('pod_watch_shutdown_timeout')
        if (child.exitCode == null) child.kill('SIGKILL')
        resolvePromise()
      }, shutdownTimeoutMs)
      child.once('close', () => { clearTimeout(shutdownTimer); resolvePromise() })
      child.kill('SIGTERM')
    })
    if (buffer.trim().length > 0) failureCodes.add('pod_watch_partial_json')
    if (stderr.trim().length > 0) failureCodes.add('pod_watch_stderr')
  }
  return {
    child,
    events,
    failureCodes,
    ready,
    stop,
    get catchupResourceVersion() { return catchupResourceVersion },
  }
}

function podList(kubectlCommand) {
  return JSON.parse(execFileSync(
    kubectlCommand,
    ['-n', 'dme-hermes', 'get', 'pods', '-o', 'json'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  ))
}

export async function startPodOverlapMonitor(snapshotValue, options = {}) {
  const resourceVersion = snapshotValue?.podListResourceVersion
  if (!validResourceVersion(resourceVersion)) {
    throw new Error('pod list resource version unavailable')
  }
  const kubectlCommand = options.kubectlCommand ?? 'kubectl'
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000
  const catchupTimeoutMs = options.catchupTimeoutMs ?? 30_000
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2_000
  const liveWatch = createPodWatch(resourceVersion, {
    kubectlCommand, readyTimeoutMs: startupTimeoutMs, shutdownTimeoutMs,
    timeoutCode: 'pod_watch_startup_timeout',
  })
  try {
    await liveWatch.ready
  } catch (error) {
    await liveWatch.stop()
    throw error
  }
  let stopPromise = null
  return {
    stop: async () => {
      if (stopPromise) return stopPromise
      stopPromise = (async () => {
        const failureCodes = new Set(liveWatch.failureCodes)
        const events = []
        let finalResourceVersion = null
        let catchupResourceVersion = null
        let catchupWatch = null
        try {
          const finalPods = podList(kubectlCommand)
          finalResourceVersion = finalPods?.metadata?.resourceVersion
          if (!validResourceVersion(finalResourceVersion) || !Array.isArray(finalPods?.items)) {
            throw new Error('pod_watch_final_list_invalid')
          }
          for (const pod of finalPods.items) {
            const legacy = legacyConsumerEvent('FINAL_LIST', pod)
            if (legacy) events.push(legacy)
          }
          catchupWatch = createPodWatch(finalResourceVersion, {
            kubectlCommand, readyTimeoutMs: catchupTimeoutMs, shutdownTimeoutMs,
            timeoutCode: 'pod_watch_catchup_timeout',
          })
          catchupResourceVersion = await catchupWatch.ready
        } catch (error) {
          const code = error instanceof Error && /^pod_watch_/.test(error.message)
            ? error.message
            : 'pod_watch_final_catchup_failed'
          failureCodes.add(code)
        } finally {
          if (catchupWatch) {
            await catchupWatch.stop()
            for (const code of catchupWatch.failureCodes) failureCodes.add(code)
            events.push(...catchupWatch.events)
          }
          await liveWatch.stop()
          for (const code of liveWatch.failureCodes) failureCodes.add(code)
          events.push(...liveWatch.events)
        }
        const uniqueEvents = [...new Map(events.map((event) => [canonicalJson(event), event])).values()]
        return {
          resource_version: resourceVersion,
          final_resource_version: finalResourceVersion,
          catchup_resource_version: catchupResourceVersion,
          healthy: failureCodes.size === 0,
          failure_codes: [...failureCodes].sort(),
          legacy_consumer_events: uniqueEvents,
        }
      })()
      return stopPromise
    },
  }
}

async function waitForZeroHostPods({ timeoutMs = 120_000, pollIntervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const deployment = kubectlJson(['-n', 'dme-hermes', 'get', 'deployment', 'dme-hermes-agent-host', '-o', 'json'])
    const replicaSets = kubectlJson(['-n', 'dme-hermes', 'get', 'replicasets', '-o', 'json'])
    const pods = kubectlJson(['-n', 'dme-hermes', 'get', 'pods', '-o', 'json'])
    if (Array.isArray(replicaSets?.items) && Array.isArray(pods?.items) &&
        agentHostPods({ deployment, replicaSets: replicaSets.items, pods: pods.items }).length === 0) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs))
  }
  throw new Error('automatic rollback timed out waiting for zero Host pods')
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[index]
    }
    if (arg === '--preflight') options.preflight = next()
    else if (arg === '--smoke-evidence') options.smokeEvidence = next()
    else if (arg === '--release-receipt') options.releaseReceipt = next()
    else if (arg === '--deployment') options.deployment = next()
    else if (arg === '--output') options.output = next()
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log('Usage: node scripts/kubernetes-agent-host-activate.mjs --preflight FILE --smoke-evidence FILE --release-receipt FILE --deployment FILE [--output FILE]')
    return
  }
  if (!options.preflight || !options.smokeEvidence || !options.releaseReceipt || !options.deployment) {
    throw new Error('--preflight, --smoke-evidence, --release-receipt, and --deployment are required')
  }
  const preflight = JSON.parse(readFileSync(resolve(options.preflight), 'utf8'))
  const smokeEvidence = JSON.parse(readFileSync(resolve(options.smokeEvidence), 'utf8'))
  const releaseReceipt = JSON.parse(readFileSync(resolve(options.releaseReceipt), 'utf8'))
  const deploymentSource = readFileSync(resolve(options.deployment), 'utf8')
  const deploymentDocuments = parseAllDocuments(deploymentSource)
  if (deploymentDocuments.length !== 2 || deploymentDocuments.some((document) => document.errors.length > 0)) {
    throw new Error('deployment artifact invalid')
  }
  const expectedDeployment = deploymentDocuments.map((document) => document.toJSON())
    .find((document) => document?.kind === 'Deployment')
  const expectedConfigMap = deploymentDocuments.map((document) => document.toJSON())
    .find((document) => document?.kind === 'ConfigMap')
  if (!expectedDeployment) throw new Error('deployment artifact missing Deployment')
  if (!expectedConfigMap) throw new Error('deployment artifact missing ConfigMap')
  let daemonConfig
  try {
    daemonConfig = JSON.parse(expectedConfigMap?.data?.['daemon.json'])
  } catch {
    throw new Error('deployment daemon config invalid')
  }
  const tokenVolume = expectedDeployment?.spec?.template?.spec?.volumes?.find((volume) => volume?.name === 'agent-token')
  const tokenSecretName = tokenVolume?.secret?.secretName
  if (typeof daemonConfig?.base_url !== 'string' || typeof tokenSecretName !== 'string') {
    throw new Error('deployment fence inputs invalid')
  }
  const pluginName = smokeEvidence?.plugin_config_map?.name
  const receipt = await runGuardedActivation({
    preflight, smokeEvidence, releaseReceipt, expectedDeployment,
    expectedDeploymentSha256: sha256(deploymentSource),
  }, {
    snapshot: () => snapshot(pluginName),
    verifyConsumerFence: () => liveConsumerFenceStatus({
      baseUrl: daemonConfig.base_url,
      secretName: tokenSecretName,
    }),
    startOverlapMonitor: startPodOverlapMonitor,
    scale: async (replicas, resourceVersion) => {
      const args = ['-n', 'dme-hermes', 'scale', 'deployment/dme-hermes-agent-host', `--replicas=${replicas}`]
      if (resourceVersion) args.push(`--resource-version=${resourceVersion}`)
      execFileSync('kubectl', args, { stdio: 'ignore' })
    },
    waitReady: async () => {
      execFileSync('kubectl', ['-n', 'dme-hermes', 'rollout', 'status', 'deployment/dme-hermes-agent-host', '--timeout=120s'], { stdio: 'ignore' })
    },
    waitStopped: waitForZeroHostPods,
  })
  const output = `${JSON.stringify(receipt, null, 2)}\n`
  if (options.output) writeFileSync(resolve(options.output), output, { mode: 0o600 })
  else process.stdout.write(output)
  if (receipt.status !== 'pass') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
