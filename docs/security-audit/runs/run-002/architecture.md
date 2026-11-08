# Architecture — run-002 (re-audit, quick, scoped to auth + middleware)

## Purpose

run-001에서 `confirmed`으로 확정된 7건(medium 3건 + low 4건)을 수정한
커밋 `57b5554`에 대한 재감사. 목적은 두 가지다.

1. 7건의 수정이 실제로 결함을 제거했는지 로컬 재현으로 확인한다
   (수정 전 재현 시나리오를 동일하게 돌려 결과가 바뀌었는지 본다).
2. 변경된 코드에서 새로 생긴 결함을 찾는다.

## Product and principals

MyHub는 단일 사용자 개인 비서 웹서비스 (Cloudflare Workers + Hono +
D1 + KV, TypeScript). 유일한 인간 주체는 소유자
(`kimjn00003@naver.com`, 운영). 이 run의 낮은 신뢰 주체는 미인증 원격
HTTP 클라이언트. 보호 자원: 소유자 세션, 메모/파일, 일정, 할 일, AI 사용량.

## Stack and deployment (source-visible)

- `src/modules/auth/routes.ts` — OTP request/verify, PIN 로그인, PIN
  설정/재발급, 로그아웃, `/me`. Hono 앱, `/api/auth`에 마운트.
- `public/login.html` — PIN 로그인 + OTP→PIN 발급 클라이언트.
- `src/index.ts` — 인증 미들웨어 (run-001에서는 out_of_scope였으나
  이번 run에서 `verifySessionForEnv`로 바뀌어 스코프에 포함).
- `migrations/0043_auth_pins.sql` — `auth_pins` 테이블 (PBKDF2 해시만).
- `migrations/0045_auth_pins_fail_count.sql` — 신규: `fail_count`,
  `locked_until` 컬럼 (PIN 실패 카운터 D1 원자화).
- 테스트: `tests/unit/auth-routes.test.ts` (98건),
  `tests/unit/core-index.test.ts` (51건).

## Entry surfaces in scope (수정 후 동작)

1. `POST /api/auth/request` — OTP 코드 요청. 발신자(IP)별 5회/시간을
   먼저 두고 계정 전역 20회/시간을 둔다. 코드 생성은
   `INSERT ... WHERE NOT EXISTS(유효 코드)` 조건부 원자 INSERT로 통합돼
   동시 요청 중 1건만 코드를 만들고 그 요청만 메일을 발송한다.
2. `POST /api/auth/verify` — OTP 검증. 발신자별 20회/시간 제한.
   오답 증가는 `UPDATE ... SET attempts = attempts + 1 WHERE email = ?
   AND attempts < 5` 원자 UPDATE로 판정과 통합 (changes=0이면 상한 초과).
   성공 시 원자적 조건부 DELETE로 코드 소비.
3. `POST /api/auth/pin-login` — 6자리 PIN 로그인. 실패 카운터가
   `auth_pins.fail_count`/`locked_until`의 D1 원자 UPDATE로 이동했다
   (5회 도달 시 같은 UPDATE의 CASE 식으로 locked_until +15분).
   발신자별 10회/시간 제한도 있다. 0045 미적용 환경에서는 KV 폴백.
4. `POST /api/auth/set-pin` — OTP 세션만 허용 (step-up). PIN 로그인
   세션·구 토큰(method 없음)은 403. 재발급 시 세션 버전 +1로 기존
   세션을 전부 무효화하고, 새 PIN 세션을 발급해 쿠키로 돌려준다.
5. `POST /api/auth/logout` — 쿠키 삭제 + 세션 버전 +1 (서버 측 무효화).
6. `GET /api/auth/me` — `verifySessionForEnv`로 버전까지 대조.
7. 세션 토큰: payload `{email, exp, method, v}` HMAC-SHA256 서명
   (`SESSION_SECRET`). method는 `'otp' | 'pin'`, v는 세션 버전.
   0045 이전 구 토큰에는 method/v가 없어 method=null·v=0으로 간주한다.
   버전 카운터는 KV `sessver:{email}` (기본 0).
8. `public/login.html` — lucide 고정 버전 0.469.0 + SHA-384 SRI +
   CSP 메타 태그. PIN 입력 필드(`type=password`, `maxlength=6`,
   `inputmode=numeric`), OTP → PIN 발급 흐름.

## Trust boundaries and strongest source-visible controls

- 미인증 클라이언트 → OTP/PIN 엔드포인트: 발신자별 속도 제한 +
  계정 전역 상한, D1 원자 카운터/조건부 쓰기, 상수 시간 해시 비교,
  원자적 단일 사용 OTP 소비.
- 세션 쿠키 → 보호 라우트: HMAC 검증 + 만료 + allowlist 이메일 바인딩
  + 세션 버전 대조 (미들웨어·`/me`·`/set-pin`).
- PIN 설정 → `auth_pins`: OTP 세션만 허용 (step-up), 평문 PIN 미저장,
  재발급 시 기존 세션 무효화 + 실패 카운터 초기화.

## run-001 findings under re-audit (7건)

| fingerprint | run-001 severity | 수정 요약 (57b5554) |
|---|---|---|
| auth/pin-lockout-kv-race | medium | D1 원자 UPDATE로 이동 (0045) |
| auth/otp-verify-attempts-race | medium | 조건부 원자 UPDATE + /verify IP 제한 |
| auth/login-page-cdn-no-sri | medium | 고정 버전 + SRI + CSP |
| auth/session-no-revocation | low | 세션 버전 무효화 |
| auth/set-pin-no-step-up | low | OTP 세션만 허용 (403) |
| auth/otp-request-race | low | 조건부 원자 INSERT |
| auth/attempt-counter-lockout-dos | low | 발신자별 버킷 + 전역 상한 상향 |

## Out of scope

- 운영 D1, 운영 Worker, 라이브 엔드포인트, 실제 메일 발송 (금지).
- 다른 모듈(메모·AI·일정·할 일·스튜디오 등) — 별도 run에서 다룬다.
- 다른 페이지의 `lucide@latest`(backup/memo/memory/schedule/search/todo)
  — login.html만 이번 스코프이며, 나머지는 후속 run의 후보로 기록한다.
