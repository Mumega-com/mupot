-- 0249 owner sudo, exact-arguments binding: an owner-sudo elevation request carries the ONE call it authorises. The arguments are
-- resolved to ids and canonicalised (src/auth/owner-sudo-args.ts); this stores the canonical JSON and its sha256. At use time the
-- call's own arguments must canonicalise to the same digest or the call is refused. NULL on every non-sudo request.
ALTER TABLE elevation_requests ADD COLUMN sudo_args_json TEXT;
ALTER TABLE elevation_requests ADD COLUMN sudo_args_sha256 TEXT;
