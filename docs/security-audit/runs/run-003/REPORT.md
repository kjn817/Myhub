# 보안 감사 보고서 — run-003 (재감사, quick, PIN 잠금 게이트 수정 검증)

- 대상 커밋: `cf80259` (run-002 medium `auth/pin-lock-gate-stale-read` 수정)
- 스코프: 인증 모듈 — `POST /api/auth/pin-login` 게이트 선점 + 성공 초기화
- 프로파일: quick, prior run: run-002
- 검증: 헌터 1명 + 독립 검증자 3명 (각자 신규 하네스 작성, 실제 `routes.ts` import, 상태 저장 Mock D1, 실제 PBKDF2)
- 검증기: `validate-findings.cjs` PASS (3 findings), `validate-coverage-ledger.cjs` PASS (2 units)

## 최종 판정

- **대상 medium `auth/pin-lock-gate-stale-read` → FIXED 확인** (헌터 + 검증자 A 독립 재현 2회 동일 결과).
- **신규 confirmed 3건: low 2건 + informational 1건. P0/P1 0건.**
  - low `auth/pin-gate-failure-leaves-lock` (신규 — cf80259 게이트 선점의 부수 효과)
  - low `auth/pin-failcount-no-decay` (run-002 잔존 — cf80259가 건드리지 않아 재확인)
  - informational `auth/pin-success-reset-erases-concurrent-failure` (현상 확인, 보안 결함 아님)
- **배포 게이트 주의:** run-002와 동일하게, 마이그레이션 0045 미적용 시 run-001 medium(`auth/pin-lockout-kv-race`)이 부활한다. 0045 적용 없는 배포 금지.

## 1. 대상 medium 재검증 결과

| fingerprint | run-002 severity | run-003 결과 |
|---|---|---|
| auth/pin-lock-gate-stale-read | medium | **FIXED** — 동시 10개 → 401×5 + 429×5, fail_count=5. 동시 20개 → 401×5 + 429×15. 순차 대조군 동일. 동일 IP 버스트도 401×5. 오답 후 정답 → 200·fail_count=0. 헌터·검증자 A가 각자 하네스로 2회씩 동일하게 재현 |

run-002의 나머지 8건은 cf80259에서 소스가 변경되지 않아 이번 run에서 재검증하지 않았다 (NOT TESTED, run-002 상태 그대로 유지):
`sessver-fail-open`, `sessver-bump-race`, `rate-limit-kv-race`, `rate-limit-unknown-ip`,
`pin-kv-fallback-race`, `login-csp-unsafe-inline`, `lockout-dos-verify-pin-residual`, `pin-failcount-no-decay` 중
`pin-failcount-no-decay`만 아래 §2에서 재확인됐다 (나머지 7건은 미재검증).

## 2. confirmed findings (3건)

### low — `auth/pin-gate-failure-leaves-lock` (신규)

게이트 선점 이후 예외가 나면 선점한 실패·잠금이 그대로 남는다.
- (M) fail_count=4 + 정답 PIN + 초기화 UPDATE 실패 주입 → 500, fail_count=5, locked_until≈현재+900초, 직후 정답 재시도 → 429로 잠금 유지.
- (R) 손상된 pin_salt + 오답 PIN → verifyPin 내부 atob이 InvalidCharacterError → 500, fail_count 4→5 + 잠금, 직후 정답 재시도 → 429.
- 구 로직 대조군: 동일 실패 주입에도 500이나 fail_count=4·locked_until=null 유지, 복구 후 정답 → 200. 원인 = 게이트 선점.
- 정정: 잠금은 영구 고착이 아니다. 15분 후 만료되고 set-pin(:615)도 카운터 초기화를 수행하므로 OTP→PIN 재발급으로 풀린다.
- 부수 관찰: (R) 상태에서 salt가 손상된 채로 재시도하면 매 시도마다 게이트가 locked_until을 +900초로 갱신하므로 salt를 고치지 않는 한 429가 사실상 계속 이어진다.
- 수정 방향: 게이트 이후 단계(verifyPin·초기화)를 try/catch로 감싸고 예외 시 선점분을 되돌리는 보상 UPDATE, salt base64 사전 검증.

### low — `auth/pin-failcount-no-decay` (run-002 잔존, 재확인)

fail_count가 절대 감소하지 않아 오답 1개로 15분 잠금을 무기한 재연장할 수 있다.
- T1a: 오답 5회 → 잠금, 만료 시뮬레이션 → 오답 1개 → 401·fail_count 5→6·재잠금, 정답 후속 → 429.
- T1b: 만료 직후 정답을 먼저 보내면 200·fail_count=0으로 초기화 — 소유자에게 로그인 창이 있다.
- cf80259는 이 결함을 건드리지 않았다. 수정 방향은 run-002 remediation과 동일 (실패 UPDATE 안에서 만료된 잠금 뒤 fail_count 재시작, 원자성 유지).

### informational — `auth/pin-success-reset-erases-concurrent-failure` (현상 확인)

성공 시 무조건 초기화(`fail_count=0`)가 동시 오답의 선점분까지 함께 지운다.
- 정답+오답 동시 전송 → 최종 fail_count=0. 순차 대조군(오답→정답)도 최종 0으로 동일.
- 공격자 이득 없음, 순차 실행과 최종 상태 동일 → 보안 결함이 아니라 관찰 기록. 수정 불필요 (선택: 초기화 UPDATE 조건부화).

## 3. 커버리지

- 유닛 2개 (coverage-ledger.json, 검증기 PASS):
  - `POST /api/auth/pin-login` — D1 게이트 선점 UPDATE + PBKDF2 verifyPin (candidate)
  - `POST /api/auth/pin-login` — 성공 초기화 UPDATE + fail_count 라이프사이클 (candidate)
- 헌터: run-002 재현 시나리오를 cf80259에 동일하게 돌리고 변경 코드에서 신규 결함을 탐색.
- 검증자 A: 대상 medium FIXED 독립 확인 (2회 실행 동일).
- 검증자 B: 신규 후보 `pin-gate-failure-leaves-lock` 독립 확인 (트리거 2종 + 구 로직 대조군).
- 검증자 C: `pin-failcount-no-decay` 재확인 + `pin-success-reset-erases-concurrent-failure` 현상 확인 (3회 반복).

## 4. finding이 아닌 관찰 (기록용)

- (없음 — `pin-success-reset-erases-concurrent-failure`는 informational finding으로 findings.json에 포함했다.)

## 5. 조정자가 직접 검증한 항목 (헌터 NOT TESTED 중 해소된 것)

- (없음 — 아래 NOT TESTED 항목은 그대로 남는다.)

## 6. NOT TESTED

- 실제 Cloudflare Workers/D1 환경에서의 동작 (로컬 하네스만 수행).
- fail_count NULL 행 (마이그레이션 0045 적용 전 행)에서의 게이트 동작.
- KV 폴백 동시 버스트 (0045 미적용 환경).
- 동시 요청 버스트 하에서의 게이트 경합은 검증자 A가 확인했으나, 실제 D1 동시성은 미확인.
- run-002 나머지 7건의 재검증 (소스 변경 없음 — §1 참조).

## 7. 다음 단계

1. **신규 low `auth/pin-gate-failure-leaves-lock` 수정 여부 결정** — 권장: try/catch + 보상 UPDATE + salt 사전 검증. no-decay 수정과 함께 적용하면 잠금 고착 경로가 구조적으로 줄어든다.
2. **잔존 low `auth/pin-failcount-no-decay` 수정 여부 결정** — run-002 remediation 그대로 (실패 UPDATE 안에서 만료된 잠금 뒤 fail_count 재시작).
3. 수정 시 run-004 재감사 (스코프: 인증 모듈, 대상 finding 재검증 중심).
4. 운영 배포 시 마이그레이션 0045 적용 확인 필수 (0045 미적용 시 run-001 medium 부활 — 배포 게이트).
