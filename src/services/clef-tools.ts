// Clef 도구 라우터 (2026-10-15)
// 각 모듈의 도구를 AI에게 쥐어주기 전, Clef로 최적 도구 선택

import type { ClefInvoker, PersonaId } from './router';

// 모듈별 사용 가능한 도구 정의
export const MODULE_TOOLS: Record<string, string[]> = {
  memo: ['memo_create', 'memo_create_from_source', 'memo_search', 'memo_get', 'memo_update', 'memo_delete', 'memo_ui_action'],
  schedule: ['schedule_create', 'schedule_read', 'schedule_update', 'schedule_delete'],
  todo: ['todo_create', 'todo_read', 'todo_update', 'todo_delete', 'todo_complete'],
  search: ['web_search', 'memo_search'],
  file: ['file_upload', 'file_read'],
};

// 비서별 허용 도구 (기존 getLegacyMarkerTools와 일치)
const PERSONA_TOOLS: Record<PersonaId, string[]> = {
  lumi: ['web_search', 'memo_search'],  // concierge
  echo: ['memo_create', 'memo_search', 'memo_get', 'memo_update', 'memo_delete', 'memo_ui_action', 'web_search'],  // keeper - 전체 메모 도구
  nova: ['web_search', 'file_upload', 'file_read'],  // builder
  cali: ['schedule_create', 'schedule_read', 'schedule_update', 'schedule_delete', 'todo_create', 'todo_read', 'todo_update', 'todo_delete', 'todo_complete'],  // scheduler
};

export type ToolPlan = {
  tools: string[];
  sequence: 'sequential' | 'parallel';
  reason: string;
};

/**
 * 사용자 요청에 필요한 도구들을 Clef로 결정
 * @param invoke Clef 호출 함수
 * @param persona 비서 ID
 * @param userMessage 사용자 메시지
 * @returns 도구 실행 계획
 */
export async function planTools(
  invoke: ClefInvoker,
  persona: PersonaId,
  userMessage: string
): Promise<ToolPlan | null> {
  const allowedTools = PERSONA_TOOLS[persona] || [];
  
  if (allowedTools.length === 0) {
    return null;
  }

  // 도구를 카테고리별로 그룹화하여 선택지 구성
  const toolCriteria: Record<string, string> = {};
  for (const tool of allowedTools) {
    toolCriteria[tool] = getToolDescription(tool);
  }
  toolCriteria['none'] = '도구 사용 불필요, 직접 답변 가능';

  const response = (await invoke({
    model: 'clef-flash',
    state: {
      current_message: userMessage,
      persona,
      allowed_tools: allowedTools.join(', '),
    },
    questions: {
      primary_tool: {
        type: 'choice',
        instructions: `${persona} 비서가 이 요청을 처리하기 위해 사용할 가장 적절한 도구를 선택하라. 도구 없이 직접 답변이 가능하면 none을 선택하라.`,
        criteria: toolCriteria,
      } as any,
      needs_second_tool: {
        type: 'noul',
        instructions: '첫 번째 도구 외에 추가로 필요한 도구가 있는가?',
      } as any,
    },
  } as any)) as any;

  const primaryTool = response?.answers?.primary_tool?.choice;
  if (!primaryTool || primaryTool === 'none') {
    return { tools: [], sequence: 'sequential', reason: 'no_tool_needed' };
  }

  const tools = [primaryTool];
  const needsSecond = response?.answers?.needs_second_tool?.noul ?? 0;
  
  // TODO: 두 번째 도구 선택 로직 (현재는 기본 구조만)
  
  return {
    tools,
    sequence: 'sequential',
    reason: 'clef_selected',
  };
}

function getToolDescription(tool: string): string {
  const descriptions: Record<string, string> = {
    memo_create: '새 메모 생성',
    memo_create_from_source: '원본에서 메모 생성',
    memo_search: '메모 검색',
    memo_get: '메모 조회',
    memo_update: '메모 수정',
    memo_delete: '메모 삭제',
    memo_ui_action: '메모 UI 동작 (열기/닫기/편집/꾸미기)',
    schedule_create: '일정 등록',
    schedule_read: '일정 조회',
    schedule_update: '일정 수정',
    schedule_delete: '일정 삭제',
    todo_create: '할 일 등록',
    todo_read: '할 일 조회',
    todo_update: '할 일 수정',
    todo_delete: '할 일 삭제',
    todo_complete: '할 일 완료',
    web_search: '웹 검색',
    file_upload: '파일 업로드',
    file_read: '파일 읽기',
  };
  return descriptions[tool] || tool;
}

/**
 * 도구 실행 결과를 검증하고 추가 도구가 필요한지 판단
 */
export async function validateToolResult(
  invoke: ClefInvoker,
  userMessage: string,
  toolName: string,
  toolResult: unknown
): Promise<{ sufficient: boolean; nextTool?: string }> {
  const hasContent = toolResult !== null && toolResult !== undefined;
  const resultStr = typeof toolResult === 'string' ? toolResult : (JSON.stringify(toolResult) ?? '');
  
  const response = (await invoke({
    model: 'clef-flash',
    state: {
      current_message: userMessage,
      tool_name: toolName,
      result_length: resultStr.length,
      has_content: hasContent,
    },
    questions: {
      sufficient: {
        type: 'choice',
        instructions: '도구 실행 결과가 사용자 요청에 답하기에 충분한가?',
        criteria: {
          yes: '충분함, 추가 도구 불필요',
          no: '불충분함, 다른 도구가 필요함',
        },
      } as any,
    },
  } as any)) as any;

  const sufficient = response?.answers?.sufficient?.choice === 'yes';
  return { sufficient };
}
