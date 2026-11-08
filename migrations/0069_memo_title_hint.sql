-- 0069: 메모 제목 힌트 분리 보관 (memos.title_hint)
--
-- 배경: 메모 목록에서 제목과 본문 첫 줄이 섞여 보이는 문제를 줄이기 위해,
-- 제목 줄 뒤에 본문이 더 있을 때만 제목 힌트를 분리 보관한다. 제목이 곧
-- 본문인 한 줄 메모는 hint를 비워 두는 것이 의도된 동작이다
-- (2026-11-05 표시 규칙 기록). 운영 적용 확인 후 배포된 기록이 있다.
--
-- 재구축 근거: 운영 번들 실측으로 memos.title_hint의 존재·사용
-- (SELECT title_hint FROM memos / UPDATE memos SET title_hint)을 확인했고,
-- ~/memory/2026-11-05.md에 "마이그레이션 0069(title_hint)"로 등재돼 있다.
-- 타입(TEXT)은 추정 — 운영 D1 스키마 대조 단계에서 확정한다.
-- 운영 D1에는 이미 적용된 상태다 (재적용 금지).
--
-- 주의: 추가형 변경만 포함한다.

ALTER TABLE memos ADD COLUMN title_hint TEXT;
