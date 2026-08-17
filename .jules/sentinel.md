## 2026-08-17 - Secure Token Comparison in Addons
**Vulnerability:** Addon endpoints (`src/addons/mirror.ts`, `src/addons/sos.ts`, and `src/addons/inkwell.ts`) were using standard string comparison (`!==`) to compare user-provided tokens against application secrets. This makes them vulnerable to timing attacks.
**Learning:** The application uses basic middleware for token verification, but it lacked constant-time string comparison for the shared secret.
**Prevention:** Always use constant-time comparison functions (like the custom `timingSafeEqual` utilizing bitwise XOR) when comparing sensitive secrets, passwords, or tokens to prevent timing-based side-channel attacks. A shared utility `src/lib/crypto.ts` was created to house this logic.
