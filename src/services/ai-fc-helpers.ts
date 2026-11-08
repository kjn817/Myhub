// FC(Function Calling) 후속 처리 순수 헬퍼 — 시간 예산·후속 메시지 조립·쓰기 멱등성 서명
// src/services/ai.ts에서 순수 이동 (트랙 D, 2026-10-31) — 동작 변경 없음.
import type { ChatMessage } from './ai-types'

// AI 채팅 폴백 체인 전체 시간 예산 (P-5, perf-audit §4.1).
// 시도당 25~30초 × 최대 4회면 최악 100~120초 순차 대기라, websearch의
// deadline/remaining() 패턴을 이식한다. 남은 예산이 없으면 다음 모델
// 시도를 건너뛴다. context.totalTimeoutMs로 테스트에서만 조정 가능하다.
export const AI_CHAT_TOTAL_TIMEOUT_MS = 60000

/**
 * FC 후속 호출 메시지 조립 (2026-10-30 라이브 게이트 — 메모 중복 생성 근본 원인)
 *
 * 도구 결과(tool 역할) 뒤에 user 메시지를 붙이면 mistral(vLLM 서빙)이
 * 8007 "Unexpected role 'user' after role 'tool'"로 요청 자체를 거부한다
 * (운영 ai_error_log id 179 실측). 그래서 마지막 메시지가 tool이면 최종
 * 응답 규칙을 새 user 메시지가 아니라 기존 system 메시지에 합쳐 보낸다 —
 * 역할 순서(tool → assistant 생성)는 모든 서빙 스택이 허용하는 형태다.
 * 마지막이 tool이 아닌 경우(방어적 분기)는 기존처럼 user로 붙인다.
 */
export function buildFCFollowUpMessages(fcMessages: ChatMessage[], rules: string): ChatMessage[] {
  const msgs = [...fcMessages]
  const last = msgs[msgs.length - 1]
  if (last?.role === 'tool') {
    const sysIdx = msgs.findIndex((m) => m.role === 'system')
    if (sysIdx >= 0) {
      msgs[sysIdx] = { ...msgs[sysIdx], content: `${msgs[sysIdx].content}\n\n${rules}` }
    } else {
      msgs.unshift({ role: 'system', content: rules })
    }
    return msgs
  }
  return [...msgs, { role: 'user' as const, content: rules }]
}

/**
 * FC 쓰기 호출의 멱등성 서명 (2026-10-30 라이브 게이트 — 메모 중복 생성 방어)
 *
 * 같은 aiChat 턴(라운드 간·모델 폴백 시도 간 포함) 안에서 이미 성공한
 * 생성 호출과 정규화된 인자가 동일하면 같은 쓰기로 본다. 읽기·삭제·UI
 * 도구와 인자가 비어 있는 호출은 대상이 아니다 (null 반환).
 * 전역 dedupe가 아니라 단일 턴의 FC 실행 지점에서만 동작한다.
 */
export function fcWriteSignature(name: string, args: any): string | null {
  if (!args || typeof args !== 'object') return null
  const norm = (v: unknown): string => (typeof v === 'string' ? v.normalize('NFC').trim() : '')
  switch (name) {
    case 'memo_create': {
      const t = norm(args.text)
      return t ? `memo_create:${t}` : null
    }
    case 'memo_create_from_source': {
      const t = norm(args.source_text)
      return t ? `memo_create_from_source:${t}` : null
    }
    case 'schedule_create': {
      const title = norm(args.title)
      const start = norm(args.start_at)
      return title && start ? `schedule_create:${title}|${start}` : null
    }
    case 'cron_create': {
      const t = norm(args.text)
      return t ? `cron_create:${t}` : null
    }
    default:
      return null
  }
}

/** FC 쓰기 도구 이름 (성공 후 후속 호출 실패 시 폴백 재실행 금지 판정용) */
export const FC_FINAL_RULES = `IMPORTANT RULES for your response:
1. If a tool result has "status": "ui_pending", ONLY the UI action part was REQUESTED but NOT confirmed. For that UI part say "요청을 전달했습니다" (request sent), NEVER "열렸습니다" or "닫혔습니다" (already done). This phrase must NEVER replace or suppress the summary of any content results in the same turn.
2. If a tool result has "status": "confirmation_required", ask the user for confirmation. Do NOT say it was deleted.
3. If a tool result has "requiresConfirmation": true, ask "삭제하시겠습니까?" Do NOT say "삭제했습니다".
4. For memo_get/memo_search results, ALWAYS summarize the actual content naturally and include that summary in your answer — even when another tool result in the same turn is ui_pending.
5. NEVER invent a memo ID or content. Use only what the tools returned.
6. For cron_create/cron_list/cron_set_enabled/cron_delete results, confirm in Korean using the returned description (schedule text and enabled state). NEVER invent a schedule or an automation ID.
7. For schedule_create results, confirm the registration in Korean using the exact title from the tool call. NEVER invent a schedule title or time.
8. If a tool result has "status": "approval_required", the action was NOT executed — an approval request was sent to the user and it is pending. Tell the user in Korean that approval is needed and nothing has been executed yet (e.g. "승인 요청을 보냈어. 아직 실행되지 않았어"). NEVER say it was created, registered, or deleted.

Please provide a natural Korean response to the user based on these results.`

export const FC_WRITE_TOOL_NAMES = ['memo_create', 'memo_create_from_source', 'schedule_create', 'cron_create']
