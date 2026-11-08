-- 0005: 메모 목록/달력 속도 개선용 인덱스
CREATE INDEX IF NOT EXISTS idx_memos_created_at ON memos(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_memo_id_created ON files(memo_id, created_at DESC);
