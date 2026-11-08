# TimelyAI 질문용 프롬프트 — MyHub AI 채팅 장애

아래를 복사해서 TimelyAI에 붙여넣으세요.

---

## 시스템 개요

Cloudflare Workers + Hono + D1으로 만든 개인 AI 비서 시스템입니다.
3명의 비서가 있음: 루미(대화), 에코(기록), 노바(개발)

**파일 구조:**
- `src/services/ai.ts` — Provider 추상화, 모델 선택, 폴백 로직, 키 풀 관리
- `src/modules/ai/routes.ts` — `/api/ai/chat` 등 API 라우트
- `src/services/tools.ts` — 도구 레지스트리 (현재 비활성화)
- `src/services/tools-builtin.ts` — 내장 도구 구현 (현재 비활성화)

**Provider:**
- Gemini (4 모델): gemini-2.5-flash, 3.7-flash, 3.5-flash, 3.8-flash
  - Cloudflare Workers에서 직접 호출 시 지역 제한 400 에러 → Deno Deploy 릴레이 경유
- Groq (3 모델): openai/gpt-oss-20b, llama-3.3-70b-versatile, openai/gpt-oss-120b
- Workers AI (3 모델): llama-3.2-1b, mistral-small-3.1, llama-3.3-70b-fp8

**모델 선택 로직 (selectModel):**
1. 명시적 Gemini 폴백 체인 (3.8 → 3.7 → 3.5)
2. D1 `ai_settings` 테이블의 사용자 오버라이드 (`model.<capability>`)
3. privacy=private면 Workers AI만
4. 점수 기반: latency=interactive면 Groq +10, quality 매칭 +5, capability=chat/summarize/translate면 Gemini +20

**폴백 로직 (aiChat):**
- 최대 4회 시도, 실패한 모델은 exclude set에 추가
- Gemini 2개 실패 후에는 체인 로직 스킵하고 다른 provider로 전환

## 문제

**루미(capability='chat')가 모든 요청에 "AI 호출 실패" 반환.**
- "@루미 안녕?" 같은 기본 인사도 실패
- 뉴스, 날씨 요청도 실패
- D1 `ai_error_log` 테이블에 에러 기록 중 (최근 20개 조회: `GET /api/ai/debug/errors`)

**반면 노바(capability='code')는 정상 동작:**
- Groq `openai/gpt-oss-120b`로 코드 생성 성공 확인

## 핵심 단서

1. **Jest 테스트 25개 전부 통과**, 배포 스크립트 검증 통과 — 코드 문법/로직상 문제없음
2. **라이브에서만 실패** — 로컬 테스트와 Workers 환경의 차이
3. **Groq 사용량 카운터가 증가하지 않음** — 루미 요청 시 Groq API가 호출되지 않거나 성공 로그가 안 찍힘 (성공 시에만 `ai_usage` 테이블에 기록)
4. **명시적 모델 지정해도 실패** — 설정에서 루미 모델을 `groq/llama-3.3-70b-versatile`로 직접 지정해도 동일하게 실패
5. **노바는 됨** — 같은 Groq provider, 같은 `callGroq` 함수인데 노바는 되고 루미는 안 됨
6. 노바와 루미의 차이점: `capability` ('code' vs 'chat'), `quality` ('high' vs 'balanced'), 시스템 프롬프트, 사용자 메시지 내용

## 시도한 것들 (모두 실패)

1. Gemini Google Search grounding (`body.tools = [{google_search: {}}]`) → 제거함
2. Groq function calling (tools 파라미터 + temperature 0.1) → 제거함
3. qwen 모델 비활성화 (function calling 할루시네이션 버그, GitHub 이슈 확인됨)
4. 폴백 로직 수정 (Gemini 4개 다 시도하던 버그 → 2개 실패 후 provider 전환)
5. llama-3.3-70b-versatile 모델 추가

## 질문

1. **같은 `callGroq` 함수를 쓰는데 노바는 되고 루미는 안 되는 원인은?**
   - 메시지 내용 차이 (시스템 프롬프트, 대화 히스토리)가 API 호출 실패를 유발할 수 있는가?
   - `capability='chat'`일 때 선택되는 모델과 `capability='code'`일 때 선택되는 모델의 차이점을 봐야 하는가?

2. **Cloudflare Workers 환경에서 특정 모델만 실패하는 원인?**
   - Gemini는 Deno 릴레이를 경유하는데, 릴레이 자체가 죽었을 가능성은?
   - `AbortSignal.timeout(25000)`이 특정 조건에서 즉시 실패를 유발할 수 있는가?

3. **에러가 `ai_error_log`에 기록되는데도 원인이 안 보이는 경우, 다음 디버깅 단계는?**
   - 현재 기록: provider, model, capability, error 메시지(500자), http_status, 시간
   - 추가로 기록해야 할 정보는?

4. **아키텍처 관점: 이런 식의 "테스트는 통과하는데 라이브만 실패"를 방지하려면?**
   - Workers 환경과 동일한 조건의 통합 테스트 방법은?
   - Provider 헬스체크를 주기적으로 해서 죽은 모델을 자동으로 제외하는 게 나은가?

## 관련 코드 (필요시 요청)

- `src/services/ai.ts` 전체 (약 500줄): `selectModel`, `aiChat`, `callGemini`, `callGroq`, `callWorkersAI`
- `src/modules/ai/routes.ts`의 `/api/ai/chat` 핸들러 (메시지 전처리 포함)
- D1 마이그레이션: `0011_ai_memory.sql`, `0012_ai_error_log.sql`
