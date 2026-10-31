-- 장기 메모리 테이블
CREATE TABLE IF NOT EXISTS ai_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL, -- 'fact', 'preference', 'project', 'summary'
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_memory_category ON ai_memory(category);
CREATE INDEX IF NOT EXISTS idx_ai_memory_key ON ai_memory(key);
