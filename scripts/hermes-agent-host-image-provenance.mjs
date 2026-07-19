#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const HERMES_IMAGE_PROVENANCE_TYPE = 'mupot.hermes-agent-host-image-provenance/v1'
export const HERMES_BASE_DIGEST = 'sha256:8d56cd839ad76b0fc2c9202f39a7ffe1b464c247059a17bc3c72ba6b4ae57616'

const IMAGE_DIGEST_RE = /^sha256:[a-f0-9]{64}$/
const REVISION_RE = /^[a-f0-9]{7,64}$/
export const HERMES_RUNTIME_FILES = Object.freeze([
  'container-entrypoint.mjs',
  'fleet-daemon.mjs',
  'fleet-sign.mjs',
  'runtime-state.mjs',
  'service-context.mjs',
  'inbox-handler.mjs',
  'profile-contract.mjs',
  'profile-runner.mjs',
  'hermes-inbox-adapter.mjs',
  'hermes-plugin-smoke.mjs',
  'hermes-query-stdin.py',
])

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function sourceContract(root = process.cwd()) {
  const dockerfilePath = resolve(root, 'deploy/kubernetes/agent-host/Dockerfile.hermes')
  const runtimeDir = resolve(root, 'fleet-runtime')
  const runtimeFiles = [...HERMES_RUNTIME_FILES].sort()
    .map((name) => ({ name, sha256: sha256(readFileSync(join(runtimeDir, name))) }))
  return {
    dockerfile_path: dockerfilePath,
    dockerfile_sha256: sha256(readFileSync(dockerfilePath)),
    runtime_bundle_sha256: sha256(runtimeFiles.map((entry) => `${entry.name}\0${entry.sha256}\n`).join('')),
    runtime_files: runtimeFiles,
  }
}

function check(checks, ok, name, code) {
  checks.push({ check: name, ok: Boolean(ok), ...(ok ? {} : { code }) })
}

function exact(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function buildHermesImageProvenance(input) {
  const checks = []
  const source = input.sourceContract
  const inspect = input.inspect
  const config = inspect?.Config
  const labels = config?.Labels ?? {}
  const imageDigest = input.imageDigest
  check(checks, IMAGE_DIGEST_RE.test(imageDigest ?? ''), 'image_digest_valid', 'image_digest_invalid')
  check(checks, REVISION_RE.test(input.sourceRevision ?? ''), 'source_revision_valid', 'source_revision_invalid')
  check(checks, inspect?.Id === imageDigest || input.imageRef?.endsWith(`@${imageDigest}`), 'inspected_digest_ref', 'inspected_digest_unbound')
  check(checks, labels['org.opencontainers.image.revision'] === input.sourceRevision, 'revision_label_matches', 'revision_label_mismatch')
  check(checks, labels['com.mumega.mupot.dockerfile-sha256'] === source.dockerfile_sha256, 'dockerfile_label_matches', 'dockerfile_label_mismatch')
  check(checks, labels['com.mumega.mupot.runtime-bundle-sha256'] === source.runtime_bundle_sha256, 'runtime_label_matches', 'runtime_label_mismatch')
  check(checks, labels['com.mumega.mupot.hermes-base-digest'] === HERMES_BASE_DIGEST, 'base_digest_label_matches', 'base_digest_label_mismatch')
  check(checks, config?.User === '10000:10000', 'runtime_user_exact', 'runtime_user_invalid')
  check(checks, exact(config?.Entrypoint, ['/usr/local/bin/node', '/opt/mupot/container-entrypoint.mjs']), 'entrypoint_exact', 'entrypoint_invalid')
  check(checks, input.uid === '10000' && input.gid === '10000', 'runtime_identity_smoke', 'runtime_identity_smoke_failed')
  check(checks, /(?:^|[^0-9])0\.18\.2(?:[^0-9]|$)/.test(input.hermesVersion ?? ''), 'hermes_version_smoke', 'hermes_version_smoke_failed')
  check(checks, input.adapterImport === 'adapter-import-ok', 'adapter_import_smoke', 'adapter_import_smoke_failed')
  check(
    checks,
    input.stdinBridgeContract === 'stdin-bridge-contract-ok',
    'stdin_bridge_contract_smoke',
    'stdin_bridge_contract_smoke_failed',
  )
  const failed = checks.filter((entry) => !entry.ok)
  return {
    schema: HERMES_IMAGE_PROVENANCE_TYPE,
    generated_at: new Date().toISOString(),
    status: failed.length === 0 ? 'pass' : 'fail',
    image_digest: IMAGE_DIGEST_RE.test(imageDigest ?? '') ? imageDigest : null,
    source_revision: REVISION_RE.test(input.sourceRevision ?? '') ? input.sourceRevision : null,
    base_image_digest: HERMES_BASE_DIGEST,
    dockerfile: { filename: basename(source.dockerfile_path), sha256: source.dockerfile_sha256 },
    runtime_bundle: { sha256: source.runtime_bundle_sha256, files: source.runtime_files },
    runtime: {
      user: config?.User === '10000:10000' ? '10000:10000' : null,
      hermes_version: /(?:^|[^0-9])0\.18\.2(?:[^0-9]|$)/.test(input.hermesVersion ?? '') ? '0.18.2' : null,
      adapter_imported: input.adapterImport === 'adapter-import-ok',
      stdin_bridge_contract_verified: input.stdinBridgeContract === 'stdin-bridge-contract-ok',
    },
    checks,
    failure_codes: failed.map((entry) => entry.code),
  }
}

function run(executable, args, options = {}) {
  const result = execFileSync(executable, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, ...options })
  return typeof result === 'string' ? result.trim() : ''
}

function runCaptured(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${executable} exited nonzero`)
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
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
    if (arg === '--image') options.image = next()
    else if (arg === '--build-tag') options.buildTag = next()
    else if (arg === '--image-digest') options.imageDigest = next()
    else if (arg === '--source-revision') options.sourceRevision = next()
    else if (arg === '--output') options.output = next()
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log('Usage: node scripts/hermes-agent-host-image-provenance.mjs (--build-tag TAG | --image REF --image-digest SHA256) [--source-revision REV] [--output FILE]')
    return
  }
  const source = sourceContract()
  const sourceRevision = options.sourceRevision ?? run('git', ['rev-parse', 'HEAD'])
  let imageRef = options.image
  if (options.buildTag) {
    run('docker', [
      'build', '-f', source.dockerfile_path,
      '--build-arg', `MUPOT_SOURCE_REVISION=${sourceRevision}`,
      '--build-arg', `MUPOT_DOCKERFILE_SHA256=${source.dockerfile_sha256}`,
      '--build-arg', `MUPOT_RUNTIME_BUNDLE_SHA256=${source.runtime_bundle_sha256}`,
      '-t', options.buildTag, '.',
    ], { stdio: 'inherit' })
    imageRef = options.buildTag
  }
  if (!imageRef) throw new Error('one of --build-tag or --image is required')
  const inspect = JSON.parse(run('docker', ['image', 'inspect', imageRef]))[0]
  const imageDigest = options.imageDigest ?? inspect?.Id
  const container = (entrypoint, args = []) => runCaptured('docker', [
    'run', '--rm', '--entrypoint', entrypoint, imageRef, ...args,
  ])
  const provenance = buildHermesImageProvenance({
    sourceContract: source,
    sourceRevision,
    imageRef,
    imageDigest,
    inspect,
    uid: container('/usr/bin/id', ['-u']),
    gid: container('/usr/bin/id', ['-g']),
    hermesVersion: container('/usr/local/bin/hermes', ['--version']),
    adapterImport: container('/usr/local/bin/node', [
      '--input-type=module', '-e',
      "await import('/opt/mupot/hermes-inbox-adapter.mjs'); console.log('adapter-import-ok')",
    ]),
    stdinBridgeContract: container('/opt/hermes/.venv/bin/python3', [
      '-c',
      "import ast,inspect,sys; ast.parse(open('/opt/mupot/hermes-query-stdin.py', encoding='utf-8').read()); sys.path.insert(0,'/opt/hermes'); from cli import main; required={'query','toolsets','max_turns','quiet'}; assert required.issubset(inspect.signature(main).parameters); print('stdin-bridge-contract-ok')",
    ]),
  })
  const output = `${JSON.stringify(provenance, null, 2)}\n`
  if (options.output) writeFileSync(options.output, output, { mode: 0o600 })
  else process.stdout.write(output)
  if (provenance.status !== 'pass') process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
