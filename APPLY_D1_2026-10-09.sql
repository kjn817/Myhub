-- ============================================================
-- MyHub D1 일괄 적용 스크립트 (2026-10-09)
-- 사용법: Cloudflare 대시보드 → D1 → myhub-db → 콘솔에
--         이 파일 전체를 복사해서 붙여넣고 실행 (한 번에 끝)
-- 원본: migrations/0013_memo_lock.sql, 0014_ai_audit.sql,
--       0014_schedules.sql, 0015_block_lock.sql, 0016_todos.sql
-- 주의: 재실행 시 ALTER TABLE 3줄에서
--       "duplicate column name" 오류가 나면 무시해도 됨 (이미 적용된 것)
--       CREATE TABLE/INDEX는 IF NOT EXISTS라 안전하게 재실행 가능
-- ============================================================

-- ---------- 1) 메모 잠금 + 민감도 등급 (0013) ----------
-- is_locked: 0=잠금해제(AI 접근 가능), 1=잠금(AI 접근 불가)
-- sensitivity: 0=일반, 1=내부, 2=기밀, 3=비밀정보(API키/비밀번호 등)
ALTER TABLE memos ADD COLUMN is_locked INTEGER DEFAULT 0;
ALTER TABLE memos ADD COLUMN sensitivity INTEGER DEFAULT 1;
ALTER TABLE files ADD COLUMN is_locked INTEGER DEFAULT 0;

-- ---------- 2) AI 메모 접근 감사 로그 (0014_ai_audit) ----------
CREATE TABLE IF NOT EXISTS ai_memo_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  resource_id INTEGER,
  tool_name TEXT NOT NULL,
  model_provider TEXT,
  policy_decision TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON ai_memo_audit(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON ai_memo_audit(actor);

-- ---------- 3) 스케줄(일정) 모듈 (0014_schedules) ----------
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  location TEXT DEFAULT '',
  start_at TEXT NOT NULL,
  end_at TEXT,
  timezone TEXT DEFAULT 'Asia/Seoul',
  recurrence_rule TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_schedules_start ON schedules(start_at);
CREATE INDEX IF NOT EXISTS idx_schedules_status ON schedules(status);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  remind_at TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  sent_at TEXT,
  dedupe_key TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_reminders_remind ON reminders(remind_at, status);

-- ---------- 4) 블록 잠금 (0015) ----------
-- locked_blocks를 JSON으로 memos 테이블에 저장
ALTER TABLE memos ADD COLUMN locked_blocks TEXT DEFAULT '[]';

-- ---------- 5) 할일(Todo) 모듈 (0016) ----------
CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  due_at TEXT,
  priority INTEGER DEFAULT 1,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
CREATE INDEX IF NOT EXISTS idx_todos_due ON todos(due_at);
CREATE INDEX IF NOT EXISTS idx_todos_priority ON todos(priority);
