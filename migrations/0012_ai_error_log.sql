-- AI 에러 로그 (디버깅용)
CREATE TABLE IF NOT EXISTS ai_error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  capability TEXT,
  error TEXT,
  http_status INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_error_log_created ON ai_error_log(created_at);
