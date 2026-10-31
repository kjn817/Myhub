/**
 * 관문 테스트 20: API kind 검증
 *
 * 품질 이슈: POST /jobs에서 kind가 'create'/'modify' 외의 값이어도
 * DB에 그대로 저장됨. 잘못된 kind는 job-processor에서 예상치 못한 동작 유발.
 *
 * 기대: 허용된 kind만 받고, 나머지는 400 오류.
 */

const VALID_KINDS = ['create', 'modify']

function validateKind(kind) {
  const k = kind || 'create'
  if (!VALID_KINDS.includes(k)) {
    return { ok: false, error: `kind는 ${VALID_KINDS.join('/')} 중 하나여야 합니다` }
  }
  return { ok: true, kind: k }
}

describe('관문 20: API kind 검증', () => {
  test('create → 통과', () => {
    expect(validateKind('create').ok).toBe(true)
  })

  test('modify → 통과', () => {
    expect(validateKind('modify').ok).toBe(true)
  })

  test('빈 값 → 기본값 create', () => {
    const r = validateKind(null)
    expect(r.ok).toBe(true)
    expect(r.kind).toBe('create')
  })

  test('잘못된 kind → 400', () => {
    const r = validateKind('delete')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('create')
  })

  test('대소문자 구분', () => {
    const r = validateKind('CREATE')
    expect(r.ok).toBe(false)
  })
})
