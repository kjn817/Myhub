-- ai_usage에 neurons 컬럼 추가 (2026-10-30, NVIDIA 대체 트랙)
-- 배경: callWorkersAI가 Workers AI 응답 usage를 버려 ai_usage의 workers-ai
-- 행은 토큰이 전부 NULL이었고, 무료 뉴런 한도(10,000/일) 대비 소비량을
-- 사후 감사할 방법이 없었다. usage.neurons를 그대로 기록해 뉴런 예산을
-- 관측한다 (토큰 컬럼과 같은 nullable 패턴 — 다른 프로바이더는 NULL).
ALTER TABLE ai_usage ADD COLUMN neurons REAL;
