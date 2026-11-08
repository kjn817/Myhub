-- AI 도구 실행 원장 (Phase 1E)
-- 쓰기 작업의 멱등성, 상태 관리, 복구를 위한 테이블
-- 비파괴적, 재실행 가능

CREATE TABLE IF NOT EXISTS ai_tool_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending / in_progress / succeeded / failed / unknown
  result_ref TEXT,                          -- 실제 생성된 데이터의 참조 (예: todo:123)
  error_code TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  UNIQUE(user_id, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_tool_ops_user ON ai_tool_operations(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_tool_ops_status ON ai_tool_operations(status);
CREATE INDEX IF NOT EXISTS idx_ai_tool_ops_request ON ai_tool_operations(request_id);
