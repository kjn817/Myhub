-- Phase 3C: AI 답변 피드백
-- 운영 D1에는 적용하지 않음

CREATE TABLE IF NOT EXISTS ai_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  message_id INTEGER NOT NULL REFERENCES ai_chats(id) ON DELETE CASCADE,
  value TEXT NOT NULL CHECK (value IN ('like', 'dislike')),
  reason_code TEXT CHECK (reason_code IN ('inaccurate', 'irrelevant', 'too_long', 'too_short', 'wrong_action', 'other')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- 사용자당 메시지당 하나의 활성 피드백
  UNIQUE(user_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_feedback_message ON ai_feedback(message_id);
CREATE INDEX IF NOT EXISTS idx_ai_feedback_user ON ai_feedback(user_id);
-- 비서별 집계용 (ai_chats 조인)
CREATE INDEX IF NOT EXISTS idx_ai_feedback_created ON ai_feedback(created_at);
