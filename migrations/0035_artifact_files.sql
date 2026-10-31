-- 0035: 다중 파일 프로젝트 지원 (AI 스튜디오 Codex급)
-- 각 버전마다 여러 파일을 저장할 수 있도록 함

CREATE TABLE IF NOT EXISTS artifact_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,  -- 예: 'index.html', 'style.css', 'app.js'
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (version_id, file_path),
  FOREIGN KEY (version_id) REFERENCES artifact_versions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_artifact_files_version ON artifact_files(version_id);

-- artifacts 테이블에 프로젝트 타입 추가
-- 'single': 단일 HTML 파일 (기존 방식)
-- 'multi': 다중 파일 프로젝트
ALTER TABLE artifacts ADD COLUMN project_type TEXT NOT NULL DEFAULT 'single';
