-- 0052: 도구 승인 요청 (진짜 비서 1단계 b트랙 — 위험 기반 승인 게이트 마감)
--
-- tool_approvals(0047)는 승인·거부 "결정"의 감사 기록이다.
-- 이 테이블은 파괴적/쓰기 도구 실행 전에 사용자에게 보여주고 답을 기다리는
-- "대기 중인 승인 요청"을 저장한다. 채팅은 무상태 HTTP라서, 모델이 낸
-- 도구 마커를 바로 실행하지 않고 여기에 보관했다가 사용자가
-- "승인해" / "거부해" / "이 세션 허용해"로 답하면 그때 실행한다.
--
-- - marker_text: 실행을 보류한 원본 마커 1개 (승인 시 그대로 재실행)
-- - summary/reversible/impact: 승인 요청 문안에 들어간 내용 (감사 추적용)
-- - user_request: 근거가 된 마지막 사용자 메시지 (200자 절단)
-- - status: pending → approved | denied | expired
--   (승인 후 실행 결과는 채팅 기록이 남긴다. executed 상태는 두지 않는다 —
--   실행 실패와 성공을 이 테이블이 판정하지 않기 위함)
-- - expires_at: 생성 후 10분 (APPROVAL_TIMEOUT_MS). 만료 판정은 JS에서 수행한다
--   (D1 datetime('now')와 ISO 문자열의 사전식 비교 회피 — 0047과 같은 방식).
--   만료된 요청은 조회 시점에 status='expired'로 갱신한다 (lazy expiry, 별도 스윕 없음).
--
-- 주의: 추가형 변경만 포함한다. 기존 테이블은 손대지 않는다.
-- 운영 적용 전 Time Travel bookmark 확보 등 운영 D1 안전 규칙을 따를 것.

CREATE TABLE IF NOT EXISTS tool_approval_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id TEXT NOT NULL,
  conversation_id INTEGER NOT NULL,
  tool TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  marker_text TEXT NOT NULL,
  summary TEXT NOT NULL,
  user_request TEXT NOT NULL DEFAULT '',
  reversible INTEGER NOT NULL DEFAULT 0,
  impact TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tool_approval_requests_pending
  ON tool_approval_requests (conversation_id, status, created_at);
