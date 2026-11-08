-- 0072: 승인 요청 pending 중복 방지 부분 유니크 인덱스
--
-- 재구축: 운영 스키마 역추정 (2026-11-07). 원문 복원이 아니라 운영 D1
-- (myhub-db)의 sqlite_master 실측과 동등한 효과를 내는 SQL로 재구성했다.
--
-- 배경·귀속 근거:
-- - wave2/RECONCILIATION.md §8 (2026-11-05 배치 B): 0072는 운영 D1에 단독
--   적용 완료됐고 (Time Travel bookmark 00000f25-… 확보 후), 적용 전
--   "중복 pending 그룹 0건" 사전 실측 + 적용 후 인덱스 생성을 검증했다.
--   즉 pending 중복을 막는 유니크 인덱스 생성이 이 마이그레이션의 본문이다.
-- - 운영 실측에서 tool_approval_requests의 인덱스 중 베이스라인(0052)에
--   없는 유니크 인덱스는 idx_tool_approval_requests_pending_scope 하나뿐이며,
--   정의가 (conversation_id, scope_key) + WHERE status = 'pending'으로
--   "대화·스코프당 pending 승인 요청은 최대 1건"이라는 기록과 정확히
--   대응한다. 동반 커밋: 603e98d4 (BW9 + 0072).
--
-- 운영 D1에는 이미 적용된 상태다 (재적용 금지).

CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_approval_requests_pending_scope
  ON tool_approval_requests (conversation_id, scope_key)
  WHERE status = 'pending';
