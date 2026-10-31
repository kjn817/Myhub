-- AI 대화 기록 (비서별)
CREATE TABLE IF NOT EXISTS ai_chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id TEXT NOT NULL,
  role TEXT NOT NULL,              -- user | assistant
  content TEXT NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_chats_persona ON ai_chats(persona_id, id);
