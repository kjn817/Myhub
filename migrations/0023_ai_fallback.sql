-- Phase 2B: Fallback 추적 컬럼 추가
-- 운영 D1에는 적용하지 않음 (스테이징 검증용)

ALTER TABLE ai_runs ADD COLUMN initial_provider TEXT;
ALTER TABLE ai_runs ADD COLUMN initial_model TEXT;
ALTER TABLE ai_runs ADD COLUMN final_provider TEXT;
ALTER TABLE ai_runs ADD COLUMN final_model TEXT;
ALTER TABLE ai_runs ADD COLUMN fallback_occurred INTEGER DEFAULT 0;
ALTER TABLE ai_runs ADD COLUMN fallback_count INTEGER DEFAULT 0;
ALTER TABLE ai_runs ADD COLUMN fallback_reason TEXT;
