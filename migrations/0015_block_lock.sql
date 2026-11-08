-- 블록 잠금: 메모 내 특정 텍스트 블록 잠금
-- locked_ranges를 JSON으로 memos 테이블에 저장
ALTER TABLE memos ADD COLUMN locked_blocks TEXT DEFAULT '[]';
