# 보안 감사 보고서 — run-004 (재감사, quick, run-002·run-003 low 9건 수정 검증)

- 대상 커밋: `df17d3e` (low 9건 수정) + 후속 수정 `886c012` (재감사 중 발견된 신규 low 2건)
- 스코프: 인증 모듈 — 세션 버전·속도 제한 D1 원자화, PIN·OTP 소진 DoS 차단, 로그인 CSP
- 프로파일: quick, prior run: run-003
- 검증: 헌터 1명 + 독립 검증자 4명 (A·B·C·D, 각자 신규 하네스 작성, 실제 `routes.ts` import, 상태 저장 Mock D1, 실제 PBKDF2)
- 검증기: `validate-findings.cjs` PASS (4 findings), `validate-coverage-ledger.cjs` PASS (12 units)

## 최종 판정

- **대상 low 9건 → 전부 FIXED 확인** (검증자 A·B·C가 각자 독립 하네스로 확인, 음성 대조군 포함).
- **신규 confirmed 4건: low 3건 + informational 1건. P0/P1 0건.**
  - low `auth/pin-locked-branch-no-retry` (신규 — df17d3e 잠금 중 분기 try/catch 누락) → **886c012에서 수정, 검증자 D 독립 재검증으로 FIXED 확인**
  - low `auth/set-pin-order` (신규 — df17d3e /set-pin 순서 결함) → **886c012에서 수정, 검증자 D 독립 재검증으로 FIXED 확인**
  - low `auth/rate-limit-global-backstop-dos` (신규 — 전역 백스톱 잔여 DoS, 장벽 20배) → **잔존, 미수정 (설계 결정 필요)**
  - informational `auth/pin-iterations-no-upper-bound` (신규 — iterations 상한 부재) → **후속 후보로 기록**
- **배포 게이트 주의:** 마이그레이션 0051 미적용 시 모든 세션이 거부된다 (fail-closed 설계). 0051 적용 없는 배포 금지. 절체: 배포 전 KV `sessver:{email}` 현재값을 session_versions에 시드하면 기존 30일 세션 유지, 시드 안 하면 기존 세션 무효·OTP 재로그인 필요.

## 1. 대상 low 9건 재검증 결과

| fingerprint | run-002/003 severity | run-004 결과 |
|---|---|---|
| auth/sessver-fail-open | low | **FIXED** — 검증자 A, 44개 체크 PASS. D1 읽기 실패 시 /verify·/me·/logout 500/401 fail-closed. 0051 미적용 상태도 fail-closed (문서화된 배포 게이트와 일치) |
| auth/sessver-bump-race | low | **FIXED** — 검증자 A, 44개 체크 PASS. 동시 /set-pin 시 살아남는 세션 최대 1개 (D1 UPDATE ... RETURNING 원자화) |
| auth/rate-limit-kv-race | low | **FIXED** — 검증자 A, 44개 체크 PASS. 지연 인터리빙에도 동시 버스트가 상한을 넘지 않음 (단일 UPSERT 문장) |
| auth/rate-limit-unknown-ip | low | **FIXED** — 검증자 A, 44개 체크 PASS. XFF 위조 무효과, CF-Connecting-IP만 신뢰, 식별 불가 시 per-IP 검사 건너뜀 + 전역 백스톱 존재 |
| auth/pin-failcount-no-decay | low | **FIXED** — 검증자 B, N1~N4 PASS. 만료된 잠금 뒤 오답 1개 → fail_count=1로 재시작, 재잠금 없음. 음성 대조군(23e1e91): 12 FAIL / 3 PASS |
| auth/pin-kv-fallback-race | low | **FIXED** — 검증자 B, K1~K4 PASS. 'no such column'일 때만 폴백, 그 외 D1 오류는 500. 음성 대조군(23e1e91): 12 FAIL / 3 PASS |
| auth/pin-gate-failure-leaves-lock | low | **FIXED** — 검증자 B, G1~G5 PASS. 게이트 이후 예외 시 보상 UPDATE로 선점분 복원, 손상 salt/hash는 게이트 전 500. 음성 대조군(23e1e91): 12 FAIL / 3 PASS |
| auth/lockout-dos-verify-pin-residual | low | **FIXED** — 검증자 C, 48개 체크 PASS. 오답 5회 후에도 소유자 정답 코드·정답 PIN 200. 잠금 중 오답 반복해도 fail_count·locked_until 불변 |
| auth/login-csp-unsafe-inline | low | **FIXED** — 검증자 C, 47개 정적 체크 PASS + 라이브 서빙 확인. /login.html 200 + CSP 헤더(unsafe-inline 없음), /js/login.js·/css/login.css 미인증 200, /index.html → 302 /login.html. 브라우저 실제 클릭 흐름은 NOT TESTED |

## 2. confirmed findings (4건)

### low — `auth/pin-locked-branch-no-retry` (신규, **수정됨 → FIXED**)

잠금 중 /pin-login 분기에 try/catch이 없어 정답 PIN 처리 중 예외 시 잠금이 그대로 남았다.
- X1: 잠금 + 정답 PIN + 초기화 UPDATE 실패 주입 → 500, fail_count=5·잠금 잔존, 직후 정답 재시도도 잠금 유지.
- X2: iterations=0 손상 행 + 정답 PIN → verifyPin PBKDF2 OperationError → 500, 잠금 잔존.
- 수정(886c012): 초기화 UPDATE를 resetPinCounter 헬퍼로 바꿔 1회 재시도, iterations(0·비정수·음수)를 salt/hash와 함께 게이트 전 500으로 분리.
- 재검증(검증자 D): 10개 시나리오 PASS — 1회 실패→재시도 200·reset 2회 호출, 2회 실패→500·잠금 그대로·쿠키 미발급, iterations 0/1.5/-3→500·UPDATE 0회. 음성 대조군(df17d3e): 재시도 없음·게이트 선점 실행 확인.

### low — `auth/set-pin-order` (신규, **수정됨 → FIXED**)

PIN 교체 후 bump을 해서 bump 실패 시 새 PIN이 적용됐는데 구 세션이 살아남았다.
- E5: bump만 실패 주입 → /set-pin 500인데 PIN 행은 새 PIN으로 교체, session_versions 0 그대로, 구 세션 /me 200.
- 수정(886c012): bumpSessionVersion을 PIN UPSERT보다 먼저 수행. bump 실패 시 PIN도 세션도 그대로인 일관 상태.
- 재검증(검증자 D): 10개 시나리오 PASS — bump 실패→500·UPSERT 0회·OTP 세션 유지·구 PIN 200, 정상 set-pin→호출 로그에서 bump 인덱스 < UPSERT 인덱스 직접 확인·구 세션 401. 음성 대조군(df17d3e): 500이면서 UPSERT 실행·새 PIN 200 + 구 세션 200 재현.

### low — `auth/rate-limit-global-backstop-dos` (신규, **잔존**)

전역 백스톱(verify:global·pin:global 100회/시간)을 분산 공격으로 소진하면 소유자 정답 제출이 429를 받는다.
- D1: 5개 IP × 20회 /verify 오답 = 100회 전부 400 → 소유자 정답 429 (코드 행은 살아있음).
- D2: 10개 IP × 10회 /pin-login 오답 = 100회 → 소유자 정답 PIN 429.
- D3: CF 헤더 없는 단일 공격자 100회로도 전역 소진 → 소유자 정답 429 (운영은 CF 헤더가 normally 존재하므로 조건부).
- D4: 전역 소진 후 /me 200 — 기존 30일 세션 무영향. 원본 결함(5회 차단) 대비 장벽 20배, 영향 최대 1시간.
- 수정 방향: (a) 전역 상한 상향 (b) 속도 제한 검사를 자격 증명 검증 뒤로 이동(오답에만 적용). 구조 변경이라 별도 설계 결정 필요 — 이번 run에서는 미적용.

### informational — `auth/pin-iterations-no-upper-bound` (신규, 후속 후보)

손상 행 iterations 사전 검증에 상한이 없어 극단적으로 큰 값(예: 10^9)이 PBKDF2를 매우 느리게 만들 수 있다. set-pin은 100000만 저장하므로 손상된 DB 행을 통해서만 도달 가능하고, 이번 수정이 새로 만든 문제가 아니라 기존부터 있던 이론적 지점이라 informational로 기록. 수정 방향: 사전 검증에 상한(예: 1,000,000) 추가 — 한 줄 변경, 후속 적용 후보.

## 3. 커버리지

- 유닛 12개 (coverage-ledger.json, 검증기 PASS):
  - covered 9개: 9건 FIXED 영역 (sessver fail-open/bump, rate-limit UPSERT/unknown-IP, no-decay, KV 폴백, lockout-dos bypass, gate 보상, login CSP)
  - candidate 3개: 신규 finding 영역 (잠금 분기 재시도 + iterations, set-pin 순서, 전역 백스톱)
- 헌터: df17d3e 재현 시나리오를 9건에 동일하게 돌리고 변경 코드에서 신규 결함을 탐색, 신규 2건 수정(886c012) 후 검증자 D 재검증 조율.
- 검증자 A: sessver·rate-limit 4건 FIXED 독립 확인 (44개 체크, 장애 주입·지연 인터리빙).
- 검증자 B: PIN 카운터·게이트·폴백 3건 FIXED 독립 확인 (15개 체크, 음성 대조군 23e1e91에서 12 FAIL).
- 검증자 C: lockout-dos·login CSP 2건 FIXED 독립 확인 (48+47개 체크) + 회귀 헌트 (전역 백스톱 잔여 DoS, /set-pin 순서 결함 발견).
- 검증자 D: 신규 low 2건 수정(886c012) 독립 재검증 (10개 시나리오, 음성 대조군 df17d3e에서 구 동작 확인).

## 4. finding이 아닌 관찰 (기록용)

- **/set-pin 부분 적용 (검증자 A 관찰)** — df17d3e에서 bump 실패 시 PIN UPSERT는 이미 완료돼 PIN은 교체되지만 토큰 미발급·구 세션 유지. 결함이 아니라 관찰로 기록했고, 검증자 C의 E5와 같은 뿌리라 886c012 순서 교환으로 해소됨 (검증자 D가 FIXED 확인).
- **pinLoginKvFallback에 KV read-modify-write 잔존 (검증자 A 관찰)** — 0045 미적용 환경 전용 폴백 경로라 배포 게이트(0051 적용 필수)로 판정에 영향 없음. 0051 적용 환경에서는 도달하지 않는다.
- **set-pin 순서 교환의 맞교환 지점 (검증자 D 관찰)** — bump 성공 후 UPSERT이 D1 오류로 실패하면 버전은 올라가 모든 세션(사용 중인 OTP 세션 포함)이 무효화되는데 PIN은 구 PIN 그대로 남는다. 안전 방향(fail-closed — 세션이 살아남거나 PIN만 바뀌는 일은 없음)이지만 재시도하려면 OTP를 새로 받아야 한다. D1 장애 시에만 발생하는 UX 비용으로 보안 결함이 아니다.
- **login.js 최상단 lucide.createIcons() 무방비 호출 (검증자 C 관찰)** — 이전 인라인 스크립트에도 동일하게 있던 기존 동작이라 이번 커밋의 퇴행이 아니다.

## 5. 조정자가 직접 검증한 항목

- 전체 Jest **219 스위트 / 3631 테스트 전부 통과**, `tsc --noEmit` 클린 (커밋 886c012 기준, 실제 실행).
- 신규 테스트: `tests/unit/auth-low-fixes.test.ts`에 잠금 분기 재시도 3건 + set-pin bump-first 확장 1건 추가 (전체 138건 통과: auth-low-fixes·auth-pin-gate·auth-routes·auth-0051-real).

## 6. NOT TESTED

- 실제 Cloudflare Workers/D1 환경에서의 동작 (로컬 하네스만 수행 — better-sqlite3 인메모리 D1 + Hono app.request).
- 브라우저 실제 로그인 클릭 흐름 (login.js 분리 후 동작은 정적 검증 + 로컬 서빙까지만 확인).
- D1 실동시성 버스트 (better-sqlite3 단일 프로세스라 동시성은 단일 문장 원자성 수준까지만 확인).
- iterations 상한 부재의 실측 재현 (값 자체가 코드 경로로 도달 불가하고 실측은 로그인 경로 장시간 점유라 실행하지 않음 — 소스 확인만).
- 전역 백스톱 소진 시나리오의 실제 운영 IP 환경 (CF 헤더 존재 전제).

## 7. 다음 단계

1. **잔존 low `auth/rate-limit-global-backstop-dos` 수정 여부 결정** — (a) 전역 상한 상향 또는 (b) 속도 제한 검사를 자격 증명 검증 뒤로 이동. 구조 변경이라 별도 설계 검토 필요.
2. **informational `auth/pin-iterations-no-upper-bound` 적용 여부 결정** — 사전 검증에 상한(예: 1,000,000) 추가, 한 줄 변경.
3. **운영 배포 시 마이그레이션 0051 적용 확인 필수** — 0051 미적용 시 모든 세션 거부됨 (fail-closed). 배포 전 KV `sessver:{email}` 시드로 기존 세션 유지 여부 결정.
4. 후속 run 후보: 다른 페이지의 lucide@latest SRI 미적용 (run-003에서 이월), 미들웨어 allowlist 이메일 바인딩 부재.
