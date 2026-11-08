-- 0044: ai_memory 장기 메모리 재설계 (akitaonrails/ai-memory 패턴 이식, 설계만 참고)
--
-- 1) 0028 FTS 결함 수정 (0030과 동일 방식 — 0028 파일은 수정하지 않고 이 파일이 최종 상태를 기록)
--    - 0028의 ai_memory_fts는 content='ai_memory_v2' 외부 콘텐츠 테이블 + 'delete'/'delete-all'
--      특수 명령 사용. D1은 content= 테이블 CREATE 시 전체 자동 인덱싱을 하고,
--      'delete' 특수 명령이 SQLITE_ERROR를 유발한다 (memos의 0030 결함과 같은 부류).
--    - 일반 FTS5 테이블로 재구성 + 트리거를 DELETE ... WHERE rowid = ? 로 교체.
-- 2) 기억 노화/대체/요약 컬럼 추가 (ai_memory_v2)
--    - access_count / last_accessed_at: 접근 가중 감쇠의 입력 (tier는 코드에서 파생 계산, 저장 안 함)
--    - superseded_by / supersedes: 삭제가 아닌 대체 계보 (복원 가능)
--    - contradiction_flag: 모순 플래그
--    - summary: 식은 에피소드의 핵심 사실 압축문 (zero-LLM, 첫 문장 추출)
--    - entities: 엔티티 목록(JSON 배열, 사람이 읽을 수 있는 평문) — 융합 랭킹용
-- 3) memory_pages: 사람이 읽을 수 있는 요약 페이지 (source of truth는 평문, DB는 파생 인덱스)
-- 4) memory_handoffs: 비서 간 인계 — claim-once (소유권 있는 1회 수령)
--
-- 주의: DROP TABLE은 FTS 인덱스(파생 데이터)에만 적용. 원본 ai_memory_v2는 손대지 않음.
-- 운영 적용 전 Time Travel bookmark 확보 등 운영 D1 안전 규칙을 따를 것.

-- ---------- 1) FTS 재구성 ----------
DROP TRIGGER IF EXISTS memory_fts_ai;
DROP TRIGGER IF EXISTS memory_fts_ad;
DROP TRIGGER IF EXISTS memory_fts_au;
DROP TABLE IF EXISTS ai_memory_fts;

CREATE VIRTUAL TABLE ai_memory_fts USING fts5(content);

INSERT INTO ai_memory_fts(rowid, content)
SELECT id, content FROM ai_memory_v2 WHERE is_active = 1;

CREATE TRIGGER memory_fts_ai AFTER INSERT ON ai_memory_v2
WHEN new.is_active = 1
BEGIN
  INSERT INTO ai_memory_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER memory_fts_ad AFTER DELETE ON ai_memory_v2
BEGIN
  DELETE FROM ai_memory_fts WHERE rowid = old.id;
END;

CREATE TRIGGER memory_fts_au AFTER UPDATE ON ai_memory_v2
BEGIN
  DELETE FROM ai_memory_fts WHERE rowid = old.id;
  INSERT INTO ai_memory_fts(rowid, content)
  SELECT new.id, new.content
  WHERE new.is_active = 1;
END;

-- ---------- 2) 노화/대체/요약 컬럼 ----------
ALTER TABLE ai_memory_v2 ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_memory_v2 ADD COLUMN last_accessed_at DATETIME;
ALTER TABLE ai_memory_v2 ADD COLUMN superseded_by INTEGER;
ALTER TABLE ai_memory_v2 ADD COLUMN supersedes INTEGER;
ALTER TABLE ai_memory_v2 ADD COLUMN contradiction_flag INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_memory_v2 ADD COLUMN summary TEXT;
ALTER TABLE ai_memory_v2 ADD COLUMN entities TEXT;

CREATE INDEX IF NOT EXISTS idx_memory_v2_superseded ON ai_memory_v2(superseded_by);
CREATE INDEX IF NOT EXISTS idx_memory_v2_access ON ai_memory_v2(last_accessed_at);

-- ---------- 3) 요약 페이지 ----------
CREATE TABLE IF NOT EXISTS memory_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  source_ids TEXT NOT NULL DEFAULT '[]',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_active INTEGER NOT NULL DEFAULT 1,
  CHECK (length(title) > 0 AND length(body) > 0),
  CHECK (is_active IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_memory_pages_active ON memory_pages(is_active, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_pages_category ON memory_pages(category, is_active);

-- ---------- 4) 비서 간 인계 (claim-once) ----------
CREATE TABLE IF NOT EXISTS memory_handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_token TEXT NOT NULL UNIQUE,
  from_persona TEXT NOT NULL,
  to_persona TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  claimed_at DATETIME,
  expires_at DATETIME NOT NULL,
  CHECK (status IN ('pending', 'claimed', 'expired'))
);

CREATE INDEX IF NOT EXISTS idx_handoffs_token ON memory_handoffs(claim_token);
CREATE INDEX IF NOT EXISTS idx_handoffs_status ON memory_handoffs(status, expires_at);
