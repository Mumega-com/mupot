import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServiceContext, definitionSha256 } from './service-context.mjs'
import {
  installLaunchd,
  reloadLaunchd,
  renderLaunchd,
  statusLaunchd,
  uninstallLaunchd,
} from './launchd-service-manager.mjs'

async function fixtureContext() {
  const root = await mkdtemp(join(tmpdir(), 'mupot-launchd-'))
  return createServiceContext({
    manager: 'launchd',
    homeDir: join(root, 'home & <ops> "quote" \'apostrophe\''),
    prefix: join(root, 'fleet & <prefix>'),
    runtimeDir: join(root, 'runtime & <scripts>'),
    logsDir: join(root, 'logs & <output>'),
    definitionDir: join(root, 'definitions & <plist>'),
    nodePath: join(root, 'bin & <node>', 'node'),
    uid: 501,
    username: 'fleet',
  })
}

function recordingRunner(overrides = {}) {
  const calls = []
  const runner = async (argv) => {
    calls.push(argv)
    return overrides[argv[1]]?.(argv, calls) ?? { code: 0, stdout: '', stderr: '' }
  }
  return { calls, runner }
}

function programArguments(content) {
  const match = content.match(/<key>ProgramArguments<\/key><array>(.*?)<\/array>/)
  assert.ok(match)
  return [...match[1].matchAll(/<string>(.*?)<\/string>/g)].map((entry) => entry[1]
    .replaceAll('&apos;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&'))
}

test('renderLaunchd emits escaped absolute plist definitions without secret-like fields', async () => {
  const context = await fixtureContext()
  const definitions = renderLaunchd(context)

  assert.equal(definitions.length, 2)
  assert.deepEqual(definitions.map((definition) => definition.label), [
    'com.mumega.mupot-fleet-daemon',
    'com.mumega.mupot-fleet-control',
  ])
  for (const [index, definition] of definitions.entries()) {
    assert.equal(definition.path.startsWith('/'), true)
    assert.match(definition.content, /^<\?xml version="1\.0" encoding="UTF-8"\?>/)
    assert.match(definition.content, /<string>\/.*bin &amp; &lt;node&gt;\/node<\/string>/)
    assert.match(definition.content, /<string>\/.*runtime &amp; &lt;scripts&gt;\/fleet-(?:control-)?daemon\.mjs<\/string>/)
    assert.match(definition.content, /<key>RunAtLoad<\/key><true\/>/)
    assert.match(definition.content, /<key>KeepAlive<\/key><true\/>/)
    assert.match(definition.content, /<key>ProcessType<\/key><string>Background<\/string>/)
    assert.match(definition.content, /<key>EnvironmentVariables<\/key><dict><key>HOME<\/key><string>.*<\/string><key>PATH<\/key><string>\/usr\/local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string><\/dict>/)
    assert.match(definition.content, /<key>StandardOutPath<\/key><string>\/.*logs &amp; &lt;output&gt;\/fleet-(?:control-)?daemon\.log<\/string>/)
    assert.match(definition.content, /<key>StandardErrorPath<\/key><string>\/.*logs &amp; &lt;output&gt;\/fleet-(?:control-)?daemon\.err\.log<\/string>/)
    assert.doesNotMatch(definition.content, /token|secret|password|private[_-]?key|authorization/i)
    assert.match(definition.content, /home &amp; &lt;ops&gt; &quot;quote&quot; &apos;apostrophe&apos;/)
    const argv = programArguments(definition.content)
    assert.equal(argv.length, 3)
    assert.equal(argv.every((argument) => argument.startsWith('/')), true)
    assert.deepEqual(argv, context.services[index].argv)
  }
  assert.deepEqual(Object.keys(definitions[0].environment), ['HOME', 'PATH'])
})

test('installLaunchd bootstraps only services that launchctl reports as unloaded', async () => {
  const context = await fixtureContext()
  const { calls, runner } = recordingRunner({
    print: () => ({ code: 113, stdout: '', stderr: 'not found' }),
  })

  const result = await installLaunchd(context, runner)

  assert.equal(result.ok, true)
  assert.deepEqual(calls.filter((call) => call[1] === 'bootstrap').map((call) => call.slice(0, 3)), [
    ['launchctl', 'bootstrap', 'gui/501'],
    ['launchctl', 'bootstrap', 'gui/501'],
  ])
  for (const service of context.services) {
    assert.equal((await readFile(service.definitionPath, 'utf8')).includes('<plist version="1.0">'), true)
  }
})

test('installLaunchd does not bootstrap a service when launchctl state is unknown', async () => {
  const context = await fixtureContext()
  const { calls, runner } = recordingRunner({
    print: () => ({ code: 1, stdout: '', stderr: 'launchctl unavailable' }),
  })

  const result = await installLaunchd(context, runner)

  assert.equal(result.ok, false)
  assert.equal(calls.some((call) => call[1] === 'bootstrap'), false)
})

test('statusLaunchd parses a loaded service pid and an unloaded exit 113', async () => {
  const context = await fixtureContext()
  const { runner } = recordingRunner({
    print: (argv) => argv[2].endsWith(context.services[0].launchdLabel)
      ? { code: 0, stdout: 'gui/501/com.mumega.mupot-fleet-daemon = {\n\tpid = 4242\n}', stderr: '' }
      : { code: 113, stdout: '', stderr: 'not found' },
  })

  const states = await statusLaunchd(context, runner)

  assert.deepEqual(states.map(({ key, loaded, running, pid }) => ({ key, loaded, running, pid })), [
    { key: 'heartbeat', loaded: true, running: true, pid: 4242 },
    { key: 'control', loaded: false, running: false, pid: null },
  ])
})

test('uninstallLaunchd is idempotent and unlinks only known plist paths', async () => {
  const context = await fixtureContext()
  const definitions = renderLaunchd(context)
  await mkdir(context.definitionDir, { recursive: true })
  for (const definition of definitions) await writeFile(definition.path, definition.content)
  const unrelated = join(context.definitionDir, 'unrelated.plist')
  await writeFile(unrelated, 'leave me')
  const { calls, runner } = recordingRunner({
    print: () => ({ code: 113, stdout: '', stderr: 'not found' }),
  })

  const first = await uninstallLaunchd(context, runner)
  const second = await uninstallLaunchd(context, runner)

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  await assert.rejects(readFile(context.services[0].definitionPath))
  await assert.rejects(readFile(context.services[1].definitionPath))
  assert.equal(await readFile(unrelated, 'utf8'), 'leave me')
  assert.equal(calls.some((call) => call[1] === 'bootout'), false)
})

test('reloadLaunchd restores prior definition bytes before retrying bootstrap after failure', async () => {
  const context = await fixtureContext()
  const definitions = renderLaunchd(context)
  await mkdir(context.definitionDir, { recursive: true })
  const previous = new Map(definitions.map((definition) => [definition.path, `previous:${definition.label}`]))
  for (const [path, content] of previous) await writeFile(path, content)
  const calls = []
  let bootstraps = 0
  const runner = async (argv) => {
    calls.push(argv)
    if (argv[1] === 'print') return { code: 0, stdout: 'pid = 7', stderr: '' }
    if (argv[1] === 'bootstrap') {
      bootstraps += 1
      if (bootstraps === 1) return { code: 1, stdout: '', stderr: 'bootstrap failed' }
      const restored = await readFile(argv[3], 'utf8')
      assert.equal(restored, previous.get(argv[3]))
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }

  const result = await reloadLaunchd(context, runner)

  assert.equal(result.ok, false)
  assert.equal(bootstraps, 3)
  assert.equal(calls.filter((call) => call[1] === 'bootout').length, 3)
  assert.equal(result.services[0].definitionSha256, definitionSha256(previous.get(context.services[0].definitionPath)))
})

test('reloadLaunchd restores every prior loaded state after a later bootstrap fails', async () => {
  const context = await fixtureContext()
  const definitions = renderLaunchd(context)
  await mkdir(context.definitionDir, { recursive: true })
  const previous = new Map(definitions.map((definition) => [definition.path, `previous:${definition.label}`]))
  for (const [path, content] of previous) await writeFile(path, content)
  const calls = []
  let bootstrapCount = 0
  const runner = async (argv) => {
    calls.push(argv)
    if (argv[1] === 'print') {
      return argv[2].endsWith(context.services[0].launchdLabel)
        ? { code: 0, stdout: 'service = {\n\tpid = 7\n}', stderr: '' }
        : { code: 113, stdout: '', stderr: 'not found' }
    }
    if (argv[1] !== 'bootstrap') return { code: 0, stdout: '', stderr: '' }
    bootstrapCount += 1
    const content = await readFile(argv[3], 'utf8')
    if (bootstrapCount === 1) {
      assert.equal(content, definitions[0].content)
      return { code: 0, stdout: '', stderr: '' }
    }
    if (bootstrapCount === 2) {
      assert.equal(content, definitions[1].content)
      return { code: 1, stdout: '', stderr: 'second bootstrap failed' }
    }
    assert.equal(argv[3], context.services[0].definitionPath)
    assert.equal(content, previous.get(argv[3]))
    return { code: 0, stdout: '', stderr: '' }
  }

  const result = await reloadLaunchd(context, runner)

  assert.equal(result.ok, false)
  assert.equal(bootstrapCount, 3)
  assert.deepEqual(calls.filter((call) => call[1] === 'bootstrap').map((call) => call[3]), [
    context.services[0].definitionPath,
    context.services[1].definitionPath,
    context.services[0].definitionPath,
  ])
  assert.equal(calls.filter((call) => call[1] === 'bootout' && call[2] === `${context.domain}/${context.services[0].launchdLabel}`).length, 2)
  assert.equal(calls.filter((call) => call[1] === 'bootout' && call[2] === `${context.domain}/${context.services[1].launchdLabel}`).length, 1)
  for (const [path, content] of previous) assert.equal(await readFile(path, 'utf8'), content)
})

test('reloadLaunchd reboots services already stopped after a partial bootout failure', async () => {
  const context = await fixtureContext()
  const definitions = renderLaunchd(context)
  await mkdir(context.definitionDir, { recursive: true })
  const previous = new Map(definitions.map((definition) => [definition.path, `previous:${definition.label}`]))
  for (const [path, content] of previous) await writeFile(path, content)
  const calls = []
  const runner = async (argv) => {
    calls.push(argv)
    if (argv[1] === 'print') return { code: 0, stdout: 'service = {\n\tpid = 7\n}', stderr: '' }
    if (argv[1] === 'bootout' && argv[2].endsWith(context.services[1].launchdLabel)) return { code: 1, stdout: '', stderr: 'second bootout failed' }
    if (argv[1] === 'bootstrap') assert.equal(await readFile(argv[3], 'utf8'), previous.get(argv[3]))
    return { code: 0, stdout: '', stderr: '' }
  }

  const result = await reloadLaunchd(context, runner)

  assert.equal(result.ok, false)
  assert.deepEqual(calls.filter((call) => call[1] === 'bootstrap').map((call) => call[3]), [context.services[0].definitionPath])
  assert.equal(calls.some((call) => call[1] === 'bootstrap' && call[3] === context.services[1].definitionPath), false)
  for (const [path, content] of previous) assert.equal(await readFile(path, 'utf8'), content)
})

test('reloadLaunchd does not transition services when launchctl state is unknown', async () => {
  const context = await fixtureContext()
  const definitions = renderLaunchd(context)
  await mkdir(context.definitionDir, { recursive: true })
  for (const definition of definitions) await writeFile(definition.path, `previous:${definition.label}`)
  const { calls, runner } = recordingRunner({
    print: () => ({ code: 1, stdout: '', stderr: 'launchctl unavailable' }),
  })

  const result = await reloadLaunchd(context, runner)

  assert.equal(result.ok, false)
  assert.equal(calls.some((call) => call[1] === 'bootout' || call[1] === 'bootstrap'), false)
  for (const definition of definitions) assert.equal(await readFile(definition.path, 'utf8'), `previous:${definition.label}`)
})

test('uninstallLaunchd preserves known definitions when launchctl state is unknown', async () => {
  const context = await fixtureContext()
  const definitions = renderLaunchd(context)
  await mkdir(context.definitionDir, { recursive: true })
  const previous = new Map(definitions.map((definition) => [definition.path, `previous:${definition.label}`]))
  for (const [path, content] of previous) await writeFile(path, content)
  const { calls, runner } = recordingRunner({
    print: () => ({ code: 1, stdout: '', stderr: 'launchctl unavailable' }),
  })

  const result = await uninstallLaunchd(context, runner)

  assert.equal(result.ok, false)
  assert.equal(calls.some((call) => call[1] === 'bootout'), false)
  for (const [path, content] of previous) assert.equal(await readFile(path, 'utf8'), content)
})
