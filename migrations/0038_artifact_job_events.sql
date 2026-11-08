-- Codex 스타일 이벤트 스트리밍을 위한 Job 이벤트 테이블
-- Thread/Turn/Item 패턴: job.started → tool.started → file.changed → version.committed
CREATE TABLE IF NOT EXISTS artifact_job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES artifact_jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL, -- job.started, job.completed, job.failed, tool.started, tool.completed, file.changed, version.committed
  payload TEXT, -- JSON: {file_path, tool_name, version_no, message 등}
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_job_events_job ON artifact_job_events(job_id, id);
