-- 0045: PIN 실패 카운터의 D1 원자화 (run-001 medium auth/pin-lockout-kv-race 수정)
-- 문제: PIN 실패 잠금이 KV read-modify-write 카운터(pinfail:{email})라
-- 동시 실패 버스트에서 카운터가 1씩만 증가해 5회/15분 잠금이 우회됐다.
-- 수정: 카운터를 auth_pins 행의 fail_count/locked_until로 이동하고,
-- 실패 시 `UPDATE ... SET fail_count = fail_count + 1` 단일 원자 UPDATE로 갱신한다.
-- 5회 도달 시 같은 UPDATE의 CASE 식으로 locked_until을 +15분으로 설정한다.
-- (D1 단일 UPDATE는 원자적이므로 동시 실패도 전부 카운트된다.)
-- fail_count/locked_until은 추가형 컬럼이라 기존 행·PIN 해시에 영향이 없다.
-- locked_until 형식: ISO 8601 UTC (strftime '%Y-%m-%dT%H:%M:%fZ').
ALTER TABLE auth_pins ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auth_pins ADD COLUMN locked_until TEXT;
