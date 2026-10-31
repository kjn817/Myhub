-- 스케줄(일정) 모듈
-- Phase 3: 일정 CRUD + 리마인더

CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  location TEXT DEFAULT '',
  start_at TEXT NOT NULL,       -- ISO8601 (예: 2026-10-10T09:00:00)
  end_at TEXT,                  -- ISO8601, nullable
  timezone TEXT DEFAULT 'Asia/Seoul',
  recurrence_rule TEXT,         -- RRULE 형식 문자열, nullable (예: FREQ=WEEKLY;BYDAY=MO)
  status TEXT DEFAULT 'active',  -- active / cancelled / done
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_schedules_start ON schedules(start_at);
CREATE INDEX IF NOT EXISTS idx_schedules_status ON schedules(status);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  remind_at TEXT NOT NULL,       -- ISO8601, 알림 발송 예정 시각
  status TEXT DEFAULT 'pending', -- pending / sent / failed / cancelled
  sent_at TEXT,
  dedupe_key TEXT UNIQUE        -- schedule_id + occurrence + offset 기반 중복 방지
);

CREATE INDEX IF NOT EXISTS idx_reminders_remind ON reminders(remind_at, status);
