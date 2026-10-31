-- Phase 4C-2: ai_memory_v2 FTS5 검색
-- is_active=1인 기억만 인덱싱

CREATE VIRTUAL TABLE IF NOT EXISTS ai_memory_fts USING fts5(
  content,
  content='ai_memory_v2',
  content_rowid='id'
);

-- INSERT: 활성 기억만 인덱싱
DROP TRIGGER IF EXISTS memory_fts_ai;
CREATE TRIGGER memory_fts_ai AFTER INSERT ON ai_memory_v2
WHEN new.is_active = 1
BEGIN
  INSERT INTO ai_memory_fts(rowid, content) VALUES (new.id, new.content);
END;

-- DELETE: 활성 기억이었을 때만 삭제
DROP TRIGGER IF EXISTS memory_fts_ad;
CREATE TRIGGER memory_fts_ad AFTER DELETE ON ai_memory_v2
WHEN old.is_active = 1
BEGIN
  INSERT INTO ai_memory_fts(ai_memory_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

-- UPDATE: OLD 활성→삭제, NEW 활성→삽입
DROP TRIGGER IF EXISTS memory_fts_au;
CREATE TRIGGER memory_fts_au AFTER UPDATE ON ai_memory_v2
BEGIN
  INSERT INTO ai_memory_fts(ai_memory_fts, rowid, content)
  SELECT 'delete', old.id, old.content
  WHERE old.is_active = 1;

  INSERT INTO ai_memory_fts(rowid, content)
  SELECT new.id, new.content
  WHERE new.is_active = 1;
END;

-- 기존 활성 기억 재인덱싱
INSERT INTO ai_memory_fts(ai_memory_fts) VALUES ('delete-all');
INSERT INTO ai_memory_fts(rowid, content)
SELECT id, content FROM ai_memory_v2 WHERE is_active = 1;
