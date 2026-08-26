// src/athena/routes.ts — HTTP seam for the Athena GitHub webhook gate.
//
// POST /api/webhooks/github  (mounted at that prefix in src/index.ts)
//
// Unauthenticated by session. Proof is HMAC (`X-Hub-Signature-256`) or the
// fail-safe bearer token path in src/athena/webhook.ts.

import { Hono } from 'hono'
import type { Env } from '../types'
import { handleAthenaGitHubWebhook, type AthenaWebhookDeps } from './webhook'

export function createAthenaWebhookApp(deps: AthenaWebhookDeps = {}): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>()

  app.post('/', async (c) => {
    const result = await handleAthenaGitHubWebhook(c.env, c.req.raw, deps)
    return c.json(result.body, result.status as 200 | 400 | 401 | 413 | 503)
  })

  return app
}

export const athenaWebhookApp = createAthenaWebhookApp()
