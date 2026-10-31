-- 0051: 인증 원자 카운터 D1 이전 (run-002 low 3건 + run-003 low 1건 관련)
--
-- 배경: KV read-modify-write는 동시 요청에 원자성이 없어 아래 결함이 생긴다.
--   - auth/sessver-fail-open: KV 읽기 실패 시 버전 0으로 fail-open
--   - auth/sessver-bump-race: 동시 /set-pin 시 bump이 하나로 합쳐져 구 세션 잔존
--   - auth/rate-limit-kv-race: checkRateLimit의 모든 버킷이 동시 버스트에 무력화
-- 이 마이그레이션은 두 카운터를 D1 원자 UPDATE로 옮기는 기반이다.
--   - session_versions: getSessionVersion/bumpSessionVersion이 KV 대신 읽고 쓴다.
--     UPDATE ... RETURNING version 한 문장으로 bump을 원자화한다.
--   - rate_limits: checkRateLimit이 INSERT ... ON CONFLICT DO UPDATE 한 문장으로
--     선점·증가·상한 판정을 합친다. 윈도우 만료 시 카운터를 1로 재시작한다.
--
-- 배포 게이트 (0045와 동일): 0051 미적용 환경에서는 세션 버전 조회가 실패해
-- 모든 인증 세션이 거부된다(fail-closed). 코드 배포 전에 반드시 0051을 먼저 적용할 것.
-- 절체(cutover): 배포 전 KV `sessver:{email}`의 현재 값을 session_versions에
-- 시드하면 기존 30일 세션이 유지된다. 시드하지 않으면 기존 세션은 무효가 되고
-- 사용자는 OTP로 다시 로그인해야 한다 (PIN 자체는 그대로 유효).
-- rate_limits는 휘발성(TTL 윈도우) 카운터라 시드가 필요 없다.
CREATE TABLE IF NOT EXISTS session_versions (
  email TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_expiry ON rate_limits(window_expires_at);
