# Architecture — run-003 (re-audit, quick, scoped to pin-login gate fix)

## Purpose

run-002에서 남은 medium 1건(`auth/pin-lock-gate-stale-read`)을 수정한
커밋 `cf80259`에 대한 재감사. 목적은 두 가지다.

1. 해당 medium의 수정이 실제로 결함을 제거했는지 로컬 재현으로 확인한다
   (수정 전 재현 시나리오를 동일하게 돌려 결과가 바뀌었는지 본다).
2. 변경된 코드(게이트 선점 UPDATE + 성공 초기화)에서 새로 생긴 결함을 찾는다.

## Product and principals

MyHub는 단일 사용자 개인 비서 웹서비스 (Cloudflare Workers + Hono +
D1 + KV, TypeScript). 유일한 인간 주체는 소유자
(`kimjn00003@naver.com`, 운영). 이 run의 낮은 신뢰 주체는 미인증 원격
HTTP 클라이언트. 보호 자원: 소유자 세션, 메모/파일, 일정, 할 일, AI 사용량.

## Stack and deployment (source-visible)

- `src/modules/auth/routes.ts` — OTP request/verify, PIN 로그인, PIN
  설정/재발급, 로그아웃, `/me`. Hono 앱, `/api/auth`에 마운트.
- `migrations/0045_auth_pins_fail_count.sql` — `auth_pins` 테이블의
  `fail_count`, `locked_until` 컬럼 (PIN 실패 카운터 D1 원자화).
- 테스트: `tests/unit/auth-pin-gate.test.ts` (8건, cf80259에서 신규).

## Entry surfaces in scope (수정 후 동작)

1. `POST /api/auth/pin-login` — 6자리 PIN 로그인. cf80259 변경점:
   - PBKDF2 검증 전에 `UPDATE auth_pins SET fail_count = fail_count + 1, locked_until = CASE WHEN fail_count + 1 >= 5 THEN +900초 ELSE locked_until END WHERE email = ? AND (locked_until IS NULL OR locked_until <= ?)` 원자 UPDATE로 실패 1회를 선점한다. changes=0이면 이미 잠긴 상태 → 429.
   - 오답이면 추가 증가 없이 401만 돌려준다 (선점분이 이미 카운트됨).
   - 정답이면 `UPDATE auth_pins SET fail_count = 0, locked_until = NULL WHERE email = ?`로 무조건 초기화한다 (게이트 선점분 남지 않게).
   - 이미 잠긴 상태의 fast-path 429 검사(:507)는 게이트 UPDATE 전에 유지된다.
   - 발신자별 10회/시간 제한(pinip)도 있다. 0045 미적용 환경에서는 KV 폴백.
2. `POST /api/auth/verify` — OTP 검증. 조건부 원자 UPDATE 패턴의 참조 원본
   (`/verify` :423 부근). 이번 run에서는 소스 변경이 없어 참조만 했다.

## Trust boundaries and strongest source-visible controls

- 미인증 클라이언트 → PIN 엔드포인트: 발신자별 속도 제한 +
  계정 전역 상한, D1 원자 카운터/조건부 쓰기, 상수 시간 해시 비교.
- 게이트 선점: PBKDF2 검증 전에 조건부 UPDATE로 실패 1회를 선점해
  동시 버스트가 5회 추측 예산을 넘기지 못하게 한다.
- PIN 설정 → `auth_pins`: OTP 세션만 허용 (step-up), 평문 PIN 미저장.

## run-002 finding under re-audit (1건)

| fingerprint | run-002 severity | 수정 요약 (cf80259) |
|---|---|---|
| auth/pin-lock-gate-stale-read | medium | PBKDF2 검증 전 조건부 원자 UPDATE로 게이트 선점 (changes=0 → 429), 실패 시 추가 증가 없음, 성공 시 무조건 초기화 |

## Out of scope

- 운영 D1, 운영 Worker, 라이브 엔드포인트, 실제 메일 발송 (금지).
- 다른 모듈(메모·AI·일정·할 일·스튜디오 등) — 별도 run에서 다룬다.
- run-002의 나머지 8건(소스 변경 없음) — 이번 run에서 재검증하지 않았고
  run-002 상태 그대로 유지된다 (REPORT.md §1 참조).
- `public/login.html` — cf80259에서 변경 없음.
- KV 폴백 동시 버스트 — 헌터·검증자 모두 NOT TESTED로 남김.
