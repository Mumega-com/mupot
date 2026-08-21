import { describe, expect, it } from "vitest"
import { mcpApp } from "../src/mcp"
import type { CapabilityGrant, Env } from "../src/types"

// Issue #1192: Stateless Connect Persistence & Security Invariant Test Suite

const SQUAD = { id: "squad-acme-eng", department_id: "dept-1" }
const AGENT = {
  id: "agent-growth-lead",
  squad_id: "squad-acme-eng",
  slug: "growth-lead",
  name: "Growth Lead",
}

interface MockState {
  boundAgentId: string | null
  tokenChannel: string
  grants: CapabilityGrant[]
}

function makeStatelessEnv(state: MockState): { env: Env; getState: () => MockState } {
  const memberId = "member-bot-1"
  const tokenId = "token-bot-1"

  const handler = (sql: string) => ({
    bind(...args: unknown[]) {
      const bound = args[0]
      return {
        sql,
        args,
        async run() {
          if (sql.includes("UPDATE member_tokens SET agent_id")) {
            state.boundAgentId = args[0] as string
            return { success: true, meta: { changes: 1 } }
          }
          return { success: true, meta: { changes: 0 } }
        },
        async first() {
          if (sql.includes("FROM member_tokens")) {
            return {
              token_id: tokenId,
              member_id: memberId,
              email: null,
              display_name: "Bot",
              telegram_chat_id: null,
              status: "active",
              created_at: "2026-06-13 00:00:00",
              channel: state.tokenChannel,
              bound_agent_id: state.boundAgentId,
            }
          }
          if (sql.includes("FROM squads") && sql.includes("WHERE id")) {
            if (bound === SQUAD.id) return { id: SQUAD.id, name: "Acme Eng", charter: null, okr: null, department_id: SQUAD.department_id }
            return null
          }
          if (sql.includes("FROM departments") && sql.includes("WHERE id")) {
            return { id: SQUAD.department_id, name: "Engineering" }
          }
          if (sql.includes("FROM agents") && sql.includes("kpi_progress")) {
            return {
              id: AGENT.id,
              squad_id: AGENT.squad_id,
              slug: AGENT.slug,
              name: AGENT.name,
              role: "engineer",
              status: "active",
              effort: "standard",
              autonomy: "draft",
              kpi_progress: 0,
              budget_cap_cents: null,
              budget_window: "day",
              okr: null,
              kpi_target: null,
            }
          }
          if (sql.includes("FROM agents") && sql.includes("WHERE id")) {
            if (bound === AGENT.id) return { id: AGENT.id, squad_id: AGENT.squad_id, slug: AGENT.slug, name: AGENT.name }
            return null
          }
          return null
        },
        async all() {
          if (sql.includes("FROM capabilities")) return { results: state.grants }
          if (sql.includes("FROM agents") && sql.includes("WHERE slug")) {
            return { results: [{ id: AGENT.id, squad_id: AGENT.squad_id, slug: AGENT.slug, name: AGENT.name }] }
          }
          return { results: [] }
        },
      }
    },
  })

  const env = {
    TENANT_SLUG: "acme",
    BRAND: "Acme Co",
    OAUTH_PROVIDER: "google",
    DB: { prepare: (sql: string) => handler(sql), batch: () => Promise.resolve([]) } as unknown as Env["DB"],
    VEC: { query: async () => ({ matches: [] }) } as unknown as Env["VEC"],
    BUS: { send: async () => {} } as unknown as Env["BUS"],
    SESSIONS: {} as unknown as Env["SESSIONS"],
    OAUTH_KV: {} as unknown as Env["OAUTH_KV"],
    BLOBS: {} as unknown as Env["BLOBS"],
    AI: {} as unknown as Env["AI"],
    AGENT: {} as unknown as Env["AGENT"],
    SQUAD: {} as unknown as Env["SQUAD"],
  } as unknown as Env

  return { env, getState: () => state }
}

async function callTool(env: Env, toolName: string, args: Record<string, unknown> = {}) {
  return mcpApp.request(
    "https://mcp.acme-example.co/",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer test-token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
    },
    env,
  )
}

describe("Issue #1192 — Stateless Connect Persistence Regression Suite", () => {
  it("connect_then_orient_returns_claimed_agent across stateless calls", async () => {
    const { env, getState } = makeStatelessEnv({
      boundAgentId: null,
      tokenChannel: "workspace",
      grants: [{ member_id: "member-bot-1", scope_type: "squad", scope_id: SQUAD.id, capability: "member" }],
    })

    // Step 1: Initial stateless connect call
    const connectRes = await callTool(env, "connect", { agent_name: AGENT.slug })
    expect(connectRes.status).toBe(200)
    const connectBody = (await connectRes.json()) as any
    expect(connectBody.result.structuredContent.connection_status).toBe("hot")
    expect(connectBody.result.structuredContent.binding).toBe("durable")
    expect(getState().boundAgentId).toBe(AGENT.id)

    // Step 2: Next completely stateless orient call (reads D1 state directly)
    const orientRes = await callTool(env, "orient", {})
    expect(orientRes.status).toBe(200)
    const orientBody = (await orientRes.json()) as any
    expect(orientBody.result.structuredContent.packet.agent.id).toBe(AGENT.id)
    expect(orientBody.result.structuredContent.packet.agent.name).toBe(AGENT.name)
  })

  it("unauthorized_squad_claim_refuses_d1_weld", async () => {
    const { env, getState } = makeStatelessEnv({
      boundAgentId: null,
      tokenChannel: "workspace",
      grants: [], // No squad capability
    })

    const res = await callTool(env, "connect", { agent_name: AGENT.slug })
    expect(res.status).toBe(403)
    expect(getState().boundAgentId).toBeNull() // D1 must not be modified
  })

  it("directory_unbound_bearer_writes_fail_closed", async () => {
    const { env } = makeStatelessEnv({
      boundAgentId: null,
      tokenChannel: "directory",
      grants: [],
    })

    // An unbound directory session must fail closed on send
    const sendRes = await callTool(env, "send", {
      to: "peer-agent-id",
      body: "Hello from unbound",
      kind: "message",
    })
    expect(sendRes.status).toBe(403)
  })
})
