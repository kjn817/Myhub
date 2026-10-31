-- 0034: 아티팩트 버전 관리 (MyHub OS 1단계)
-- GPT 91차 설계: A안 (별도 버전 테이블) + 게시 포인터

-- 버전 테이블 (불변 스냅샷)
CREATE TABLE IF NOT EXISTS artifact_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL,
  parent_version_id INTEGER,
  html_content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  manifest_json TEXT NOT NULL DEFAULT '{}',
  change_note TEXT,
  source_type TEXT NOT NULL DEFAULT 'nova',
  source_ref TEXT,
  created_by TEXT NOT NULL DEFAULT 'nova',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (artifact_id, version_no),
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT,
  FOREIGN KEY (parent_version_id) REFERENCES artifact_versions(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_artifact_versions_history ON artifact_versions(artifact_id, version_no DESC);

-- artifacts 테이블에 버전 포인터 추가
ALTER TABLE artifacts ADD COLUMN draft_version_id INTEGER REFERENCES artifact_versions(id) ON DELETE SET NULL;
ALTER TABLE artifacts ADD COLUMN published_version_id INTEGER REFERENCES artifact_versions(id) ON DELETE SET NULL;
ALTER TABLE artifacts ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE artifacts ADD COLUMN icon_key TEXT NOT NULL DEFAULT 'default';
ALTER TABLE artifacts ADD COLUMN row_revision INTEGER NOT NULL DEFAULT 1;
