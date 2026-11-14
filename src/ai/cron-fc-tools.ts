/**
 * 에코(keeper) 자동화 Function Calling 도구 정의
 * - 자연어 cron 작업의 생성·조회·활성화/비활성화·삭제
 * - 실행은 src/services/cron-tools.ts (저장소는 services/cron-jobs.ts)
 * - MEMO_FC_TOOLS와 같은 평형식 {name, description, parameters}이라
 *   prepareToolsFor 변환·정규화·preflight를 그대로 재사용한다.
 */

import type { FCToolDefinition } from './memo-fc-tools'
import { validateFCArgsBase } from './fc-validate'

export const CRON_FC_TOOLS: FCToolDefinition[] = [
  {
    name: 'cron_create',
    description:
      'Save a recurring automation from the user\'s natural-language request, e.g. "매일 아침 8시에 뉴스 요약해서 푸시해줘". Pass the user\'s request verbatim as text; the server parses the schedule deterministically. Use ONLY when the user asks to repeat something on a schedule (daily, weekly, every N minutes, etc.). If the request has no time expression, do NOT call this tool — ask the user when instead.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The user\'s automation request verbatim, including the time expression',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'cron_list',
    description:
      'List the user\'s saved recurring automations with their schedule, next run time, and enabled state. Use when the user asks what automations exist ("자동화 목록 보여줘").',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'cron_set_enabled',
    description:
      'Enable or disable a saved automation by its numeric ID. Use when the user asks to pause, resume, turn on, or turn off an automation.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: 'The automation ID from cron_list',
        },
        enabled: {
          type: 'boolean',
          description: 'true to enable, false to disable',
        },
      },
      required: ['id', 'enabled'],
    },
  },
  {
    name: 'cron_delete',
    description:
      'Delete a saved automation by its numeric ID. Use only when the user explicitly asks to delete or cancel an automation.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: 'The automation ID from cron_list',
        },
      },
      required: ['id'],
    },
  },
]

export function getCronFCTool(name: string): FCToolDefinition | undefined {
  return CRON_FC_TOOLS.find((t) => t.name === name)
}

/** cron 도구 인자 검증 (공용 코어 + cron 도구 정의) */
export function validateCronFCArgs(toolName: string, args: any): { valid: boolean; error?: string } {
  return validateFCArgsBase(getCronFCTool, toolName, args)
}
