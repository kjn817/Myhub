-- 0077: ai_chats(conversation_id) 인덱스 — D1 일일 한도 초과 원인 수정
--
-- 배경 (2026-11-16, Cloudflare D1 경고 메일 조사):
-- GET /api/ai/conversations의 상관 서브쿼리
--   (SELECT content FROM ai_chats WHERE conversation_id = cv.id
--    ORDER BY id DESC LIMIT 1)
-- 가 ai_chats에 conversation_id 인덱스가 없어 대화방마다 테이블 전체를
-- 스캔했다. 2026-11-14 하루에 이 쿼리 하나가 7,851,504행을 읽어
-- 일일 무료 한도(5,000,000행)를 초과했다.
-- ai_chats 1,302행·대화방 506개 기준 목록 1회 호출 ≈ 65,100행.
-- 인덱스 적용 후 호출당 ≈ 50~100행으로 감소 (약 650배).
--
-- 같은 인덱스가 DELETE 트리밍
-- (DELETE FROM ai_chats WHERE conversation_id = ? AND id NOT IN (...))
-- 의 스캔도 줄인다.
--
-- DDL은 데이터 변경이 없으며, CREATE INDEX IF NOT EXISTS로 재실행 안전.

CREATE INDEX IF NOT EXISTS idx_ai_chats_conversation ON ai_chats(conversation_id, id DESC);
