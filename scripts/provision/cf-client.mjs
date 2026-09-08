// CF REST client — P0 core. Token loaded from FILE PATH (0600) only — the
// value never appears in argv, env echo, logs, or journal. Browser-ish UA:
// Cloudflare error-1010 bans Python/undisclosed user agents (measured live
// 2026-09-04 from this host).
import { readFileSync } from 'node:fs';

export function makeCfClient({ accountId, tokenPath, baseUrl }) {
  if (!accountId || !tokenPath) throw new Error('cf-client: accountId and tokenPath required');
  const base = baseUrl ?? 'https://api.cloudflare.com/client/v4';
  const token = readFileSync(tokenPath, 'utf8').trim();
  if (!token) throw new Error('cf-client: token file empty');

  return {
    accountId,
    async request(method, p, body) {
      const res = await fetch(`${base}${p}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'mubot-provisioner/0.1 (hermes; +https://mumega.com)',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      const raw = await res.text();
      let json = null;
      try { json = JSON.parse(raw); } catch { /* non-JSON error body — keep raw */ }
      return { status: res.status, json, raw };
    },
  };
}
