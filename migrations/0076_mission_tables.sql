-- 0076: Mission Control + Mission Workspace 테이블
--
-- 재구축: 운영 스키마 역추정 (2026-11-07). 원문 복원이 아니라 운영 D1
-- (myhub-db)의 sqlite_master 실측 전문을 그대로 옮긴, 스키마 동등 SQL이다.
--
-- 확정된 사실 (~/memory/2026-11-06.md, 2026-11-06 운영 배포 완료):
-- - 테이블 4개 신설: missions, mission_attempts, mission_evaluations,
--   mission_workspace_artifacts.
-- - Mission Workspace는 Privacy Engine이 토큰화한 산출물만 저장하는 것이
--   계약이다. 서비스층까지가 계약 범위이며 채팅 배선은 의도적으로 없다.
-- - 게이트 jest 469스위트/8,447건 PASS와 함께 운영 배포됐다 (88650220).
--
-- 실측에서 확인한 구조적 특징:
-- - missions / mission_workspace_artifacts의 PK는 TEXT다 (sqlite_autoindex
--   존재로도 확인됨). missions.status에는 CHECK 제약이 있다.
-- - mission_attempts에는 UNIQUE (mission_id, step_key, attempt_no)가 있다.
-- - mission_evaluations.kind에는 CHECK ('step_eval', 'seed_audit')가 있고
--   mission_id는 nullable이다 (미션 이전 단계의 seed_audit 기록용).
-- - 인덱스 8개: missions 4개(conversation/run/status/trace),
--   mission_attempts 1개, mission_evaluations 2개, artifacts 1개.
--
-- 운영 D1에는 이미 적용된 상태다 (재적용 금지).

CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  trace_id TEXT,
  owner_persona TEXT,
  worker_persona TEXT,
  goal TEXT,
  context_refs_json TEXT,
  output_schema_json TEXT,
  allowed_tools_json TEXT,
  boundaries_json TEXT,
  done_conditions_json TEXT,
  verify_method TEXT,
  escalation_json TEXT,
  budget_json TEXT,
  max_privacy_level INTEGER,
  status TEXT NOT NULL DEFAULT 'ready'
    CHECK (status IN ('ready', 'running', 'paused', 'completed', 'failed', 'cancelled', 'escalated')),
  run_id TEXT,
  conversation_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE mission_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  output_hash TEXT,
  score REAL,
  reason_code TEXT,
  strategy TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (mission_id, step_key, attempt_no)
);

CREATE TABLE mission_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT,
  kind TEXT NOT NULL
    CHECK (kind IN ('step_eval', 'seed_audit')),
  generator_provider TEXT,
  evaluator_provider TEXT,
  verdict TEXT,
  score REAL,
  detail_codes_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE mission_workspace_artifacts (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref_type TEXT,
  ref_id TEXT,
  content_text TEXT,
  content_hash TEXT,
  level INTEGER NOT NULL DEFAULT 0,
  reason_codes_json TEXT,
  created_by_persona TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_missions_conversation ON missions (conversation_id, created_at DESC);

CREATE INDEX idx_missions_run ON missions (run_id);

CREATE INDEX idx_missions_status ON missions (status, updated_at DESC);

CREATE INDEX idx_missions_trace ON missions (trace_id);

CREATE INDEX idx_mission_attempts_mission
  ON mission_attempts (mission_id, step_key, attempt_no);

CREATE INDEX idx_mission_evaluations_kind
  ON mission_evaluations (kind, created_at DESC);

CREATE INDEX idx_mission_evaluations_mission
  ON mission_evaluations (mission_id, created_at DESC);

CREATE INDEX idx_mission_artifacts_mission
  ON mission_workspace_artifacts (mission_id, created_at DESC);
