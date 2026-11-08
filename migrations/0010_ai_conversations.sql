-- 대화방 (채팅 세션) 테이블
CREATE TABLE IF NOT EXISTS ai_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '새 대화',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 기존 ai_chats에 conversation_id 컬럼 추가
ALTER TABLE ai_chats ADD COLUMN conversation_id INTEGER REFERENCES ai_conversations(id);

-- 기본 대화방 생성 (기존 메시지용)
INSERT INTO ai_conversations (title, created_at, updated_at)
VALUES ('AI 비서방', datetime('now'), datetime('now'));

-- 기존 메시지를 기본 대화방에 연결
UPDATE ai_chats SET conversation_id = 1 WHERE conversation_id IS NULL;
