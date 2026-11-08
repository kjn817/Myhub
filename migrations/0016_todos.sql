-- 할일(Todo) 모듈
-- 간단한 체크리스트: 제목, 설명, 마감일, 우선순위, 상태

CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  due_at TEXT,                       -- ISO8601 (예: 2026-10-10T09:00), nullable
  priority INTEGER DEFAULT 1,        -- 0=낮음, 1=보통, 2=높음
  status TEXT DEFAULT 'pending',      -- pending / done
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
CREATE INDEX IF NOT EXISTS idx_todos_due ON todos(due_at);
CREATE INDEX IF NOT EXISTS idx_todos_priority ON todos(priority);
