-- 0049: agent-framework 패턴 — 코디네이터·핸드오프·체크포인팅 (트랙 7 전용)
--
-- microsoft/agent-framework(HandoffBuilder + CheckpointStorage) 패턴만 참고해
-- MyHub 오케스트레이션에 맞게 D1 기반으로 구현한다.
--
-- 역할 분리 (0044 memory_handoffs와 중복 아님):
-- - memory_handoffs: 소유권 있는 1회 수령 (claim-once) — 기억 페이로드 인계용.
-- - agent_handoffs: 형식 있는 핸드오프 기록 (요청·맥락·제약·기대 출력) — 코디네이터가
--   비서 간 인계 시 남기는 감사 추적용. 수령 토큰이 없고, 상태 전이(pending →
--   accepted/completed/rejected)로 해결한다. 필요 시 memory_handoff_id로
--   claim-once 인계와 연결한다 (소유권 로직은 memory-service에 그대로 둔다).
-- - agent_runs / agent_run_checkpoints: 다단계 실행(run)의 상태 스냅샷.
--   체크포인트는 노드(단계) 경계마다 저장하고, 중단된 실행은 마지막 완료 단계
--   다음부터 이어서 재개한다 (재실행이 아닌 이어하기 — 이미 완료한 단계는
--   다시 실행하지 않는다).
--
-- 주의: 잠긴 메모는 모든 외부 AI 전송 경로에서 제외된다. 체크포인트 state는
-- 실행자가 넘긴 단계 결과만 저장하며, 잠긴 메모 내용을 state에 넣지 말 것
-- (서비스 계층에서 잠긴 메모를 state로 전달하는 호출은 만들지 않는다).
-- 운영 적용 전 Time Travel bookmark 확보 등 운영 D1 안전 규칙을 따를 것.

-- ---------- 1) 다단계 실행 ----------
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  user_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  current_step INTEGER NOT NULL DEFAULT 0,
  total_steps INTEGER NOT NULL,
  plan_json TEXT NOT NULL DEFAULT '{"steps":[]}',
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CHECK (status IN ('running', 'paused', 'completed', 'failed', 'cancelled')),
  CHECK (total_steps > 0),
  CHECK (current_step >= 0 AND current_step <= total_steps)
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation ON agent_runs(conversation_id, created_at DESC);

-- ---------- 2) 단계별 체크포인트 ----------
CREATE TABLE IF NOT EXISTS agent_run_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  step_index INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  persona TEXT NOT NULL,
  state_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (run_id, step_index),
  CHECK (step_index >= 0),
  CHECK (length(step_name) > 0)
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_run ON agent_run_checkpoints(run_id, step_index DESC);

-- ---------- 3) 형식 있는 코디네이터 핸드오프 기록 ----------
CREATE TABLE IF NOT EXISTS agent_handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT REFERENCES agent_runs(id),
  memory_handoff_id INTEGER REFERENCES memory_handoffs(id),
  from_persona TEXT NOT NULL,
  to_persona TEXT NOT NULL,
  request TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '[]',
  constraints_json TEXT NOT NULL DEFAULT '[]',
  expected_output TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME,
  CHECK (status IN ('pending', 'accepted', 'completed', 'rejected')),
  CHECK (from_persona <> to_persona),
  CHECK (length(request) > 0)
);

CREATE INDEX IF NOT EXISTS idx_agent_handoffs_run ON agent_handoffs(run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_handoffs_to ON agent_handoffs(to_persona, status);
