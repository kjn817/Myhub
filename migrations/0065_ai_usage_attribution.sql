-- ai_usage에 engine·persona 귀속(attribution) 컬럼 추가 (2026-10-30, 경로 귀속 트랙)
-- 배경: 실행 엔진이 3갈래(E1 마커 / E2 운영 내장 FC / E3 파일럿 Registry FC)인데
-- ai_usage에는 provider·model·capability만 있어 비서별·경로별 성공률을 측정할 수
-- 없었다 (docs/fc-transition-plan-20261029.md §1·§3.0). engine은 고정 어휘
-- ('marker' | 'builtin-fc' | 'registry-fc' | 'degraded'), persona는 실제
-- personaId(concierge/keeper/builder/scheduler 등)를 기록한다.
--
-- ① 기존 행은 소급하지 않는다 — 이 마이그레이션 이전 행의 engine·persona는
--    NULL로 남으며, NULL은 "unknown(귀속 불명)"으로 해석한다. 비서 맥락이 없는
--    호출(요약 유틸 등)의 신규 행도 persona를 억지로 채우지 않고 NULL로 남긴다.
-- ② 번호 근거: 0062는 미사용 예약 번호(Talorys 충돌 검토 큐 설계)라 건너뛰고,
--    0064는 원래 계획 카드용 예약이었으나 ai_usage.neurons가 이미 사용했으므로,
--    다음 가용 번호인 0065를 쓴다.
ALTER TABLE ai_usage ADD COLUMN engine TEXT;
ALTER TABLE ai_usage ADD COLUMN persona TEXT;
