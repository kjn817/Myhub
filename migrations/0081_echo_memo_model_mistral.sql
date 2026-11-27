-- 0081: 에코 메모 모델 교체 — model.summarize를 qwen3-30b에서 mistral-small로
--
-- 배경: @cf/qwen/qwen3-30b-a3b-fp8이 2026-11-20 Cloudflare에서 deprecated
-- 돼 매 메모 턴마다 5028 오류 1회 후 mistral-small로 폴백되고 있었다
-- (ai_error_log에 11-20 이후 11건, 최근 2026-11-26 18:22 UTC).
-- 코드(src/services/ai-models.ts)도 같은 날 qwen3-30b을 deprecated로 바꿔
-- selectModel이 오버라이드를 무시하고 mistral-small을 1차로 고르게 했다.
-- 이 마이그레이션은 설정값 자체를 교체해 오버라이드 경고 로그를 없애고
-- 설정 화면에 남은 폐기 모델 표시를 정리한다.
--
-- 멱등: WHERE key='model.summarize' AND value가 qwen3-30b일 때만 교체.
-- 되돌리기: value를 '@cf/qwen/qwen3-30b-a3b-fp8'으로 다시 UPDATE (단,
-- 해당 모델은 Cloudflare에서 deprecated라 되돌리면 5028이 재발한다).
-- 적용 전 스냅샷: ai_settings 전 행 SELECT 결과를 별도 파일로 보관한다.

UPDATE ai_settings
SET value = '@cf/mistralai/mistral-small-3.1-24b-instruct',
    updated_at = datetime('now')
WHERE key = 'model.summarize'
  AND value = '@cf/qwen/qwen3-30b-a3b-fp8';
