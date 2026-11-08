-- 0075: schedules.start_at 오프셋 명시 (의미 보존형 데이터 정규화)
--
-- 재구축: 운영 스키마 역추정 (2026-11-07). 운영 D1(myhub-db)의 sqlite_master
-- 실측 결과 start_at 컬럼 정의(TEXT NOT NULL)는 베이스라인 0014와 동일하고,
-- schedules의 스키마 델타는 0068(google_event_id)·0071(동기화 상태 3컬럼+
-- 인덱스)뿐이다 — 즉 이 마이그레이션은 스키마 델타가 없는 데이터 정규화다.
--
-- 확정된 사실 (wave2/RECONCILIATION.md §10, ~/memory/2026-11-06.md):
-- - 주제: schedules.start_at 오프셋 명시. "의미 보존형" 변경으로 분류됐다.
-- - 파일 작성과 로컬 검증은 2026-11-05까지 완료됐고, 2026-11-06 마감
--   트랙에서 운영 적용 완료됐다.
-- - schedules.start_at은 TEXT ISO8601이며 timezone 컬럼(기본
--   'Asia/Seoul')과 별개로 오프셋 없는 형태가 섞일 수 있었다.
--
-- 재구성 근거: timezone 기본값 'Asia/Seoul'은 UTC+09:00 (서머타임 없음)
-- 이므로, 오프셋 표기가 없는 start_at에 '+09:00'을 붙이는 것이 기록된
-- 주제("오프셋 명시")와 정합하는 의미 보존형 변환이다. 이미 오프셋이나
-- 'Z'가 있는 값은 건드리지 않으며 멱등하다.
--
-- 남은 불확실성 (정직 표기): end_at 등 동반 컬럼의 처리 여부는 기록만으로
-- 확정되지 않아, 파일명이 명시한 start_at만 대상으로 했다. 원문의 정확한
-- 대상 행 범위도 운영 행 데이터를 조회하지 않는 이번 범위에서는 확정할
-- 수 없다 — 데이터 수준 대조가 필요하면 별도 승인 하에 확인할 것.
--
-- 운영 D1에는 이미 적용된 상태다 (재적용 금지).

UPDATE schedules
SET start_at = start_at || '+09:00'
WHERE length(start_at) >= 16
  AND start_at NOT LIKE '%Z'
  AND substr(start_at, 11) NOT LIKE '%+%'
  AND substr(start_at, 11) NOT LIKE '%-%';
