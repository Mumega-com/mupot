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

const tokKasra = path.join(tmp, "kasra.tok"); fs.writeFileSync(tokKasra, "TOK-K\n", { mode: 0o600 });
const tokAth = path.join(tmp, "athena.tok"); fs.writeFileSync(tokAth, "TOK-A\n", { mode: 0o600 });
const keyFile = path.join(tmp, "host.pem");
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
fs.writeFileSync(keyFile, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });

const cfg = {
  mupot_api_url: "https://pot.test",
  seat_events: { host_id: "muvps-host", tenant: "mumega", host_key_file: keyFile },
  seats: [
    { herdr: "muvps_kasra", mupot_agent_id: "agent-kasra", mupot_token_file: tokKasra, seat_events: true },
    { herdr: "muvps_athena", mupot_agent_id: "agent-athena", mupot_token_file: tokAth },
    { herdr: "muvps_hermes" },
  ],
};
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

test("plan: opted-in seat is push, other token seat stays SSE, tokenless seat is neither", () => {
  const { push, sse } = planInboxTransports(cfg);
  assert.deepEqual(push.seats.map((s) => s.herdr), ["muvps_kasra"]);
  assert.deepEqual(sse.map((s) => s.herdr), ["muvps_athena"]);
});

test("plan: seat_events block absent => everything SSE, as before", () => {
  const { seat_events, ...rest } = cfg;
  const { push, sse } = planInboxTransports(rest);
  assert.equal(push, null);
  assert.deepEqual(sse.map((s) => s.herdr), ["muvps_kasra", "muvps_athena"]);
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
      assert.deepEqual(Object.keys(h.since), ["agent-kasra"]);
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ type: "ready", protocol: 1, host: "muvps-host", subscriptions: [{ agent: "agent-kasra", ok: true }] }) }));
    }
    close() {}
  }
  const fetchImpl = async (_u, init) => {
    const b = JSON.parse(init.body);
    assert.deepEqual(b.agents, ["agent-kasra"]); // the SSE seat is not in the ticket
    const msg = Buffer.from(["seat-events-ticket:v1", "mumega", b.host_agent_id, "agent-kasra", String(b.ts), b.nonce].join("\n"));
    assert.ok(crypto.verify(null, msg, publicKey, Buffer.from(b.sig, "base64url")));
    const ticket = crypto.randomBytes(32).toString("base64url"); tickets.add(ticket);
    return { ok: true, status: 200, json: async () => ({ ticket }) };
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
  assert.match(inboxCalls[0].url, /peek=1/); assert.equal(inboxCalls[0].auth, "Bearer TOK-K");
  assert.deepEqual(routed, [["muvps_kasra", "m1"], ["muvps_kasra", "m2"]]);
  sockets[0].emit("message", { data: JSON.stringify({ type: "hint", agent: "agent-kasra", hint: { id: "m3", seq: 3 } }) }); await flush();
  assert.equal(inboxCalls.length, 2); assert.match(inboxCalls[1].url, /since_seq=2/);
  const cur = JSON.parse(fs.readFileSync(path.join(process.env.SEATLINK_STATE, "mupot-cursors.json"), "utf8"));
  assert.equal(cur.muvps_kasra, 2); assert.equal(cur.muvps_athena, undefined);
  c.stop();
});

test("SSE opener: 409 notify_owned_by_fleet_host stops after ONE request (no retry storm)", async () => {
  const realFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: "notify_owned_by_fleet_host", host_agent_id: "h" }), { status: 409 }); };
  try {
    await openInboxStream(cfg.seats[1], cfg.mupot_api_url);
    await new Promise((r) => setTimeout(r, 1500)); // a retry loop would have re-requested within the 1s backoff
    assert.equal(calls, 1);
  } finally { globalThis.fetch = realFetch; }
});
