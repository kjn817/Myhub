-- 아티팩트별 노바 대화 기록
CREATE TABLE IF NOT EXISTS artifact_chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id INTEGER REFERENCES artifacts(id),
  session_key TEXT NOT NULL DEFAULT 'new',
  who TEXT NOT NULL, -- user, nova
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_artifact_chats_session ON artifact_chats(session_key, created_at);
CREATE INDEX IF NOT EXISTS idx_artifact_chats_artifact ON artifact_chats(artifact_id, created_at);
