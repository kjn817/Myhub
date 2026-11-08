# Findings Detail — run-003

## low — 결정적 재현 요약

### auth/pin-gate-failure-leaves-lock — 게이트 선점 이후 예외가 나면 선점한 실패·잠금이 그대로 남는다

- 트리거 (M): fail_count=4 + 정답 PIN + 초기화 UPDATE 실패 주입 → **500**, fail_count=5, locked_until 잔여 899,973ms. 직후 정답 재시도 → **429**, fail_count=5, 잠금 유지.
- 트리거 (R): pin_salt='!!!not-base64!!!' + 오답 PIN → **500** (stderr에 atob InvalidCharacterError 확인), fail_count 4→5, locked_until 잔여 899,999ms. 직후 정답 재시도 → **429**.
- 대조군 (M'): 구 로직(9914dc9: 검증→증가→조건부 초기화) + 동일 실패 주입 → 500이나 fail_count=4, locked_until=null 유지. 초기화 복구 후 재시도 → **200**, fail_count=0.
- 대조군 (R'): 구 로직 + 손상 salt + 오답 → 500, fail_count=4, locked_until=null 그대로.
- 베이스라인: 정답 PIN → 200, fail_count=0; 오답 → 401, fail_count=1, 미잠금.
- 복구 경로: 잠금은 15분 후 만료되고, set-pin(:615)도 fail_count=0·locked_until=NULL 초기화를 수행하므로 OTP→PIN 재발급으로 풀린다 (영구 고착 아님).
- 부수 관찰: (R) 상태에서 salt가 손상된 채로 재시도하면 매 시도마다 게이트가 locked_until을 +900초로 갱신하므로 salt를 고치지 않는 한 429가 사실상 계속 이어진다. 복구는 OTP→set-pin으로만 가능하다 (해당 경로는 salt를 통째로 교체한다).

### auth/pin-failcount-no-decay — fail_count가 절대 감소하지 않아 오답 1개로 15분 잠금을 무기한 재연장할 수 있다

- T1a: 오답 5회 → 전부 401, fail_count=5, locked_until≈현재+15분, 정답 PIN → 429. 만료 시뮬레이션 후 오답 1개 → 401, fail_count 5→6, locked_until 다시 미래, 정답 PIN → 429.
- T1b: 만료 직후 정답 PIN을 먼저 보내면 200, 카운터 0으로 초기화 (소유자 창 존재).
- run-002 재현과 동일하게 확인됨 (run-002: 두 번째 사이클 반복 → fail_count 7, 재잠금, 정답 PIN → 429. 잠금 중 OTP /request → 200, /verify → 200, /set-pin → 200 후 fail_count=0·locked_until=NULL, 재발급 PIN 로그인 → 200으로 복구 확인. KV 폴백 대조군: 카운터 소멸 후 오답 1개 → 401·카운터 1부터 재시작, 정답 PIN → 200).

## informational — 결정적 재현 요약

### auth/pin-success-reset-erases-concurrent-failure — 성공 시 무조건 초기화가 동시 오답의 선점분까지 함께 지운다

- 정답+오답 동시 전송 → 최종 fail_count=0 (검증자 C 3회 반복 확인, 헌터도 확인).
- 순차 대조군(오답→정답)도 최종 fail_count=0으로 동일.
- 공격자 이득 없음, 순차 실행과 최종 상태 동일 → 보안 결함이 아니라 관찰 기록.

## FIXED 확인 — 대상 medium 재현 결과

### auth/pin-lock-gate-stale-read — PIN 잠금 게이트가 SELECT 시점 값이라 동시 버스트가 5회 예산을 넘긴다

- run-002 (수정 전): 동시 10개 전부 401, fail_count=10.
- run-003 (cf80259, 헌터 + 검증자 A 독립 재현 2회 동일):
  - 동시 10개 → **401×5 + 429×5**, fail_count=5.
  - 동시 20개 → **401×5 + 429×15**.
  - 순차 대조군 동일, 동일 IP 버스트도 401×5.
  - 오답 후 정답 → **200**·fail_count=0.
- 판정: **FIXED**.
