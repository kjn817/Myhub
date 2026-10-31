/**
 * OTEL 스팬 식별자 — OpenTelemetry 규약만 차용 (SDK 설치 없음)
 *
 * OpenLLMetry / OpenLIT의 스팬 시맨틱 컨벤션을 따른다:
 * - trace_id: 128-bit, 32자 소문자 hex — 한 번의 실행(런) 전체를 묶는다.
 * - span_id: 64-bit, 16자 소문자 hex — 개별 LLM 호출·도구 호출 단위.
 * - parent_span_id: 부모 스팬 (없으면 트레이스 루트).
 *
 * 생성은 Workers 내장 crypto만 쓴다 (crypto.getRandomValues 우선,
 * 없으면 crypto.randomUUID 폴백). 외부 전송 없음 — D1에만 저장.
 */

export interface TraceContext {
  traceId: string
  spanId: string
  parentSpanId?: string | null
}

const HEX = '0123456789abcdef'

function randomHexChars(n: number): string {
  // crypto.getRandomValues가 있으면 그것을, 없으면 randomUUID를 쓴다.
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(Math.ceil(n / 2))
    crypto.getRandomValues(bytes)
    let out = ''
    for (const b of bytes) out += HEX[(b >> 4) & 0xf] + HEX[b & 0xf]
    return out.slice(0, n)
  }
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '').slice(0, n).padEnd(n, '0')
  }
  // 최후 폴백 (테스트 환경 등 crypto가 없을 때) — 충돌 확률은 무시 가능 수준
  let out = ''
  for (let i = 0; i < n; i++) out += HEX[Math.floor(Math.random() * 16)]
  return out
}

export function isValidTraceId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)
}

export function isValidSpanId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value)
}

/** 새 트레이스 루트 (128-bit trace_id + 64-bit span_id) */
export function newTraceId(): string {
  return randomHexChars(32)
}

/** 새 스팬 id (64-bit) */
export function newSpanId(): string {
  return randomHexChars(16)
}

/** 새 트레이스의 루트 컨텍스트 */
export function newRootTrace(): TraceContext {
  return { traceId: newTraceId(), spanId: newSpanId(), parentSpanId: null }
}

/** 부모 스팬의 자식 컨텍스트 (같은 trace_id, 부모는 parent.spanId) */
export function childSpan(parent: TraceContext): TraceContext {
  return { traceId: parent.traceId, spanId: newSpanId(), parentSpanId: parent.spanId }
}
