import crypto from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";

const agentId = crypto.randomUUID();
const memberId = crypto.randomUUID();
const tokenId = crypto.randomUUID();
const capId = crypto.randomUUID();
const rawToken = "mupot_" + crypto.randomBytes(32).toString("hex");
const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
const createdAt = new Date().toISOString();

const sql = `
INSERT INTO agents (id, squad_id, slug, name, role, status, created_at)
VALUES ('${agentId}', 'squad-core', 'pi', 'Pi CLI', 'Minimalist & Extensible AI Coding Harness (Pi)', 'active', '${createdAt}');

INSERT INTO members (id, email, display_name, status, created_at, tenant)
VALUES ('${memberId}', NULL, 'Pi CLI', 'active', '${createdAt}', 'mumega');

INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
VALUES ('mumega', '${agentId}', '${memberId}', '${createdAt}');

INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
VALUES ('${capId}', '${memberId}', 'squad', 'squad-core', 'member');

INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
VALUES ('${tokenId}', '${memberId}', '${tokenHash}', 'pi', 'workspace', '${createdAt}', '${agentId}', 'mumega');
`;

console.log("Generated SQL statements:");
console.log(sql);
console.log("\nMINTED RAW TOKEN:");
console.log(rawToken);

import os from "node:os";
import path from "node:path";
// Write outside the repo tree with owner-only perms — the SQL carries a token
// hash and identity rows; keep it out of any future git add sweep.
const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mupot-mint-")), "mint.sql");
fs.writeFileSync(tokenFile, sql, { mode: 0o600 });

const cmd = `CLOUDFLARE_API_TOKEN=$(cat /home/mumega/.sos/keys/cf-token-mupot-digid-deploy.token) NODE_OPTIONS="--dns-result-order=ipv4first" npx wrangler d1 execute b78f4ca0-1d09-4e9a-a3db-96df238af6ce --remote --file ${tokenFile}`;
const res = execSync(cmd, { cwd: "/home/mumega/mupot", encoding: "utf-8" });
console.log(res);

fs.writeFileSync("/home/mumega/.fleet/agents/pi-member.token", rawToken + "\n", { mode: 0o600 });
console.log("Successfully saved raw token to /home/mumega/.fleet/agents/pi-member.token");
