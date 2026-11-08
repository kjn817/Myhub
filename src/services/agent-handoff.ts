export interface StructuredHandoffInput {
  /** 체크포인트 실행과 연결할 때만 지정 (없으면 독립 핸드오프) */
  runId?: string
  fromPersona: string
  toPersona: string
  /** 인계 요청 (원문, 최대 2000자) */
  request: string
  /** 인계 맥락 — 최소 정보만 (최대 10개, 각 500자) */
  context: string[]
  /** 제약 조건 (최대 10개, 각 200자) */
  constraints: string[]
  /** 기대 출력 (최대 1000자) */
  expectedOutput: string
  /** claim-once 기억 인계와 연결할 때만 지정 (memory_handoffs.id) */
  memoryHandoffId?: number
}

/** 주 담당 비서의 답변을 받아 협업자에게 넘길 형식 있는 핸드오프를 만든다 (순수 함수). */
export function buildCoordinatorHandoff(
  fromPersona: string,
  toPersona: string,
  request: string,
  primaryAnswer: string,
  constraints: string[] = []
): StructuredHandoffInput {
  return {
    fromPersona,
    toPersona,
    request: request.slice(0, 2000),
    context: [`[${fromPersona}의 답변]\n${(primaryAnswer || '').slice(0, 500)}`],
    constraints: constraints.slice(0, 10).map((c) => c.slice(0, 200)),
    expectedOutput: '주 담당 답변을 보완하는 추가 답변 (같은 내용 반복 금지)',
  }
}
