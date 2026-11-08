# Findings Detail — run-004

## low — 결정적 재현 요약

### auth/pin-locked-branch-no-retry — 잠금 중 /pin-login 분기에 try/catch이 없어 정답 PIN 처리 중 예외 시 잠금이 그대로 남는다

- 트리거 (X1, 검증자 B): fail_count=5·locked_until=미래인 잠금 행 + 정답 PIN + 초기화 UPDATE 실패 주입 → **500**, fail_count=5·locked_until 그대로. 직후 정답 재시도 → 잠금 유지.
- 트리거 (X2, 검증자 B): iterations=0 손상 행 + 정답 PIN → verifyPin PBKDF2 OperationError → **500**, 잠금 잔존.
- 수정 후 (검증자 D, 886c012): 잠금 중 정답 + 초기화 1회 실패 → 재시도로 **200**, `UPDATE auth_pins SET fail_count = 0` 정확히 2회 호출, fail_count=0·locked_until=null, Set-Cookie 발급.
- 수정 후 (검증자 D): 초기화 2회 실패 → **500**, fail_count=5·locked_until 그대로, 쿠키 미발급. 고장 해제 후 소유자 재시도 → **200** (잠금 고착 없음).
- 수정 후 (검증자 D): iterations=0 / 1.5 / -3 → **500**, `auth_pins` UPDATE 0회 (게이트 선점 없음).
- 건전성 (검증자 D): 잠금 중 오답 → 429·reset 미호출·카운터 그대로 / 잠금 없음 정답 → 200·reset 1회.
- 음성 대조군 (검증자 D, df17d3e 코드): reset 1회 실패 시 **500에 reset 1회 호출**(재시도 없음), iterations=0 시 **게이트 선점 UPDATE 실행됨** — 수정 전 결함 동작 확인.
- 판정: **FIXED** (886c012, 검증자 D 독립 재검증).

### auth/set-pin-order — /set-pin이 PIN 교체 후 bump을 해서 bump 실패 시 새 PIN이 적용됐는데 구 세션이 살아남는다

- 트리거 (E5, 검증자 C): bump UPDATE만 일시 실패하게 주입 → /set-pin **500**인데 PIN 행은 새 PIN으로 교체되고 session_versions는 0 그대로라 구 세션이 **/me 200**으로 살아남음.
- 수정 후 (검증자 D, 886c012): bump 실패 → **500** + `INSERT INTO auth_pins` 0회 + bump 시도 1회 + 버전 0 유지 + Set-Cookie 없음 + 기존 OTP 세션 /me 200 + 구 PIN 로그인 200 (아무것도 바뀌지 않은 일관 상태).
- 수정 후 (검증자 D): bump 1회 실패 후 재시도 → 첫 호출 500(UPSERT 0회) → 같은 OTP 토큰으로 재시도 시 **200**, UPSERT 1회, 버전 1, 새 PIN 로그인 200·구 PIN 401·구 OTP 세션 /me 401.
- 수정 후 (검증자 D): 정상 set-pin → **200** + 새 쿠키 발급, 버전 1, **호출 로그에서 bump 인덱스 < UPSERT 인덱스**로 순서 직접 확인, 구 PIN 세션 /me 401, 새 쿠키 세션 /me 200, 새 PIN 200·구 PIN 401.
- 음성 대조군 (검증자 D, df17d3e 코드): bump 실패 시 **500이면서 UPSERT 실행됨 — 새 PIN 로그인 200 + 구 OTP 세션 /me 200 + 버전 0**이라는 지적된 그대로의 불일치 상태 재현.
- 판정: **FIXED** (886c012, 검증자 D 독립 재검증).

### auth/rate-limit-global-backstop-dos — 전역 백스톱을 분산 공격으로 소진하면 소유자 정답 제출이 429를 받는다

- D1 (검증자 C): 5개 IP × 20회 /verify 오답 = 100회 전부 400 → 소유자 정답 **429** (코드 행은 살아있음).
- D2 (검증자 C): 10개 IP × 10회 /pin-login 오답 = 100회 → 소유자 정답 PIN **429**.
- D3 (검증자 C): CF 헤더 없는 단일 공격자 100회로도 전역 소진 → 소유자 정답 **429** (운영은 CF 헤더가 normally 존재하므로 이 경로는 조건부, D1/D2가 현실적 경로).
- D4 (검증자 C): 전역 소진 후 /me **200** — 기존 30일 세션 무영향.
- 원본 결함(5회로 차단) 대비 장벽은 20배 높아졌고(100회·IP 분산 필요), 영향은 최대 1시간·양 로그인 경로 동시 차단은 200회/시간.
- 판정: **확인된 잔존 low** (미수정 — 설계 결정 필요).

## informational — 결정적 재현 요약

### auth/pin-iterations-no-upper-bound — 손상 행 iterations 사전 검증에 상한이 없어 극단적으로 큰 값이 PBKDF2를 매우 느리게 만들 수 있다

- 소스 확인 (검증자 D): 사전 검증(routes.ts:598)에 상한이 없고, verifyPin이 row.iterations를 그대로 PBKDF2 deriveBits에 전달하며, set-pin은 100000만 저장한다.
- 실측 재현은 하지 않았다 (NOT TESTED — 값 자체가 코드 경로로 도달 불가하고 실측은 로그인 경로 장시간 점유라 실행하지 않음).
- 판정: **확인된 관찰 (informational)** — 후속 후보로 기록.

## FIXED 확인 — 대상 low 9건 재현 결과

### auth/sessver-fail-open — KV 장애 시 세션 무효화 우회·버전 하락

- 검증자 A (df17d3e, /tmp/run004-verifier-a.cjs, 44개 체크 전부 PASS): D1 읽기 실패 주입 시 /verify·/me·/logout 500/401 fail-closed. 0051 미적용 상태도 fail-closed (배포 게이트와 일치).
- 판정: **FIXED**.

### auth/sessver-bump-race — 동시 /set-pin 시 두 세션 모두 생존

- 검증자 A: 동시 /set-pin 버스트 후 살아남는 세션 최대 1개 (D1 UPDATE ... RETURNING 원자화). 44개 체크 전부 PASS.
- 판정: **FIXED**.

### auth/rate-limit-kv-race — KV read-modify-write 경합으로 상한 초과

- 검증자 A: 지연 인터리빙 하네스로 동시 버스트를 돌려도 상한 초과 없음 (단일 UPSERT 문장). 44개 체크 전부 PASS.
- 판정: **FIXED**.

### auth/rate-limit-unknown-ip — XFF 위조로 per-IP 제한 우회

- 검증자 A: XFF 위조 무효과, CF-Connecting-IP만 신뢰, 식별 불가 시 per-IP 검사 건너뜀 + 전역 백스톱 100회/시간 존재. 44개 체크 전부 PASS.
- 판정: **FIXED**.

### auth/pin-failcount-no-decay — 만료 후 오답 1개로 재잠금

- 검증자 B (N1~N4 PASS): 만료된 잠금 뒤 오답 1개 → fail_count=1로 재시작, 재잠금 없음. 15/15 체크 PASS.
- 음성 대조군 (23e1e91 코드): 동일 하네스 12 FAIL / 3 PASS — 수정 전 결함 동작 확인.
- 판정: **FIXED**.

### auth/pin-kv-fallback-race — D1 일시 장애 시 KV 폴백으로 경합 부활

- 검증자 B (K1~K4 PASS): 'no such column'일 때만 폴백, 그 외 D1 오류는 500. 15/15 체크 PASS.
- 음성 대조군 (23e1e91 코드): 동일 하네스 12 FAIL / 3 PASS.
- 판정: **FIXED**.

### auth/pin-gate-failure-leaves-lock — 게이트 선점 후 예외 시 실패·잠금 잔존

- 검증자 B (G1~G5 PASS): 게이트 이후 예외 시 보상 UPDATE로 선점분 복원, 손상 salt/hash는 게이트 전 500, 보상 후 재시도하면 정상 로그인. 15/15 체크 PASS.
- 음성 대조군 (23e1e91 코드): 동일 하네스 12 FAIL / 3 PASS.
- 판정: **FIXED**.

### auth/lockout-dos-verify-pin-residual — 미인증자 5회 오답으로 소유자 로그인 차단

- 검증자 C (/tmp/run004-c.cjs [A][C] 섹션, 48개 체크 중 해당 부분 전부 PASS):
  - /verify: 공격자 오답 5회 → 400×5, attempts=5에서 행 유지(삭제 안 됨), 6번째 오답도 400에 행 유지. 소유자 정답(다른 IP) → **200 + 세션 쿠키 발급**. attempts=5 상태의 정답도 200.
  - /pin-login: 공격자 오답 5회 → 401×5, fail_count=5·잠금 설정. 잠금 중 오답 → 429, 반복해도 fail_count·locked_until 불변(연장 없음). 잠금 중 소유자 정답 PIN → **200**, fail_count=0·잠금 해제.
- 회귀 확인: 서로 다른 IP 10회 오답 후에도 attempts=5 유지, 소유자 정답 200. /request 재요청도 attempts를 초기화하지 않음 — 코드당 오답 예산 5회 그대로.
- 판정: **FIXED**.

### auth/login-csp-unsafe-inline — login.html 인라인 스크립트 + CSP unsafe-inline

- 검증자 C (/tmp/run004-c-static.cjs, 47개 체크 전부 PASS):
  - F1~F3: login.html에 인라인 `<script>`·`<style>`·`onclick` 없음, /js/login.js·/css/login.css 외부 참조, CSP 메타에 unsafe-inline 없음. login.js esbuild 컴파일 성공, addEventListener 8개, innerHTML/eval 없음, textContent만 사용, fetch 4개 전부 /api/auth/*, 참조 ID 14개 전부 HTML에 존재. lucide unpkg에 SRI integrity 있음.
  - F4~F5: deploy_full.py에 staticBufs·files·CT 맵·ver()에 login.js/css 포함, /login.html 전용 CSP 헤더(unsafe-inline 없음). src/index.ts allowlist에 /js/login.js·/css/login.css 있음.
  - F6 라이브 서빙: 실제 src/index-inline.ts를 esbuild 컴파일해 node에서 fetch — /login.html 200 + CSP 헤더, 미인증 /js/login.js 200(application/javascript, 본문=public 파일과 동일), /css/login.css 200(text/css, 본문 동일), 미인증 /index.html → 302 /login.html, /api/health 200.
- 브라우저 실제 클릭 흐름은 NOT TESTED (subagent 브라우저 불가 — 정적 검증 + 로컬 서빙까지만 확인).
- 판정: **FIXED**.
