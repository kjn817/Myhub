-- ai_usage에 run_id, call_index 컬럼 추가 (Phase 1G-A)
-- capability 필드의 기존 의미를 유지하기 위함

ALTER TABLE ai_usage ADD COLUMN run_id TEXT;
ALTER TABLE ai_usage ADD COLUMN call_index INTEGER;

CREATE INDEX IF NOT EXISTS idx_ai_usage_run ON ai_usage(run_id);
