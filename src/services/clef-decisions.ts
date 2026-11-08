// Clef-flash 적극 활용: 5개 결정 기능 (2026-10-15)
// 1. 복합 요청 분해, 2. 도구 선택, 3. 응답 품질 판단, 4. 긴급도 분류, 5. 모델 선택

import type { ClefInvoker, PersonaId } from './router';

const MODEL = '@cf/cloudflare/clef-flash';

// ---------------------------------------------------------------------------
// 1. 복합 요청 분해: "A하고 B해줘" → ["A", "B"]
// ---------------------------------------------------------------------------

export type DecomposedTask = {
  description: string;
  persona: PersonaId;
};

export async function decomposeCompoundRequest(
  invoke: ClefInvoker,
  userMessage: string
): Promise<DecomposedTask[] | null> {
  const response = (await invoke({
    model: 'clef-flash',
    state: { current_message: userMessage },
    questions: {
      task_count: {
        type: 'choice',
        instructions: '사용자 요청에 포함된 독립적인 작업의 개수를 선택하라.',
        criteria: {
          one: '단일 작업',
          two: '두 개의 독립 작업',
          three: '세 개의 독립 작업',
        },
      } as any,
      tasks: {
        type: 'choice',
        instructions: '각 작업을 담당할 비서를 순서대로 선택하라.',
        criteria: {
          chat: '루미: 일상 대화',
          summarize: '에코: 요약/검색',
          code: '노바: 코드',
          schedule: '캘리: 일정',
        },
      } as any,
    },
  } as any)) as any;

  // TODO: 실제 응답 파싱 후 작업 목록 반환
  // 현재는 기본 구조만 제공
  return null;
}

// ---------------------------------------------------------------------------
// 2. 도구 선택: 비서 내부에서 사용할 도구 결정
// ---------------------------------------------------------------------------

export type ToolChoice = 'memo_search' | 'web_search' | 'summarize' | 'code_gen' | 'code_fix' | 'schedule_create' | 'schedule_read';

export async function selectTool(
  invoke: ClefInvoker,
  persona: PersonaId,
  userMessage: string
): Promise<ToolChoice | null> {
  const toolCriteria: Record<string, string> = {
    memo_search: '저장된 메모 검색',
    web_search: '웹 검색',
    summarize: '문서 요약',
    code_gen: '코드 생성',
    code_fix: '코드 수정',
    schedule_create: '일정 등록',
    schedule_read: '일정 조회',
  };

  const response = (await invoke({
    model: 'clef-flash',
    state: { current_message: userMessage, persona },
    questions: {
      tool: {
        type: 'choice',
        instructions: `${persona} 비서가 사용할 가장 적절한 도구를 선택하라.`,
        criteria: toolCriteria,
      } as any,
    },
  } as any)) as any;

  const choice = response?.answers?.tool?.choice;
  return choice ?? null;
}

// ---------------------------------------------------------------------------
// 3. 응답 품질 판단: 생성된 답변이 충분한지
// ---------------------------------------------------------------------------

export async function checkResponseQuality(
  invoke: ClefInvoker,
  userMessage: string,
  generatedResponse: string
): Promise<{ good: boolean; confidence: number }> {
  const response = (await invoke({
    model: 'clef-flash',
    state: {
      current_message: userMessage,
      generated_response: generatedResponse.slice(0, 2000),
    },
    questions: {
      quality: {
        type: 'choice',
        instructions: '생성된 답변이 사용자 요청에 충분히 답하는지 판단하라.',
        criteria: {
          good: '충분히 답변됨',
          poor: '불충분하거나 관련 없음',
        },
      } as any,
    },
  } as any)) as any;

  const answer = response?.answers?.quality;
  return {
    good: answer?.choice === 'good',
    confidence: answer?.probabilities?.good ?? 0,
  };
}

// ---------------------------------------------------------------------------
// 4. 긴급도 분류: 캘리용 우선순위
// ---------------------------------------------------------------------------

export type Urgency = 'urgent' | 'normal' | 'low';

export async function classifyUrgency(
  invoke: ClefInvoker,
  userMessage: string
): Promise<Urgency> {
  const response = (await invoke({
    model: 'clef-flash',
    state: { current_message: userMessage },
    questions: {
      urgency: {
        type: 'choice',
        instructions: '요청의 긴급도를 판단하라.',
        criteria: {
          urgent: '즉시 처리 필요 (급해, 지금, 빨리)',
          normal: '일반적인 요청',
          low: '여유 있음 (나중에, 천천히)',
        },
      } as any,
    },
  } as any)) as any;

  return response?.answers?.urgency?.choice ?? 'normal';
}

// ---------------------------------------------------------------------------
// 5. 모델 선택: 질문 복잡도에 따른 비용 최적화
// ---------------------------------------------------------------------------

export type ModelTier = 'fast' | 'balanced' | 'high';

export async function selectModelTier(
  invoke: ClefInvoker,
  userMessage: string
): Promise<ModelTier> {
  const response = (await invoke({
    model: 'clef-flash',
    state: { current_message: userMessage },
    questions: {
      complexity: {
        type: 'choice',
        instructions: '질문의 복잡도를 판단하여 적절한 모델 티어를 선택하라.',
        criteria: {
          fast: '간단한 질문 (인사, 단순 조회)',
          balanced: '보통 복잡도 (설명, 요약)',
          high: '높은 복잡도 (복잡한 코드, 심층 분석)',
        },
      } as any,
    },
  } as any)) as any;

  const choice = response?.answers?.complexity?.choice;
  if (choice === 'fast') return 'fast';
  if (choice === 'high') return 'high';
  return 'balanced';
}
