-- 0002: 파일 메타데이터 + 메모 전문검색(FTS5)

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memo_id INTEGER NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  mime TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (memo_id) REFERENCES memos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_files_memo_id ON files(memo_id);

-- 메모 전문검색용 FTS5 가상 테이블 (기본 토크나이저: 한국어 단어 단위 검색에 적합)
-- 2글자 이하 짧은 검색어는 앱에서 LIKE 폴백으로 처리
CREATE VIRTUAL TABLE IF NOT EXISTS memos_fts USING fts5(
  text,
  content='memos',
  content_rowid='id'
);

-- memos 변경 시 FTS 인덱스 자동 동기화
CREATE TRIGGER IF NOT EXISTS memos_fts_ai AFTER INSERT ON memos BEGIN
  INSERT INTO memos_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS memos_fts_ad AFTER DELETE ON memos BEGIN
  INSERT INTO memos_fts(memos_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS memos_fts_au AFTER UPDATE ON memos BEGIN
  INSERT INTO memos_fts(memos_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO memos_fts(rowid, text) VALUES (new.id, new.text);
END;

-- 기존 메모 backfill
INSERT INTO memos_fts(rowid, text)
SELECT id, text FROM memos WHERE id NOT IN (SELECT rowid FROM memos_fts);
