-- 0078: ai_conversations(updated_at, id) 인덱스 — 0077 후속
--
-- 0077로 ai_chats 서브쿼리는 인덱스를 타게 됐으나, /conversations 쿼리의
-- 바깥쪽은 여전히 ai_conversations 전체 스캔(506행) + ORDER BY용
-- 임시 B-트리였다 (호출당 1,483행). ORDER BY updated_at DESC, id DESC와
-- LIMIT에 맞는 인덱스를 두면 호출당 약 100행 수준으로 떨어진다.
--
-- DDL은 데이터 변경이 없으며, CREATE INDEX IF NOT EXISTS로 재실행 안전.
-- Time Travel 북마크는 0077 적용 전 확보한
-- 00001b43-00000000-00005125-9ba8be29796ce1a9bd443cf3cba457cf 를 공용한다.

CREATE INDEX IF NOT EXISTS idx_ai_conversations_updated ON ai_conversations(updated_at DESC, id DESC);
