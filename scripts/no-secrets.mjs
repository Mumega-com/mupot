import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const rules = [
  {
    label: 'OpenAI API key',
    pattern: /sk-[A-Za-z0-9_-]{20,}/,
  },
  {
    label: 'GitHub personal access token',
    pattern: /ghp_[A-Za-z0-9]{20,}/,
  },
  {
    label: 'private key',
    pattern: new RegExp(['BEGIN', '(?:RSA|EC|OPENSSH)', 'PRIVATE KEY'].join(' ')),
  },
]

function parseRoot(args) {
  if (args.length === 0) return process.cwd()
  if (args.length === 2 && args[0] === '--root' && args[1]) return resolve(args[1])
  throw new Error('usage: node scripts/no-secrets.mjs [--root <repository>]')
}

function trackedFiles(root) {
  const output = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached'], {
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return output.toString('utf8').split('\0').filter(Boolean)
}

function decodeText(buffer) {
  if (buffer.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return null
  }
}

function displayPath(path) {
  return path.replaceAll('\r', '\\r').replaceAll('\n', '\\n')
}

function scan(root) {
  const findings = []

  for (const path of trackedFiles(root)) {
    const absolutePath = resolve(root, path)
    if (!lstatSync(absolutePath).isFile()) continue

    const text = decodeText(readFileSync(absolutePath))
    if (text === null) continue

    const lines = text.split(/\r?\n/)
    for (const [index, line] of lines.entries()) {
      for (const rule of rules) {
        if (rule.pattern.test(line)) {
          findings.push(`${displayPath(path)}:${index + 1}: ${rule.label}`)
        }
      }
    }
  }

  return findings
}

try {
  const root = parseRoot(process.argv.slice(2))
  const findings = scan(root)
  if (findings.length > 0) {
    for (const finding of findings) console.error(finding)
    console.error(`possible secrets found in ${findings.length} location(s)`)
    process.exitCode = 1
  } else {
    console.log('no secrets found')
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`no-secrets scan failed: ${message}`)
  process.exitCode = 2
}
