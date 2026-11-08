-- 0059: 메모 부분 검색용 trigram 보조 FTS 인덱스 (perf-audit-20261028 §3.1·§6 #2)
--
-- 배경: GET /api/memos?q= 의 LIKE 폴백이 `REPLACE(m.text,' ','') LIKE '%…%'`로
-- 메모 본문 전수 스캔이었다. FTS5 unicode61 토크나이저는 토큰 단위 정확 일치라
-- 한국어 부분 검색('민국' → '대한민국' 안의 '민국', '김치찌' → '김치찌개')을
-- 못 찾고, 그때마다 LIKE 폴백이 돌았다.
--
-- 설계 (실측 근거 — better-sqlite3 인메모리 FTS5):
--   - trigram 토크나이저는 3글자 이상 부분 문자열을 LIKE와 동일하게 찾는다
--     (구 phrase 매칭이 정확한 부분 문자열 의미와 일치함을 전수 대조로 확인).
--     단, 2글자 이하 질의는 trigram으로 매칭되지 않는다 — 그 경우만 LIKE
--     폴백을 남긴다 (src/modules/memo/routes.ts의 isShortQuery 게이트).
--   - 공백 없는 검색어('여행계획' → '여행 계획')는 공백 제거 컬럼
--     text_nospace로 커버한다. trigram은 공백을 경계로 삼아 공백을 가로지르는
--     부분 문자열을 못 찾기 때문이다.
--   - 잠금 메모(is_locked=1)·기밀 이상(sensitivity>=2)은 0030과 동일하게
--     인덱싱에서 제외한다 (FTS 개인정보 경계 유지).
--   - 트리거는 0030과 같은 D1 안전 패턴이다: FTS5 'delete' 특수 명령을 쓰지
--     않고 `DELETE FROM ... WHERE rowid = ?` + 조건부 INSERT.
--
-- 주의: 이 마이그레이션은 memos_fts(0030)를 건드리지 않는다. 새 테이블
-- memos_fts_tri만 추가한다.

DROP TRIGGER IF EXISTS memos_fts_tri_ai;
DROP TRIGGER IF EXISTS memos_fts_tri_ad;
DROP TRIGGER IF EXISTS memos_fts_tri_au;
DROP TABLE IF EXISTS memos_fts_tri;

CREATE VIRTUAL TABLE memos_fts_tri USING fts5(text, text_nospace, tokenize='trigram');

INSERT INTO memos_fts_tri(rowid, text, text_nospace)
SELECT id, text, REPLACE(text, ' ', '')
FROM memos WHERE is_locked = 0 AND sensitivity < 2;

CREATE TRIGGER memos_fts_tri_ai AFTER INSERT ON memos
WHEN new.is_locked = 0 AND new.sensitivity < 2
BEGIN
  INSERT INTO memos_fts_tri(rowid, text, text_nospace)
  VALUES (new.id, new.text, REPLACE(new.text, ' ', ''));
END;

CREATE TRIGGER memos_fts_tri_ad AFTER DELETE ON memos
BEGIN
  DELETE FROM memos_fts_tri WHERE rowid = old.id;
END;

CREATE TRIGGER memos_fts_tri_au AFTER UPDATE ON memos
BEGIN
  DELETE FROM memos_fts_tri WHERE rowid = old.id;
  INSERT INTO memos_fts_tri(rowid, text, text_nospace)
  SELECT new.id, new.text, REPLACE(new.text, ' ', '')
  WHERE new.is_locked = 0 AND new.sensitivity < 2;
END;
