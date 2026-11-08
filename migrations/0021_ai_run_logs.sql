-- AI 실행 로그 (Phase 1F)
-- 비파괴적, 재실행 가능

-- Run 단위 집계
CREATE TABLE IF NOT EXISTS ai_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  assistant_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',  -- running / completed / budget_exceeded / provider_error / tool_error / invalid_response / cancelled
  model_calls INTEGER DEFAULT 0,
  requested_tool_calls INTEGER DEFAULT 0,
  executed_tool_calls INTEGER DEFAULT 0,
  total_input_tokens INTEGER,
  total_output_tokens INTEGER,
  usage_source TEXT,  -- provider / estimated / unavailable / mixed
  elapsed_ms INTEGER,
  error_code TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_runs_user ON ai_runs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_runs_request ON ai_runs(request_id);
CREATE INDEX IF NOT EXISTS idx_ai_runs_run_id ON ai_runs(run_id);

-- 도구 실행 추적 (관측용, 멱등성 원장과 분리)
CREATE TABLE IF NOT EXISTS ai_tool_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  mode TEXT NOT NULL,  -- read / write
  status TEXT NOT NULL,  -- success / error / cached / blocked
  duration_ms INTEGER,
  error_code TEXT,
  cache_hit INTEGER DEFAULT 0,
  operation_id TEXT,  -- 쓰기 작업인 경우
  created_at TEXT DEFAULT (datetime('now')),

  UNIQUE(run_id, tool_call_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_tool_runs_run ON ai_tool_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_ai_tool_runs_tool ON ai_tool_runs(tool_name, created_at);
