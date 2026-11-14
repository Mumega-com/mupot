// Bridge wiring: one push-opted seat + one SSE seat, real cursor file, fake hub/inbox/clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sl-int-"));
process.env.SEATLINK_STATE = path.join(tmp, "state");
fs.mkdirSync(process.env.SEATLINK_STATE, { recursive: true });
process.env.HERDR_SOCK = path.join(tmp, "none.sock");
const { planInboxTransports, startPushClient, openInboxStream } = await import("./seatlink.mjs");

const tokP = path.join(tmp, "p.tok"); fs.writeFileSync(tokP, "TOK-P\n", { mode: 0o600 });
const tokS = path.join(tmp, "s.tok"); fs.writeFileSync(tokS, "TOK-S\n", { mode: 0o600 });
const keyFile = path.join(tmp, "host.pem");
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
fs.writeFileSync(keyFile, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });

const cfg = {
  mupot_api_url: "https://pot.test",
  seat_events: { host_id: "host-1", tenant: "tenant-x", host_key_file: keyFile },
  seats: [
    { herdr: "seat_push", mupot_agent_id: "agent-push", mupot_token_file: tokP, seat_events: true },
    { herdr: "seat_sse", mupot_agent_id: "agent-sse", mupot_token_file: tokS },
    { herdr: "seat_none" },
  ],
};
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

test("plan: opted-in seat is push, other token seat stays SSE, tokenless seat is neither", () => {
  const { push, sse } = planInboxTransports(cfg);
  assert.deepEqual(push.seats.map((s) => s.herdr), ["seat_push"]);
  assert.deepEqual(sse.map((s) => s.herdr), ["seat_sse"]);
});

test("plan: seat_events block absent => everything SSE, as before", () => {
  const { seat_events, ...rest } = cfg;
  const { push, sse } = planInboxTransports(rest);
  assert.equal(push, null);
  assert.deepEqual(sse.map((s) => s.herdr), ["seat_push", "seat_sse"]);
});

test("push seat: hint -> one authenticated peek read -> routeMail path; cursor persisted; SSE seat untouched", async () => {
  const { push } = planInboxTransports(cfg);
  const sockets = []; const tickets = new Set(); const inboxCalls = []; const routed = [];
  class WS {
    constructor(url) { this.url = url; this.l = {}; sockets.push(this); queueMicrotask(() => this.emit("open")); }
    addEventListener(n, f) { (this.l[n] ||= []).push(f); }
    emit(n, ev = {}) { for (const f of this.l[n] || []) f(ev); }
    send(d) {
      if (d === "ping") return queueMicrotask(() => this.emit("message", { data: "pong" }));
      const h = JSON.parse(d);
      assert.ok(tickets.delete(new URL(this.url).searchParams.get("ticket")));
      assert.deepEqual(Object.keys(h.since), ["agent-push"]);
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ type: "ready", protocol: 1, host: "host-1", subscriptions: [{ agent: "agent-push", ok: true }] }) }));
    }
    close() {}
  }
  const fetchImpl = async (_u, init) => {
    const b = JSON.parse(init.body);
    assert.deepEqual(b.agents, ["agent-push"]); // the SSE seat is not in the ticket
    const msg = Buffer.from(["seat-events-ticket:v1", "tenant-x", b.host_agent_id, "agent-push", String(b.ts), b.nonce].join("\n"));
    assert.ok(crypto.verify(null, msg, publicKey, Buffer.from(b.sig, "base64url")));
    const ticket = crypto.randomBytes(32).toString("base64url"); tickets.add(ticket);
    return { ok: true, status: 200, json: async () => ({ ticket, agents: b.agents, refused: [] }) };
  };
  const inboxFetch = async (url, init) => {
    inboxCalls.push({ url, auth: init.headers.Authorization });
    const since = Number(new URL(url).searchParams.get("since_seq") || 0);
    const all = [{ id: "m1", seq: 1 }, { id: "m2", seq: 2 }].filter((m) => m.seq > since);
    return { ok: true, json: async () => ({ ok: true, messages: all, complete: true, remaining: 0 }) };
  };
  const c = startPushClient(push, cfg.mupot_api_url, {
    keyFile, inboxFetch, route: async (seat, m) => { routed.push([seat.herdr, m.id]); },
    deps: { fetchImpl, WebSocketImpl: WS, log: () => {} },
  });
  c.start(); await flush();
  assert.equal(sockets.length, 1);
  assert.equal(inboxCalls.length, 1); // resync on ready
  assert.match(inboxCalls[0].url, /peek=1/); assert.equal(inboxCalls[0].auth, "Bearer TOK-P");
  assert.deepEqual(routed, [["seat_push", "m1"], ["seat_push", "m2"]]);
  sockets[0].emit("message", { data: JSON.stringify({ type: "hint", agent: "agent-push", hint: { id: "m3", seq: 3 } }) }); await flush();
  assert.equal(inboxCalls.length, 2); assert.match(inboxCalls[1].url, /since_seq=2/);
  const cur = JSON.parse(fs.readFileSync(path.join(process.env.SEATLINK_STATE, "mupot-cursors.json"), "utf8"));
  assert.equal(cur.seat_push, 2); assert.equal(cur.seat_sse, undefined);
  c.stop();
});

test("SSE opener: 409 notify_owned_by_fleet_host stops after ONE request (no retry storm)", async () => {
  const realFetch = globalThis.fetch; let calls = 0; let stop = false;
  globalThis.fetch = async () => { calls++; if (calls > 1) stop = true; return new Response(JSON.stringify({ error: "notify_owned_by_fleet_host", host_agent_id: "h" }), { status: 409 }); };
  try {
    // shouldContinue ends a (mutated) retry loop at its second request, so a regression fails instead of hanging
    await openInboxStream(cfg.seats[1], cfg.mupot_api_url, { shouldContinue: () => !stop });
    await new Promise((r) => setTimeout(r, 1300)); // a retry loop re-requests within its 1s backoff
    assert.equal(calls, 1);
  } finally { stop = true; globalThis.fetch = realFetch; }
});

test("SSE cursor write re-reads the file: a concurrent push-client cursor entry survives", async () => {
  const cursorFile = path.join(process.env.SEATLINK_STATE, "mupot-cursors.json");
  fs.writeFileSync(cursorFile, JSON.stringify({}));
  const realFetch = globalThis.fetch; let go = false; let stop = false;
  const enc = new TextEncoder();
  globalThis.fetch = async () => new Response(new ReadableStream({
    async start(ctrl) {
      while (!go) await new Promise((r) => setTimeout(r, 5));
      ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ type: "message", message: { id: "s1", seq: 7 } })}\n\n`));
      ctrl.close();
    },
  }), { status: 200 });
  try {
    await openInboxStream(cfg.seats[1], cfg.mupot_api_url, { shouldContinue: () => !stop });
    // the push client persists ITS cursor after the SSE opener loaded its own copy
    fs.writeFileSync(cursorFile, JSON.stringify({ seat_push: 5 }));
    go = true;
    for (let i = 0; i < 100 && !JSON.parse(fs.readFileSync(cursorFile, "utf8")).seat_sse; i++) await new Promise((r) => setTimeout(r, 20));
    const cur = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
    assert.equal(cur.seat_sse, 7); assert.equal(cur.seat_push, 5);
  } finally { stop = true; globalThis.fetch = realFetch; }
});

test("dark push seat opens the normal SSE stream (no grant at ticket time); a live-grant 409 then stops it", async () => {
  const { push } = planInboxTransports(cfg);
  const realFetch = globalThis.fetch; const sseCalls = []; let stop = false;
  globalThis.fetch = async (url, init) => {
    sseCalls.push({ url: String(url), auth: init.headers.Authorization });
    return new Response(JSON.stringify({ error: "notify_owned_by_fleet_host", host_agent_id: "h" }), { status: 409 });
  };
  try {
    const c = startPushClient(push, cfg.mupot_api_url, {
      keyFile, inboxFetch: async () => ({ ok: true, json: async () => ({ ok: true, messages: [], complete: true }) }),
      route: async () => {},
      deps: { fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: "no_granted_agents" }) }), WebSocketImpl: class {}, log: () => {} },
    });
    c.start();
    try {
    for (let i = 0; i < 50 && sseCalls.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(sseCalls.length, 1);
    assert.match(sseCalls[0].url, /\/api\/inbox\/stream/); assert.equal(sseCalls[0].auth, "Bearer TOK-P");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(sseCalls.length, 1, "409 stops the stream: no retry");
    } finally { c.stop(); }
  } finally { stop = true; globalThis.fetch = realFetch; }
});
