import { Hono } from 'hono'
import type { AuthContext, Env } from '../types'
import { listNeedsYou } from './service'
import { principalCanReadProject, routinePrincipal } from '../routines/access'
import { noStore, routineAuth } from '../routines/routes'

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

function validId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,200}$/.test(value)
}

function pagination(c: { req: { query: (key: string) => string | undefined } }): { limit?: number; after?: string } | null {
  const rawLimit = c.req.query('limit')
  const after = c.req.query('cursor')
  if (rawLimit !== undefined && !/^[1-9]\d{0,2}$/.test(rawLimit)) return null
  if (after !== undefined && !/^[A-Za-z0-9_-]{1,200}$/.test(after)) return null
  const limit = rawLimit === undefined ? undefined : Number(rawLimit)
  return limit === undefined || (limit >= 1 && limit <= 100)
    ? { ...(limit === undefined ? {} : { limit }), ...(after === undefined ? {} : { after }) }
    : null
}

export const attentionApp = new Hono<AppEnv>()

attentionApp.use('*', noStore)
attentionApp.use('*', routineAuth)

attentionApp.get('/needs-you', async (c) => {
  const options = pagination(c)
  if (!options) return c.json({ error: 'invalid_pagination' }, 400)
  try {
    return c.json(await listNeedsYou(c.env, routinePrincipal(c.get('auth')), options))
  } catch {
    return c.json({ error: 'invalid_pagination' }, 400)
  }
})

attentionApp.get('/projects/:projectId/needs-you', async (c) => {
  const projectId = c.req.param('projectId')
  const options = pagination(c)
  if (!validId(projectId) || !options) return c.json({ error: !options ? 'invalid_pagination' : 'project_not_found' }, !options ? 400 : 404)
  const principal = routinePrincipal(c.get('auth'))
  if (!await principalCanReadProject(c.env, principal, projectId)) return c.json({ error: 'project_not_found' }, 404)
  try {
    return c.json(await listNeedsYou(c.env, principal, { ...options, project_id: projectId }))
  } catch {
    return c.json({ error: 'invalid_pagination' }, 400)
  }
})
