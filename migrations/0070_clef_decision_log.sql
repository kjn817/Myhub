-- 0070: Clef 결정 로그 (clef_decision_log)
--
-- 배경: Clef Decision Engine의 판정을 사후 감사·측정할 수 있도록 결정
-- 1건당 1행을 남기는 원장 (2026-11-05, 기둥 ③ Clef). 메시지 본문은
-- 남기지 않고 해시·길이만 기록한다 (message_hash / message_length).
--
-- 스키마 확정 (2026-11-07 재구축): 운영 D1(myhub-db)의 sqlite_master 실측으로
-- 컬럼·타입·제약·인덱스를 확정했다. 역추정 초안에서 달라진 점:
-- - trace_id / kind / spec_hash / option_order / threshold_version /
--   message_hash / message_length / mode는 전부 NOT NULL이다.
-- - applied는 INTEGER NOT NULL DEFAULT 0이다.
-- - created_at은 기본값 없는 TEXT NOT NULL이다 (앱이 명시 기록).
-- - 조회용 인덱스 2개(idx_clef_decision_log_created,
--   idx_clef_decision_log_kind)가 함께 존재한다.
-- 컬럼 순서는 운영 실측 및 번들 INSERT 실측과 동일하다:
-- trace_id, kind, spec_hash, option_order, threshold_version, message_hash,
-- message_length, choice, probabilities_json, top_prob, margin, applied,
-- served_persona, mode, reason, created_at
-- 운영 D1에는 이미 적용된 상태다 (재적용 금지).

CREATE TABLE IF NOT EXISTS clef_decision_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  spec_hash TEXT NOT NULL,
  option_order TEXT NOT NULL,
  threshold_version TEXT NOT NULL,
  message_hash TEXT NOT NULL,
  message_length INTEGER NOT NULL,
  choice TEXT,
  probabilities_json TEXT,
  top_prob REAL,
  margin REAL,
  applied INTEGER NOT NULL DEFAULT 0,
  served_persona TEXT,
  mode TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clef_decision_log_created
  ON clef_decision_log(created_at);

CREATE INDEX IF NOT EXISTS idx_clef_decision_log_kind
  ON clef_decision_log(kind, created_at);
