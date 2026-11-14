/**
 * 에코(keeper) 단일 일정 등록 Function Calling 도구 정의
 *
 * 배경 (2026-10-30, promptfoo 라이브 게이트 회귀 2):
 * - keeper에게는 일정 마커 권한(SCHEDULE_*)이 없고 일정 스킬(마커 전용)도
 *   keeper에게 매칭되지 않아, "일정 등록해줘" 턴에 부착되는 도구가
 *   메모+자동화뿐이었다. 모델이 "단일 일정 도구가 없고 cron_create만
 *   있다"고 답하는 것이 라이브로 실측됐다.
 * - 그래서 일정 등록만 FC 도구로 제공한다 (cron-fc-tools.ts와 같은 패턴:
 *   정의는 여기, 실행은 services/schedule-tools.ts의 executeScheduleCreate
 *   재사용 — 마커 경로와 같은 실행기라 중복 체크·중복 방지 로직이 같다).
 * - 조회·수정·삭제는 기존대로 캘리(scheduler)의 마커 경로 영역이다.
 *   이 파일은 "등록" 하나만 다룬다.
 */

import type { FCToolDefinition } from './memo-fc-tools'
import { validateFCArgsBase } from './fc-validate'

export const SCHEDULE_FC_TOOLS: FCToolDefinition[] = [
  {
    name: 'schedule_create',
    description:
      'Register a single one-time schedule/appointment for the user, e.g. "내일 오후 3시에 회의 등록해줘". ' +
      'title is the schedule title (strip surrounding quotes from the user\'s wording). ' +
      'start_at must be local time in ISO format "YYYY-MM-DDTHH:MM:SS" (Asia/Seoul) — resolve relative ' +
      'expressions (내일, 모레, 다음주 월요일 등) against the current date given in the system context. ' +
      'Use ONLY for a single one-time schedule. For recurring automations (매일/매주 반복) use cron_create instead.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'The schedule title',
        },
        start_at: {
          type: 'string',
          description: 'Start time, ISO local "YYYY-MM-DDTHH:MM:SS" (Asia/Seoul)',
        },
        end_at: {
          type: 'string',
          description: 'Optional end time, ISO local "YYYY-MM-DDTHH:MM:SS" (Asia/Seoul)',
        },
        description: {
          type: 'string',
          description: 'Optional description',
        },
        location: {
          type: 'string',
          description: 'Optional location',
        },
      },
      required: ['title', 'start_at'],
    },
  },
]

export function getScheduleFCTool(name: string): FCToolDefinition | undefined {
  return SCHEDULE_FC_TOOLS.find((t) => t.name === name)
}

const ISO_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/

/** schedule 도구 인자 검증 (공용 코어 + schedule 전용 말미 검사) */
export function validateScheduleFCArgs(toolName: string, args: any): { valid: boolean; error?: string } {
  const base = validateFCArgsBase(getScheduleFCTool, toolName, args)
  if (!base.valid) return base
  if (typeof args.title !== 'string' || !args.title.trim()) {
    return { valid: false, error: 'Argument title must be a non-empty string' }
  }
  if (typeof args.start_at !== 'string' || !ISO_LOCAL_RE.test(args.start_at)) {
    return { valid: false, error: 'Argument start_at must be ISO local time "YYYY-MM-DDTHH:MM:SS"' }
  }
  if (args.end_at !== undefined && (typeof args.end_at !== 'string' || !ISO_LOCAL_RE.test(args.end_at))) {
    return { valid: false, error: 'Argument end_at must be ISO local time "YYYY-MM-DDTHH:MM:SS"' }
  }
  return { valid: true }
}
