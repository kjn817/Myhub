-- Phase 4B-2R: FTS5 개인정보 보호
-- 잠금·restricted 메모를 FTS 인덱스에서 제외
--
-- 핵심: DELETE는 OLD가 인덱싱 대상이었을 때만 실행
-- (존재하지 않는 항목에 delete 실행 시 malformed 오류 발생)

-- 기존 트리거 삭제
DROP TRIGGER IF EXISTS memos_fts_ai;
DROP TRIGGER IF EXISTS memos_fts_ad;
DROP TRIGGER IF EXISTS memos_fts_au;
DROP TRIGGER IF EXISTS memos_fts_au_insert;

-- INSERT: NEW가 공개일 때만 인덱싱
CREATE TRIGGER memos_fts_ai AFTER INSERT ON memos
WHEN new.is_locked = 0 AND new.sensitivity < 2
BEGIN
  INSERT INTO memos_fts(rowid, text) VALUES (new.id, new.text);
END;

-- DELETE: OLD가 공개였을 때만 삭제
CREATE TRIGGER memos_fts_ad AFTER DELETE ON memos
WHEN old.is_locked = 0 AND old.sensitivity < 2
BEGIN
  INSERT INTO memos_fts(memos_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

-- UPDATE: OLD 공개→삭제, NEW 공개→삽입 (각각 조건 확인)
CREATE TRIGGER memos_fts_au AFTER UPDATE ON memos
BEGIN
  INSERT INTO memos_fts(memos_fts, rowid, text)
  SELECT 'delete', old.id, old.text
  WHERE old.is_locked = 0 AND old.sensitivity < 2;

  INSERT INTO memos_fts(rowid, text)
  SELECT new.id, new.text
  WHERE new.is_locked = 0 AND new.sensitivity < 2;
END;

-- 기존 인덱스 정리: delete-all 후 공개 메모만 재인덱싱
-- (rebuild는 전체 원본을 인덱싱하므로 사용 금지)
INSERT INTO memos_fts(memos_fts) VALUES ('delete-all');

INSERT INTO memos_fts(rowid, text)
SELECT id, text FROM memos
WHERE is_locked = 0 AND sensitivity < 2;
