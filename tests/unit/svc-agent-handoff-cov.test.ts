/**
 * agent-handoff 커버리지 보강 (그룹 D) — 현행 표면 기준 재작성 (2026-11-08 배치 3)
 * - buildCoordinatorHandoff: 주 담당 답변을 맥락으로 담은 입력 생성·길이 제한 절단
 *
 * [삭제 기록] 구 DB CRUD 표면(createStructuredHandoff·resolveStructuredHandoff·
 * getStructuredHandoff·listRunHandoffs — agent_handoffs 테이블 대상 검증·원자적
 * pending 가드·JSON 폴백 등 26건)은 원본 번들·현행 src 어디에도 존재하지 않는다.
 * 현행 인계는 buildCoordinatorHandoff(순수 빌더)가 만든 StructuredHandoffInput을
 * 오케스트레이터의 선택 dep recordHandoff로 넘기는 구조로 대체됐고, 검증·영속
 * CRUD 자체가 소멸했으므로 해당 테스트는 삭제한다.
 */
import {
  buildCoordinatorHandoff,
} from '../../src/services/agent-handoff'

describe('buildCoordinatorHandoff', () => {
  test('주 담당 답변을 맥락으로 담은 입력 생성 + 길이 제한 절단', () => {
    const h = buildCoordinatorHandoff(
      'keeper',
      'scheduler',
      'x'.repeat(2500),
      'y'.repeat(800),
      ['a'.repeat(300), ...Array.from({ length: 12 }, (_, i) => `제약${i}`)],
    )
    expect(h.fromPersona).toBe('keeper')
    expect(h.toPersona).toBe('scheduler')
    expect(h.request).toHaveLength(2000)
    expect(h.context).toHaveLength(1)
    expect(h.context[0]).toContain('[keeper의 답변]')
    expect(h.context[0]).toHaveLength('[keeper의 답변]\n'.length + 500)
    expect(h.constraints).toHaveLength(10)
    expect(h.constraints[0]).toHaveLength(200)
    expect(h.expectedOutput).toContain('주 담당 답변을 보완')
  })

  test('빈 답변·기본 제약', () => {
    const h = buildCoordinatorHandoff('a', 'b', '요청', '')
    expect(h.context).toEqual(['[a의 답변]\n'])
    expect(h.constraints).toEqual([])
  })
})
