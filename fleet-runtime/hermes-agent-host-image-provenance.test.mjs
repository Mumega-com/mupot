import test from 'node:test'
import assert from 'node:assert/strict'

import {
  HERMES_BASE_DIGEST,
  HERMES_IMAGE_PROVENANCE_TYPE,
  buildHermesImageProvenance,
  sourceContract,
} from '../scripts/hermes-agent-host-image-provenance.mjs'

function input() {
  const source = sourceContract()
  const imageDigest = `sha256:${'a'.repeat(64)}`
  const sourceRevision = 'b'.repeat(40)
  return {
    sourceContract: source,
    imageDigest,
    imageRef: imageDigest,
    sourceRevision,
    inspect: {
      Id: imageDigest,
      Config: {
        User: '10000:10000',
        Entrypoint: ['/usr/local/bin/node', '/opt/mupot/container-entrypoint.mjs'],
        Labels: {
          'org.opencontainers.image.revision': sourceRevision,
          'com.mumega.mupot.dockerfile-sha256': source.dockerfile_sha256,
          'com.mumega.mupot.runtime-bundle-sha256': source.runtime_bundle_sha256,
          'com.mumega.mupot.hermes-base-digest': HERMES_BASE_DIGEST,
        },
      },
    },
    uid: '10000',
    gid: '10000',
    hermesVersion: '0.18.2',
    adapterImport: 'adapter-import-ok',
    stdinBridgeContract: 'stdin-bridge-contract-ok',
  }
}

test('binds a passing image receipt to reviewed source labels and runtime smoke', () => {
  const receipt = buildHermesImageProvenance(input())
  assert.equal(receipt.schema, HERMES_IMAGE_PROVENANCE_TYPE)
  assert.equal(receipt.status, 'pass')
  assert.equal(receipt.failure_codes.length, 0)
  assert.match(receipt.dockerfile.sha256, /^[a-f0-9]{64}$/)
  assert.match(receipt.runtime_bundle.sha256, /^[a-f0-9]{64}$/)
  assert.ok(receipt.runtime_bundle.files.some((entry) => entry.name === 'hermes-inbox-adapter.mjs'))
})

test('fails when a digest is unbound or a reviewed source label changes', () => {
  const value = input()
  value.inspect.Id = `sha256:${'c'.repeat(64)}`
  value.inspect.Config.Labels['com.mumega.mupot.runtime-bundle-sha256'] = 'd'.repeat(64)
  const receipt = buildHermesImageProvenance(value)
  assert.equal(receipt.status, 'fail')
  assert.ok(receipt.failure_codes.includes('inspected_digest_unbound'))
  assert.ok(receipt.failure_codes.includes('runtime_label_mismatch'))
})
