/**
 * FC 도구 인자 검증 공용 코어 (B-L3)
 * - validateFCArgs(memo) / validateCronFCArgs(cron) / validateScheduleFCArgs(schedule)의
 *   공통 4단계: 미지 도구 검사 → args 객체 검사 → required 검사 → properties 타입 검사
 * - memo본에는 boolean 타입 검사가 없었으나 메모 도구에는 boolean 속성이 없어
 *   (memo-fc-tools.ts 내 boolean은 반환 타입뿐) 코어에 boolean 검사를 넣어도
 *   메모 동작은 동일하다.
 * - schedule 전용 말미 검사(title 비어 있지 않음·start_at/end_at ISO 형식)는
 *   의도된 추가 검사라 코어에 넣지 않고 schedule 래퍼가 이어서 수행한다.
 */

import type { FCToolDefinition } from './memo-fc-tools'

export type FCValidateResult = { valid: boolean; error?: string }
export type FCToolGetter = (name: string) => FCToolDefinition | undefined

export function validateFCArgsBase(
  getTool: FCToolGetter,
  toolName: string,
  args: any,
): FCValidateResult {
  const tool = getTool(toolName)
  if (!tool) {
    return { valid: false, error: `Unknown tool: ${toolName}` }
  }
  if (!args || typeof args !== 'object') {
    return { valid: false, error: 'Arguments must be an object' }
  }
  for (const required of tool.parameters.required) {
    if (!(required in args)) {
      return { valid: false, error: `Missing required argument: ${required}` }
    }
  }
  for (const [key, def] of Object.entries(tool.parameters.properties)) {
    if (key in args) {
      const val = args[key]
      if (def.type === 'string' && typeof val !== 'string') {
        return { valid: false, error: `Argument ${key} must be a string` }
      }
      if (def.type === 'number' && typeof val !== 'number') {
        return { valid: false, error: `Argument ${key} must be a number` }
      }
      if (def.type === 'boolean' && typeof val !== 'boolean') {
        return { valid: false, error: `Argument ${key} must be a boolean` }
      }
    }
  }
  return { valid: true }
}
