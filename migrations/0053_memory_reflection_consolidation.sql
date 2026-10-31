-- 0053: 성찰·수면 통합 (진짜 비서 2단계 d트랙)
--
-- Letta의 sleep-time 에이전트 + Agent Zero의 성찰 프롬프트 패턴만 이식
-- (Letta/Agent Zero 코드 미사용, 개념만 참고):
-- - 성찰: 작업 완료 후 배운 사실·선호·제약을 ai_memory_v2에
--   source_type='reflection'으로 저장 (0046 captureFacts 재사용 — 별도 테이블 없음).
-- - 수면 통합: 새벽 03:00 KST에 중복 병합·모순 표시·오래된 기억 요약을
--   결정적 규칙으로 수행. 삭제는 절대 하지 않고 대체(supersede) 표시만 남긴다.
-- - 이 마이그레이션은 통합 내역의 감사 로그 테이블만 추가한다
--   (추가형 변경 — 기존 테이블 ALTER/DROP 없음).
-- - LLM 요약/성찰은 플래그 기본 OFF (memory.llm_reflection_enabled,
--   memory.llm_consolidation_enabled — ai_settings에 행이 없으면 OFF).
--   운영 적용 전 Time Travel bookmark 확보 등 운영 D1 안전 규칙을 따를 것.

CREATE TABLE IF NOT EXISTS memory_consolidation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  action TEXT NOT NULL,
  memory_id INTEGER,
  related_memory_id INTEGER,
  detail TEXT NOT NULL DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CHECK (action IN ('run', 'merge', 'contradiction', 'summarize')),
  CHECK (length(run_id) > 0)
);

CREATE INDEX IF NOT EXISTS idx_consolidation_log_run ON memory_consolidation_log(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_consolidation_log_memory ON memory_consolidation_log(memory_id, created_at);
