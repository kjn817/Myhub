# GPT 자문 요청: Clef-flash 라우터 아키텍처 (2026-10-15)

## 배경

MyHub는 4명의 AI 비서를 운영하는 1인용 개인 비서 시스템입니다.
사용자가 `@비서명` 멘션으로 직접 지정하지 않으면, 어떤 비서가 응답해야 할지 자동으로 판단해야 합니다.

현재는 사용자가 수동으로 `@루미`, `@에코`, `@노바`, `@캘리`를 지정합니다.
이를 자동화하기 위해 상단에 의도 분류용 라우터 모델을 두려고 합니다.

## 비서별 역할과 프로바이더 (2026-10-15 확정)

| 비서 | 역할 | 프로바이더 | 모델 | 선정 이유 |
|------|------|-----------|------|-----------|
| 루미 | 대표, 일상 대화 | Gemini | gemini-3.5-flash-lite | 한국어 최고 품질, 실측 완벽 작동 |
| 에코 | 기록, 검색, 요약 | NVIDIA | nvidia/nemotron-3-ultra-550b-a55b | 55B 최대 크기, 1M 컨텍스트, 장문 요약 최적. 사용자 실측 3개 키 모두 작동 확인 |
| 노바 | 코드, AI 스튜디오 | Gemini | gemini-3.5-flash-lite | HTML 생성 실측 성공 (유일하게 작동). NVIDIA 코딩 모델 전멸 |
| 캘리 | 일정, 할 일 | Groq | openai/gpt-oss-120b | 사용자 지시 "Groq는 캘리만", 현재 작동 중 |

### NVIDIA 모델 선정 과정 (중요)

2026-10-15 사용자가 직접 PowerShell로 14개 무료 모델을 3개 키로 전수 테스트:
- **작동 (7개)**: nemotron-3-ultra-550b, nemotron-3-super-120b, nemotron-3.5-lightning-30b, muse-glimmer-30b, diffusiongemma-26b, gpt-oss-20b, nemotron-3-nano-reasoning
- **실패 (7개)**: kimi-k3, laguna-xs-2.1, deepseek-v4.1-flash, glm-5.3, glm-5-3, glm-5-3-flash, gemma-4-31b-it

인기 코딩 모델은 전부 풀 포화 또는 계정 미지원으로 실패. NVIDIA 자체 Nemotron 모델만 작동.

## 제안 아키텍처: Clef-flash 라우터

### Clef-flash란?

Cloudflare가 2026-10-01에 발표한 결정(Decision) 모델:
- **모델 ID**: `@cf/cloudflare/clef-flash`
- **크기**: 9B 파라미터 (Qwen3.5-9B 기반)
- **속도**: 중앙값 39ms (매우 빠름)
- **정확도**: BANKING77 macro-F1 90.93
- **가격**: $0.09 / 백만 입력 토큰 (출력 토큰 무료)
- **특징**: 확률값 반환 (텍스트 생성 아님), Jev API 호환
- **용도**: 요청 분류, 라우팅 결정, yes/no, 다지선다, 우선순위 결정

형제 모델 `Clef` (27B, 209ms, F1 94.20)도 있으나, 라우터 용도로는 속도가 중요한 Clef-flash를 선택.

### 아키텍처 다이어그램

```
사용자 입력
    ↓
[Clef-flash 라우터] (@cf/cloudflare/clef-flash, 39ms)
    ↓ 의도 분류 (확률값)
    ├─→ 일상대화 (95%) → 루미 (Gemini)
    ├─→ 요약/기록 (90%) → 에코 (NVIDIA nemotron-ultra)
    ├─→ 코드/HTML (98%) → 노바 (Gemini)
    └─→ 일정/할일 (92%) → 캘리 (Groq)
```

### 라우팅 카테고리 정의

Clef-flash에게 미리 정의된 카테고리 중 확률이 가장 높은 것을 선택하도록 요청:

```json
{
  "categories": [
    {"id": "chat", "description": "일상 대화, 인사, 감정 공유, 잡담"},
    {"id": "summarize", "description": "요약, 기록, 검색, 정보 정리"},
    {"id": "code", "description": "코드 생성, HTML, 프로그래밍, 기술 질문"},
    {"id": "schedule", "description": "일정 등록/조회, 할 일 관리, 날짜/시간 관련"}
  ]
}
```

### 구현 방법 (초안)

**1단계: Clef-flash 호출**

```typescript
// src/services/router.ts (신규)
import { Ai } from '@cloudflare/workers-types';

async function classifyIntent(ai: Ai, userMessage: string): Promise<string> {
  const response = await ai.run('@cf/cloudflare/clef-flash', {
    messages: [
      { role: 'user', content: userMessage }
    ],
    // Clef-flash는 Jev API 호환 - 카테고리 정의 방식 확인 필요
    categories: ['chat', 'summarize', 'code', 'schedule'],
  });
  // response에서 가장 확률 높은 카테고리 ID 반환
  return response.category; // 실제 응답 형식 확인 필요
}
```

**2단계: 카테고리 → 비서 매핑**

```typescript
const CATEGORY_TO_PERSONA = {
  'chat': 'lumi',      // Gemini
  'summarize': 'echo', // NVIDIA nemotron-ultra
  'code': 'nova',      // Gemini
  'schedule': 'cali',  // Groq
};
```

**3단계: 기존 채팅 플로우에 통합**

```typescript
// src/modules/ai/routes.ts (/api/ai/chat)
async function handleChat(c, userMessage) {
  // 사용자가 @멘션으로 직접 지정했으면 라우터 스킵
  const explicitPersona = extractMention(userMessage); // @루미, @에코 등
  let personaId;
  
  if (explicitPersona) {
    personaId = explicitPersona;
  } else {
    // Clef-flash로 자동 분류 (39ms, 무시할 수준)
    const category = await classifyIntent(c.env.AI, userMessage);
    personaId = CATEGORY_TO_PERSONA[category] || 'lumi'; // 기본값: 루미
  }
  
  // 기존 로직대로 해당 비서로 처리
  return await processWithPersona(c, personaId, userMessage);
}
```

## GPT에게 묻고 싶은 것

### Q1. Clef-flash API 사용법
Cloudflare 문서에 Clef-flash의 정확한 API 호출 방법이 명시되어 있나요?
- Workers AI의 `ai.run()`으로 호출 가능한가요?
- 카테고리를 어떻게 정의하나요? (Jev API 호환이라는데 구체적인 요청 형식)
- 응답에서 확률값은 어떤 형식으로 오나요?

### Q2. 라우터 아키텍처의 타당성
- 39ms의 추가 지연이 사용자 경험에 미치는 영향은 무시할 수준인가요?
- 의도 분류 실패 시 폴백 전략은? (기본값을 루미로 하는 것이 적절한가?)
- 사용자가 @멘션으로 명시적 지정한 경우 라우터를 스킵하는 것이 맞는가?

### Q3. 카테고리 정의의 적절성
현재 4개 카테고리 (chat, summarize, code, schedule)로 충분한가?
- "검색해줘"는 summarize인가 chat인가?
- "메모해줘"는 어디에 속하는가?
- 더 세분화해야 할 카테고리가 있는가?

### Q4. 비용 최적화
- Clef-flash는 $0.09/백만 토큰. 매 요청마다 호출하면 비용이 얼마나 드는가?
- 캐싱 전략이 필요한가? (예: "안녕" 같은 간단한 인사는 라우터 없이 바로 루미로)
- 배치 처리 (최대 64개 질문을 한 번에)가 유용한 시나리오가 있는가?

### Q5. 대안 검토
- Clef (27B, 209ms, F1 94.20) 대신 Clef-flash (9B, 39ms, F1 90.93)를 선택한 것이 타당한가?
- 정확도 3.3% 차이가 라우팅에서 치명적인가?
- 아니면 규칙 기반 (키워드 매칭)으로 충분한가? (예: "일정" 포함 → 캘리)

### Q6. 구현 시 주의점
- Workers AI 바인딩 설정에 특별한 것이 필요한가?
- Clef-flash가 아직 베타인가? 프로덕션 사용에 문제없는가?
- 확률 임계값 (threshold)을 설정해야 하는가? (예: 70% 미만이면 루미로 폴백)

## 참고 자료

- Cloudflare 발표 (2026-10-01): Clef와 Clef-flash는 Workers AI 팀이 직접 학습한 첫 모델
- 모델 ID: `@cf/cloudflare/clef`, `@cf/cloudflare/clef-flash`
- Hugging Face: Apache 2.0 라이선스로 오픈 웨이트 공개
- API 호환: Jev API와 호환 (엔드포인트와 모델명만 변경하면 마이그레이션 가능)
- 벤치마크: BANKING77에서 Clef 94.20, Clef-flash 90.93, Jev 79.74

## 현재 상태

- [x] 4개 비서별 프로바이더 확정 (사용자 승인)
- [x] NVIDIA 작동 모델 7개로 정리 (사용자 실측)
- [ ] Clef-flash 라우터 구현 (GPT 자문 후)
- [ ] 카테고리 정의 확정 (GPT 자문 후)
- [ ] 통합 테스트

---
*작성: 2026-10-15, Muse*
*용도: GPT 자문 요청용*
