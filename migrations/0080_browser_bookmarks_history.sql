-- 0080: 브라우저 북마크·방문 기록 (2026-11-20)
--
-- 배경: 브라우저 1단계 — 즐겨찾기 6개 하드코딩과 최근 방문 6개
-- (localStorage)를 D1으로 옮겨 기기 간 동기·장기 보존을 한다.
-- 북마크는 URL UNIQUE, 방문 기록도 URL UNIQUE로 재방문 시
-- visited_at만 갱신한다 (upsert — 행이 늘지 않는다).
-- GET /bookmarks가 비어 있으면 기존 하드코딩 6개를 pinned 시드로
-- 넣어 반환한다 (Worker가 INSERT OR IGNORE로 넣는다).
-- 방문 기록은 1000개 상한으로 Worker가 삽입 뒤 prune한다.
-- 적용은 단독 파일로만 (docs/migration-history-check.md §5).

CREATE TABLE IF NOT EXISTS browser_bookmarks (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  title TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS browser_history (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  title TEXT,
  visited_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_browser_bookmarks_pinned_position
  ON browser_bookmarks(pinned, position);

CREATE INDEX IF NOT EXISTS idx_browser_history_visited_at
  ON browser_history(visited_at DESC);
