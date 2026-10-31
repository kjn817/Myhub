-- Phase 1: 메모 잠금 + 민감도 등급
-- is_locked: 0=잠금해제(AI 접근 가능), 1=잠금(AI 접근 불가)
-- sensitivity: 0=일반, 1=내부, 2=기밀, 3=비밀정보(API키/비밀번호 등)

ALTER TABLE memos ADD COLUMN is_locked INTEGER DEFAULT 0;
ALTER TABLE memos ADD COLUMN sensitivity INTEGER DEFAULT 1;

-- 첨부파일 잠금
ALTER TABLE files ADD COLUMN is_locked INTEGER DEFAULT 0;
