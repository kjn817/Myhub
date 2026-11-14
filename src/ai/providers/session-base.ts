/**
 * Provider 세션 공용 베이스 (B-L6, 5-7).
 *
 * Groq·Workers AI 어댑터가 바이트 동일하게 공유하던 OpenAI 형식 세션
 * 보일러플레이트(setSystemPrompt·addUserMessage·appendToolResults·
 * getMessages)를 한 곳으로 모은다. Gemini는 Native contents +
 * systemInstruction 저장 방식을 쓰므로 이 베이스를 상속하지 않고,
 * next() 서두의 systemPrompt 주입만 applyNextSystemPrompt로 공유한다.
 *
 * 의도된 차이로 남기는 것:
 * - Workers AI의 appendToolResults는 hasExecutedTools 플래그를 먼저 세운다
 *   (오버라이드로 유지, 루프 본문은 베이스와 동일).
 * - tool_calls 파싱 실패 표기(Groq의 parseError 플래그 vs Workers AI의
 *   __parseError 인자), id 접두사, mapFinishReason 매핑은 프로바이더별
 *   계약이라 각 파일에 남긴다.
 */

import type { ToolResult } from '../types'

/** next() 옵션에 systemPrompt가 있으면 세션에 주입한다 (3개 어댑터 공통 서두). */
export function applyNextSystemPrompt(
  session: { setSystemPrompt(prompt: string): void },
  options: { systemPrompt?: string },
): void {
  if (options.systemPrompt) {
    session.setSystemPrompt(options.systemPrompt)
  }
}

/**
 * OpenAI 형식 메시지 이력을 유지하는 세션 베이스.
 * system 메시지는 1개만 유지(재설정 시 기존 system을 걷어내고 맨 앞에 삽입),
 * 도구 결과는 role:tool 메시지로 원본 tool_call_id와 함께 쌓는다.
 */
export abstract class OpenAIStyleSession {
  /** OpenAI 형식 메시지 이력 (원본 보존) */
  protected messages: any[] = []

  setSystemPrompt(prompt: string): void {
    // 기존 system 메시지가 있으면 교체
    this.messages = this.messages.filter((m) => m.role !== 'system')
    this.messages.unshift({ role: 'system', content: prompt })
  }

  addUserMessage(content: string): void {
    this.messages.push({ role: 'user', content })
  }

  appendToolResults(results: ToolResult[]): void {
    for (const r of results) {
      // 원본 tool_call_id와 연결
      const toolMsg: any = {
        role: 'tool',
        tool_call_id: r.callId,
        content: JSON.stringify(
          r.output.ok
            ? r.output.data
            : { error: r.output.errorCode, message: r.output.message }
        ),
      }
      this.messages.push(toolMsg)
    }
  }

  /** 디버깅용: 현재 이력 반환 */
  getMessages(): any[] {
    return [...this.messages]
  }
}
