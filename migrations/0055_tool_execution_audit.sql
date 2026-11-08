-- 0055: 샌드박스 격리 감사 로그 (진짜 비서 3단계 i트랙 — dry-run + 승인)
--
-- tool_approvals(0047)는 승인·거부 "결정"의 감사 기록,
-- tool_approval_requests(0052)는 대기 중인 "승인 요청"이다.
-- 이 테이블은 dry-run 미리보기를 보여준 순간부터 승인 후 실제 실행까지,
-- 샌드박스 격리 흐름 전체의 "실행 감사"를 남긴다.
-- 무엇을·언제·누가 승인했는지 추적하는 것이 목적이다.
--
-- - action: preview_shown (dry-run 미리보기를 승인 요청에 첨부)
--         | executed (승인 후 저장된 마커 재실행)
--         | denied (사용자가 거부)
--         | expired (10분 만료)
--         | blocked (게이트·정책이 실행을 막음 — 향후 확장용)
-- - detail: 미리보기 요약·실행 결과 등. 마스킹된 값만 들어간다
--   (시크릿·잠긴 메모 내용은 절대 저장하지 않음 — sandbox.ts 참조).
-- - conversation_id: 백그라운드 실행(대화 없음)은 NULL.
--
-- 주의: 추가형 변경만 포함한다. 기존 테이블은 손대지 않는다.
-- 운영 적용 전 Time Travel bookmark 확보 등 운영 D1 안전 규칙을 따를 것.

CREATE TABLE IF NOT EXISTS tool_execution_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id TEXT NOT NULL,
  conversation_id INTEGER,
  tool TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('preview_shown', 'executed', 'denied', 'expired', 'blocked')),
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_execution_audit_conversation
  ON tool_execution_audit (conversation_id, created_at);
