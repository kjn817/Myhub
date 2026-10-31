-- 0033: 아티팩트 초안/게시 상태 분리 (GPT 검토 반영)
ALTER TABLE artifacts ADD COLUMN status TEXT NOT NULL DEFAULT 'published';
CREATE INDEX IF NOT EXISTS idx_artifacts_status ON artifacts(status);
