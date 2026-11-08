-- 할일(Todo) 드래그 정렬: 수동 순서 저장
-- 새 할일은 목록 맨 위에 추가되도록 sort_order = MIN - 1 로 시작

ALTER TABLE todos ADD COLUMN sort_order INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_todos_sort ON todos(status, sort_order);
