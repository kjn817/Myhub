-- 0004: 태그 테이블 (본문의 #태그를 별도 저장해 정확히 필터/집계)
CREATE TABLE IF NOT EXISTS memo_tags (
  memo_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (memo_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_memo_tags_tag ON memo_tags(tag);
