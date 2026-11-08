/// <reference types="jest" />
/**
 * src/services/office-ops.ts · office-ops-slide.ts — 연산 검증 성질 테스트.
 *
 * 고정하는 성질:
 * - 시트 연산: A1 주소 정규화(소문자→대문자, 경계 행/열), 수식·값 정규화,
 *   범위·행렬 크기 상한(500행×50열·2500셀), 알 수 없는 연산의 거부.
 *   검증에 실패한 연산은 ops에 들어가지 않고 errors에만 남는다.
 * - 한글 연산: 문단 50건·2000자, 찾기 200자 상한. 시트와 달리 개수 초과는
 *   오류 문구 없이 MAX_OPS에서 절단된다.
 * - PDF 연산: 페이지 경계는 pageCount 기준, 마지막 1장은 삭제 불가,
 *   overlay 좌표·크기는 범위 밖이면 조용히 버려진다(연산 자체는 유지).
 * - 스냅샷 검사: 오류 값·깨진 참조·합계 불일치를 A1 주소와 함께 보고하고,
 *   스냅샷 밖을 참조하는 합계는 단정하지 않는다. 보고는 50건에서 끊긴다.
 * - 승인 서명: HMAC 서명은 키 순서에 무관하고(정규화 JSON), 페이로드를
 *   바꾸면 검증이 실패한다. 비밀값이 없으면 서명·검증 모두 실패 쪽이다.
 * 카나리아: 범위 크기 상한이나 서명 정규화를 깨면 실패한다.
 */
import {
  validateSheetOps,
  validateHwpOps,
  validatePdfOps,
  inspectSheetSnapshot,
  signApproval,
  verifyApproval,
} from '../../src/services/office-ops'
import { validateSlideOps } from '../../src/services/office-ops-slide'

describe('validateSheetOps — 기본 계약', () => {
  test('배열이 아니면 오류만 돌려준다', () => {
    const r = validateSheetOps('ops')
    expect(r.ops).toEqual([])
    expect(r.errors).toEqual(['연산 목록이 배열이 아닙니다'])
  })

  test('형식이 잘못된 항목과 알 수 없는 연산은 건너뛰고 오류를 남긴다', () => {
    const r = validateSheetOps([null, 42, { type: 'explode' }, { noType: true }])
    expect(r.ops).toEqual([])
    expect(r.errors).toEqual([
      '형식이 잘못된 연산을 건너뜀',
      '형식이 잘못된 연산을 건너뜀',
      '알 수 없는 연산: explode',
      '형식이 잘못된 연산을 건너뜀',
    ])
  })

  test('MAX_OPS(24)를 넘기면 오류를 남기고 24개까지만 처리한다', () => {
    const raw = Array.from({ length: 25 }, (_, i) => ({ type: 'set_cell', cell: `A${i + 1}`, value: i }))
    const r = validateSheetOps(raw)
    expect(r.ops.length).toBe(24)
    expect(r.errors).toEqual(['연산이 너무 많습니다 (최대 24개)'])
  })
})

describe('validateSheetOps — set_cell', () => {
  test('값 연산: 소문자 셀 주소는 대문자로 정규화된다', () => {
    const r = validateSheetOps([{ type: 'set_cell', cell: 'b2', value: 5 }])
    expect(r.errors).toEqual([])
    expect(r.ops).toEqual([{ type: 'set_cell', cell: 'B2', value: 5 }])
  })

  test('"="로 시작하는 문자열 값은 수식으로 정규화된다', () => {
    const r = validateSheetOps([{ type: 'set_cell', cell: 'B3', value: '=SUM(B1:B2)' }])
    expect(r.ops).toEqual([{ type: 'set_cell', cell: 'B3', formula: '=SUM(B1:B2)' }])
  })

  test('formula 필드는 "=" 접두를 보강한다', () => {
    const r = validateSheetOps([{ type: 'set_cell', cell: 'A1', formula: 'SUM(A2:A3)' }])
    expect(r.ops).toEqual([{ type: 'set_cell', cell: 'A1', formula: '=SUM(A2:A3)' }])
  })

  test('null·불리언 값은 그대로 허용된다', () => {
    const r = validateSheetOps([
      { type: 'set_cell', cell: 'A1', value: null },
      { type: 'set_cell', cell: 'A2', value: true },
    ])
    expect(r.errors).toEqual([])
    expect(r.ops.length).toBe(2)
  })

  test('잘못된 셀 주소는 거부된다 (행 0, 열 4자, 최대 행 초과)', () => {
    for (const cell of ['A0', 'AAAA1', 'A1048577', '1A', '']) {
      const r = validateSheetOps([{ type: 'set_cell', cell, value: 1 }])
      expect(r.ops).toEqual([])
      expect(r.errors.length).toBe(1)
      expect(r.errors[0]).toContain('셀 주소가 잘못됨')
    }
  })

  test('최대 행(A1048576)은 허용된다', () => {
    const r = validateSheetOps([{ type: 'set_cell', cell: 'A1048576', value: 1 }])
    expect(r.errors).toEqual([])
    expect(r.ops.length).toBe(1)
  })

  test('500자 초과 문자열과 객체 값은 거부된다', () => {
    const long = validateSheetOps([{ type: 'set_cell', cell: 'A1', value: 'x'.repeat(501) }])
    expect(long.ops).toEqual([])
    expect(long.errors[0]).toContain('값이 올바르지 않음')
    const obj = validateSheetOps([{ type: 'set_cell', cell: 'A1', value: { nested: 1 } }])
    expect(obj.ops).toEqual([])
    expect(obj.errors[0]).toContain('값이 올바르지 않음')
  })

  test('300자 초과 수식은 거부된다', () => {
    const r = validateSheetOps([{ type: 'set_cell', cell: 'A1', value: '=' + 'A'.repeat(300) }])
    expect(r.ops).toEqual([])
  })
})

describe('validateSheetOps — set_range', () => {
  test('정상 행렬은 셀 입력으로 정규화되어 들어간다 ({f} → formula)', () => {
    const r = validateSheetOps([
      { type: 'set_range', range: 'A1:B2', values: [[1, 'x'], [{ f: 'SUM(A1:B1)' }, null]] },
    ])
    expect(r.errors).toEqual([])
    expect(r.ops).toEqual([
      {
        type: 'set_range',
        range: 'A1:B2',
        values: [[{ value: 1 }, { value: 'x' }], [{ formula: '=SUM(A1:B1)' }, { value: null }]],
      },
    ])
  })

  test('역방향 범위(B2:A1)도 크기가 맞으면 허용된다', () => {
    const r = validateSheetOps([{ type: 'set_range', range: 'B2:A1', values: [[1, 2], [3, 4]] }])
    expect(r.errors).toEqual([])
    expect(r.ops.length).toBe(1)
  })

  test('행렬 크기가 범위와 다르면 거부된다', () => {
    const r = validateSheetOps([{ type: 'set_range', range: 'A1:B2', values: [[1, 2]] }])
    expect(r.ops).toEqual([])
    expect(r.errors[0]).toContain('값 행렬 크기(1×2)가 범위와 다름')
  })

  test('들쭉날쭉한 행렬은 거부된다', () => {
    const r = validateSheetOps([{ type: 'set_range', range: 'A1:B2', values: [[1, 2], [3]] }])
    expect(r.ops).toEqual([])
    expect(r.errors[0]).toContain('값 행렬이 올바르지 않음')
  })

  test('범위 상한: 501행·2500셀 초과는 크기 오류', () => {
    const rows = validateSheetOps([{ type: 'set_range', range: 'A1:A501', values: [[1]] }])
    expect(rows.errors[0]).toContain('범위가 너무 큽니다')
    const cells = validateSheetOps([{ type: 'set_range', range: 'A1:AX51', values: [[1]] }])
    expect(cells.errors[0]).toContain('범위가 너무 큽니다')
  })

  test('잘못된 범위 표기는 거부된다', () => {
    const r = validateSheetOps([{ type: 'set_range', range: 'A1:B2:C3', values: [[1]] }])
    expect(r.ops).toEqual([])
    expect(r.errors[0]).toContain('범위가 잘못됨')
  })
})

describe('validateSheetOps — insert_table / sort_range / format_range', () => {
  test('insert_table 정상', () => {
    const r = validateSheetOps([
      { type: 'insert_table', at: 'a5', headers: ['이름', '금액'], rows: [['철수', 100], ['영희', null]] },
    ])
    expect(r.errors).toEqual([])
    expect(r.ops).toEqual([
      { type: 'insert_table', at: 'A5', headers: ['이름', '금액'], rows: [['철수', 100], ['영희', null]] },
    ])
  })

  test('insert_table: 행 길이가 제목행과 다르면 거부', () => {
    const r = validateSheetOps([{ type: 'insert_table', at: 'A1', headers: ['a', 'b'], rows: [['x']] }])
    expect(r.ops).toEqual([])
    expect(r.errors[0]).toContain('행 데이터가 올바르지 않음')
  })

  test('insert_table: 빈 행 목록은 허용된다', () => {
    const r = validateSheetOps([{ type: 'insert_table', at: 'A1', headers: ['a'], rows: [] }])
    expect(r.errors).toEqual([])
    expect(r.ops.length).toBe(1)
  })

  test('insert_table: (행+1)×열이 2500셀을 넘으면 너무 크다고 거부', () => {
    const headers = Array.from({ length: 50 }, () => 'h')
    const rows = Array.from({ length: 50 }, () => Array.from({ length: 50 }, () => 'v'))
    const r = validateSheetOps([{ type: 'insert_table', at: 'A1', headers, rows }])
    expect(r.ops).toEqual([])
    expect(r.errors[0]).toContain('표가 너무 큽니다')
  })

  test('sort_range: 정렬 열이 범위를 벗어나면 거부, 비정수 by는 0으로', () => {
    const out = validateSheetOps([{ type: 'sort_range', range: 'A1:B5', by: 2 }])
    expect(out.ops).toEqual([])
    expect(out.errors[0]).toContain('정렬 열이 범위를 벗어남')
    const frac = validateSheetOps([{ type: 'sort_range', range: 'A1:B5', by: 1.5, order: 'DESC', hasHeader: 1 }])
    expect(frac.errors).toEqual([])
    expect(frac.ops).toEqual([{ type: 'sort_range', range: 'A1:B5', by: 0, order: 'asc', hasHeader: false }])
  })

  test('format_range: 적용할 서식이 하나도 없으면 거부', () => {
    const r = validateSheetOps([{ type: 'format_range', range: 'A1:B1' }])
    expect(r.ops).toEqual([])
    expect(r.errors[0]).toContain('적용할 서식이 없음')
  })

  test('format_range: 잘못된 배경색·긴 숫자서식은 버려지고 나머지는 유지', () => {
    const r = validateSheetOps([
      { type: 'format_range', range: 'A1:B1', bold: true, background: '#FFF', numberFormat: 'x'.repeat(41) },
    ])
    expect(r.errors).toEqual([])
    expect(r.ops).toEqual([{ type: 'format_range', range: 'A1:B1', bold: true }])
  })

  test('format_range: bold:false도 명시 서식으로 인정된다', () => {
    const r = validateSheetOps([{ type: 'format_range', range: 'A1', bold: false, background: '#FFF2CC' }])
    expect(r.errors).toEqual([])
    expect(r.ops).toEqual([{ type: 'format_range', range: 'A1', bold: false, background: '#FFF2CC' }])
  })
})

describe('validateHwpOps', () => {
  test('배열이 아니면 오류', () => {
    expect(validateHwpOps(null).errors).toEqual(['연산 목록이 배열이 아닙니다'])
  })

  test('append_paragraphs 경계: 50건·2000자는 허용, 초과는 거부', () => {
    const ok = validateHwpOps([{ type: 'append_paragraphs', paragraphs: Array.from({ length: 50 }, () => '문단') }])
    expect(ok.errors).toEqual([])
    const many = validateHwpOps([{ type: 'append_paragraphs', paragraphs: Array.from({ length: 51 }, () => '문단') }])
    expect(many.ops).toEqual([])
    const long = validateHwpOps([{ type: 'append_paragraphs', paragraphs: ['x'.repeat(2001)] }])
    expect(long.ops).toEqual([])
    const empty = validateHwpOps([{ type: 'append_paragraphs', paragraphs: [] }])
    expect(empty.ops).toEqual([])
  })

  test('replace_text: 빈 찾기는 거부, 빈 바꾸기는 허용, 길이 상한 적용', () => {
    expect(validateHwpOps([{ type: 'replace_text', find: '', replace: 'x' }]).ops).toEqual([])
    const ok = validateHwpOps([{ type: 'replace_text', find: '오타', replace: '' }])
    expect(ok.ops).toEqual([{ type: 'replace_text', find: '오타', replace: '' }])
    expect(validateHwpOps([{ type: 'replace_text', find: 'x'.repeat(201), replace: 'y' }]).ops).toEqual([])
    expect(validateHwpOps([{ type: 'replace_text', find: 'x', replace: 'y'.repeat(2001) }]).ops).toEqual([])
  })

  test('insert_table: 제목행 8개까지, 셀은 문자열만', () => {
    const ok = validateHwpOps([
      { type: 'insert_table', headers: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], rows: [['1', '2', '3', '4', '5', '6', '7', '8']] },
    ])
    expect(ok.errors).toEqual([])
    const nine = validateHwpOps([{ type: 'insert_table', headers: Array.from({ length: 9 }, () => 'h'), rows: [] }])
    expect(nine.ops).toEqual([])
    const numCell = validateHwpOps([{ type: 'insert_table', headers: ['a'], rows: [[1]] }])
    expect(numCell.ops).toEqual([])
    expect(numCell.errors[0]).toContain('행 데이터가 올바르지 않음')
  })

  test('MAX_OPS 초과분은 오류 없이 절단된다 (시트 검증과 다른 계약)', () => {
    const raw = Array.from({ length: 25 }, () => ({ type: 'append_paragraphs', paragraphs: ['문단'] }))
    const r = validateHwpOps(raw)
    expect(r.ops.length).toBe(24)
    expect(r.errors).toEqual([])
  })

  test('알 수 없는 연산은 오류를 남긴다', () => {
    const r = validateHwpOps([{ type: 'set_cell', cell: 'A1', value: 1 }])
    expect(r.ops).toEqual([])
    expect(r.errors).toEqual(['알 수 없는 연산: set_cell'])
  })
})

describe('validatePdfOps', () => {
  test('pageCount를 모르면(0) 큰 페이지도 허용한다', () => {
    const r = validatePdfOps([{ type: 'rotate_page', page: 999 }], 0)
    expect(r.errors).toEqual([])
    expect(r.ops).toEqual([{ type: 'rotate_page', page: 999 }])
  })

  test('pageCount를 알면 범위를 벗어난 페이지는 거부', () => {
    const r = validatePdfOps([{ type: 'rotate_page', page: 6 }], 5)
    expect(r.ops).toEqual([])
    expect(r.errors[0]).toContain('페이지가 올바르지 않음')
  })

  test('페이지 0·소수·문자열은 거부', () => {
    for (const page of [0, -1, 1.5, '2']) {
      expect(validatePdfOps([{ type: 'rotate_page', page }], 0).ops).toEqual([])
    }
  })

  test('delete_page: 마지막 1장은 삭제할 수 없다', () => {
    const last = validatePdfOps([{ type: 'delete_page', page: 1 }], 1)
    expect(last.ops).toEqual([])
    expect(last.errors[0]).toContain('마지막 페이지는 삭제할 수 없음')
    const ok = validatePdfOps([{ type: 'delete_page', page: 2 }], 2)
    expect(ok.ops).toEqual([{ type: 'delete_page', page: 2 }])
  })

  test('extract_pages: from > to는 거부', () => {
    expect(validatePdfOps([{ type: 'extract_pages', from: 3, to: 2 }], 5).ops).toEqual([])
    expect(validatePdfOps([{ type: 'extract_pages', from: 2, to: 4 }], 5).ops).toEqual([
      { type: 'extract_pages', from: 2, to: 4 },
    ])
  })

  test('overlay_text: 범위 밖 좌표·크기는 버려지고 연산은 유지된다', () => {
    const r = validatePdfOps(
      [{ type: 'overlay_text', page: 1, text: '검토 완료', x: -5, y: 2000, size: 100 }],
      3,
    )
    expect(r.errors).toEqual([])
    expect(r.ops).toEqual([{ type: 'overlay_text', page: 1, text: '검토 완료', y: 2000 }])
  })

  test('overlay_text: 빈 문구·200자 초과는 거부', () => {
    expect(validatePdfOps([{ type: 'overlay_text', page: 1, text: '   ' }], 3).ops).toEqual([])
    expect(validatePdfOps([{ type: 'overlay_text', page: 1, text: 'x'.repeat(201) }], 3).ops).toEqual([])
  })
})

describe('inspectSheetSnapshot', () => {
  test('스냅샷이 없거나 cells가 배열이 아니면 빈 결과', () => {
    expect(inspectSheetSnapshot(null)).toEqual([])
    expect(inspectSheetSnapshot(undefined)).toEqual([])
    expect(inspectSheetSnapshot({ cells: 'nope' } as never)).toEqual([])
  })

  test('오류 값 셀을 A1 주소와 함께 보고한다', () => {
    const f = inspectSheetSnapshot({ cells: [[{ v: 1 }, { v: '#DIV/0!' }]] })
    expect(f).toEqual([{ kind: 'error_value', cell: 'B1', detail: '오류 값 #DIV/0!' }])
  })

  test('수식 안의 #REF!를 깨진 참조로 보고한다', () => {
    const f = inspectSheetSnapshot({ cells: [[{ v: 0, f: '=SUM(#REF!)' }]] })
    expect(f.map((x) => x.kind)).toEqual(['broken_ref'])
    expect(f[0].cell).toBe('A1')
  })

  test('스냅샷 range 시작 위치가 주소에 반영된다', () => {
    const f = inspectSheetSnapshot({ range: 'C3', cells: [[{ v: '#N/A' }]] })
    expect(f[0].cell).toBe('C3')
  })

  test('합계 수식의 표시값이 실제 합과 다르면 불일치로 보고한다', () => {
    const f = inspectSheetSnapshot({
      cells: [[{ v: 10 }], [{ v: 20 }], [{ v: 25, f: '=SUM(A1:A2)' }]],
    })
    expect(f.length).toBe(1)
    expect(f[0].kind).toBe('sum_mismatch')
    expect(f[0].cell).toBe('A3')
    expect(f[0].detail).toContain('30')
  })

  test('합계가 맞으면 보고하지 않는다 (가로 합계 포함)', () => {
    expect(
      inspectSheetSnapshot({ cells: [[{ v: 10 }], [{ v: 20 }], [{ v: 30, f: '=SUM(A1:A2)' }]] }),
    ).toEqual([])
    expect(
      inspectSheetSnapshot({ cells: [[{ v: 1 }, { v: 2 }, { v: 3, f: '=SUM(A1:B1)' }]] }),
    ).toEqual([])
  })

  test('2차원 블록 합계는 검사 대상이 아니다 (단정하지 않음)', () => {
    const f = inspectSheetSnapshot({
      cells: [
        [{ v: 1 }, { v: 2 }],
        [{ v: 3 }, { v: 999, f: '=SUM(A1:B2)' }],
      ],
    })
    expect(f).toEqual([])
  })

  test('스냅샷 밖까지 참조하는 합계는 검사하지 않는다', () => {
    const f = inspectSheetSnapshot({ cells: [[{ v: 5 }], [{ v: 999, f: '=SUM(A1:A5)' }]] })
    expect(f).toEqual([])
  })

  test('보고는 50건에서 끊긴다', () => {
    const cells = Array.from({ length: 60 }, () => [{ v: '#VALUE!' }])
    const f = inspectSheetSnapshot({ cells })
    expect(f.length).toBe(50)
  })
})

describe('signApproval / verifyApproval', () => {
  const payload = { draft: { to: 'a@b.co', subject: '제목', body: '본문' }, fileId: 7 }

  test('서명→검증 왕복이 성립한다', async () => {
    const token = await signApproval('secret-1', payload)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    await expect(verifyApproval('secret-1', payload, token)).resolves.toBe(true)
  })

  test('키 순서를 바꿔도 같은 서명이다 (정규화 JSON)', async () => {
    const a = await signApproval('s', { b: 2, a: { y: 1, x: 2 } })
    const b = await signApproval('s', { a: { x: 2, y: 1 }, b: 2 })
    expect(a).toBe(b)
  })

  test('배열 순서는 서명에 반영된다', async () => {
    const a = await signApproval('s', { p: [1, 2] })
    const b = await signApproval('s', { p: [2, 1] })
    expect(a).not.toBe(b)
  })

  test('페이로드를 바꾸면 검증이 실패한다', async () => {
    const token = await signApproval('secret-1', payload)
    const tampered = { ...payload, draft: { ...payload.draft, subject: '바꾼 제목' } }
    await expect(verifyApproval('secret-1', tampered, token)).resolves.toBe(false)
  })

  test('다른 비밀값의 서명은 검증되지 않는다', async () => {
    const token = await signApproval('secret-1', payload)
    await expect(verifyApproval('secret-2', payload, token)).resolves.toBe(false)
  })

  test('비밀값이 없으면 서명은 빈 문자열, 검증은 항상 실패', async () => {
    await expect(signApproval('', payload)).resolves.toBe('')
    const token = await signApproval('secret-1', payload)
    await expect(verifyApproval('', payload, token)).resolves.toBe(false)
    await expect(verifyApproval('secret-1', payload, '')).resolves.toBe(false)
    await expect(verifyApproval('secret-1', payload, 'short')).resolves.toBe(false)
  })
})

describe('validateSlideOps — 잔여 경계', () => {
  test('배열이 아니면 오류', () => {
    expect(validateSlideOps({}).errors).toEqual(['연산 목록이 배열이 아닙니다'])
  })

  test('MAX_OPS 초과 시 오류를 남기고 24개까지만 처리한다', () => {
    const raw = Array.from({ length: 25 }, () => ({ id: 'slide.new', params: {} }))
    const r = validateSlideOps(raw)
    expect(r.ops.length).toBe(24)
    expect(r.errors).toEqual(['연산이 너무 많습니다 (최대 24개)'])
  })

  test('화이트리스트 밖 명령과 파라미터 누락은 거부', () => {
    const r = validateSlideOps([
      { id: 'slide.delete', params: {} },
      { id: 'text.set' },
      'junk',
    ])
    expect(r.ops).toEqual([])
    expect(r.errors).toEqual([
      '알 수 없는 연산: slide.delete',
      'text.set: 파라미터가 올바르지 않음',
      '형식이 잘못된 연산을 건너뜀',
    ])
  })

  test('text.replace: matchCase·wholeWords는 true일 때만 실린다', () => {
    const r = validateSlideOps([
      { id: 'text.replace', params: { text: 'a', with: 'b', matchCase: false, wholeWords: true } },
    ])
    expect(r.ops).toEqual([{ id: 'text.replace', params: { text: 'a', with: 'b', wholeWords: true } }])
    expect(validateSlideOps([{ id: 'text.replace', params: { text: '', with: 'b' } }]).ops).toEqual([])
    expect(validateSlideOps([{ id: 'text.replace', params: { text: 'x'.repeat(201), with: 'b' } }]).ops).toEqual([])
  })

  test('text.set: 도형 id 경계 (1 ~ 4294967295, 정수)', () => {
    for (const id of [0, -1, 1.5, 4294967296]) {
      expect(validateSlideOps([{ id: 'text.set', params: { id, text: 't' } }]).ops).toEqual([])
    }
    expect(validateSlideOps([{ id: 'text.set', params: { id: 4294967295, text: 't' } }]).ops.length).toBe(1)
  })

  test('text.set: 슬라이드 번호·셀 위치 경계', () => {
    expect(validateSlideOps([{ id: 'text.set', params: { id: 1, text: 't', slide: 1000 } }]).errors[0]).toContain('슬라이드 번호')
    expect(validateSlideOps([{ id: 'text.set', params: { id: 1, text: 't', slide: -1 } }]).ops).toEqual([])
    const ok = validateSlideOps([{ id: 'text.set', params: { id: 1, text: 't', slide: 999, cell: [99, 0] } }])
    expect(ok.ops).toEqual([{ id: 'text.set', params: { id: 1, text: 't', slide: 999, cell: [99, 0] } }])
    expect(validateSlideOps([{ id: 'text.set', params: { id: 1, text: 't', cell: [100, 0] } }]).errors[0]).toContain('표 셀 위치')
    expect(validateSlideOps([{ id: 'text.set', params: { id: 1, text: 't', cell: [0] } }]).ops).toEqual([])
  })

  test('insert.textBox: rect 경계 (x/y 0~5000, 너비/높이 1~5000)', () => {
    const ok = validateSlideOps([{ id: 'insert.textBox', params: { text: 't', rect: [0, 5000, 1, 5000] } }])
    expect(ok.errors).toEqual([])
    for (const rect of [[-1, 0, 10, 10], [0, 0, 0, 10], [0, 0, 10], [0, 0, 10, 5001], [0, 0, 10, '10']]) {
      const r = validateSlideOps([{ id: 'insert.textBox', params: { text: 't', rect } }])
      expect(r.ops).toEqual([])
      expect(r.errors[0]).toContain('위치/크기')
    }
    expect(validateSlideOps([{ id: 'insert.textBox', params: { text: '' } }]).ops).toEqual([])
    expect(validateSlideOps([{ id: 'insert.textBox', params: { text: 't', slide: 1.5 } }]).errors[0]).toContain('슬라이드 번호')
  })

  test('slide.new: 레이아웃 화이트리스트와 필드 길이 상한', () => {
    const ok = validateSlideOps([{ id: 'slide.new', params: { layout: 'titleAndContent', title: '제목', body: '본문', at: 0 } }])
    expect(ok.ops).toEqual([{ id: 'slide.new', params: { layout: 'titleAndContent', title: '제목', body: '본문', at: 0 } }])
    expect(validateSlideOps([{ id: 'slide.new', params: { layout: 'fancy' } }]).errors[0]).toContain('레이아웃')
    expect(validateSlideOps([{ id: 'slide.new', params: { title: 'x'.repeat(201) } }]).errors[0]).toContain('제목')
    expect(validateSlideOps([{ id: 'slide.new', params: { body: 'x'.repeat(4001) } }]).errors[0]).toContain('본문')
    expect(validateSlideOps([{ id: 'slide.new', params: { at: -1 } }]).errors[0]).toContain('위치')
    // 빈 params는 기본 슬라이드 추가로 허용
    expect(validateSlideOps([{ id: 'slide.new', params: {} }]).ops).toEqual([{ id: 'slide.new', params: {} }])
  })
})
