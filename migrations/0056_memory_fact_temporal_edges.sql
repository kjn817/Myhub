-- 0056: Graphiti 시간 엣지 패턴 이식 — 사실↔엔티티 연결에 유효 기간
--
-- Graphiti(getzep/graphiti)의 시간 엣지 패턴만 이식 (Graphiti 코드 미사용,
-- Python/Neo4j 설치 없음 — docs/github-apply-research-20261026.md 2-4절):
-- - memory_fact_entities(0046)에 valid_from·valid_until을 추가한다.
--   valid_until IS NULL = 현재 유효한 연결 (열린 구간, Graphiti의 open interval).
-- - 새 사실이 오면 기존 사실의 연결을 닫는다 (valid_until = 대체 시각):
--   memory-consolidation의 중복 병합 + POST /api/memory/:id/supersede가
--   supersedeMemory 성공 후 closeFactTemporalEdges로 닫는다.
-- - 복원(POST /api/memory/:id/restore)은 reopenFactTemporalEdges로 다시 연다.
-- - 읽기는 현재 유효한 연결만 본다 (expandGraphFacts / getFactNeighbors의
--   fe.valid_until IS NULL 조건). 0056 미적용 DB에서는 해당 쿼리가 예외를
--   내고 호출자의 fail-soft 경로(FTS 결과만 사용)로 떨어진다.
--
-- - 추가형 변경만 포함 (기존 컬럼 ALTER/DROP 없음 — 컬럼 추가 2개만).
--   SQLite는 ALTER TABLE ADD CONSTRAINT를 지원하지 않아 유효 구간
--   CHECK(valid_until >= valid_from)는 두지 않는다 — 코드에서 보장한다.
-- - 기존 행 백필: valid_from = created_at(연결 생성 시각), valid_until NULL.
-- - 운영 적용 전 Time Travel bookmark 확보 등 운영 D1 안전 규칙을 따를 것.
--   이 파일은 작성만 하고 운영 DB에는 적용하지 않는다 (트랙 C4+C5).

ALTER TABLE memory_fact_entities ADD COLUMN valid_from DATETIME;
ALTER TABLE memory_fact_entities ADD COLUMN valid_until DATETIME;

UPDATE memory_fact_entities SET valid_from = created_at WHERE valid_from IS NULL;

CREATE INDEX IF NOT EXISTS idx_memory_fact_entities_valid
  ON memory_fact_entities(entity_id, valid_until);
