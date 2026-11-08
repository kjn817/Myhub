-- 0057: OTEL 스팬 스키마 차용 (트랙 C2 — OpenLLMetry/OpenLIT 규약, SDK 설치 없음)
--
-- 배경: MyHub는 ai_usage 원장 + tool_execution_audit를 갖고 있으나 스키마가
-- 자체 규격이다. OpenTelemetry 스팬 시맨틱 컨벤션만 차용해 두 테이블에
-- 스팬 필드를 추가한다. 나중에 Langfuse/Phoenix 같은 뷰어로 갈아끼우기
-- 쉬워지고, "어떤 프롬프트 버전이 어떤 도구 호출을 했는지"가 표준
-- 형태로 남는다 (KREAM JARVIS 교훈: LLM 호출은 전부 트레이스로 남길 것).
--
-- 이미 있는 필드는 이름만 맞춘다 (중복 추가 없음):
-- - ai_usage: model / input_tokens / output_tokens / latency_ms(=duration_ms) /
--   outcome(=status) 이미 존재 → trace_id / span_id / parent_span_id /
--   prompt_version만 추가.
-- - ai_tool_runs: tool_name / tool_call_id / duration_ms / status 이미
--   존재 → trace_id / span_id / parent_span_id만 추가.
-- - tool_execution_audit: tool(=tool_name) / action(=감사 액션) 이미 존재 →
--   trace_id / span_id / parent_span_id / tool_call_id / duration_ms /
--   status(OTEL 스팬 상태 ok|error — action의 감사 의미와 별개) 추가.
--
-- 보안 경계: D1에만 저장하고 외부 전송 없음. 잠긴 메모는 트레이스에도
-- 남기지 않는다 (ai_usage에는 애초에 본문이 없고, tool_execution_audit의
-- detail은 마스킹된 값만 들어간다 — sandbox.ts 참조).
--
-- 주의: 추가형 변경만 포함한다. 기존 테이블·컬럼은 손대지 않는다.
-- 운영 적용 전 Time Travel bookmark 확보 등 운영 D1 안전 규칙을 따를 것.

-- ai_usage: LLM 호출 스팬
ALTER TABLE ai_usage ADD COLUMN trace_id TEXT;
ALTER TABLE ai_usage ADD COLUMN span_id TEXT;
ALTER TABLE ai_usage ADD COLUMN parent_span_id TEXT;
ALTER TABLE ai_usage ADD COLUMN prompt_version TEXT;

CREATE INDEX IF NOT EXISTS idx_ai_usage_trace ON ai_usage(trace_id);

-- ai_tool_runs: FC 경로의 도구 호출 스팬 (tool_name / tool_call_id /
-- duration_ms / status는 이미 존재 → trace_id / span_id / parent_span_id만
-- 추가. 이 테이블이 있어야 런의 도구 호출이 트레이스 뷰어에 나온다.)
ALTER TABLE ai_tool_runs ADD COLUMN trace_id TEXT;
ALTER TABLE ai_tool_runs ADD COLUMN span_id TEXT;
ALTER TABLE ai_tool_runs ADD COLUMN parent_span_id TEXT;

CREATE INDEX IF NOT EXISTS idx_ai_tool_runs_trace ON ai_tool_runs(trace_id);

-- tool_execution_audit: 도구 실행 스팬
ALTER TABLE tool_execution_audit ADD COLUMN trace_id TEXT;
ALTER TABLE tool_execution_audit ADD COLUMN span_id TEXT;
ALTER TABLE tool_execution_audit ADD COLUMN parent_span_id TEXT;
ALTER TABLE tool_execution_audit ADD COLUMN tool_call_id TEXT;
ALTER TABLE tool_execution_audit ADD COLUMN duration_ms INTEGER;
ALTER TABLE tool_execution_audit ADD COLUMN status TEXT;

CREATE INDEX IF NOT EXISTS idx_tool_execution_audit_trace ON tool_execution_audit(trace_id);
