-- 아티팩트 백그라운드 작업 큐
CREATE TABLE IF NOT EXISTS artifact_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id INTEGER REFERENCES artifacts(id),
  kind TEXT NOT NULL DEFAULT 'create', -- create, modify
  status TEXT NOT NULL DEFAULT 'pending', -- pending, running, done, failed
  prompt TEXT NOT NULL,
  base_html TEXT,
  result_html TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_artifact_jobs_status ON artifact_jobs(status, created_at);

-- seen 컬럼 추가 (사용자가 확인했는지)
ALTER TABLE artifact_jobs ADD COLUMN seen INTEGER NOT NULL DEFAULT 0;

-- Lease 메커니즘 (중복 실행 방지)
ALTER TABLE artifact_jobs ADD COLUMN lease_token TEXT;
ALTER TABLE artifact_jobs ADD COLUMN lease_expires TEXT;
