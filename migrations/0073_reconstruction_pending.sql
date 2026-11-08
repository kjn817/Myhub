-- 0073: 승인 요청 정리(cleanup) 조회용 인덱스
--
-- 재구축: 운영 스키마 역추정 (2026-11-07). 원문 복원이 아니라 운영 D1
-- (myhub-db)의 sqlite_master 실측과 동등한 효과를 내는 SQL로 재구성했다.
--
-- 배경·귀속 근거:
-- - wave2/RECONCILIATION.md §9 (2026-11-06 배치 C): 0073은 운영 D1에 단독
--   적용 완료됐고 (Time Travel bookmark 00000f38-… 확보 후, 인덱스 검증),
--   동반 커밋은 ef9656ea (CW3 — R-13/R-14 + 0073)다.
-- - R-14의 주제는 "승인 요청 테이블 원문 잔존의 암호화 + 만료·결정 후
--   삭제"로, 만료·결정 완료 행을 골라 지우는 정리 작업이 (status,
--   expires_at) 조회에 의존한다. 운영 실측에서 베이스라인(0052)에도
--   0072에도 귀속되지 않는 tool_approval_requests 인덱스는
--   idx_tool_approval_requests_cleanup (status, expires_at) 하나뿐이며
--   이 주제와 정확히 대응한다.
-- - R-13 (ai_chats 평문 저장의 암호화 전환)은 데이터 변환이라 스키마
--   델타가 없다 — 운영 ai_chats 정의가 베이스라인과 스키마 수준에서
--   다르지 않음을 실측으로 확인했다 (prompt_version 기본값 차이는
--   0066 이전 베이스라인 드리프트로 별도 보고됨).
--
-- 운영 D1에는 이미 적용된 상태다 (재적용 금지).

CREATE INDEX IF NOT EXISTS idx_tool_approval_requests_cleanup
  ON tool_approval_requests (status, expires_at);
