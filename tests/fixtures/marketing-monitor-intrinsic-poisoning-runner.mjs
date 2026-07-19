import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  configFile: false,
  logLevel: 'silent',
  server: { middlewareMode: true },
})

try {
  const fixture = await server.ssrLoadModule('/tests/fixtures/marketing-monitor-intrinsic-poisoning.ts')
  const result = await fixture.runMarketingMonitorIntrinsicPoisoning()
  process.stdout.write(`${JSON.stringify(result)}\n`)
} finally {
  await server.close()
}
