## 2026-08-13 - [Add timing-safe comparison to addons]
**Vulnerability:** Addons (`src/addons/mirror.ts`, `src/addons/sos.ts`, `src/addons/inkwell.ts`) used `!==` string comparison for secret header validation, which could be vulnerable to timing attacks.
**Learning:** In edge runtimes like Cloudflare Workers, Node's `crypto.timingSafeEqual` might not be consistently available. The canonical approach in this codebase is to implement a custom constant-time check using `TextEncoder` and bitwise XOR logic.
**Prevention:** Always use the custom `timingSafeEqual` function pattern when validating tokens or secrets via string comparison to avoid leaking string length or character match progress through response timings.
