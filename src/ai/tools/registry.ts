/**
 * MyHub Tool Registry — Phase 1B
 *
 * 모든 도구를 하나의 Registry에서 정의하고 관리.
 * - 등록: ToolDefinition + Zod 스키마 + Executor
 * - 실행: 검증 → 권한 확인 → 실행 → ToolResult 반환
 *
 * 설계 원칙:
 * - Registry는 도구 종류에 무관하게 동일하게 동작
 * - search_memo 전용 로직이 Registry 내부에 들어가지 않음
 * - userId는 모델 인자가 아닌 서버 ExecutionContext에서 가져옴
 */

import { z } from 'zod'
import type {
  ToolDefinition,
  ToolCall,
  ToolResult,
  ExecutionContext,
} from '../types'

// ---------------------------------------------------------------------------
// 오류 코드
// ---------------------------------------------------------------------------

export type ToolErrorCode =
  | 'UNKNOWN_TOOL'
  | 'INVALID_ARGUMENTS'
  | 'ACCESS_DENIED'
  | 'TIMEOUT'
  | 'DB_ERROR'
  | 'INTERNAL_ERROR'

// ---------------------------------------------------------------------------
// 등록된 도구
// ---------------------------------------------------------------------------

export type ToolExecutor = (
  args: unknown,
  ctx: ExecutionContext,
  env: { DB: D1Database }
) => Promise<unknown>

type RegisteredTool = {
  definition: ToolDefinition
  schema: z.ZodType
  executor: ToolExecutor
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>()

  /**
   * 도구 등록. 중복 이름이면 오류 발생.
   */
  register(
    definition: ToolDefinition,
    schema: z.ZodType,
    executor: ToolExecutor
  ): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool already registered: ${definition.name}`)
    }
    this.tools.set(definition.name, { definition, schema, executor })
  }

  /**
   * 도구 조회. 없으면 undefined.
   */
  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name)
  }

  /**
   * 등록된 도구 정의 목록 반환.
   * Provider에 전달할 때는 정의만 (Executor, 스키마 제외).
   */
  list(filter?: string[]): ToolDefinition[] {
    const all = [...this.tools.values()].map((t) => t.definition)
    if (!filter) return all
    const set = new Set(filter)
    return all.filter((d) => set.has(d.name))
  }

  /**
   * ToolCall 실행. 검증 → 권한 → 실행 → ToolResult.
   */
  async execute(
    call: ToolCall,
    ctx: ExecutionContext,
    env: { DB: D1Database },
    timeoutMs: number = 5000
  ): Promise<ToolResult> {
    // 1. 도구 조회
    const tool = this.tools.get(call.name)
    if (!tool) {
      return {
        callId: call.id,
        name: call.name,
        output: {
          ok: false,
          errorCode: 'UNKNOWN_TOOL',
          message: `Unknown tool: ${call.name}`,
        },
      }
    }

    // 2. Zod 인자 검증
    const parsed = tool.schema.safeParse(call.args)
    if (!parsed.success) {
      return {
        callId: call.id,
        name: call.name,
        output: {
          ok: false,
          errorCode: 'INVALID_ARGUMENTS',
          message: 'Invalid arguments',
        },
      }
    }

    // 3. 실행 (타임아웃 적용)
    try {
      const data = await this.withTimeout(
        tool.executor(parsed.data, ctx, env),
        timeoutMs
      )

      // 결과 크기 제한 (문자열 변환 후 체크)
      const dataStr = JSON.stringify(data)
      if (dataStr.length > 15000) {
        return {
          callId: call.id,
          name: call.name,
          output: {
            ok: false,
            errorCode: 'INTERNAL_ERROR',
            message: 'Result too large',
          },
        }
      }

      return {
        callId: call.id,
        name: call.name,
        output: { ok: true, data },
      }
    } catch (e: any) {
      // 오류 코드 매핑
      const errorCode = this.mapError(e)
      return {
        callId: call.id,
        name: call.name,
        output: {
          ok: false,
          errorCode,
          message: this.safeMessage(e),
        },
      }
    }
  }

  /**
   * 타임아웃 래퍼. DB 작업 취소는 보장하지 않음 (문서화).
   */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('TIMEOUT'))
      }, ms)
      promise.then(
        (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        (e) => {
          clearTimeout(timer)
          reject(e)
        }
      )
    })
  }

  /**
   * 내부 오류를 표준 오류 코드로 매핑.
   * SQL 원문, 스택 트레이스는 노출하지 않음.
   */
  private mapError(e: any): ToolErrorCode {
    const msg = String(e?.message || '')
    if (msg === 'TIMEOUT') return 'TIMEOUT'
    if (msg.includes('ACCESS_DENIED')) return 'ACCESS_DENIED'
    if (msg.includes('D1') || msg.includes('database') || msg.includes('SQL'))
      return 'DB_ERROR'
    return 'INTERNAL_ERROR'
  }

  private safeMessage(e: any): string {
    const code = this.mapError(e)
    switch (code) {
      case 'TIMEOUT':
        return 'Tool execution timed out'
      case 'ACCESS_DENIED':
        return 'Access denied'
      case 'DB_ERROR':
        return 'Database error'
      default:
        return 'Internal error'
    }
  }
}

// ---------------------------------------------------------------------------
// JSON Schema 생성 (Zod 4)
// ---------------------------------------------------------------------------

/**
 * Zod 스키마에서 Provider용 JSON Schema 생성.
 * Zod 4의 z.toJSONSchema() 사용.
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>
}
