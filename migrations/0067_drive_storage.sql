-- 0067: Drive 보관함 전용 저장소 (drive_folders / drive_files)
--
-- 배경: Finder를 "메모 첨부"가 아니라 독립 파일 보관함(Drive)으로 전환하면서,
-- 메모 files와 분리된 전용 테이블을 신설했다 (2026-11-02 운영 단독 적용 완료).
-- 파일 본문은 Cloudinary에 두고 storage_key·url로 참조한다. drive_files에는
-- updated_at을 두지 않는다 — 저장마다 교체되는 storage_key 자체를 버전
-- 표식으로 써서 낙관적 동시성(base_version 대조)에 쓴다 (2026-11-02 기록).
-- 삭제는 소프트 삭제(deleted_at)다.
--
-- 스키마 확정 (2026-11-07 재구축): 운영 D1(myhub-db)의 sqlite_master 실측으로
-- 컬럼·타입·제약·인덱스를 확정했다. 역추정 초안에서 달라진 점:
-- - parent_id / folder_id에 REFERENCES가 없다 (FK 없는 단순 INTEGER).
-- - created_at은 양쪽 모두 TEXT NOT NULL DEFAULT (datetime('now'))이며
--   drive_files에도 실재한다.
-- - drive_files.resource_type은 TEXT NOT NULL DEFAULT 'raw'다.
-- - 조회용 인덱스 2개(idx_drive_folders_parent, idx_drive_files_folder)가
--   함께 존재한다.
-- 운영 D1에는 이미 적용된 상태다 (재적용 금지).

CREATE TABLE IF NOT EXISTS drive_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS drive_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER,
  storage_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  url TEXT,
  resource_type TEXT NOT NULL DEFAULT 'raw',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_drive_folders_parent
  ON drive_folders(parent_id, deleted_at);

CREATE INDEX IF NOT EXISTS idx_drive_files_folder
  ON drive_files(folder_id, deleted_at);
