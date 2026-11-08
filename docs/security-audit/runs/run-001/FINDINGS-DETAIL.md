# Findings Detail — run-001 (medium and above)

Full records live in `findings.json` (schema-validated). This file copies
the complete source path and target-neutral local reproduction for each
confirmed `medium` record. Low records are summarized in `REPORT.md`.

## auth/pin-lockout-kv-race (medium)

- **Trace (ordered):**
  1. entrypoint — `src/modules/auth/routes.ts:335`, `POST /api/auth/pin-login`:
     unauthenticated remote client calls PIN login.
  2. propagation — `src/modules/auth/routes.ts:347`: `KV.get(pinfail:<email>)`
     reads the fail count; concurrent requests all read the same stale value.
  3. propagation — `src/modules/auth/routes.ts:348`: `failCount >= PIN_FAIL_LIMIT(5)`
     gate passes for the whole burst on the stale value.
  4. sink — `src/modules/auth/routes.ts:366`:
     `KV.put(failKey, String(failCount + 1), {expirationTtl: 900})` stores
     the stale-based value, so N concurrent failures add 1 to the counter.
- **Dummy attacker / resource:** unauthenticated client vs. the owner's
  `auth_pins` row / PIN login endpoint. No real PIN, OTP, or secret used.
- **Native input / fixture:** local mock D1/KV harness (`/tmp`, scratch
  only) importing the real `routes.ts` via Node type stripping; dummy PIN
  `123456` stored as a PBKDF2 hash; wrong PIN `000000` sent 10× concurrently
  (`Promise.all`) and 6× sequentially as a control.
- **Observed output:** concurrent 10× → all 401, final `pinfail='1'`
  (expected 10). Sequential control → 401×5 then 429, `pinfail='5'`.
  Reproduced against a strongly consistent (Map-based) mock KV, proving
  the race is in the code's read-modify-write, not KV eventual consistency.
  In real Workers the window is wider (KV fetch is a network call and
  PBKDF2 100k is async).
- **Conditions:** unauthenticated access to `/pin-login`; failures must
  overlap between `KV.get` and `KV.put` (PBKDF2 verification window);
  a PIN must be set (`PIN_NOT_SET` otherwise).
- **Invariant proved:** the 5-failures/15-minute lockout does not count
  concurrent failures; guessing budget grows with burst size N.
- **Remediation + regression case:** move the counter to D1 atomic UPDATE
  (`fail_count = fail_count + 1`, read back the updated value for the lock
  decision); migration 0045 adds `fail_count` + `locked_until` to
  `auth_pins`; drop the KV `pinfail` key. Regression test: 10 concurrent
  wrong PINs must leave the counter at 10 and the 6th sequential attempt
  must return 429.

## auth/otp-verify-attempts-race (medium)

- **Trace (ordered):**
  1. entrypoint — `src/modules/auth/routes.ts:278`, `POST /api/auth/verify`:
     unauthenticated remote client submits OTP guesses.
  2. propagation — `src/modules/auth/routes.ts:298`: `row.attempts >= 5`
     check on the SELECT-time value.
  3. propagation — `src/modules/auth/routes.ts:303`: wrong-answer branch.
  4. sink — `src/modules/auth/routes.ts:305`:
     `UPDATE otp_codes SET attempts = attempts + 1` runs after the check,
     so the whole burst passes the gate.
- **Dummy attacker / resource:** unauthenticated client vs. the owner's
  `otp_codes` row (dummy OTP `654321`, attempts=0, 24h valid).
- **Native input / fixture:** local mock D1/KV harness importing the real
  `routes.ts`; 10 distinct wrong codes (`100000`–`100009`) sent
  concurrently via `Promise.all`, then the correct code as an 11th request;
  sequential control (5 wrong, then correct).
- **Observed output:** concurrent 10× → all 400 "wrong code", `attempts=10`;
  11th (correct) request → 400 "attempts exceeded", OTP row deleted.
  Sequential control → blocked after 5. Per-code guessing budget is the
  burst size, not 5.
- **Conditions:** unauthenticated access; requests must overlap between
  SELECT and UPDATE; a valid, unexpired OTP row with `attempts < 5` must
  exist; `/verify` has no separate rate limit.
- **Invariant proved:** the per-code 5-guess budget does not hold under
  concurrency; the check-then-act structure defeats the limit.
- **Remediation + regression case:** one atomic UPDATE —
  `UPDATE otp_codes SET attempts = attempts + 1 WHERE email = ? AND attempts < 5`,
  `changes == 0` means limit exceeded (delete the code, return the limit
  error). Regression test: 10 concurrent wrong codes must leave at most
  5 counted as allowed and the 6th sequential attempt must be rejected.

## auth/login-page-cdn-no-sri (medium)

- **Trace (ordered):**
  1. entrypoint — `public/login.html:12`: `<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js">`
     with no `integrity`/`crossorigin`, floating `@latest` version.
  2. propagation — `public/login.html:191`: inline script calls
     `lucide.createIcons()`, depending on the CDN script.
  3. sink — `public/login.html:145`: PIN input field
     (`<input type="password" id="pinInput">`) in the same DOM and origin
     as the CDN script.
- **Dummy attacker / resource:** a party able to tamper with the unpkg
  response (or the path) vs. the login page DOM. No real CDN payload was
  fetched or executed.
- **Native input / fixture:** static source verification only (by design —
  no live fetch). Confirmed: SRI-less `@latest` tag (line 12), PIN field
  (line 145), `lucide.createIcons()` dependency (line 191), `pinInput.value`
  read by inline script (line 213), `src/index.ts:217` sets only
  `Cache-Control: no-store`, and a repo-wide grep finds zero
  `Content-Security-Policy`/`script-src` occurrences and no `_headers` file.
  Hunter's sink citation (line 141) was a mis-citation of the lock-icon
  heading and was corrected to 145 by two independent verifiers.
- **Observed output:** the four static facts above; no execution
  reproduction (a tampered CDN payload was not obtained or run).
- **Conditions:** actual PIN theft requires compromise of the unpkg
  response or the path; this record is about the missing control itself,
  not an observed compromise. Whether unpkg is an approved trusted
  dependency is not recorded in source — irrelevant to the control gap.
- **Invariant proved:** the login page's script supply chain has no
  integrity or origin restriction, so a compromised CDN response would
  execute in the login origin with DOM access to the PIN.
- **Remediation + regression case:** bundle lucide locally, or pin a fixed
  version with a SHA-384 SRI hash + `crossorigin`; add a CSP restricting
  `script-src` (e.g. `'self'`) on the login response. Regression test:
  login HTML contains no external script without SRI, and the login
  response carries a `script-src` CSP.
