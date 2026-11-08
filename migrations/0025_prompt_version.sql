-- Phase 3D: 프롬프트 버전 기록 (D5)
-- 새 프롬프트가 적용된 답변에만 실제 버전을 연결.
-- 미적용 답변을 persona-v1으로 잘못 기록하지 않도록 기본값은 'legacy'.
ALTER TABLE ai_chats ADD COLUMN prompt_version TEXT NOT NULL DEFAULT 'legacy';
CREATE INDEX IF NOT EXISTS idx_ai_chats_prompt_version ON ai_chats(prompt_version);
