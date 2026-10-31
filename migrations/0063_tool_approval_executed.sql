-- 0063: 도구 승인 실행 claim (Talorys ②-0 — 승인 executed_at 원자 선점)
--
-- 0052는 "executed 상태는 두지 않는다 — 실행 실패와 성공을 이 테이블이
-- 판정하지 않기 위함"이라고 명시했다. 그 의도는 유지한다:
-- - executed_at: 실행 판정이 아니라 "이 승인 건의 실행을 한 번 선점했다"는
--   사실의 기록이다. 승인(status='approved')된 요청의 재실행 직전에
--   `UPDATE ... SET executed_at=? WHERE id=? AND status='approved'
--    AND executed_at IS NULL` 로 원자적으로 선점하고, changes=1인 호출만
--   실제로 도구를 실행한다 (docs/talorys-patterns-20261029.md §3.3.0).
-- - execution_result: 성공/실패 판정 용도가 아니라 감사 기록이다 —
--   "시도를 했다 + 결과 요약(생성된 리소스 id·오류 요약 등)"만 남긴다.
--   실행이 실패해도 executed_at을 되돌리지 않는다 (부작용이 났을 수 있는
--   실패의 자동 재시도 금지 — 다시 필요하면 사용자의 새 요청으로 새 승인
--   건이 생기는 것이 복구 경로다).
--
-- 주의: 추가형 변경만 포함한다. 기존 테이블·컬럼은 손대지 않는다.
-- 운영 적용 전 Time Travel bookmark 확보 등 운영 D1 안전 규칙을 따를 것.

ALTER TABLE tool_approval_requests ADD COLUMN executed_at TEXT;
ALTER TABLE tool_approval_requests ADD COLUMN execution_result TEXT;
