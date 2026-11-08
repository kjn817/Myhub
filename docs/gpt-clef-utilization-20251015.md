# GPT 자문 요청: MyHub 시스템 아키텍처 및 Clef 적극 활용 방안 (2026-10-15)

## 1. MyHub 시스템 개요

MyHub는 1인용 개인 비서 시스템입니다 (사용자: 김정남).
4명의 AI 비서가 각자의 전문 영역을 담당합니다.

### 1.1 비서별 역할 및 프로바이더 (2026-10-15 확정)

| 비서 | ID (신규/기존) | 역할 | 프로바이더 | 모델 |
|------|---------------|------|-----------|------|
| 루미 | lumi / concierge | 일상대화, 일반 상담 | Gemini | gemini-3.5-flash-lite |
| 에코 | echo / keeper | 기록, 검색, 요약 | NVIDIA | nvidia/nemotron-3-ultra-550b-a55b |
| 노바 | nova / builder | 코드, AI 스튜디오 | Gemini | gemini-3.5-flash-lite |
| 캘리 | cali / scheduler | 일정, 할 일 | Groq | openai/gpt-oss-120b |

**참고:**
- Gemini가 루미+노바 2개를 담당 (NVIDIA 코딩 모델 전멸로 인한 결정)
- Workers AI는 비서용으로 사용하지 않음
- Workers AI는 Clef-flash 라우터 전용

### 1.2 기술 스택
- Cloudflare Workers + Hono
- D1 (SQLite)
- 4개 외부 AI 프로바이더 (Gemini, NVIDIA, Groq, Workers AI)

---

## 2. Clef-flash 라우터 아키텍처 (현재 구현)

### 2.1 기본 라우팅 흐름

```
사용자 메시지
    ↓
[1단계: 명시적 멘션 검사]
    @루미/@에코/@노바/@캘리 → 해당 비서로 직접 (Clef 스킵)
    ↓ (멘션 없음)
[2단계: 규칙 기반]
    - 빈 입력 → null
    - 단순 인사 ("안녕") → 루미 (Clef 스킵)
    - 명확한 후속 요청 ("계속해") → 이전 비서 유지
    ↓ (규칙 해당 없음)
[3단계: Clef-flash 호출]
    ↓
[ID 어댑터] (신규 ID → 기존 ID 변환)
    lumi→concierge, echo→keeper, nova→builder, cali→scheduler
    ↓
[Orchestrator] (기존 실행 로직)
    ↓
[비서 실행]
```

### 2.2 구현 파일

| 파일 | 역할 |
|------|------|
| `src/services/router.ts` | Clef-flash 라우터 코어 (GPT 수정본) |
| `src/services/legacy-router.ts` | 기존 키워드 라우터 (보존) |
| `src/services/legacy-adapter.ts` | 레거시 타입 어댑터 |
| `src/services/persona-id-adapter.ts` | 신규↔기존 ID 변환 + `resolveClefRoute()` |
| `src/services/clef-decisions.ts` | 5개 추가 결정 기능 (신규) |
| `src/services/orchestrator.ts` | Feature Flag 분기 + `resolveClefRoute` 적용 |

### 2.3 Feature Flag

```typescript
// wrangler.toml
CLEF_ROUTER_ENABLED = "false"  // 현재 비활성화 (E2E 문제 수정 중)
```

- `false`: 기존 레거시 라우터 사용
- `true`: Clef-flash 라우터 사용

### 2.4 Clef-flash API 사용법 (검증 완료)

```typescript
const response = await ai.run('@cf/cloudflare/clef-flash', {
  model: 'clef-flash',
  state: {
    current_message: message,
    previous_message: '...',
    previous_persona: 'lumi',
    active_workflow: false,
  },
  questions: {
    assistant: {
      type: 'choice',
      instructions: '...',
      criteria: {
        chat: '루미: 일상 대화...',
        summarize: '에코: 요약...',
        code: '노바: 코드...',
        schedule: '캘리: 일정...',
        unclear: '분류 불가...',
      },
    },
    multiple_actions: {
      type: 'noul',
      instructions: '독립적인 작업이 둘 이상인가?',
    },
  },
});
```

**검증 결과:**
- 실제 API 호출 5건 전부 성공
- 분류 정확도 높음 (신뢰도 92-97%)
- 응답 시간: 약 200-500ms (네트워크 포함)

---

## 3. 새로 추가된 5개 Clef 결정 기능

`src/services/clef-decisions.ts`에 구현됨 (아직 채팅 플로우에 미연결).

### 3.1 복합 요청 분해 (`decomposeCompoundRequest`)
- 입력: "회의 등록하고 요약해줘"
- 출력: `[{description: "회의 등록", persona: "cali"}, {description: "요약", persona: "echo"}]`
- 상태: 기본 구조만 구현, 실제 파싱 로직 미완성

### 3.2 도구 선택 (`selectTool`)
- 비서 내부에서 사용할 도구 결정
- 선택지: memo_search, web_search, summarize, code_gen, code_fix, schedule_create, schedule_read
- 상태: 함수 구현 완료, 미연결

### 3.3 응답 품질 판단 (`checkResponseQuality`)
- 생성된 답변이 충분한지 yes/no
- 출력: `{good: boolean, confidence: number}`
- 상태: 함수 구현 완료, 미연결

### 3.4 긴급도 분류 (`classifyUrgency`)
- 출력: 'urgent' | 'normal' | 'low'
- 용도: 캘리 일정 우선순위
- 상태: 함수 구현 완료, 미연결

### 3.5 모델 선택 (`selectModelTier`)
- 출력: 'fast' | 'balanced' | 'high'
- 용도: 질문 복잡도에 따른 비용 최적화
- 상태: 함수 구현 완료, 미연결

---

## 4. 현재 문제점 (E2E 테스트에서 발견)

### 4.1 에코 응답 문제 (P0, 미해결)
- 증상: "지난 대화 내용을 요약해줘" → "지난 대화 내용은 없습니다. 새로운 메모가 생성되었습니다."
- 원인: 대화 기록에 접근하지 못함. 대신 이상한 메모를 생성함 ("잘못 함돔 소년 요주들" 같은 깨진 텍스트)
- 추가 발견: 에코가 Workers AI 모델을 사용 중이었음 (현재 NVIDIA로 변경됨)

### 4.2 노바 권한 문제 (P0, 수정 완료)
- 증상: "(이 비서는 해당 도구를 사용할 권한이 없습니다)"
- 원인: `VALID_PERSONAS`가 신규 ID를 포함하지 않음
- 수정: `normalizeLegacyPersonaId()`로 정규화 (배포 완료)

### 4.3 복합 요청 처리 (P0, 수정 완료)
- 증상: "회의 등록하고 요약해줘" → 에코 단독으로 라우팅
- 원인: `persona: null`을 예외로 처리하여 레거시 라우터로 폴백
- 수정: `resolveClefRoute()`로 정상 분류 결과로 처리 (배포 완료)

---

## 5. GPT에게 묻고 싶은 것: Clef 적극 활용 방안

### 5.1 결정 배치화 (Batching)
Clef는 한 요청에 최대 64개 질문을 지원합니다.

**현재:**
```
호출 1: 어떤 비서? (40ms)
호출 2: 긴급도? (40ms)
호출 3: 모델 티어? (40ms)
총: 120ms, 3회 과금
```

**제안:**
```typescript
questions: {
  assistant: {...},
  urgency: {...},
  model_tier: {...},
  is_compound: {...},
}
// 총: 40ms, 1회 과금 (3배 빠름, 3배 저렴)
```

**질문:**
1. 배치화된 질문들이 서로 영향을 주는가? (예: 긴급도가 비서 선택에 영향)
2. 하나의 질문이 실패하면 전체가 실패하는가, 아니면 부분 결과를 얻을 수 있는가?
3. 64개 제한 내에서 실용적인 최대 배치 크기는?

### 5.2 조기 종료 (Early Exit)
단순한 요청은 Clef나 비서 모델을 호출하지 않고 처리.

**제안:**
```
"안녕" → 규칙 기반 → 루미 인사 (모델 호출 없음)
"고마워" → 정적 응답 (모델 호출 없음)
"도움말" → 캐시된 답변 (모델 호출 없음)
```

**질문:**
1. 어떤 패턴을 조기 종료 대상으로 삼아야 하는가?
2. Clef를 사용해서 "이 요청은 단순한가?"를 판단하는 것이 비용 효율적인가?
   (Clef 호출 비용 vs 모델 호출 절감 비용)
3. 캐시 키 설계 시 고려사항은?

### 5.3 컨텍스트 최적화
대화가 길어지면 Clef로 요약 필요성을 판단.

**제안:**
```typescript
// 매 10개 메시지마다
const needSummary = await clef.questions({
  summarize_needed: {
    type: 'noul',
    instructions: '대화 기록을 요약해야 하는가?',
  }
});
if (needSummary > 0.7) {
  // 요약 실행
}
```

**질문:**
1. 요약 트리거 기준으로 토큰 수 vs 메시지 수 중 어느 것이 나은가?
2. 요약 시 원본 대화의 어떤 정보를 보존해야 하는가?
3. Clef 호출 빈도를 어떻게 조절해야 하는가? (매 요청 vs 주기적)

### 5.4 폴백 지능화
모델 실패 시 Clef로 최적 복구 경로 결정.

**현재:**
```
모델 실패 → 무조건 다음 모델로 폴백 (고정 순서)
```

**제안:**
```typescript
questions: {
  recovery: {
    type: 'choice',
    criteria: {
      retry: '같은 모델로 재시도',
      fallback: '다른 모델로 전환',
      ask_user: '사용자에게 확인',
      abort: '중단하고 오류 안내',
    }
  }
}
```

**질문:**
1. 재시도 vs 폴백의 결정 기준은 무엇인가? (오류 코드, 시도 횟수, 시간 등)
2. 사용자에게 묻는 경우와 자동 처리하는 경우를 어떻게 구분하는가?
3. 폴백 체인이 무한 루프에 빠지지 않도록 하는 방법은?

### 5.5 스트리밍 최적화
응답 길이를 예측하여 UI 전략 결정.

**제안:**
```typescript
questions: {
  response_length: {
    type: 'choice',
    criteria: {
      short: '짧은 답변 (1-2문장)',
      medium: '보통 (1단락)',
      long: '긴 답변 (여러 단락, 코드 포함)',
    }
  }
}
```

**질문:**
1. 길이 예측의 정확도가 실용적인 수준인가?
2. 예측이 틀렸을 때의 대응 방안은?
3. 이 최적화가 사용자 체감 속도에 미치는 영향은?

### 5.6 기타 아이디어
- **언어 감지**: 한국어 vs 영어 vs 혼합 (프롬프트 최적화)
- **감정 분석**: 사용자가 화났는지, 급한지 (응대 톤 조절)
- **중복 질문 감지**: 이전에 답한 질문인지 (캐시 활용)
- **개인정보 감지**: 민감정보 포함 여부 (보안 강화)

**질문:**
1. 위 아이디어 중 실용성이 높은 것은?
2. Clef의 39ms 지연이 매 요청마다 추가되는 것이 부담되는가?
3. 결정 결과를 캐싱하는 전략이 유효한가? (예: "안녕" → 항상 루미)

---

## 6. 제약 조건

1. **1인 시스템**: 동시 사용자는 1명, 트래픽이 적음
2. **비용 민감도**: 무료 티어 위주, Clef $0.038/백만 토큰은 저렴한 편
3. **지연 민감도**: 39ms는 체감하기 어려우나, 누적되면 영향 있음
4. **안정성 우선**: 새로운 기능보다 기존 기능 보호가 중요
5. **한국어 특화**: 모든 판단은 한국어 요청 기준

---

## 7. 요청사항

1. 위 5개 활용 방안(배치화, 조기종료, 컨텍스트, 폴백, 스트리밍)의 우선순위와 타당성을 평가해주세요.
2. 각 방안에 대한 구체적인 구현 방법과 주의점을 알려주세요.
3. Clef 호출을 남발하지 않으면서도 적극 활용하는 균형점을 제안해주세요.
4. 현재 아키텍처에서 가장 먼저 적용해야 할 것을 하나만 꼽아주세요.

---
*작성: 2026-10-15, Muse*
*목적: Clef 적극 활용을 통한 성능 향상 방안 자문*
