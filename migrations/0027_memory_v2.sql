-- Phase 4C-1: 사용자 동의 기반 장기 기억 (ai_memory_v2)
-- 기존 ai_memory와 별도 테이블 (기존 기능 유지)

CREATE TABLE IF NOT EXISTS ai_memory_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  created_by TEXT NOT NULL DEFAULT 'user',
  source_type TEXT,
  source_id INTEGER,
  consent_type TEXT NOT NULL DEFAULT 'explicit',
  consent_detail TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_active INTEGER NOT NULL DEFAULT 1,
  deleted_at DATETIME,
  CHECK (length(content) > 0 AND length(content) <= 5000),
  CHECK (created_by IN ('user', 'assistant')),
  CHECK (is_active IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_memory_v2_active ON ai_memory_v2(is_active, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_v2_category ON ai_memory_v2(category, is_active);
