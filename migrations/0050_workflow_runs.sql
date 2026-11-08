-- 0050: 워크플로 엔진 실행 기록 (n8n 패턴 이식 — 트랙 8 전용 번호)
--
-- n8n의 실행(execution) 개념을 최소 형태로 가져온다: 트리거로 시작한 한 번의
-- 워크플로 실행(run)과 그 안의 노드별 단계(step)를 D1에 기록한다.
-- - workflow_runs: 실행 단위. idempotency_key UNIQUE로 중복 실행 방지.
--   같은 키로 완료/실패한 실행이 있으면 재실행하지 않고 저장된 출력을 돌려준다.
--   'running' 상태로 15분 넘게 남은 행은 중단된 실행으로 보고 재실행을 허용한다.
-- - workflow_run_steps: 노드별 시도 기록 (재시도 횟수·에러 포함).
--
-- 주의: 이 테이블이 없어도 엔진은 동작한다 (기록은 best-effort로 건너뜀).
-- reminders.dedupe_key 선점이 일정 알림의 1차 중복 방지이며, 이 테이블은
-- 2차 멱등성 + 관측용이다. 운영 적용 전 Time Travel bookmark 확보 등
-- 운영 D1 안전 규칙을 따를 것 (사용자 승인 필요 — 코드만으로 적용되지 않음).

CREATE TABLE IF NOT EXISTS workflow_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  trigger_type TEXT NOT NULL DEFAULT 'manual', -- cron / event / manual
  status TEXT NOT NULL DEFAULT 'running',     -- running / completed / failed
  input_json TEXT,
  output_json TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id, started_at);

CREATE TABLE IF NOT EXISTS workflow_run_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL, -- completed / failed / skipped
  attempt INTEGER NOT NULL DEFAULT 1,
  input_json TEXT,
  output_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_run ON workflow_run_steps(run_id, id);
