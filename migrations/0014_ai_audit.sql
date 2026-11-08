-- AI 메모 접근 감사 로그
CREATE TABLE IF NOT EXISTS ai_memo_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,  -- memo_search, memo_read
  actor TEXT NOT NULL,        -- persona id (lumi, echo, nova)
  resource_id INTEGER,        -- memo id (있을 경우)
  tool_name TEXT NOT NULL,    -- MEMO_SEARCH, MEMO_GET
  model_provider TEXT,        -- google, groq, workers-ai
  policy_decision TEXT NOT NULL, -- allowed, denied
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON ai_memo_audit(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON ai_memo_audit(actor);
