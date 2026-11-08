# Architecture — run-001 (pilot, quick, scoped to auth)

## Product and principals

MyHub is a single-user personal assistant web service (Cloudflare Workers +
Hono + D1 + KV, TypeScript). The only human principal is the owner
(`kimjn00003@naver.com` in production). The lower-trust principal in this
run is an unauthenticated remote HTTP client. Protected resources: the
owner's session, memos/files, schedules, todos, and AI usage.

## Stack and deployment (source-visible)

- `src/modules/auth/routes.ts` — OTP request/verify, PIN login, PIN
  set/reissue, logout, `/me`. Hono app mounted at `/api/auth`.
- `public/login.html` — PIN login + OTP-to-PIN issuance client.
- `migrations/0043_auth_pins.sql` — `auth_pins` table (PBKDF2 hash only).
- Auth middleware in `src/index.ts` is adjacent to this scope and is
  recorded `out_of_scope` for this pilot run.
- Tests: `tests/unit/auth-routes.test.ts`, `tests/gate-06-auth-path.test.js`,
  `tests/gate-09-session-key.test.js`, `tests/gate-56-auth.test.js`,
  `tests/gate-71-session.test.js`.

## Entry surfaces in scope

1. `POST /api/auth/request` — OTP code request (KV rate limit 5/hour,
   one code per day, reused while valid).
2. `POST /api/auth/verify` — OTP verification (5 attempts, then code
   deleted; success consumes the code with a conditional atomic DELETE).
3. `POST /api/auth/pin-login` — 6-digit PIN login (KV fail counter,
   5 failures → 15-minute 429; PBKDF2-SHA256 100k, constant-time compare).
4. `POST /api/auth/set-pin` — PIN set/reissue, requires a valid session
   cookie; UPSERT immediately invalidates the previous PIN.
5. `POST /api/auth/logout` — clears the session cookie (Max-Age=0).
6. `GET /api/auth/me` — session verification; reports `hasPin` /
   `hasPassword`.
7. Session token: `createSession`/`verifySession` — JSON payload
   `{email, exp}` HMAC-SHA256 signed with `SESSION_SECRET`; cookie
   `HttpOnly; Secure; SameSite=Lax`, 30-day TTL.
8. `public/login.html` — PIN input (`type=password`, `maxlength=6`,
   `inputmode=numeric`), OTP → PIN issuance flow.

## Trust boundaries and strongest source-visible controls

- Unauthenticated client → OTP/PIN endpoints: rate limits (KV),
  attempt counters (D1/KV), constant-time hash comparison, atomic
  single-use OTP consumption.
- Session cookie → protected routes: HMAC verification + expiry +
  allowlist email binding.
- PIN set → `auth_pins`: only reachable with a session obtained by OTP
  verification; plaintext PIN is never stored.

## Companion selection

Selected: `WEB-PROTOCOL-AND-AUTH.md` (HTTP framing/cache, browser
session, federated identity N/A, MFA/account-transition, API-key N/A)
for the auth surfaces, plus ordinary `ATTACK-CLASSES.md` blocks
(Access control, Cryptography and secrets, Business logic,
Feature abuse and data leakage, Injection). Not selected for this
scope: `MEMORY-SAFETY-AND-BINARY.md` (no native code),
`AI-AND-LLM.md` (no LLM in the auth module),
`PROTOCOLS-RPC-AND-MESSAGING.md` (no RPC/broker in scope),
`SUPPLY-CHAIN-AND-RELEASE.md` (dependency audit is a separate run),
`CLOUD-AND-DEPLOYMENT.md` (deployment config is not source-visible
here; any decisive deployment fact becomes `needs_validation`).

## Prior coverage

No prior audit run exists for this repo. `prior_status` is `none` for
all seeded units. This is a partial (`quick`, scoped) pass: it does not
claim full coverage of MyHub.
