import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAllDocuments } from 'yaml'

import {
  KUBERNETES_GEO_SCANNER_RECEIPT_TYPE,
  buildKubernetesGeoScannerReceipt,
} from '../scripts/kubernetes-geo-scanner-receipt.mjs'

const ROOT = join(__dirname, '..')
const cronjobPath = join(ROOT, 'deploy/kubernetes/geo-scanner/viamar-cronjob.yaml')
const networkPolicyPath = join(ROOT, 'deploy/kubernetes/geo-scanner/network-policy.yaml')
const profilePath = join(ROOT, 'deploy/kubernetes/geo-scanner/viamar-profile.json')
const dockerfilePath = join(ROOT, 'deploy/kubernetes/agent-host/Dockerfile.hermes')
const IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`

function documents(path: string): Array<Record<string, any>> {
  return parseAllDocuments(readFileSync(path, 'utf8')).map((document) => document.toJSON())
}

describe('Viamar Kubernetes GEO scanner project cell', () => {
  it('runs a bounded non-root CronJob with dedicated identity, secrets, and persistent budget state', () => {
    const docs = documents(cronjobPath)
    const serviceAccount = docs.find((doc) => doc.kind === 'ServiceAccount')!
    const configMap = docs.find((doc) => doc.kind === 'ConfigMap')!
    const claim = docs.find((doc) => doc.kind === 'PersistentVolumeClaim')!
    const cronjob = docs.find((doc) => doc.kind === 'CronJob')!
    const pod = cronjob.spec.jobTemplate.spec.template.spec
    const container = pod.containers[0]
    const volumeByName = new Map(pod.volumes.map((volume: any) => [volume.name, volume]))
    const mountByName = new Map(container.volumeMounts.map((mount: any) => [mount.name, mount]))

    expect(serviceAccount.metadata.name).toBe('viamar-geo-scanner')
    expect(serviceAccount.metadata.annotations['iam.gke.io/gcp-service-account'])
      .toBe('mumega-agent@mumega-com.iam.gserviceaccount.com')
    expect(cronjob.spec.schedule).toBe('0 10 * * *')
    expect(cronjob.spec.concurrencyPolicy).toBe('Forbid')
    expect(cronjob.spec.startingDeadlineSeconds).toBe(1800)
    expect(cronjob.spec.successfulJobsHistoryLimit).toBe(3)
    expect(cronjob.spec.failedJobsHistoryLimit).toBe(3)
    expect(cronjob.spec.jobTemplate.spec.backoffLimit).toBe(0)
    expect(pod.restartPolicy).toBe('Never')
    expect(pod.serviceAccountName).toBe('viamar-geo-scanner')
    expect(pod.automountServiceAccountToken).toBe(true)
    expect(pod.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 10000,
      runAsGroup: 10000,
      fsGroup: 10000,
      seccompProfile: { type: 'RuntimeDefault' },
    })
    expect(container.command).toEqual([
      '/usr/local/bin/node',
      '/opt/mupot/geo-scanner/cli.mjs',
    ])
    expect(container.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      capabilities: { drop: ['ALL'] },
    })
    expect(container.resources.requests).toEqual({ cpu: '100m', memory: '128Mi' })
    expect(container.resources.limits).toEqual({ cpu: '1', memory: '512Mi' })
    expect(JSON.parse(configMap.data['profile.json'])).toEqual(JSON.parse(readFileSync(profilePath, 'utf8')))

    expect(volumeByName.get('posthog-token')).toMatchObject({
      secret: { secretName: 'viamar-posthog-capture', defaultMode: 0o440 },
    })
    expect(volumeByName.get('mupot-token')).toMatchObject({
      secret: { secretName: 'viamar-geo-scanner-agent', defaultMode: 0o440 },
    })
    expect(volumeByName.get('budget-state')).toMatchObject({
      persistentVolumeClaim: { claimName: 'viamar-geo-scanner-state' },
    })
    expect(claim.metadata.name).toBe('viamar-geo-scanner-state')
    expect(mountByName.get('profile')).toMatchObject({ readOnly: true })
    expect(mountByName.get('posthog-token')).toMatchObject({ readOnly: true })
    expect(mountByName.get('mupot-token')).toMatchObject({ readOnly: true })
    expect(mountByName.get('budget-state')).toMatchObject({ mountPath: '/var/lib/mupot/geo-budget' })

    const serialized = JSON.stringify(docs)
    expect(serialized).not.toMatch(/Bearer\s+\S+|\bmupot_[A-Za-z0-9_-]{16,}\b/)
    expect(docs.some((doc) => doc.kind === 'Secret')).toBe(false)
  })

  it('allows only DNS, GKE metadata identity, and the trusted egress gateway', () => {
    const policy = documents(networkPolicyPath)[0]
    expect(policy.kind).toBe('NetworkPolicy')
    expect(policy.spec.policyTypes).toEqual(['Ingress', 'Egress'])
    expect(policy.spec.ingress).toEqual([])
    expect(policy.spec.egress).toHaveLength(3)
    expect(JSON.stringify(policy.spec.egress)).toContain('kube-system')
    expect(JSON.stringify(policy.spec.egress)).toContain('169.254.169.254/32')
    expect(JSON.stringify(policy.spec.egress)).toContain('trusted-egress')
    expect(JSON.stringify(policy.spec.egress)).not.toContain('0.0.0.0/0')
  })

  it('reports the checked-in tag as an honest plan and passes once an immutable image is supplied', () => {
    const plan = buildKubernetesGeoScannerReceipt({
      root: ROOT,
      cronjobPath,
      networkPolicyPath,
      profilePath,
      dockerfilePath,
    })
    expect(plan.schema).toBe(KUBERNETES_GEO_SCANNER_RECEIPT_TYPE)
    expect(plan.status).toBe('plan')
    expect(plan.checks.find((check: any) => check.check === 'image_digest_pinned')).toEqual({
      check: 'image_digest_pinned',
      ok: false,
      code: 'image_digest_unresolved',
    })
    expect(plan.checks.find((check: any) => check.check === 'project_id_resolved')).toEqual({
      check: 'project_id_resolved',
      ok: true,
    })
    expect(plan.checks.filter((check: any) =>
      check.check !== 'image_digest_pinned' && check.check !== 'project_id_resolved')
      .every((check: any) => check.ok))
      .toBe(true)

    const dir = mkdtempSync(join(tmpdir(), 'mupot-geo-manifest-'))
    try {
      const pinnedPath = join(dir, 'viamar-cronjob.yaml')
      writeFileSync(
        pinnedPath,
        readFileSync(cronjobPath, 'utf8')
          .replace('registry.example/mupot-agent-host-hermes:0.24.0', `registry.example/mupot-agent-host-hermes@${IMAGE_DIGEST}`),
      )
      const resolvedProfile = join(dir, 'viamar-profile.json')
      const resolvedProjectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      writeFileSync(
        resolvedProfile,
        readFileSync(profilePath, 'utf8')
          .replace('00000000-0000-4000-8000-000000000000', resolvedProjectId),
      )
      writeFileSync(
        pinnedPath,
        readFileSync(pinnedPath, 'utf8')
          .replace('00000000-0000-4000-8000-000000000000', resolvedProjectId),
      )
      const receipt = buildKubernetesGeoScannerReceipt({
        root: ROOT,
        cronjobPath: pinnedPath,
        networkPolicyPath,
        profilePath: resolvedProfile,
        dockerfilePath,
      })
      expect(receipt.status).toBe('pass')
      expect(receipt.image_digest).toBe(IMAGE_DIGEST)
      expect(receipt.checks.every((check: any) => check.ok)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails executable proof when inline credential material is introduced', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mupot-geo-secret-'))
    try {
      const unsafePath = join(dir, 'unsafe.yaml')
      writeFileSync(
        unsafePath,
        `${readFileSync(cronjobPath, 'utf8')}\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: leaked\nstringData:\n  token: leaked-value\n`,
      )
      const receipt = buildKubernetesGeoScannerReceipt({
        root: ROOT,
        cronjobPath: unsafePath,
        networkPolicyPath,
        profilePath,
        dockerfilePath,
      })
      expect(receipt.status).toBe('fail')
      expect(receipt.checks.find((check: any) => check.check === 'credential_free')).toEqual({
        check: 'credential_free',
        ok: false,
        code: 'credential_material_present',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
