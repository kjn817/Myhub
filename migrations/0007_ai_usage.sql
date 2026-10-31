-- AI 호출 원장 (정확한 사용량 추적용 — KV 카운터 대신 D1 사용)
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,          -- gemini | groq | workers-ai
  model TEXT NOT NULL,
  capability TEXT NOT NULL,        -- summarize | search | chat | ...
  latency_ms INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  outcome TEXT NOT NULL,           -- success | rate_limited | failed
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_date ON ai_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_provider ON ai_usage(provider, created_at);
