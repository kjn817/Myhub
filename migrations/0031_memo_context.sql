-- 65차: 메모 대화 문맥 저장소
-- "방금 만든 메모", "그 메모" 같은 문맥 참조를 위한 최근 작업 ID 저장
-- Workers는 여러 isolate에서 실행되므로 메모리 상태가 아닌 D1에 저장

CREATE TABLE IF NOT EXISTS memo_conversation_context (
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,

  last_created_memo_id INTEGER,
  last_target_memo_id INTEGER,
  last_search_result_ids TEXT,

  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,

  PRIMARY KEY (user_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_memo_ctx_expires ON memo_conversation_context(expires_at);
