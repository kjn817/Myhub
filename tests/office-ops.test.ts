/**
 * office-ops — 오피스 비서 연산 파서·검증 테스트 (재구축, 2026-11-07)
 *
 * 번들 계약 (2026-11-08 사용자 결정으로 원본 복귀): 파서는 office-ops.ts 안의
 * 엄격 파서다. 닫힌 [OFFICE_OPS]…[/OFFICE_OPS] 블록 안의 본문을 JSON.parse로
 * 그대로 파싱해 {ops: [...]} 형태일 때만 rawOps로 삼고, 그 외 모든 변형
 * (코드펜스·맨배열·후행 콤마·블록 내 설명·마커 공백·이스케이프 JSON·닫는 태그
 * 누락·문자열 안 생 제어문자)은 opsMalformed=true로 거부한다. 블록·마커 잔재는
 * 답변에서 제거된다. 결과에 opsRepair·opsDiag 필드는 없다.
 * - 검증: 운영 번들(.recovery/live-bundle)의 validateSlideOps·validateSheetOps 실물.
 */
import { parseOfficeOpsResponse } from '../src/services/office-ops'
import { validateSlideOps } from '../src/services/office-ops-slide'
import { validateSheetOps } from '../src/services/office-ops'

const OPS = [{ id: 'text.set', params: { id: 1, text: '제목입니다' } }]
const BLOCK = `[OFFICE_OPS]${JSON.stringify({ ops: OPS })}[/OFFICE_OPS]`

describe('parseOfficeOpsResponse — 정본 형식', () => {
  test('닫힌 블록+엄격 JSON: ops를 파싱하고 본문에서 블록을 제거한다', () => {
    const r = parseOfficeOpsResponse(`적용했습니다.\n${BLOCK}`)
    expect(r.rawOps).toEqual(OPS)
    expect(r.opsMalformed).toBe(false)
    expect('opsRepair' in r).toBe(false)
    expect(r.reply).toBe('적용했습니다.')
  })

  test('블록이 없으면 rawOps는 null, malformed 아님, 본문 무변경', () => {
    const r = parseOfficeOpsResponse('그냥 답변입니다.')
    expect(r.rawOps).toBeNull()
    expect(r.opsMalformed).toBe(false)
    expect(r.reply).toBe('그냥 답변입니다.')
  })

  test('빈 ops 배열은 유효하다 (변경 없음 지시)', () => {
    const r = parseOfficeOpsResponse('[OFFICE_OPS]{"ops":[]}[/OFFICE_OPS]')
    expect(r.rawOps).toEqual([])
    expect(r.opsMalformed).toBe(false)
  })
})

describe('parseOfficeOpsResponse — 형식 변형은 전부 거부 (엄격 파서)', () => {
  test('블록 안 코드펜스로 감싼 JSON', () => {
    const r = parseOfficeOpsResponse(`[OFFICE_OPS]\n\`\`\`json\n${JSON.stringify({ ops: OPS })}\n\`\`\`\n[/OFFICE_OPS]`)
    expect(r.rawOps).toBeNull()
    expect(r.opsMalformed).toBe(true)
  })

  test('블록 전체를 감싼 코드펜스 — 안쪽 블록 자체는 정본이라 파싱된다', () => {
    const r = parseOfficeOpsResponse(`\`\`\`\n${BLOCK}\n\`\`\``)
    expect(r.rawOps).toEqual(OPS)
    expect(r.opsMalformed).toBe(false)
  })

  test('{"ops":...} 래퍼 없는 맨배열', () => {
    const r = parseOfficeOpsResponse(`[OFFICE_OPS]${JSON.stringify(OPS)}[/OFFICE_OPS]`)
    expect(r.rawOps).toBeNull()
    expect(r.opsMalformed).toBe(true)
  })

  test('후행 콤마가 있는 JSON', () => {
    const r = parseOfficeOpsResponse('[OFFICE_OPS]{"ops":[{"id":"slide.new","params":{},}],}[/OFFICE_OPS]')
    expect(r.rawOps).toBeNull()
    expect(r.opsMalformed).toBe(true)
  })

  test('블록 안 JSON 뒤에 설명 문장이 붙은 경우 — malformed이고 블록은 제거된다', () => {
    const r = parseOfficeOpsResponse(`[OFFICE_OPS]${JSON.stringify({ ops: OPS })} 위 연산을 적용합니다[/OFFICE_OPS]`)
    expect(r.rawOps).toBeNull()
    expect(r.opsMalformed).toBe(true)
    expect(r.reply).not.toContain('OFFICE_OPS')
  })

  test('마커 안쪽 공백 변형', () => {
    const r = parseOfficeOpsResponse(`[OFFICE_OPS ]${JSON.stringify({ ops: OPS })}[/OFFICE_OPS ]`)
    expect(r.rawOps).toBeNull()
    expect(r.opsMalformed).toBe(true)
  })

  test('이스케이프된 JSON 문자열로 온 본문', () => {
    const escaped = JSON.stringify(JSON.stringify({ ops: OPS }))
    const r = parseOfficeOpsResponse(`[OFFICE_OPS]${escaped}[/OFFICE_OPS]`)
    expect(r.rawOps).toBeNull()
    expect(r.opsMalformed).toBe(true)
  })
})

describe('parseOfficeOpsResponse — 끊긴 블록은 회수하지 않는다 (엄격 파서)', () => {
  test('닫는 태그가 없으면 완성된 JSON이어도 malformed이고 마커 뒤는 잘린다', () => {
    const r = parseOfficeOpsResponse(`앞 문장입니다. [OFFICE_OPS]${JSON.stringify({ ops: OPS })}`)
    expect(r.rawOps).toBeNull()
    expect(r.opsMalformed).toBe(true)
    expect(r.reply).toBe('앞 문장입니다.')
  })

  test('마지막 연산이 중간에 끊기면 malformed', () => {
    const body = `{"ops":[${JSON.stringify(OPS[0])},{"id":"text.set","params":{"id":2,"te`
    const r = parseOfficeOpsResponse(`[OFFICE_OPS]${body}`)
    expect(r.rawOps).toBeNull()
    expect(r.opsMalformed).toBe(true)
  })

  test('완성된 연산이 하나도 없으면 malformed — 거짓 성공을 만들지 않는다', () => {
    const r = parseOfficeOpsResponse('[OFFICE_OPS]{"ops":[{"id":"text.set","params":{"id":2,"te')
    expect(r.rawOps).toBeNull()
    expect(r.opsMalformed).toBe(true)
    expect(r.reply).not.toContain('OFFICE_OPS')
  })
})

describe('parseOfficeOpsResponse — 정직한 실패와 누출 차단', () => {
  test('JSON이 아닌 본문은 malformed이고 블록은 본문에서 제거된다', () => {
    const r = parseOfficeOpsResponse('시도했습니다. [OFFICE_OPS]이건 연산이 아닙니다[/OFFICE_OPS]')
    expect(r.rawOps).toBeNull()
    expect(r.opsMalformed).toBe(true)
    expect(r.reply).toBe('시도했습니다.')
  })

  test('ops가 배열이 아니면 malformed', () => {
    const r = parseOfficeOpsResponse('[OFFICE_OPS]{"ops":"아님"}[/OFFICE_OPS]')
    expect(r.rawOps).toBeNull()
    expect(r.opsMalformed).toBe(true)
  })

  test('완성 블록이 둘 있으면 둘 다 제거하고 첫 블록의 ops를 쓴다', () => {
    const second = `[OFFICE_OPS]${JSON.stringify({ ops: [{ id: 'slide.new', params: {} }] })}[/OFFICE_OPS]`
    const r = parseOfficeOpsResponse(`설명 ${BLOCK} 중간 ${second} 끝`)
    expect(r.rawOps).toEqual(OPS)
    expect(r.reply).not.toContain('OFFICE_OPS')
    expect(r.reply).toContain('설명')
    expect(r.reply).toContain('끝')
  })

  test('어떤 변형에서도 답변에 OFFICE_OPS 마커 잔재가 남지 않는다', () => {
    const variants = [
      `[OFFICE_OPS]\`\`\`json\n${JSON.stringify({ ops: OPS })}\n\`\`\`[/OFFICE_OPS]`,
      `본문 [OFFICE_OPS]${JSON.stringify({ ops: OPS })}`,
      '[OFFICE_OPS]{"ops":[{"id":"text.set","params":{"id":2,"te',
      '본문 [OFFICE_OPS]깨진 본문[/OFFICE_OPS] 끝',
      `본문 [OFFICE_OPS]${JSON.stringify({ ops: OPS })}[/OFFICE_OPS]`,
    ]
    for (const v of variants) {
      expect(parseOfficeOpsResponse(v).reply).not.toContain('OFFICE_OPS')
    }
  })

  test('한글 파라미터가 깨지지 않고 왕복한다', () => {
    const ops = [{ id: 'text.set', params: { id: 3, text: '강원도 차량관리팀 회의 자료' } }]
    const r = parseOfficeOpsResponse(`[OFFICE_OPS]${JSON.stringify({ ops })}[/OFFICE_OPS]`)
    expect(r.rawOps).toEqual(ops)
  })
})

describe('parseOfficeOpsResponse — F5 실모델 변형 (3차 운영 QA 한글 건)', () => {
  // 운영 다이아그: 마커 쌍 검출, 괄호 균형 정상(중괄호 2/2·대괄호 2/2·depth 0),
  // fenced 아님, 그런데 'no-complete-ops'로 전건 실패. 구조는 멀쩡한데
  // JSON.parse만 실패하는 형태 — 문자열 안 생 제어문자가 그 대표다.
  const QA_BODY =
    '{"ops":[{"type":"append_paragraphs","paragraphs":["가을 단풍 여행\n붉게 물든 계절을 걷다","설악산의 단풍은 10월 중순에 절정을 이룬다.","내장산은 터널처럼 이어지는 단풍길로 유명하다.","경주에서는 고분과 단풍이 어우러진 풍경을 볼 수 있다."]}]}'

  test('픽스처 자체가 엄격 JSON.parse를 실패하는 형태임을 고정한다', () => {
    expect(() => JSON.parse(QA_BODY)).toThrow()
  })

  test('문자열 안 실제 줄바꿈: 엄격 파서는 malformed로 거부한다 (원본 결함 그대로)', () => {
    const r = parseOfficeOpsResponse(`[OFFICE_OPS]${QA_BODY}[/OFFICE_OPS]`)
    expect(r.opsMalformed).toBe(true)
    expect(r.rawOps).toBeNull()
  })

  test('문자열 안 실제 탭 문자도 malformed로 거부한다', () => {
    const body = '{"ops":[{"type":"replace_text","find":"검토\t요망","replace":"검토 완료"}]}'
    const r = parseOfficeOpsResponse(`[OFFICE_OPS]${body}[/OFFICE_OPS]`)
    expect(r.opsMalformed).toBe(true)
    expect(r.rawOps).toBeNull()
  })

  test('작은따옴표 문자열 변형도 malformed로 거부한다', () => {
    const body = "{'ops':[{'type':'append_paragraphs','paragraphs':['문단 하나','문단 둘']}]}"
    const r = parseOfficeOpsResponse(`[OFFICE_OPS]${body}[/OFFICE_OPS]`)
    expect(r.opsMalformed).toBe(true)
    expect(r.rawOps).toBeNull()
  })

  test('끊긴 블록 + 생 제어문자: malformed로 거부한다', () => {
    const body =
      '{"ops":[{"type":"append_paragraphs","paragraphs":["완성된\n문단"]},{"type":"append_paragraphs","parag'
    const r = parseOfficeOpsResponse(`[OFFICE_OPS]${body}`)
    expect(r.opsMalformed).toBe(true)
    expect(r.rawOps).toBeNull()
  })

  test('토큰 사이 줄바꿈(들여쓴 엄격 JSON)은 그대로 파싱된다', () => {
    const pretty = JSON.stringify({ ops: OPS }, null, 2)
    const r = parseOfficeOpsResponse(`[OFFICE_OPS]${pretty}[/OFFICE_OPS]`)
    expect(r.rawOps).toEqual(OPS)
    expect(r.opsMalformed).toBe(false)
  })

  test("큰따옴표 문자열 안의 작은따옴표는 엄격 파싱을 방해하지 않는다", () => {
    const body = JSON.stringify({ ops: [{ type: 'replace_text', find: "it's", replace: 'it is' }] })
    const r = parseOfficeOpsResponse(`[OFFICE_OPS]${body}[/OFFICE_OPS]`)
    expect(r.opsMalformed).toBe(false)
    expect((r.rawOps as any[])[0].find).toBe("it's")
  })
})

describe('validateSlideOps — 슬라이드 연산 화이트리스트·필드 검증', () => {
  test('유효한 text.replace는 정규화돼 통과한다 (불필요 필드 제거, matchCase true만 유지)', () => {
    const { ops, errors } = validateSlideOps([
      { id: 'text.replace', params: { text: '이전', with: '이후', matchCase: true, bogus: 1 } },
    ])
    expect(errors).toEqual([])
    expect(ops).toEqual([{ id: 'text.replace', params: { text: '이전', with: '이후', matchCase: true } }])
  })

  test('text.replace의 찾을 문자열이 비면 거부', () => {
    const { ops, errors } = validateSlideOps([{ id: 'text.replace', params: { text: '', with: 'x' } }])
    expect(ops).toEqual([])
    expect(errors).toHaveLength(1)
  })

  test('text.replace의 찾을 문자열 200자 초과는 거부', () => {
    const { ops, errors } = validateSlideOps([
      { id: 'text.replace', params: { text: '가'.repeat(201), with: 'x' } },
    ])
    expect(ops).toEqual([])
    expect(errors).toHaveLength(1)
  })

  test('유효한 text.set (도형 id+텍스트) 통과', () => {
    const { ops, errors } = validateSlideOps([{ id: 'text.set', params: { id: 5, text: '새 제목' } }])
    expect(errors).toEqual([])
    expect(ops).toEqual([{ id: 'text.set', params: { id: 5, text: '새 제목' } }])
  })

  test('text.set의 도형 id 경계 (0과 2^32) 거부', () => {
    for (const bad of [0, 4294967296, -1, 1.5]) {
      const { ops, errors } = validateSlideOps([{ id: 'text.set', params: { id: bad, text: 'x' } }])
      expect(ops).toEqual([])
      expect(errors).toHaveLength(1)
    }
  })

  test('text.set의 표 셀 위치가 범위를 벗어나면 거부', () => {
    const { ops, errors } = validateSlideOps([
      { id: 'text.set', params: { id: 5, text: 'x', cell: [0, 100] } },
    ])
    expect(ops).toEqual([])
    expect(errors).toHaveLength(1)
  })

  test('text.set의 슬라이드 지정이 숫자가 아니면 거부', () => {
    const { ops, errors } = validateSlideOps([
      { id: 'text.set', params: { id: 5, text: 'x', slide: '두번째' as unknown as number } },
    ])
    expect(ops).toEqual([])
    expect(errors).toHaveLength(1)
  })

  test('유효한 insert.textBox (rect 포함) 통과', () => {
    const { ops, errors } = validateSlideOps([
      { id: 'insert.textBox', params: { text: '본문 상자', rect: [10, 20, 300, 80] } },
    ])
    expect(errors).toEqual([])
    expect(ops[0].params.rect).toEqual([10, 20, 300, 80])
  })

  test('insert.textBox의 빈 텍스트 거부', () => {
    const { ops, errors } = validateSlideOps([{ id: 'insert.textBox', params: { text: '' } }])
    expect(ops).toEqual([])
    expect(errors).toHaveLength(1)
  })

  test('insert.textBox의 rect 크기 0은 거부', () => {
    const { ops, errors } = validateSlideOps([
      { id: 'insert.textBox', params: { text: 'x', rect: [0, 0, 0, 100] } },
    ])
    expect(ops).toEqual([])
    expect(errors).toHaveLength(1)
  })

  test('유효한 slide.new (레이아웃+제목) 통과', () => {
    const { ops, errors } = validateSlideOps([
      { id: 'slide.new', params: { layout: 'title', title: '새 슬라이드' } },
    ])
    expect(errors).toEqual([])
    expect(ops).toEqual([{ id: 'slide.new', params: { layout: 'title', title: '새 슬라이드' } }])
  })

  test('slide.new의 알 수 없는 레이아웃 거부', () => {
    const { ops, errors } = validateSlideOps([{ id: 'slide.new', params: { layout: '없는종류' } }])
    expect(ops).toEqual([])
    expect(errors).toHaveLength(1)
  })

  test('slide.new의 제목 200자 초과 거부', () => {
    const { ops, errors } = validateSlideOps([
      { id: 'slide.new', params: { title: '가'.repeat(201) } },
    ])
    expect(ops).toEqual([])
    expect(errors).toHaveLength(1)
  })

  test('화이트리스트 밖 연산(slide.delete 등)은 알 수 없는 연산으로 거부', () => {
    const { ops, errors } = validateSlideOps([{ id: 'slide.delete', params: {} }])
    expect(ops).toEqual([])
    expect(errors[0]).toContain('알 수 없는 연산')
  })

  test('배열이 아닌 입력은 단일 오류와 빈 ops', () => {
    const { ops, errors } = validateSlideOps('아님' as unknown as unknown[])
    expect(ops).toEqual([])
    expect(errors).toHaveLength(1)
  })

  test('형식이 깨진 항목은 건너뛰고 유효한 형제 연산은 통과한다', () => {
    const { ops, errors } = validateSlideOps([
      { params: {} },
      { id: 'slide.new', params: { title: '정상' } },
    ])
    expect(errors).toHaveLength(1)
    expect(ops).toEqual([{ id: 'slide.new', params: { title: '정상' } }])
  })
})

describe('validateSheetOps — 시트 연산 검증 (flavor 대조)', () => {
  test('set_cell 값·수식 모두 통과하고 셀 주소가 정규화된다', () => {
    const v = validateSheetOps([{ type: 'set_cell', cell: 'b2', value: '값' }])
    expect(v.errors).toEqual([])
    expect(v.ops[0]).toMatchObject({ type: 'set_cell', cell: 'B2' })
    const f = validateSheetOps([{ type: 'set_cell', cell: 'A1', formula: '=SUM(B1:B3)' }])
    expect(f.errors).toEqual([])
  })

  test('set_cell의 잘못된 셀 주소 거부', () => {
    const { ops, errors } = validateSheetOps([{ type: 'set_cell', cell: '!!', value: 1 }])
    expect(ops).toEqual([])
    expect(errors).toHaveLength(1)
  })

  test('set_range 크기가 맞는 행렬 통과', () => {
    const { ops, errors } = validateSheetOps([
      { type: 'set_range', range: 'A1:B2', values: [[1, 2], [3, 4]] },
    ])
    expect(errors).toEqual([])
    expect(ops).toHaveLength(1)
  })

  test('set_range 행렬 크기가 범위와 다르면 거부', () => {
    const { ops, errors } = validateSheetOps([{ type: 'set_range', range: 'A1:B2', values: [[1]] }])
    expect(ops).toEqual([])
    expect(errors).toHaveLength(1)
  })
})
