# TimelyAI / Sol 질문용 프롬프트 — 웹검색 안전하게 재활성화하기

아래를 복사해서 TimelyAI나 Sol에게 붙여넣으세요.

---

## 현재 상태 (안정화됨)

Cloudflare Workers + Hono + D1 기반 개인 AI 비서 시스템.
며칠간의 장애 끝에 기본 채팅이 안정화됨.

**현재 동작:**
- 루미(대화 비서): Gemini 모델로 기본 대화 정상 ("@루미 안녕?" → 정상 인사 응답)
- 실시간 질문(날씨, 뉴스)에는 "실시간 확인이 어려워요"라고 정직하게 답변 (빈 응답으로 멈추지 않음)
- 도구 관련 파라미터 전부 제거된 상태 (Gemini Google Search grounding 제거, Groq function calling 제거)
- Jest 테스트 25개 통과, 배포 검증 통과

**안정화 과정에서 배운 것:**
1. 시스템 프롬프트에 존재하지 않는 도구(`web_search`) 언급이 있으면 모델이 없는 도구 호출을 시도하다 멈춤 → 프롬프트에서 도구 언급 제거함
2. `logUsage` D1 기록이 try 블록 안에 있어서 D1 실패가 모델 실패로 오인됨 → try-catch로 분리함
3. 메시지 정규화 추가 (role 검증, 빈 content 제거)

## 목표

**Gemini의 Google Search grounding을 다시 활성화해서 실시간 웹검색이 되게 하기.**
사용자가 "웹검색이 가장 중요하다"고 명시함. ChatGPT/Claude 수준의 실시간 정보 답변을 원함.

## 이전 실패 기록

Google Search grounding을 활성화했을 때 (`body.tools = [{ google_search: {} }]`):
- 모든 Gemini 호출이 "AI 호출 실패"로 실패했음
- 기본 인사("@루미 안녕?")조차 실패
- 도구를 제거하자 기본 채팅이 복구됨

**의문점:** Google Search grounding이 기본 채팅까지 망가뜨린 이유가 불명확함.
가설:
- (a) 특정 Gemini 모델이 `google_search` 도구를 지원하지 않음
- (b) Deno 릴레이 경유 시 tools 파라미터가 깨짐
- (c) grounding 파라미터 형식이 잘못됨 (`{ google_search: {} }` vs 다른 형식)
- (d) 다른 원인 (당시에는 로그가 없어서 확인 불가, 현재는 `ai_error_log` 테이블에 기록 중)

## 현재 코드 (관련 부분)

```python
async def callGemini(env, key, model, messages):
    system = ...  # system 메시지 추출
    contents = ...  # OpenAI 형식을 Gemini 형식으로 변환
    body = {"contents": contents}
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    # 현재 비활성화됨:
    # body["tools"] = [{"google_search": {}}]
    
    try:
        return await callGeminiDirect(key, model, body)  # 직접 호출
    except:
        return await callGeminiViaRelay(env, key, model, body)  # Deno 릴레이 경유
```

사용 중인 Gemini 모델:
- gemini-2.5-flash (fast)
- gemini-3.7-flash (balanced)
- gemini-3.5-flash (balanced)
- gemini-3.8-flash (high)

## 질문

1. **Google Search grounding이 기본 채팅까지 실패시킨 가장 유력한 원인은?**
   위 가설 (a)-(d) 중 어떤 게 가장 가능성 높고, 어떻게 검증해야 하는가?

2. **안전한 점진적 활성화 전략은?**
   - 특정 모델(예: gemini-2.5-flash)부터 먼저 적용해보는 게 나은가?
   - 아니면 `google_search` 대신 다른 grounding 방식이 있는가?
   - grounding 실패 시 자동으로 tools 없이 재시도하는 fallback이 좋은 패턴인가?

3. **Grounding 응답에서 출처/링크를 추출하는 방법은?**
   Gemini API의 grounding metadata에서 검색 출처 URL을 파싱해서 UI에 표시하고 싶음.
   `candidates[0].groundingMetadata` 구조에서 무엇을 추출해야 하는가?

4. **대안: Gemini grounding 대신 별도 검색 API를 쓰는 게 나은가?**
   - 예: Tavily, Brave Search API 등을 Worker에서 직접 호출 후 결과를 프롬프트에 주입
   - 이 방식 vs Gemini 네이티브 grounding의 장단기 (비용, 지연시간, 안정성, 무료 티어 기준)

5. **시스템 프롬프트는 어떻게 해야 하는가?**
   현재는 "실시간 정보는 모르면 모른다고 해"로 되어 있음.
   grounding을 활성화하면 "필요하면 검색해서 답해"로 바꿔야 하는가?
   아니면 grounding은 모델이 자동으로 판단하므로 프롬프트를 건드리지 않아도 되는가?
