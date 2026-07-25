// Hermes — minimal Telegram <-> mupot relay.
//
// Shape (see connectors/hermes/README.md): Telegram user -> Hermes -> POST
// pot /im/webhook (raw update + shared secret header) -> pot resolves
// chat_id -> Member -> capability-gated intent -> {ok, reply} -> Hermes
// echoes `reply` back to the Telegram chat.
//
// DESIGN CHOICE: long-polling Telegram (getUpdates), not a Telegram-facing
// webhook. The README only fixes the Hermes -> pot leg (POST /im/webhook +
// shared secret); how Hermes hears from Telegram is unconstrained. Polling
// means Hermes makes only OUTBOUND calls (to api.telegram.org, to the pot,
// to Secret Manager) — there is nothing for GKE to expose publicly, so no
// LoadBalancer/Ingress/TLS cert is needed at all. See ../DESIGN.md.
//
// Zero npm dependencies on purpose: smaller image, smaller attack surface,
// nothing to `npm install` at build time. Node 22 ships a global `fetch`
// and everything else here is `node:*` built-ins.
//
// Secrets (TELEGRAM_BOT_TOKEN, IM_WEBHOOK_SECRET) are NEVER passed as env
// vars in the Deployment manifest. They are fetched at boot (and refreshed
// periodically) straight from Secret Manager over the Workload Identity
// credential and held only in this process's memory. See ../SECRETS.md.

import { createServer } from 'node:http';

const POT_URL = process.env.MUPOT_URL; // e.g. https://mupot-dme-temp.weathered-scene-2272.workers.dev
const POT_WEBHOOK_PATH = process.env.MUPOT_WEBHOOK_PATH || '/im/webhook';
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID; // e.g. mumegaproject
const TELEGRAM_BOT_TOKEN_SECRET = process.env.TELEGRAM_BOT_TOKEN_SECRET_NAME || 'dme-hermes-telegram-bot-token';
const IM_WEBHOOK_SECRET_SECRET = process.env.IM_WEBHOOK_SECRET_SECRET_NAME || 'dme-hermes-im-webhook-secret';
const HEALTH_PORT = Number(process.env.PORT || 8080);
const SECRET_REFRESH_MS = Number(process.env.SECRET_REFRESH_MS || 30 * 60 * 1000); // re-pull so rotation lands without a redeploy
const POLL_TIMEOUT_SEC = Number(process.env.TELEGRAM_POLL_TIMEOUT_SEC || 30); // Telegram long-poll hold
const POLL_ERROR_BACKOFF_MS = Number(process.env.POLL_ERROR_BACKOFF_MS || 5000);

// Optional, non-secret, plaintext pre-filter mirroring hermes.config.example.yaml's
// `allowed_chats`. The POT remains the authoritative RBAC gate (chat_id ->
// Member); this is only a cheap way to stop Hermes relaying (and logging)
// noise from randoms who find the bot's public @username and DM it before
// the pot's own "unmapped chat_id -> polite refusal" path ever runs.
const ALLOWED_CHAT_IDS = (process.env.ALLOWED_CHAT_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!POT_URL) {
  console.error(JSON.stringify({ level: 'fatal', msg: 'MUPOT_URL is required', ts: new Date().toISOString() }));
  process.exit(1);
}

/** @type {{ telegramBotToken: string | null, webhookSecret: string | null, loadedAt: number | null }} */
const secrets = { telegramBotToken: null, webhookSecret: null, loadedAt: null };

function log(level, msg, extra = {}) {
  // Structured, no secret values, ever.
  console.log(JSON.stringify({ level, msg, ts: new Date().toISOString(), ...extra }));
}

// --- Secret Manager, via the Workload Identity metadata-server token. ---
// No @google-cloud/secret-manager dependency: two plain HTTPS calls.

async function fetchMetadataToken() {
  const res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } },
  );
  if (!res.ok) throw new Error(`metadata token fetch failed: ${res.status}`);
  const body = await res.json();
  return body.access_token;
}

async function fetchSecret(accessToken, secretName) {
  const url = `https://secretmanager.googleapis.com/v1/projects/${GCP_PROJECT_ID}/secrets/${secretName}/versions/latest:access`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`secret ${secretName} fetch failed: ${res.status}`);
  const body = await res.json();
  return Buffer.from(body.payload.data, 'base64').toString('utf8');
}

async function loadSecrets() {
  if (!GCP_PROJECT_ID) {
    throw new Error('GCP_PROJECT_ID is required to resolve Secret Manager secret names');
  }
  const token = await fetchMetadataToken();
  const [telegramBotToken, webhookSecret] = await Promise.all([
    fetchSecret(token, TELEGRAM_BOT_TOKEN_SECRET),
    fetchSecret(token, IM_WEBHOOK_SECRET_SECRET),
  ]);
  secrets.telegramBotToken = telegramBotToken;
  secrets.webhookSecret = webhookSecret;
  secrets.loadedAt = Date.now();
  log('info', 'secrets loaded', { telegram_bot_token_chars: telegramBotToken.length, webhook_secret_chars: webhookSecret.length });
}

async function secretRefreshLoop() {
  for (;;) {
    await new Promise((r) => setTimeout(r, SECRET_REFRESH_MS));
    try {
      await loadSecrets();
    } catch (err) {
      // Keep serving on the last-known-good secrets; just log and retry next tick.
      log('error', 'secret refresh failed, keeping cached values', { error: String(err) });
    }
  }
}

// --- the relay itself ---

async function relayUpdateToPot(update) {
  const chatId = update?.message?.chat?.id;
  if (ALLOWED_CHAT_IDS.length > 0 && (chatId === undefined || !ALLOWED_CHAT_IDS.includes(String(chatId)))) {
    log('info', 'dropped update: chat_id not in ALLOWED_CHAT_IDS pre-filter');
    return;
  }

  let potResult;
  try {
    const potRes = await fetch(new URL(POT_WEBHOOK_PATH, POT_URL), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': secrets.webhookSecret,
      },
      body: JSON.stringify(update), // forward the RAW update — identity/RBAC resolution happens in the pot only
    });
    potResult = await potRes.json().catch(() => null);
    log('info', 'relayed to pot', { pot_status: potRes.status, had_chat_id: chatId !== undefined });
  } catch (err) {
    log('error', 'pot relay failed', { error: String(err) });
    return;
  }

  if (potResult?.ok && potResult?.reply && chatId !== undefined && secrets.telegramBotToken) {
    try {
      await fetch(`https://api.telegram.org/bot${secrets.telegramBotToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: potResult.reply }),
      });
    } catch (err) {
      log('error', 'telegram sendMessage failed', { error: String(err) });
    }
  }
}

let pollOffset = 0;
let lastPollOkAt = 0;

async function pollOnce() {
  const url = `https://api.telegram.org/bot${secrets.telegramBotToken}/getUpdates` +
    `?timeout=${POLL_TIMEOUT_SEC}&offset=${pollOffset}`;
  const res = await fetch(url, { signal: AbortSignal.timeout((POLL_TIMEOUT_SEC + 10) * 1000) });
  if (!res.ok) throw new Error(`getUpdates failed: ${res.status}`);
  const body = await res.json();
  if (!body.ok || !Array.isArray(body.result)) throw new Error('getUpdates: unexpected response shape');

  for (const update of body.result) {
    // Advance the offset (Telegram's ack mechanism) before relaying: a crash
    // mid-relay drops at most the in-flight message rather than replaying a
    // backlog forever. Acceptable for a low-stakes chat relay.
    pollOffset = update.update_id + 1;
    await relayUpdateToPot(update);
  }
  lastPollOkAt = Date.now();
}

async function pollLoop() {
  // Don't start polling until we have a bot token.
  while (!secrets.telegramBotToken) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  for (;;) {
    try {
      await pollOnce();
    } catch (err) {
      log('error', 'telegram poll failed, backing off', { error: String(err) });
      await new Promise((r) => setTimeout(r, POLL_ERROR_BACKOFF_MS));
    }
  }
}

// --- health endpoints only; nothing here needs to be reachable from outside the cluster ---

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    // Liveness: process + event loop are up. Deliberately independent of
    // secrets/pot/Telegram reachability — a transient outage in any of
    // those must not cause Kubernetes to restart-loop a healthy container.
    res.writeHead(200).end('ok');
    return;
  }
  if (req.method === 'GET' && req.url === '/readyz') {
    // Readiness: secrets loaded AND the poll loop has completed at least
    // one successful round-trip to Telegram recently.
    const pollStale = lastPollOkAt === 0 || Date.now() - lastPollOkAt > (POLL_TIMEOUT_SEC + 60) * 1000;
    if (secrets.webhookSecret && secrets.telegramBotToken && !pollStale) {
      res.writeHead(200).end('ready');
    } else {
      res.writeHead(503).end('not ready');
    }
    return;
  }
  res.writeHead(404).end();
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutting down', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function main() {
  try {
    await loadSecrets();
  } catch (err) {
    log('error', 'initial secret load failed; readyz stays 503 until secretRefreshLoop succeeds', { error: String(err) });
  }
  secretRefreshLoop();
  pollLoop();
  server.listen(HEALTH_PORT, () => log('info', 'hermes relay up (long-poll mode)', { health_port: HEALTH_PORT }));
}

main();
