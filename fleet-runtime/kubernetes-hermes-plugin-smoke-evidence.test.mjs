import test from 'node:test'
import assert from 'node:assert/strict'

import {
  KUBERNETES_HERMES_PLUGIN_SMOKE_EVIDENCE_TYPE,
  buildKubernetesHermesPluginSmokeEvidence,
  immutablePluginConfigMapName,
  kubernetesJobExecutionContractHash,
  renderImmutablePluginConfigMap,
} from '../scripts/kubernetes-hermes-plugin-smoke-evidence.mjs'
import { PLUGIN_FILES, pluginBundleHash } from './hermes-plugin-smoke.mjs'

const DIGEST = `sha256:${'a'.repeat(64)}`
const NOW = new Date('2026-07-18T21:00:00Z')

function pluginData() {
  return Object.fromEntries(PLUGIN_FILES.map((name) => [name, `content:${name}`]))
}

function job() {
  return {
    apiVersion: 'batch/v1', kind: 'Job',
    metadata: {
      name: 'dme-hermes-plugin-smoke', uid: 'job-uid',
      labels: { 'app.kubernetes.io/name': 'mupot-agent-host-smoke', 'app.kubernetes.io/instance': 'dme-hermes' },
    },
    spec: {
      backoffLimit: 0, ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'mupot-agent-host-smoke', 'app.kubernetes.io/instance': 'dme-hermes' } },
        spec: {
          restartPolicy: 'Never', automountServiceAccountToken: false, enableServiceLinks: false,
          securityContext: { runAsNonRoot: true },
          containers: [{
            name: 'plugin-smoke', image: `registry.example/host@${DIGEST}`, imagePullPolicy: 'IfNotPresent',
            command: ['/usr/local/bin/node', '/opt/mupot/hermes-plugin-smoke.mjs'],
            env: [{ name: 'MUPOT_PLUGIN_MODE', value: 'operator' }], resources: {},
            securityContext: { readOnlyRootFilesystem: true }, volumeMounts: [],
          }],
          volumes: [],
        },
      },
    },
    status: { completionTime: '2026-07-18T20:59:00Z' },
  }
}

function pod() {
  return {
    metadata: {
      name: 'dme-hermes-plugin-smoke-abc', uid: 'pod-uid',
      ownerReferences: [{
        apiVersion: 'batch/v1', kind: 'Job', name: 'dme-hermes-plugin-smoke', uid: 'job-uid', controller: true,
      }],
    },
    status: {
      phase: 'Succeeded',
      containerStatuses: [{ name: 'plugin-smoke', imageID: `docker-pullable://registry.example/host@${DIGEST}` }],
    },
  }
}

function log(data) {
  return JSON.stringify({
    schema: 'mupot.hermes-plugin-smoke/v1', status: 'pass',
    plugin: { name: 'mupot', version: '0.3.0', enabled: true, toolset: 'mupot-operator' },
    plugin_bundle_sha256: pluginBundleHash(data), exit_code: 0,
  })
}

function pluginConfigMap(data) {
  return {
    apiVersion: 'v1', kind: 'ConfigMap', immutable: true,
    metadata: {
      name: immutablePluginConfigMapName(data), uid: 'plugin-config-uid', resourceVersion: '42',
    },
    data,
  }
}

function bindPluginVolume(value, configMap) {
  value.spec.template.spec.volumes = [{
    name: 'hermes-plugin', configMap: { name: configMap.metadata.name, defaultMode: 292 },
  }]
}

function observedPod(expectedJob) {
  const value = pod()
  value.spec = structuredClone(expectedJob.spec.template.spec)
  return value
}

test('binds a fresh passing smoke to the exact Job and runtime image digest', () => {
  const data = pluginData()
  const expectedJob = job()
  const configMap = pluginConfigMap(data)
  bindPluginVolume(expectedJob, configMap)
  const observedJob = structuredClone(expectedJob)
  const livePod = observedPod(expectedJob)
  const evidence = buildKubernetesHermesPluginSmokeEvidence({
    namespace: 'dme-hermes', expectedJob, observedJob, pods: [livePod], logs: log(data),
    expectedPluginConfigMap: configMap, observedPluginConfigMap: configMap,
    expectedImageDigest: DIGEST, now: NOW,
  })
  assert.equal(evidence.schema, KUBERNETES_HERMES_PLUGIN_SMOKE_EVIDENCE_TYPE)
  assert.equal(evidence.status, 'pass')
  assert.equal(evidence.image_digest, DIGEST)
  assert.equal(evidence.pod.image_digest, DIGEST)
  assert.match(evidence.job.execution_contract_sha256, /^[a-f0-9]{64}$/)
  assert.equal(evidence.failure_codes.length, 0)
})

test('fails on a changed command, stale replay, or different runtime image', () => {
  const data = pluginData()
  const expectedJob = job()
  const configMap = pluginConfigMap(data)
  bindPluginVolume(expectedJob, configMap)
  const observedJob = structuredClone(expectedJob)
  observedJob.spec.template.spec.containers[0].command.push('--changed')
  observedJob.status.completionTime = '2026-07-18T20:00:00Z'
  const changedPod = pod()
  changedPod.spec = structuredClone(expectedJob.spec.template.spec)
  changedPod.status.containerStatuses[0].imageID = `docker://sha256:${'b'.repeat(64)}`
  const evidence = buildKubernetesHermesPluginSmokeEvidence({
    namespace: 'dme-hermes', expectedJob, observedJob, pods: [changedPod], logs: log(data),
    expectedPluginConfigMap: configMap, observedPluginConfigMap: configMap,
    expectedImageDigest: DIGEST, now: NOW,
  })
  assert.equal(evidence.status, 'fail')
  assert.deepEqual(evidence.failure_codes, [
    'job_execution_contract_changed', 'runtime_image_digest_unbound', 'smoke_observation_stale',
  ])
})

test('fails closed when logs or pod identity are ambiguous', () => {
  const data = pluginData()
  const configMap = pluginConfigMap(data)
  const expectedJob = job()
  bindPluginVolume(expectedJob, configMap)
  const livePod = observedPod(expectedJob)
  const evidence = buildKubernetesHermesPluginSmokeEvidence({
    namespace: 'dme-hermes', expectedJob, observedJob: structuredClone(expectedJob),
    pods: [livePod, structuredClone(livePod)], logs: 'not json',
    expectedPluginConfigMap: configMap, observedPluginConfigMap: configMap,
    expectedImageDigest: DIGEST, now: NOW,
  })
  assert.equal(evidence.status, 'fail')
  assert.ok(evidence.failure_codes.includes('smoke_pod_count_invalid'))
  assert.ok(evidence.failure_codes.includes('plugin_discovery_failed'))
})

test('execution hash covers every behavior-bearing Job and pod field', () => {
  const expected = job()
  for (const mutate of [
    (value) => { value.spec.activeDeadlineSeconds = 30 },
    (value) => { value.spec.template.spec.initContainers = [{ name: 'extra', image: 'busybox' }] },
    (value) => { value.spec.template.spec.serviceAccountName = 'privileged' },
    (value) => { value.spec.template.spec.hostNetwork = true },
    (value) => { value.spec.template.spec.containers[0].envFrom = [{ secretRef: { name: 'extra' } }] },
  ]) {
    const changed = structuredClone(expected)
    mutate(changed)
    assert.notEqual(kubernetesJobExecutionContractHash(changed), kubernetesJobExecutionContractHash(expected))
  }
})

test('fails when admission mutates the generated Pod without changing the Job', () => {
  const data = pluginData()
  const configMap = pluginConfigMap(data)
  const expectedJob = job()
  bindPluginVolume(expectedJob, configMap)
  const livePod = observedPod(expectedJob)
  livePod.spec.hostNetwork = true
  livePod.spec.hostPID = true
  livePod.spec.initContainers = [{ name: 'injected', image: 'busybox' }]
  const evidence = buildKubernetesHermesPluginSmokeEvidence({
    namespace: 'dme-hermes', expectedJob, observedJob: structuredClone(expectedJob),
    pods: [livePod], logs: log(data), expectedPluginConfigMap: configMap,
    observedPluginConfigMap: configMap, expectedImageDigest: DIGEST, now: NOW,
  })
  assert.equal(evidence.status, 'fail')
  assert.ok(evidence.failure_codes.includes('pod_admission_contract_changed'))
})

test('renders only an exact immutable content-addressed plugin ConfigMap', () => {
  const data = pluginData()
  const rendered = renderImmutablePluginConfigMap({ data })
  assert.equal(rendered.immutable, true)
  assert.equal(rendered.metadata.name, immutablePluginConfigMapName(data))
  assert.deepEqual(rendered.data, data)
  assert.throws(() => renderImmutablePluginConfigMap({ data: { ...data, 'extra.py': 'x' } }), /files invalid/)
})

test('rejects an immutable plugin ConfigMap with unbound binaryData', () => {
  const data = pluginData()
  const configMap = pluginConfigMap(data)
  const expectedJob = job()
  bindPluginVolume(expectedJob, configMap)
  const observedConfigMap = structuredClone(configMap)
  observedConfigMap.binaryData = { 'shadow.py': 'cHJpbnQoImhpIik=' }
  const evidence = buildKubernetesHermesPluginSmokeEvidence({
    namespace: 'dme-hermes', expectedJob, observedJob: structuredClone(expectedJob),
    pods: [observedPod(expectedJob)], logs: log(data), expectedPluginConfigMap: configMap,
    observedPluginConfigMap: observedConfigMap, expectedImageDigest: DIGEST, now: NOW,
  })
  assert.equal(evidence.status, 'fail')
  assert.ok(evidence.failure_codes.includes('immutable_plugin_config_unbound'))
})
