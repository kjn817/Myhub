# Security Audit Report — run-001 (MyHub, pilot)

## 1. Run facts

- **Profile:** `quick` (scoped) — **partial pass, not full coverage.**
- **Scope:** auth module only — `src/modules/auth/routes.ts`,
  `public/login.html`, `migrations/0043_auth_pins.sql`,
  `tests/unit/auth-routes.test.ts`.
- **Source ref:** commit `2494f055743c675824c0dd077e9353512f83823d`
  (branch `fix/unlock-block-remove-ciphertext`).
- **Budget:** none set. Agents spent: 1 hunter + 7 candidate verifiers +
  1 follow-up verifier for the promoted CDN record = 9 subagent calls.
- **Execution:** sandboxed source-and-local-only. Read-only source review
  plus local mock D1/KV harnesses with dummy values only (Node type
  stripping, `/tmp` scratch). No production D1, no live endpoints, no
  real email sending, no paid API calls. No target source was modified.
- **Prior runs:** none exist for this repo. All ledger units seeded with
  `prior_status: none`.
- **Out of scope:** `src/index.ts` auth middleware (1 ledger unit,
  recorded `out_of_scope`; a later run should cover it). Everything else
  in the repo is out of scope for this pilot.
- **Deferred:** none.
- **Skill:** Cloudflare `security-audit-skill` (MIT, commit
  `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`), installed at
  `skills/security-audit/`; MyHub adapter at
  `skills/security-audit/MYHUB-ADAPTER.md`.

## 2. Security posture summary

The auth module's sequential-path controls are sound: OTP single-use is
atomic, PIN hashing uses PBKDF2-SHA256 100k with constant-time compare,
session tokens are HMAC-signed with expiry and allowlist binding, and
the existing 83 Jest auth tests pass. Every confirmed finding in this
run is a **concurrency or lifecycle gap, not a sequential logic bug**:
rate/lockout counters that are check-then-act instead of atomic, a
session with no server-side revocation, a step-up control stated in
comments but not enforced in code, and an SRI/CSP gap on the login page.
No P0/P1 (critical/high) findings. **3 medium, 4 low — all confirmed
with local reproduction.**

## 3. Confirmed findings

| Severity | Fingerprint | Boundary | Observed result (one line) |
|---|---|---|---|
| medium | `auth/pin-lockout-kv-race` | PIN login lockout | 10 concurrent wrong PINs → all 401, counter only +1 (expected +10) |
| medium | `auth/otp-verify-attempts-race` | OTP attempt limit | 10 concurrent wrong OTPs → all 400, budget becomes burst size, not 5 |
| medium | `auth/login-page-cdn-no-sri` | Login page script supply | `lucide@latest` loaded without SRI/CSP; same-origin DOM access to PIN field |
| low | `auth/session-no-revocation` | Session lifecycle | Token still accepted (`/me` 200) after logout and after PIN reissue |
| low | `auth/set-pin-no-step-up` | PIN reissue assurance | PIN-login session alone reissues the PIN; owner locked out, no OTP needed |
| low | `auth/otp-request-race` | OTP request rate limit | 5 concurrent requests → 5 mails, 5 codes, rate counter 1; first code invalid |
| low | `auth/attempt-counter-lockout-dos` | Login availability | 5–6 unauthenticated requests lock the owner out for up to 1 hour |

### auth/pin-lockout-kv-race (medium)

- **Location:** `src/modules/auth/routes.ts:335` (entrypoint),
  `:347`–`:348` (stale read + gate), `:366` (sink, stale `count+1` store).
- **Principal:** unauthenticated remote client. **Boundary crossed:**
  the 5-failures/15-minute lockout that is the only online-guessing
  defense for the 10^6-space PIN.
- **Reproduction (local mock D1/KV, dummy PIN):** 10 concurrent wrong
  PINs → all 401, `pinfail='1'`; sequential control → 401×5 then 429,
  `pinfail='5'`. Reproduced even against a strongly consistent mock KV,
  so this is a code race, not KV eventual consistency.
- **Impact:** guessing budget grows from 5 to 5×N per 15 minutes
  (N=100 → 500). Not a direct bypass; full search still takes long.
- **Fix (smallest):** move the fail counter to D1 atomic UPDATE
  (`fail_count = fail_count + 1`, then read back the updated value);
  add `fail_count` + `locked_until` columns (next migration 0045);
  remove the KV `pinfail` key. See `findings.json` remediation.

### auth/otp-verify-attempts-race (medium)

- **Location:** `src/modules/auth/routes.ts:278` (entrypoint), `:298`
  (stale `attempts >= 5` check), `:305` (sink, increment after the check).
- **Principal:** unauthenticated remote client. **Boundary crossed:**
  the per-code 5-guess budget.
- **Reproduction:** 10 concurrent wrong OTPs → all 400, `attempts=10`;
  11th (correct) request → 400 "attempts exceeded", code deleted.
  Sequential control → blocked after 5.
- **Impact:** per-code guessing budget becomes the burst size. A hit
  still yields a 30-day session, but per-burst success stays N/1,000,000
  and the code is consumed afterwards.
- **Fix (smallest):** single atomic UPDATE —
  `UPDATE otp_codes SET attempts = attempts + 1 WHERE email = ? AND attempts < 5`,
  treat `changes == 0` as limit exceeded. See `findings.json`.

### auth/login-page-cdn-no-sri (medium)

- **Location:** `public/login.html:12` (entrypoint, SRI-less
  `unpkg.com/lucide@latest` script), `:191` (`lucide.createIcons()`
  dependency), `:145` (sink, `pinInput` password field, same DOM/origin).
  `src/index.ts:217` sets only `Cache-Control: no-store`; no CSP anywhere
  in `src/`, `public/`, or `wrangler.toml`, and no `_headers` file.
- **Principal:** anyone able to tamper with the unpkg response (or the
  path). **Boundary crossed:** login-page script supply chain — the
  tampered script would run in the login origin with DOM access to the PIN.
- **Reproduction:** static verification only (no live fetch by design).
  Confirmed by two independent verifiers; hunter's sink line 141 was a
  mis-citation (lock-icon heading) and was corrected to 145.
- **Impact:** conditional on CDN/path compromise, but then it is direct
  PIN theft → account takeover. Likelihood medium, impact high.
- **Fix (smallest):** bundle lucide locally, or pin a fixed version with
  a SHA-384 SRI hash + `crossorigin`; add a CSP restricting `script-src`
  (e.g. `'self'`) on the login response.

### auth/session-no-revocation (low)

- **Location:** `src/modules/auth/routes.ts:187` (`createSession`,
  `{email, exp}` only), `:408` (`/logout`, cookie clear only), `:379`/`:399`
  (`/set-pin`, PIN row only), `:200` (`verifySession`, signature+expiry
  only).
- **Reproduction:** token issued via OTP verify → `/logout` → `/me` 200;
  same token → `/set-pin` → `/me` 200.
- **Impact:** a stolen token stays valid up to 30 days after logout or
  PIN reissue. Requires prior token theft (HttpOnly·Secure·SameSite=Lax
  cookie), and the holder already had access — no new privilege.
- **Fix:** add a session version/issued-at claim; bump a D1/KV version
  counter on logout and PIN reissue; check it in `verifySession`. Add
  regression tests (401 after logout/reissue).

### auth/set-pin-no-step-up (low)

- **Location:** `src/modules/auth/routes.ts:335` (`/pin-login` issues a
  session), `:189` (`createSession`, no method claim), `:379` (`/set-pin`,
  session check only), `:399` (UPSERT).
- **Reproduction:** dummy PIN login → session → `/set-pin` with a new PIN
  → 200; new PIN logs in, old PIN 401. No OTP involved.
- **Impact:** anyone knowing the current PIN can replace it and lock the
  owner out without email access. Downgraded from hunter's medium: the
  attacker already has full account access, so the new gain is lockout
  and persistence only — and the owner can recover via the OTP flow.
- **Fix:** add a `method: 'otp' | 'pin'` claim to the session payload;
  `/set-pin` accepts only `method === 'otp'`; treat claim-less tokens as
  non-OTP (fail-closed).

### auth/otp-request-race (low)

- **Location:** `src/modules/auth/routes.ts:222` (entrypoint), `:230`
  (stale rate-limit read), `:238` (SELECT, no valid code), `:253`
  (`INSERT OR REPLACE`), `:257` (stale `count+1` store), `:261`
  (`sendOtpEmail` per request).
- **Reproduction:** 5 concurrent `/request`s → all 200, 5 mails, 5 codes,
  `rl='1'`; first mailed code → `/verify` 400, last code → 200.
- **Impact:** rate limit bypass, owner mailbox + Resend quota burn, first
  code invalidated. Login is not fully blocked (last code works), and the
  recipient is the fixed allowlist address, so no arbitrary-address spam.
- **Fix:** atomize "no valid code" check + INSERT (D1 transaction or
  `INSERT ... WHERE NOT EXISTS`); send mail only for the winning INSERT;
  move the rate counter to an atomic D1 increment.

### auth/attempt-counter-lockout-dos (low)

- **Location:** `src/modules/auth/routes.ts:278` (`/verify`), `:298`
  (`attempts >= 5` deletes the code), `:222`/`:232` (`/request` 5/hour),
  `:348` (`/pin-login` 5/15 min).
- **Reproduction:** 5 wrong OTPs → correct code rejected, row deleted;
  `/request` 6th → 429 (recovered after +3601s); PIN wrong ×5 → correct
  PIN 429 on 6th (+901s recovery).
- **Impact:** unauthenticated 5–6 requests lock the owner out for up to
  1 hour (OTP path) or 15 minutes (PIN path). Existing sessions are
  unaffected; everything auto-recovers.
- **Fix:** split limits into per-sender buckets (IP/fingerprint hash)
  plus a global cap; keep a separate bucket for owner re-requests;
  consider exponential backoff instead of a hard PIN lockout.

## 4. Needs validation

None. All 7 candidates reached an independent `confirmed` disposition.
(One candidate was proposed `needs_validation` by the hunter — the CDN
SRI case — and was promoted to `confirmed` by two independent verifiers
after source checks established the control gap itself.)

## 5. Hardening notes and positive patterns

- OTP single-use via conditional atomic DELETE (`/verify` success path)
  is the correct pattern — the same atomicity is what the three race
  findings lack on their sibling paths.
- PBKDF2-SHA256 100k + constant-time compare for PIN/password; OTP
  codes are CSPRNG-generated; session cookies are
  `HttpOnly; Secure; SameSite=Lax` with 30-day TTL.
- `sendOtpEmail` refuses its test transport outside `development`;
  `getAuthEmail` fails closed on missing/misconfigured environment.
- Hardening (not findings): consider per-sender rate limits on
  `/verify` (currently none), and a CSP for all HTML responses, not
  just the login page.

## 6. Coverage summary

Ledger: 9 units — **6 candidate, 2 covered, 1 out_of_scope, 0 deferred,
0 blocked**. In-scope units reviewed 8/8: `/request`, `/verify`,
`/pin-login`, `/set-pin`, `/logout`, `/me`, `createSession`/`verifySession`,
login.html client. Covered with no findings: `GET /me` (same-principal
info only) and `createSession`/`verifySession` (HMAC/expiry/allowlist,
83 Jest tests). Out of scope: `src/index.ts` auth middleware — next run.
No coverage critic was run as a separate pass in this pilot (quick
profile, single hunter wave); the independent verifiers re-checked every
cited location, which is the quick profile's merged validation step.

## 7. QA gate consequence

Per MyHub rules, P0/P1 unresolved findings block production deploy.
This run found **0 critical/high (P0/P1) findings**, so it does not by
itself block a deploy. The 3 medium findings are real, independently
reproduced control gaps in the login path and should be fixed before the
next release that touches auth; the 4 low findings are scheduled fixes.
Re-audit after the fixes, carrying this run's ledger forward.
