# Architecture — run-004 (re-audit, quick, scoped to low 9 fixes)

## Purpose

run-002·run-003에서 남은 low 9건을 수정한 커밋 `df17d3e`에 대한 재감사. 목적은 두 가지다.

1. 각 low의 수정이 실제로 결함을 제거했는지 로컬 재현으로 확인한다
   (수정 전 재현 시나리오를 동일하게 돌려 결과가 바뀌었는지 본다).
2. 변경된 코드(세션 버전 D1 이전·속도 제한 D1 원자화·PIN/OTP 소진 차단·로그인 CSP)에서
   새로 생긴 결함을 찾는다.

재감사 중 발견된 신규 low 2건은 커밋 `886c012`에서 추가 수정하고 검증자 D가 독립 재검증했다.

## Product and principals

MyHub는 단일 사용자 개인 비서 웹서비스 (Cloudflare Workers + Hono +
D1 + KV, TypeScript). 유일한 인간 주체는 소유자
(`kimjn00003@naver.com`, 운영). 이 run의 낮은 신뢰 주체는 미인증 원격
HTTP 클라이언트. 보호 자원: 소유자 세션, 메모/파일, 일정, 할 일, AI 사용량.

## Stack and deployment (source-visible)

- `src/modules/auth/routes.ts` — OTP request/verify, PIN 로그인, PIN
  설정/재발급, 로그아웃, `/me`. Hono 앱, `/api/auth`에 마운트.
- `migrations/0051_auth_atomic_counters.sql` — `session_versions`,
  `rate_limits` 테이블 (배포 게이트 — 미적용 시 모든 세션 거부됨).
- `migrations/0045_auth_pins_fail_count.sql` — `auth_pins` 테이블의
  `fail_count`, `locked_until` 컬럼 (PIN 실패 카운터 D1 원자화).
- `public/login.html` + `public/js/login.js` + `public/css/login.css` —
  로그인 페이지 (인라인 스크립트·스타일 외부 분리, CSP unsafe-inline 제거).
- `deploy_full.py` — 정식 배포 스크립트 (login.js/css를 인라인 번들에 포함,
  /login.html 응답에 CSP 헤더 추가).
- 테스트: `tests/unit/auth-low-fixes.test.ts` (8건 신규 + 후속 3건),
  `tests/integration/auth-0051-real.test.js` (실제 SQLite 9건),
  `tests/unit/auth-pin-gate.test.ts` (14건), `tests/unit/auth-routes.test.ts` (104건).

## Entry surfaces in scope (수정 후 동작)

1. `GET /api/auth/me`, `POST /api/auth/verify`, `POST /api/auth/pin-login`,
   `POST /api/auth/logout` — 세션 검증. `getSessionVersion`이 D1
   `session_versions`를 읽고, 읽기 실패 시 예외를 전파해
   `verifySessionForEnv`가 세션을 거부한다 (fail-closed).
2. `POST /api/auth/set-pin` — PIN 설정/재발급. `bumpSessionVersion`이
   D1 `UPDATE ... RETURNING version` 한 문장으로 기존 세션을 무효화한다.
   886c012부터 bump이 PIN UPSERT보다 먼저 수행된다.
3. `POST /api/auth/request`, `POST /api/auth/verify`, `POST /api/auth/pin-login` —
   속도 제한. `checkRateLimit`이 D1 `INSERT ... ON CONFLICT DO UPDATE`
   한 문장으로 선점·증가·상한 판정을 합친다. IP 식별은 CF-Connecting-IP만
   신뢰하고, 식별 불가 시 per-IP 검사를 건너뛴다. `/verify`·`/pin-login`에는
   전역 백스톱(`verify:global`·`pin:global`, 100회/시간)이 있다.
4. `POST /api/auth/pin-login` — PIN 로그인. PBKDF2 전에 조건부 UPDATE
   게이트로 실패 1회를 선점하고, 게이트 이후 예외 시 보상 UPDATE로
   되돌린다. 손상 salt/hash/iterations는 게이트 전에 500으로 분리한다.
   잠금 중에도 정답 PIN은 성공하고, 잠금 중 분기의 초기화 UPDATE는
   1회 재시도한다 (886c012). 만료된 잠금 뒤에는 fail_count가 1로 재시작한다.
5. `POST /api/auth/verify` — OTP 검증. 정답 코드는 attempts와 무관하게
   성공하고, 오답인데 이미 상한(attempts >= 5)이면 행을 지우지 않고 400만
   돌려준다. 시도 증가는 `attempts < 5` 조건부 UPDATE로 원자화한다.
6. `public/login.html` — CSP 메타에서 unsafe-inline 제거, 스크립트·스타일
   외부 파일 분리, lucide unpkg에 SRI integrity + 고정 버전(0.469.0).

## Verification method

- 검증자 A·B·C·D는 각자 신규 하네스를 작성해 실제 `routes.ts`를 import하고
  상태 저장 Mock D1 + 실제 PBKDF2 + Hono `app.request`로 재현했다.
  기존 테스트 파일을 그대로 믿지 않고 독립 재현했으며, 수정 전 코드에
  대한 음성 대조군(23e1e91·df17d3e)으로 하네스의 판별력을 확인했다.
- 운영 D1·운영 Worker·라이브 엔드포인트·실제 이메일 발송·유료 API 호출 없음.
  로컬 Jest·node·더미 데이터만 사용했다.
- 전체 Jest 219 스위트 / 3631 테스트 전부 통과, `tsc --noEmit` 클린
  (커밋 886c012 기준, 조정자 직접 실행).
