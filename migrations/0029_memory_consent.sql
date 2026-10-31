-- Phase 4C-3: v2 기억 활용 동의 정책
-- 저장 동의와 AI 활용/전송 동의를 분리

ALTER TABLE ai_memory_v2 ADD COLUMN allow_ai_use INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_memory_v2 ADD COLUMN allow_provider_send INTEGER NOT NULL DEFAULT 0;

-- 기존 기억은 저장 동의만 있고 AI 활용/전송은 비활성화 (안전 기본값)
-- 사용자가 명시적으로 허용해야 활성화됨
