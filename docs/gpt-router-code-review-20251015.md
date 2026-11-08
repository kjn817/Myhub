# GPT 코드 리뷰 요청: Clef-flash 라우터 구현 (2026-10-15)

## 개요

GPT 자문을 받아 구현한 `src/services/router.ts`의 코드 리뷰를 요청합니다.
이전 자문에서 제공해주신 API 형식(`model`/`state`/`questions`)과 아키텍처(3단계)를 반영했습니다.

## 현재 상태

- ✅ `src/services/router.ts` 생성 완료
- ⚠️ 기존 `orchestrator.ts`와 인터페이스 충돌 (아직 통합 전)
- ❌ 실제 Cloudflare API 호출 테스트 미완료

## 코드 원문

```typescript
// Clef-flash 자동 라우터 (2026-10-15)
// GPT 자문 기반 구현: https://developers.cloudflare.com/workers-ai/models/clef-flash/
// 3단계: @멘션 → 규칙/문맥 → Clef-flash
// 기존 키워드 기반 라우터를 대체

import type { Ai } from '@cloudflare/workers-types';

export type PersonaId = 'lumi' | 'echo' | 'nova' | 'cali';

export type Category = 'chat' | 'summarize' | 'code' | 'schedule' | 'unclear';

export type RouteResult = {
  persona: PersonaId | null;
  source: 'rule' | 'clef' | 'fallback';
  reason: string;
  confidence?: number;
};

export type RouteContext = {
  previousPersona?: PersonaId;
  previousMessage?: string;
};

type ClefResponse = {
  answers?: {
    assistant?: {
      choice?: string;
      confidence?: number;
      probabilities?: Record<string, number>;
    };
    multiple_actions?: {
      noul?: number;
    };
  };
};

const MODEL = '@cf/cloudflare/clef-flash';

const PERSONA_MAP: Record<Exclude<Category, 'unclear'>, PersonaId> = {
  chat: 'lumi',
  summarize: 'echo',
  code: 'nova',
  schedule: 'cali',
};

const CRITERIA = {
  chat:
    '루미: 일상 대화, 일반적인 설명, 상담, 잡담. ' +
    '단순 날짜나 시간에 관한 지식 질문도 포함한다.',

  summarize:
    '에코: 문서 요약, 과거 기록 검색, 메모, ' +
    '정보 수집 및 자료 정리.',

  code:
    '노바: 프로그래밍, 코드 수정, 디버깅, ' +
    'HTML 생성, AI 스튜디오 앱 개발.',

  schedule:
    '캘리: 일정이나 할 일의 등록, 조회, 변경, 삭제, ' +
    '알림 및 리마인더 관리.',

  unclear:
    '요청의 의미가 불명확하거나 담당 비서를 ' +
    '결정하기에 정보가 부족한 경우.',
} as const;

function isCategory(value: string): value is Category {
  return Object.prototype.hasOwnProperty.call(CRITERIA, value);
}

function needsCarefulFallback(message: string): boolean {
  return /(등록|추가|변경|삭제|취소|저장|예약|알려줘|리마인드)/.test(message);
}

function fallback(message: string): RouteResult {
  if (needsCarefulFallback(message)) {
    return {
      persona: null,
      source: 'fallback',
      reason: 'action_needs_explicit_routing',
    };
  }
  return {
    persona: 'lumi',
    source: 'fallback',
    reason: 'safe_default',
  };
}

/**
 * 사용자 의도를 분류하여 담당 비서를 결정
 * @param ai Workers AI 바인딩
 * @param userMessage 사용자 메시지
 * @param context 이전 대화 문맥 (선택)
 * @returns 라우팅 결과
 */
export async function classifyIntent(
  ai: Ai,
  userMessage: string,
  context: RouteContext = {}
): Promise<RouteResult> {
  const message = userMessage.trim();

  // 1. 빈 입력
  if (!message) {
    return { persona: null, source: 'rule', reason: 'empty_message' };
  }

  // 2. 단순 인사는 모델 호출 생략 (비용 절감)
  if (/^(안녕|안녕하세요|하이|hi|hello)[!?.~ ]*$/i.test(message)) {
    return { persona: 'lumi', source: 'rule', reason: 'simple_greeting' };
  }

  // 3. 명확한 후속 요청은 이전 비서 유지
  if (
    context.previousPersona &&
    /^(계속|계속해|이어서 해줘|더 자세히 설명해줘)[!?.~ ]*$/.test(message)
  ) {
    return {
      persona: context.previousPersona,
      source: 'rule',
      reason: 'conversation_continuation',
    };
  }

  try {
    // 4. Clef-flash 공식 API 호출
    const response = (await ai.run(MODEL, {
      model: 'clef-flash',
      state: {
        current_message: message,
        previous_message: context.previousMessage?.slice(0, 1000) ?? '',
        previous_persona: context.previousPersona ?? null,
      },
      questions: {
        assistant: {
          type: 'choice',
          instructions:
            '현재 사용자 요청을 실제로 처리해야 할 ' +
            'MyHub 비서를 하나 선택하라. ' +
            '주제가 아니라 필요한 작업과 도구를 기준으로 ' +
            '판단하라. 이전 대화는 문맥 파악에만 사용하라.',
          criteria: CRITERIA,
        },
        multiple_actions: {
          type: 'noul',
          instructions:
            '서로 다른 비서가 담당해야 하는 ' +
            '독립적인 작업이 둘 이상 포함되어 있는가?',
        },
      },
    } as any)) as ClefResponse;

    // 5. 응답 형식 검증
    const answer = response.answers?.assistant;
    const selected = answer?.choice;
    const probabilities = answer?.probabilities;

    if (!selected || !isCategory(selected) || !probabilities) {
      return fallback(message);
    }

    const ranked = Object.entries(probabilities)
      .filter(
        ([id, value]) =>
          isCategory(id) &&
          Number.isFinite(value) &&
          value >= 0 &&
          value <= 1
      )
      .sort((a, b) => b[1] - a[1]);

    if (ranked.length < 2) {
      return fallback(message);
    }

    const [topCategory, topProbability] = ranked[0];
    const secondProbability = ranked[1][1];
    const margin = topProbability - secondProbability;

    // 6. 신뢰도 부족 시 폴백 (GPT 권장: p1≥0.70, p1-p2≥0.15)
    if (
      selected !== topCategory ||
      selected === 'unclear' ||
      topProbability < 0.7 ||
      margin < 0.15
    ) {
      return {
        persona: null,
        source: 'fallback',
        reason: 'low_confidence',
        confidence: topProbability,
      };
    }

    // 7. 복합 요청 감지
    const multiple = response.answers?.multiple_actions?.noul ?? 0;
    if (multiple >= 0.8) {
      return {
        persona: null,
        source: 'fallback',
        reason: 'multiple_actions',
        confidence: topProbability,
      };
    }

    return {
      persona: PERSONA_MAP[selected as Exclude<Category, 'unclear'>],
      source: 'clef',
      reason: 'classified',
      confidence: topProbability,
    };
  } catch (e) {
    // 분류 실패 시 재시도 없이 폴백 (무한 루프 방지)
    console.error('[router] Clef-flash failed:', e);
    return fallback(message);
  }
}

/**
 * @멘션에서 명시적 비서 지정 추출
 * @param message 사용자 메시지
 * @returns 비서 ID 또는 null
 */
export function extractMention(message: string): PersonaId | null {
  const lower = message.toLowerCase();
  if (/@루미|@lumi/.test(lower)) return 'lumi';
  if (/@에코|@echo/.test(lower)) return 'echo';
  if (/@노바|@nova/.test(lower)) return 'nova';
  if (/@캘리|@cali|@calli/.test(lower)) return 'cali';
  return null;
}

// 하위 호환성: 기존 RouterDecision 인터페이스
export interface LegacyRouteContext {
  historySummary?: string;
  suggestedPersonaId?: string;
}

export interface RouterDecision {
  primary: string;
  collaborator?: string;
  reason: string;
}

// 하위 호환성: 기존 export들
export function isValidPersonaId(id: string): boolean {
  return ['lumi', 'echo', 'nova', 'cali'].includes(id);
}

export class KeywordRouter {
  // 기존 키워드 기반 라우터 (더 이상 사용 안 함, Clef-flash로 대체)
  // 하위 호환성을 위해 빈 클래스로 유지
}

export interface Router {
  // 기존 라우터 인터페이스 (하위 호환성)
}
```

## 리뷰 요청 사항

### 1. API 호출 형식 검증
- `ai.run('@cf/cloudflare/clef-flash', {...})`의 파라미터 구조가 공식 문서와 일치하는가?
- `state`에 `current_message`, `previous_message`, `previous_persona`를 넣는 방식이 적절한가?
- `questions.assistant`의 `type: 'choice'`, `instructions`, `criteria` 구조가 맞는가?
- `multiple_actions`의 `type: 'noul'` 사용법이 올바른가?

### 2. TypeScript 타입 안정성
- `as any` 캐스팅을 사용한 부분 (ai.run 호출 시)이 불가피한가? 더 나은 방법이 있는가?
- `ClefResponse` 타입 정의가 실제 응답과 일치하는가?
- `isCategory` 타입 가드의 구현이 적절한가?

### 3. 로직 검증
- 3단계 (빈입력 → 인사 → 후속요청 → Clef) 순서가 적절한가?
- 정규식 `/^(안녕|안녕하세요|하이|hi|hello)[!?.~ ]*$/i`가 한국어 인사를 충분히 커버하는가?
- `needsCarefulFallback`의 키워드 목록이 적절한가? (등록|추가|변경|삭제|취소|저장|예약|알려줘|리마인드)
- 임계값 0.70과 마진 0.15가 한국어 요청에도 적절한가?

### 4. 에러 처리
- `catch`에서 무조건 `fallback()`으로 가는 것이 맞는가?
- 네트워크 오류, 타임아웃, 429 등을 구분해서 처리해야 하는가?
- `console.error` 로깅이 적절한가? (민감정보 노출 위험은 없는가?)

### 5. 하위 호환성
- 기존 `KeywordRouter`, `isValidPersonaId`, `Router`를 빈 껍데기로 유지한 방식이 적절한가?
- 아니면 기존 코드를 완전히 제거하고 사용하는 곳을 모두 수정해야 하는가?
- `LegacyRouteContext`, `RouterDecision` 인터페이스는 아직 필요한가?

### 6. 성능 최적화
- 매 요청마다 Clef-flash를 호출하는 것이 비용 효율적인가?
- 인사말 외에 추가로 규칙 기반 단축 경로를 둘 만한 경우가 있는가?
- `previous_message`를 1000자로 자르는 것이 적절한가?

### 7. 보안
- 사용자 메시지를 그대로 `state`에 넣어도 되는가? (프롬프트 인젝션 위험?)
- `CRITERIA`의 한국어 설명이 모델에게 충분히 명확한가?
- 악의적 입력으로 라우터를 속일 수 있는가?

## 통합 전 해결해야 할 문제

현재 `src/services/orchestrator.ts`가 기존 라우터 인터페이스를 사용 중이라 TypeScript 컴파일 에러 발생:
- `Module '"../../services/router"' has no exported member 'isValidPersonaId'` → 해결됨 (추가함)
- `Module '"./router"' has no exported member 'KeywordRouter'` → 해결됨 (빈 클래스 추가)
- `Object literal may only specify known properties, and 'confidence' does not exist in type 'RouterDecision'` → 미해결

`orchestrator.ts`의 기존 코드를 새 `RouteResult` 인터페이스에 맞게 수정해야 하는지, 아니면 어댑터를 만들어야 하는지 조언 부탁드립니다.

---
*작성: 2026-10-15, Muse*
*기반: GPT 자문 (2026-10-15)*
