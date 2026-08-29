#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const outDir = path.resolve('tmp/device-grant')
await mkdir(outDir, { recursive: true })

const enterHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Approve agent access</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; color: #111; background: #fff; }
  h1 { font-size: 1.25rem; }
  .card { border: 1px solid #ccc; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  .code-input { font-size: 1.5rem; letter-spacing: 0.2rem; font-family: ui-monospace, monospace; width: 12rem; padding: 0.4rem; text-transform: uppercase; }
  .actions { display: flex; gap: 0.75rem; margin-top: 1rem; }
  button { padding: 0.5rem 1rem; font-size: 1rem; }
  .hint, .meta { font-size: 0.85rem; color: #444; }
</style>
</head>
<body>
<h1>Approve agent access</h1>
<p class="meta">Signed in as <strong>local-owner@mupot.test</strong>.</p>
<p class="hint">Type the code shown on the agent screen, then continue. Pending requests are not listed here.</p>
<form class="card">
  <label for="user_code">Code</label><br>
  <input class="code-input" id="user_code" name="user_code" value="R7KM-2P4Q" maxlength="12">
  <div class="actions">
    <button type="button">Continue</button>
  </div>
</form>
</body>
</html>`

const confirmHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Confirm agent access</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; color: #111; background: #fff; }
  h1 { font-size: 1.25rem; }
  .card { border: 1px solid #ccc; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  .actions { display: flex; gap: 0.75rem; margin-top: 1rem; }
  button { padding: 0.5rem 1rem; font-size: 1rem; }
  .hint, .meta { font-size: 0.85rem; color: #444; }
</style>
</head>
<body>
<h1>Confirm agent access</h1>
<p class="meta">Signed in as <strong>local-owner@mupot.test</strong>.</p>
<form class="card">
  <p>Grant a pot token to <strong>Hermes Local</strong> <code>hermes</code>?</p>
  <p class="hint">This is the request for the code you typed. No token is shown on this page.</p>
  <div class="actions">
    <button type="button">Allow</button>
    <button type="button">Deny</button>
  </div>
</form>
</body>
</html>`

await writeFile(path.join(outDir, 'enter.html'), enterHtml)
await writeFile(path.join(outDir, 'confirm.html'), confirmHtml)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 800, height: 520 } })
await page.setContent(enterHtml, { waitUntil: 'load' })
await page.screenshot({ path: path.join(outDir, 'enter.png') })
await page.setContent(confirmHtml, { waitUntil: 'load' })
await page.screenshot({ path: path.join(outDir, 'confirm.png') })
await browser.close()
console.log(`wrote ${outDir}/enter.png and confirm.png`)
