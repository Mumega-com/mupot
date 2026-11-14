// lib/paperclip.mjs - Paperclip target for seatlink seats (2026-10-23).
//
// A seat whose seats.json entry carries target.kind === "paperclip" is NOT a herdr pane. When a mupot
// inbox doorbell arrives for it, we create ONE Paperclip issue assigned to the target agent (creating an
// assigned todo issue wakes that agent). No herdr pane is ever touched for such a seat.
//
// The issue carries POINTERS ONLY (seq, message id, task id, request_id). Message bodies are member-written
// and untrusted, so none of the body text is copied into the issue title or description.
//
// Idempotency, two layers:
//   1. local state file  (last seq + processed ids + retry queue, per seat)
//   2. Paperclip's own `idempotencyKey` on issue create (replays the original issue)
import fs from "node:fs";
import path from "node:path";

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const SAFE_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const DONE_MAX = 500;
const RETRY_MAX = 50;
const RETRY_GIVE_UP = 20;
export const DEFAULT_MAX_INITIAL = 3;

export const INSTRUCTION =
  "Read the source from your own mupot inbox, call task_brief for the task, do the work, task_submit_result. Do not print tokens.";

export function isPaperclipSeat(entry) {
  return entry?.target?.kind === "paperclip";
}

export function extractPointers(msg) {
  const body = typeof msg?.body === "string" ? msg.body : "";
  const taskIds = [...new Set((body.match(UUID_RE) || []).map((s) => s.toLowerCase()))].slice(0, 10);
  const rid = typeof msg?.request_id === "string" && SAFE_ID_RE.test(msg.request_id) ? msg.request_id : null;
  return { seq: msg?.seq ?? null, id: msg?.id ?? null, taskIds, requestId: rid };
}

export function buildIssue(entry, msg) {
  const t = entry.target;
  const p = extractPointers(msg);
  const subject = p.taskIds.length
    ? `task ${p.taskIds[0].slice(0, 8)}${p.taskIds.length > 1 ? ` +${p.taskIds.length - 1}` : ""} (seq ${p.seq})`
    : `message seq ${p.seq}`;
  const description = [
    "Pointers only. No message content is copied here.",
    "",
    `- mupot seat: ${entry.herdr}`,
    `- mupot message seq: ${p.seq}`,
    `- mupot message id: ${p.id}`,
    `- mupot task id: ${p.taskIds.length ? p.taskIds.join(", ") : "none"}`,
    `- request_id: ${p.requestId ?? "none"}`,
    "",
    INSTRUCTION,
  ].join("\n");
  return {
    title: `mupot: ${subject}`,
    description,
    status: "todo",
    assigneeAgentId: t.agentId,
    idempotencyKey: `mupot:${entry.herdr}:${p.id}`,
  };
}

function readKey(file) {
  return fs.readFileSync(file, "utf8").replace(/\r?\n/g, "").trim();
}

/**
 * deps: { stateFile, fetchImpl?, log? }
 * Returns { handle(entry, msg, {initial}), drainRetry(entry), state() }.
 */
export function createPaperclipHandler({ stateFile, fetchImpl = (...a) => globalThis.fetch(...a), log = () => {} }) {
  let chain = Promise.resolve();
  const load = () => {
    try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return { seats: {} }; }
  };
  const save = (s) => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  };
  const seatState = (s, seat) => (s.seats[seat] ||= { last_seq: 0, done: [], retry: [] });
  const markDone = (ss, msg) => {
    if (!ss.done.includes(msg.id)) ss.done.push(msg.id);
    if (ss.done.length > DONE_MAX) ss.done = ss.done.slice(-DONE_MAX);
    if (typeof msg.seq === "number" && msg.seq > ss.last_seq) ss.last_seq = msg.seq;
  };

  async function post(entry, msg) {
    const t = entry.target;
    const base = (t.baseUrl || "http://127.0.0.1:3100").replace(/\/$/, "");
    const key = readKey(t.boardKeyFile);
    const res = await fetchImpl(`${base}/api/companies/${t.companyId}/issues`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(buildIssue(entry, msg)),
    });
    if (!res.ok) throw new Error(`paperclip HTTP ${res.status}`);
    const j = await res.json().catch(() => ({}));
    return j?.identifier || j?.id || "created";
  }

  async function attempt(entry, msg) {
    const s = load();
    const ss = seatState(s, entry.herdr);
    if (ss.done.includes(msg.id)) return "duplicate";
    if (msg.kind === "ack") { markDone(ss, msg); save(s); return "skipped_ack"; }
    try {
      const ref = await post(entry, msg);
      const s2 = load(); const ss2 = seatState(s2, entry.herdr);
      markDone(ss2, msg);
      ss2.retry = ss2.retry.filter((r) => r.msg.id !== msg.id);
      save(s2);
      log(`paperclip issue ${ref} for ${entry.herdr} seq=${msg.seq} id=${msg.id}`);
      return "created";
    } catch (e) {
      const s2 = load(); const ss2 = seatState(s2, entry.herdr);
      const r = ss2.retry.find((x) => x.msg.id === msg.id);
      if (r) r.tries += 1;
      else ss2.retry.push({ msg: { id: msg.id, seq: msg.seq, kind: msg.kind, request_id: msg.request_id, body: msg.body }, tries: 1 });
      ss2.retry = ss2.retry.slice(-RETRY_MAX);
      save(s2);
      log(`paperclip create failed for ${entry.herdr} seq=${msg.seq}: ${e.message}`);
      return "retry";
    }
  }

  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  return {
    handle: (entry, msg) => serial(() => attempt(entry, msg)),
    // initial backlog guard: only the newest `max` unprocessed messages ring; older ones are recorded as skipped.
    handleInitial: (entry, msgs) => serial(async () => {
      const max = entry.target.maxInitial ?? DEFAULT_MAX_INITIAL;
      const s = load(); const ss = seatState(s, entry.herdr);
      const fresh = (msgs || []).filter((m) => m?.id && !ss.done.includes(m.id)).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      const skip = fresh.slice(0, Math.max(0, fresh.length - max));
      for (const m of skip) markDone(ss, m);
      if (skip.length) { save(s); log(`paperclip ${entry.herdr}: skipped ${skip.length} backlog message(s), handling newest ${max}`); }
      const out = [];
      for (const m of fresh.slice(skip.length)) out.push(await attempt(entry, m));
      return out;
    }),
    drainRetry: (entry) => serial(async () => {
      const ss = seatState(load(), entry.herdr);
      const out = [];
      for (const r of [...ss.retry]) {
        if (r.tries >= RETRY_GIVE_UP) {
          const s = load(); const x = seatState(s, entry.herdr);
          x.retry = x.retry.filter((q) => q.msg.id !== r.msg.id); markDone(x, r.msg); save(s);
          log(`paperclip ${entry.herdr}: giving up on seq=${r.msg.seq} after ${r.tries} tries`);
          continue;
        }
        out.push(await attempt(entry, r.msg));
      }
      return out;
    }),
    state: () => load(),
  };
}
