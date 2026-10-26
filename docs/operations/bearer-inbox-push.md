# Member token inbox push

Task mumega-com#1535. `INBOX_STREAM_PUSH=1` selects the new implementation of
`GET /api/inbox/stream`; omission is off. It also requires the existing
`REALTIME_SEAT_EVENTS=1` and `SEAT_EVENTS` binding. This change does not enable any
deployment or create credentials or grants.

Only existing agent-bound member tokens are supported. OAuth chat attachments,
ChatGPT Events, dashboard observers and desktop idle wake are different integrations.

The Worker authenticates the token, derives its seat and constructs a private DO
subscription. Fleet-authorized agents remain fenced from this route. The DO keeps
bearer observers separate from host sockets (256 per pot, 4 per agent, 2 per
credential); hosts synchronously evict observers on claim. No bearer may select a
host, agent or seat through client metadata.

The internal hint contains only message id and sequence. The Worker peeks its own
authorized inbox and preserves public `initial` and `message` payloads. It never
consumes, leases or acknowledges. Multiple bearer observers are notifications, not
additional consumers. Each disclosure requires a credential check started within
10 seconds and a live 60-second deadline. Scheduled validation is every45seconds;
errors permit at most two retries at50/55seconds. Five-second lookup timeouts and
independent closure prevent hung/late results from extending authority.

An idle stream has no fast inbox polling. One initial catch-up and at most one
resync cycle per300seconds plus positive jitter remain, each capped at ten pages
of100. Queries within a cycle are not claimed to be a single D1 statement. A
25-second heartbeat performs no inbox read. Hints use a dirty flag and one read
chain; oversized queues and ten-page backlog close for reconnect instead of
dropping the cursor. This bounded recovery is necessary because the existing
commit-to-event path can lose hints; it is not a durable-outbox guarantee.

Every public data frame carries an SSE `id` cursor. Explicit `?since` takes
precedence over `Last-Event-ID`; malformed cursors refuse. Streams rotate after
30minutes and internally renew the15-minute observer before expiry. The existing
seatlink client persists `initial.since` / `message.seq` and sends `?since` on its
next request; a pinned read-only fixture tests that path.

Capacity refuses503. Only actual DO unavailability plus a definitive no-host-grant
authorization permits a30-second fallback poll. `X-Mupot-Stream-Mode` and structured
operation logs distinguish push/fallback; auth, resync and hint reads are not
reported as zero total database traffic. Invalid credentials and failed authority
lookups never justify fallback. A newly committed host grant may leave an observer
alive until revalidation (at most60seconds) if best-effort eviction is absent; it
only sees its credential's own mail and does not consume it.

Validation:

```
npx vitest run tests/inbox-stream-auth.test.ts tests/seat-events-bearer.test.ts tests/inbox-push-stream.test.ts tests/inbox-push-route.test.ts tests/inbox-push-rotation.test.ts
npx vitest run --config vitest.bearer.config.ts
npm run typecheck
```

The workerd suite exercises the real DO, migrated D1, host handshakes and the
Worker SSE path. Host-client Step1 and webhook Step3 are not modified here.
