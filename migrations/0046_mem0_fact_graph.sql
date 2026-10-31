-- 0046: mem0 패턴 이식 — 사실 노드 + 관계 그래프 (임베딩 없음)
--
-- akitaonrails/ai-memory(0044)의 ai_memory_v2 사실 저장소를 재사용·확장한다.
-- mem0의 그래프 메모리 패턴만 이식 (mem0 코드 미사용):
-- - 사실 노드: ai_memory_v2 행 자체 (category='fact', source_type/source_id로 출처 기록)
-- - 엔티티 노드: memory_entities (정규화 이름 UNIQUE — 동일 엔티티 1행)
-- - 관계 간선: memory_relations (같은 사실에서 함께 등장한 엔티티 쌍, related_to)
-- - 사실↔엔티티 연결: memory_fact_entities
-- - 검색은 기존 ai_memory_fts(FTS5) + 융합 랭킹을 재사용하고, 그래프는 1-hop
--   확장으로 관련 사실을 보강한다. 임베딩 컬럼 없음.
-- - 추가형 변경만 포함 (기존 테이블 ALTER/DROP 없음). 운영 적용 전 Time Travel
--   bookmark 확보 등 운영 D1 안전 규칙을 따를 것.

-- ---------- 1) 엔티티 노드 ----------
CREATE TABLE IF NOT EXISTS memory_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  normalized TEXT NOT NULL UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at DATETIME,
  CHECK (length(name) > 0 AND length(name) <= 200),
  CHECK (length(normalized) > 0 AND length(normalized) <= 200)
);

CREATE INDEX IF NOT EXISTS idx_memory_entities_name ON memory_entities(name);
CREATE INDEX IF NOT EXISTS idx_memory_entities_access ON memory_entities(last_accessed_at);

-- ---------- 2) 관계 간선 ----------
CREATE TABLE IF NOT EXISTS memory_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_entity_id INTEGER NOT NULL REFERENCES memory_entities(id),
  target_entity_id INTEGER NOT NULL REFERENCES memory_entities(id),
  relation TEXT NOT NULL DEFAULT 'related_to',
  fact_id INTEGER REFERENCES ai_memory_v2(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CHECK (source_entity_id <> target_entity_id),
  CHECK (relation IN ('related_to')),
  CHECK (is_active IN (0, 1)),
  UNIQUE (source_entity_id, target_entity_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_memory_relations_source ON memory_relations(source_entity_id, is_active);
CREATE INDEX IF NOT EXISTS idx_memory_relations_target ON memory_relations(target_entity_id, is_active);
CREATE INDEX IF NOT EXISTS idx_memory_relations_fact ON memory_relations(fact_id);

-- ---------- 3) 사실↔엔티티 연결 ----------
CREATE TABLE IF NOT EXISTS memory_fact_entities (
  fact_id INTEGER NOT NULL REFERENCES ai_memory_v2(id),
  entity_id INTEGER NOT NULL REFERENCES memory_entities(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (fact_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_fact_entities_entity ON memory_fact_entities(entity_id);
CREATE INDEX IF NOT EXISTS idx_memory_fact_entities_fact ON memory_fact_entities(fact_id);
