# Phase 0 완료 보고

## 1. 프로젝트 구조 분석

### AI 관련 파일

| 파일 | 줄 수 | 역할 |
|---|---|---|
| `src/modules/ai/routes.ts` | 948 | Hono 라우트, PERSONA_POLICY, 마커 후처리 |
| `src/services/ai.ts` | 692 | Provider 호출, 모델 선택, 사용량 원장 |
| `src/services/router.ts` | 117 | 키워드 기반 비서 라우터 |
| `src/services/orchestrator.ts` | 152 | 비서 선택·협업·종합 |
| `src/services/tools.ts` | 38 | 도구 관련 (거의 비어있음) |
| `src/services/memo-tools.ts` | ? | 메모 도구 마커 파싱·실행 |
| `src/services/todo-tools.ts` | ? | 할일 도구 마커 파싱·실행 |
| `src/services/schedule-tools.ts` | ? | 일정 도구 마커 파싱·실행 |

### AI 요청 흐름

```
POST /api/ai/chat
  → aiApp (routes.ts)
    → callSingleAssistant (personaId로 비서 선택)
      → PERSONA_POLICY 조회
      → ai_settings에서 model.<capability> 오버라이드 조회
      → aiChat (services/ai.ts)
        → selectModel (정책 + 오버라이드 + 폴백 체인)
        → Provider 호출 (Gemini/Groq/Workers AI)
        → logUsage (D1 ai_usage 기록)
      → processToolMarkers (마커 문자열 파싱·실행)
        → [SEARCH:], [MEMO_CREATE], [TODO_*], [SCHEDULE_*], [ASK:], [IMG:], [GITHUB:]
    → 응답 반환
```

### 마커 종류 (현재)

- `[SEARCH:쿼리]` → Exa 웹검색
- `[MEMO_CREATE]` → 메모 생성
- `[TODO_ADD]`, `[TODO_LIST]`, `[TODO_DONE]` 등 → 할일
- `[SCHEDULE_*]` → 일정
- `[ASK:persona_id]...[/ASK]` → 다른 비서 호출 (최대 2단계)
- `[IMG:prompt]` → 이미지 생성 (pollinations.ai)
- `[GITHUB:query]` → GitHub 검색

### Provider 구조

- **Gemini**: Deno 릴레이 경유 (`https://dear-kingfisher-2082.kjn817.deno.net`), 직접 호출 실패 시 폴백
- **Groq**: OpenAI 호환 API 직접 호출
- **Workers AI**: Cloudflare 내장 AI 바인딩

모델 선택 로직 (`selectModel`):
1. Gemini 체인 폴백 (3.8 → 3.7 → 3.5)
2. 사용자 오버라이드 (`model.<capability>`)
3. 정책 기반 랭킹 (latency, quality, capability, useSearch 보너스)

**발견된 문제:**
- `gemini-3.5-flash`가 deprecated → `3.6-flash` 확인 필요 (GPT 지적)
- `useSearch` 보너스가 에코를 Gemini로 편향시킴 (+50)
- `selectModel`이 `policy.model`을 무시하고 DB에서 직접 읽음 (수정 완료)

## 2. D1 스키마

| 테이블 | 용도 |
|---|---|
| `ai_usage` | 호출 원장 (provider, model, capability, latency, tokens, outcome) |
| `ai_chats` | 대화 기록 (persona_id, role, content, model) |
| `ai_settings` | 설정 (key-value, model.<capability> 등) |
| `ai_conversations` | 대화 세션 |
| `ai_memory` | 메모리 (0011) |
| `ai_error_log` | 에러 로그 (0012) |
| `ai_memo_audit` | 메모 접근 감사 (0014) |

## 3. 기존 테스트

13개 테스트 스위트:
- `ai.test.js` - AI 서비스 단위 테스트
- `ai-tools.test.js`, `ai-tools-crud.test.js` - 도구 테스트
- `chat.test.js` - 채팅 라우팅·그룹핑
- `orchestrator.test.js` - 오케스트레이터
- `ask-marker.test.js` - [ASK:] 마커

## 4. 30개 고정 테스트

`phase0-fixed-tests.md`에 작성 완료. 5개 그룹 × 6개.

## 5. 기능 플래그

`ai_settings` 테이블 사용:
- 키: `ai.engine`
- 값: `legacy` (기본) | `function_calling`
- 서버에서만 변경 가능 (클라이언트 직접 변경 불가)

## 6. 재사용 가능 / 신규 구현 필요

### 재사용 가능
- `selectModel` - 모델 선택 로직 (어댑터로 래핑)
- `logUsage` - 사용량 기록 (필드 확장)
- `getSetting`/`setSetting` - 설정 관리
- `PERSONA_POLICY` - 비서 정책
- `injectDates` - 날짜 주입 (확장 필요)
- 마커 파싱 함수들 - 폴백용으로 유지

### 신규 구현 필요
- `src/ai/types.ts` - ToolCall, ToolResult, ModelStep 등 공통 타입
- `src/ai/providers/` - Gemini/Groq/Workers AI 어댑터
- `src/ai/tools/registry.ts` - Tool Registry
- `src/ai/runner.ts` - Agent Runner
- `src/ai/policies/` - 권한, 멱등성, 민감도
- `ai_tool_runs` 테이블 - 도구 실행 로그

## 7. Phase 1 주의사항

1. **Gemini Thought Signature**: 후속 요청에 반드시 포함 (누락 시 400)
2. **기존 마커와 병행**: 기능 플래그로 전환, 롤백 가능해야 함
3. **토큰 예산**: 8,000 = 요청당 누적 입력 상한으로 정의
4. **테스트 데이터**: 민감하지 않은 가상 데이터만 사용
5. **DB 변경**: 비파괴적 마이그레이션만, 운영 데이터 보호
