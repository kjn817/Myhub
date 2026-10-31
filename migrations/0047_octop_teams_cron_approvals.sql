-- 0047: Octop 패턴 이식 (트랙 4) — 자연어 cron 작업 + 도구 승인 기록
--
-- 1) user_cron_jobs: "매일 아침 8시에 브리핑해줘" 같은 한국어 자연어 시간 표현을
--    결정적 파서(nl-cron.ts)로 변환해 저장한다. 시각은 KST wall-clock 기준이며,
--    next_run_at은 UTC instant ISO 문자열로 저장한다 (사전식 비교 가능).
--    Cloudflare Cron Trigger는 UTC 전용이라, 실행 판정은 5분 틱 scheduled
--    핸들러가 KST로 수행한다 (기존 scheduled.ts의 '-9 hours' 보정과 같은 방식).
-- 2) tool_approvals: 파괴적 도구(MEMO/SCHEDULE/TODO/ARTIFACT 삭제)의 승인 기록.
--    승인은 "도구+대상" 단위(scope_key, 예: MEMO_DELETE:123)이며, 만료 판정은
--    JS에서 수행한다 (D1 datetime('now')와 ISO 문자열의 사전식 비교 회피).
--
-- 주의: 추가형 변경만 포함한다. 기존 테이블은 손대지 않는다.
-- 운영 적용 전 Time Travel bookmark 확보 등 운영 D1 안전 규칙을 따를 것.

-- ---------- 1) 자연어 cron 작업 ----------
CREATE TABLE IF NOT EXISTS user_cron_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  nl_text TEXT NOT NULL,
  cron_kst TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Seoul',
  next_run_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_cron_jobs_due
  ON user_cron_jobs (enabled, next_run_at);

-- ---------- 2) 도구 승인 기록 ----------
CREATE TABLE IF NOT EXISTS tool_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'denied')),
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (persona_id, tool, scope_key)
);

CREATE INDEX IF NOT EXISTS idx_tool_approvals_scope
  ON tool_approvals (persona_id, tool, scope_key);
