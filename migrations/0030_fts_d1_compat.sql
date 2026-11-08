-- 0030: D1 FTS5 호환 — memos_fts를 content='memos' 외부 콘텐츠 테이블에서 일반 FTS5 테이블로 전환
--
-- 사유 (2026-10-13 운영 D1 직접 실측):
--   1) D1은 content='memos' 테이블을 CREATE 시 전체 자동 인덱싱함 (잠금 메모 포함) —
--      표준 SQLite FTS5와 다른 동작. 0026의 의도(잠금 제외 재인덱싱)가 달성되지 않음.
--   2) FTS5 특수 명령('delete-all', rowid 'delete')이 D1에서 SQLITE_ERROR / SQLITE_CORRUPT 유발.
--      0026 트리거의 'delete' 명령은 메모 UPDATE/DELETE 시 인덱스를 깨뜨릴 수 있음.
--   3) content= 테이블에 대한 DELETE도 CORRUPT 유발.
--   4) 일반 FTS5 테이블에서는 CREATE / INSERT / SELECT(MATCH) / DELETE ... WHERE rowid = ?
--      모두 정상 동작 확인 (스크래치 테이블 + 운영 재구성으로 검증).
--
-- 주의: DROP TABLE은 FTS 인덱스(파생 데이터)에만 적용. 원본 memos 테이블은 손대지 않음.
-- 적용된 0002/0026 파일은 수정하지 않고, 이 파일이 운영의 실제 최종 상태를 기록함.

DROP TRIGGER IF EXISTS memos_fts_ai;
DROP TRIGGER IF EXISTS memos_fts_ad;
DROP TRIGGER IF EXISTS memos_fts_au;
DROP TABLE IF EXISTS memos_fts;

CREATE VIRTUAL TABLE memos_fts USING fts5(text);

INSERT INTO memos_fts(rowid, text)
SELECT id, text FROM memos WHERE is_locked = 0 AND sensitivity < 2;

CREATE TRIGGER memos_fts_ai AFTER INSERT ON memos
WHEN new.is_locked = 0 AND new.sensitivity < 2
BEGIN
  INSERT INTO memos_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER memos_fts_ad AFTER DELETE ON memos
BEGIN
  DELETE FROM memos_fts WHERE rowid = old.id;
END;

CREATE TRIGGER memos_fts_au AFTER UPDATE ON memos
BEGIN
  DELETE FROM memos_fts WHERE rowid = old.id;
  INSERT INTO memos_fts(rowid, text)
  SELECT new.id, new.text
  WHERE new.is_locked = 0 AND new.sensitivity < 2;
END;
