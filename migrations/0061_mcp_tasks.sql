-- 0061: MCP Tasks 확장용 태스크 저장소 (POC)
--
-- Tasks 확장(io.modelcontextprotocol/tasks, 2026-07-28)의 태스크 핸들은
-- 응답 전에 durable하게 저장해야 한다 (스펙 요구). Stateless Worker라
-- 태스크 상태는 D1에 둔다. KV가 아니라 D1인 이유: 태스크는 사용자별
-- 소유권(email) 조회 + 상태 전이(working -> completed/cancelled)를
-- 조건부 UPDATE로 원자적으로 해야 해서 SQL이 맞다.
--
-- POC 범위: input_required 상태는 없다 (브리핑은 추가 입력이 필요 없는
-- 읽기 작업). tasks/update는 항상 -32602(입력 대기 아님)로 답한다.
-- 완료는 첫 tasks/get 폴링 시점에 계산한다 (지연 완료 — 운영 도입 시
-- Queue/Cron으로 실제 비동기 실행을 붙이는 것이 전제 조건, 문서 참조).
CREATE TABLE IF NOT EXISTS mcp_tasks (
  task_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  tool TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('working', 'input_required', 'completed', 'failed', 'cancelled')),
  params_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error_json TEXT,
  status_message TEXT,
  ttl_ms INTEGER NOT NULL DEFAULT 600000,
  poll_interval_ms INTEGER NOT NULL DEFAULT 500,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_tasks_email_created
  ON mcp_tasks (email, created_at DESC);
