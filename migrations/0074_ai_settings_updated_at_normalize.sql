-- 0074: ai_settings.updated_at 정규화 (의미 보존형 데이터 정규화)
--
-- 재구축: 운영 스키마 역추정 (2026-11-07). 운영 D1(myhub-db)의 sqlite_master
-- 실측 결과 ai_settings 정의(key TEXT PRIMARY KEY, value TEXT NOT NULL,
-- updated_at TEXT NOT NULL)는 베이스라인 0009와 완전히 동일하다 — 즉 이
-- 마이그레이션은 스키마 델타가 없는 데이터 정규화다.
--
-- 확정된 사실 (wave2/RECONCILIATION.md §10, ~/memory/2026-11-06.md):
-- - 주제: ai_settings.updated_at 정규화. "의미 보존형" 변경으로 분류됐다.
-- - 파일 작성과 로컬 검증은 2026-11-05까지 완료됐고, 2026-11-06 마감
--   트랙에서 운영 적용 완료됐다.
--
-- 재구성의 한계 (정직 표기): 원문의 정확한 변환 규칙은 운영 행 데이터를
-- 조회하지 않는 이번 역추정 범위에서는 확정할 수 없다. 아래 UPDATE는
-- datetime()으로 파싱 가능한 값을 SQLite 표준 형식
-- ('YYYY-MM-DD HH:MM:SS')으로 통일하는 의미 보존형으로 재구성한 것으로,
-- 이미 표준 형식인 값과 파싱 불가 값은 건드리지 않으며 멱등하다.
-- 원문이 ISO 'T…Z' 형식으로의 통일이었다면 변환 방향이 다를 수 있다는
-- 점이 남은 불확실성이다 — 데이터 수준 대조가 필요하면 별도 승인 하에
-- 값 분포를 확인할 것.
--
-- 운영 D1에는 이미 적용된 상태다 (재적용 금지).

UPDATE ai_settings
SET updated_at = datetime(updated_at)
WHERE datetime(updated_at) IS NOT NULL
  AND updated_at <> datetime(updated_at);
