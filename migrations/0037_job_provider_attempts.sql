-- P0-7/8: D1 외부 호출 원장 (GPT 96차)
-- 한 작업당 외부 AI 호출 1회를 원자적으로 보장

CREATE TABLE job_provider_attempts (
    provider_attempt_id TEXT PRIMARY KEY,
    job_id INTEGER NOT NULL,
    workflow_instance_id TEXT,
    attempt_no INTEGER NOT NULL CHECK (attempt_no = 1),
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    key_slot INTEGER,
    state TEXT NOT NULL CHECK (state IN (
        'reserved',
        'dispatching',
        'completed',
        'failed',
        'unknown_outcome'
    )),
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    dispatch_started_at TEXT,
    finished_at TEXT,
    http_status INTEGER,
    classified_error TEXT,
    upstream_request_id TEXT,
    elapsed_ms INTEGER,
    error_detail TEXT,
    FOREIGN KEY (job_id) REFERENCES artifact_jobs(id),
    UNIQUE (job_id)
);

CREATE INDEX idx_job_provider_attempts_started
ON job_provider_attempts(started_at);

CREATE INDEX idx_job_provider_attempts_model
ON job_provider_attempts(provider, model, state);
