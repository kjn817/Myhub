/// <reference types="jest" />
/**
 * src/services/office-docgen.ts — 문서 생성 엔진 성질 테스트.
 *
 * 고정하는 성질:
 * - ZIP: buildStoredZip ↔ readZipEntries 왕복이 이름·바이트를 그대로
 *   보존하고, EOCD가 없는 입력·지원하지 않는 압축 방식은 명시적으로
 *   실패한다. deflate 엔트리도 풀어 읽는다.
 * - XLSX: 모델(제목·문단·표)이 시트 XML로 정확히 변환된다 — 숫자 셀은
 *   <v>, "=..." 문자열은 수식 <f>, 빈 값은 빈 셀, 특수문자는 XML 이스케이프,
 *   시트 이름은 31자에서 잘린다.
 * - HWPX: 템플릿의 첫 문단(<hp:t/>)에 제목이 들어가고 나머지는 문단으로
 *   뒤에 붙으며, 표는 " | " 결합 행이 된다. mimetype이 첫 엔트리로 유지.
 *   템플릿 구조가 다르면 명시적으로 실패한다.
 * - 메모→문서 종단: 잠긴 메모·민감도 2 메모는 존재하지 않는 것처럼
 *   거부되고(memo_not_found), 잠긴 블록은 모델 입력에 닿기 전에 제거된다.
 * 카나리아: ZIP CRC나 셀 변환 규칙을 깨면 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'
import { deflateRawSync } from 'zlib'
import {
  crc32,
  buildStoredZip,
  readZipEntries,
  buildXlsxFromModel,
  buildHwpxFromModel,
  generateDocFromMemo,
  type ZipEntry,
} from '../../src/services/office-docgen'
import type { OfficeDocModel } from '../../src/services/office-ai'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createLocalD1 } = require('../helpers/local-d1.cjs')

const enc = new TextEncoder()
const dec = new TextDecoder()
const ROOT = path.join(__dirname, '..', '..')
const mig = (n: string) => fs.readFileSync(path.join(ROOT, 'migrations', n), 'utf8')

describe('crc32', () => {
  test('표준 검사 벡터와 빈 입력', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array(0))).toBe(0)
  })
})

describe('buildStoredZip / readZipEntries 왕복', () => {
  test('이름·바이트가 그대로 보존된다 (한글 이름·바이너리·빈 데이터)', async () => {
    const binary = new Uint8Array(Array.from({ length: 256 }, (_, i) => i))
    const zip = buildStoredZip([
      { name: '문서/제목.txt', data: enc.encode('안녕하세요') },
      { name: 'bin.dat', data: binary },
      { name: 'empty.txt', data: new Uint8Array(0) },
    ])
    // ZIP 시그니처: 로컬 헤더로 시작해 EOCD로 끝난다
    expect(new DataView(zip.buffer).getUint32(0, true)).toBe(0x04034b50)
    expect(new DataView(zip.buffer).getUint32(zip.length - 22, true)).toBe(0x06054b50)
    const out = await readZipEntries(zip)
    expect([...out.keys()]).toEqual(['문서/제목.txt', 'bin.dat', 'empty.txt'])
    expect(dec.decode(out.get('문서/제목.txt')!)).toBe('안녕하세요')
    expect(out.get('bin.dat')).toEqual(binary)
    expect(out.get('empty.txt')!.length).toBe(0)
  })

  test('EOCD가 없는 입력은 명시적으로 실패한다', async () => {
    await expect(readZipEntries(enc.encode('이것은 zip이 아닙니다'))).rejects.toThrow('EOCD')
    const zip = buildStoredZip([{ name: 'a.txt', data: enc.encode('x') }])
    await expect(readZipEntries(zip.slice(0, zip.length - 10))).rejects.toThrow('EOCD')
  })

  test('deflate 엔트리도 풀어 읽는다', async () => {
    const original = enc.encode('압축될 텍스트 '.repeat(50))
    const zip = buildRawZip([{ name: 'deflated.txt', data: original, method: 8, stored: deflateRawSync(original) }])
    const out = await readZipEntries(zip)
    expect(out.get('deflated.txt')).toEqual(original)
  })

  test('지원하지 않는 압축 방식은 명시적으로 실패한다', async () => {
    const zip = buildStoredZip([{ name: 'a.txt', data: enc.encode('x') }])
    // 중앙 디렉터리의 method 필드를 9로 바꾼다
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    for (let i = 0; i + 4 <= zip.length; i++) {
      if (view.getUint32(i, true) === 0x02014b50) view.setUint16(i + 10, 9, true)
    }
    await expect(readZipEntries(zip)).rejects.toThrow('지원하지 않는 압축 방식 9')
  })
})

/** method를 지정해 ZIP을 만드는 픽스처 빌더 (SUT가 아니라 입력 제작용). */
function buildRawZip(entries: Array<{ name: string; data: Uint8Array; method: number; stored: Uint8Array }>): Uint8Array {
  const chunks: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const e of entries) {
    const nameBytes = enc.encode(e.name)
    const crc = crc32(e.data)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint16(8, e.method, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, e.stored.length, true)
    local.setUint32(22, e.data.length, true)
    local.setUint16(26, nameBytes.length, true)
    chunks.push(new Uint8Array(local.buffer), nameBytes, e.stored)
    const central = new DataView(new ArrayBuffer(46))
    central.setUint32(0, 0x02014b50, true)
    central.setUint16(4, 20, true)
    central.setUint16(6, 20, true)
    central.setUint16(10, e.method, true)
    central.setUint32(16, crc, true)
    central.setUint32(20, e.stored.length, true)
    central.setUint32(24, e.data.length, true)
    central.setUint16(28, nameBytes.length, true)
    central.setUint32(42, offset, true)
    centrals.push(new Uint8Array(central.buffer), nameBytes)
    offset += 30 + nameBytes.length + e.stored.length
  }
  const centralSize = centrals.reduce((s, c) => s + c.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, centralSize, true)
  end.setUint32(16, offset, true)
  const out = new Uint8Array(offset + centralSize + 22)
  let pos = 0
  for (const c of [...chunks, ...centrals, new Uint8Array(end.buffer)]) {
    out.set(c, pos)
    pos += c.length
  }
  return out
}

const baseModel: OfficeDocModel = {
  title: '주간 보고',
  paragraphs: ['요약 문단'],
  table: { headers: ['이름', '금액'], rows: [['철수', 1000], ['영희', null]] },
}

describe('buildXlsxFromModel', () => {
  test('5개 파트가 정해진 이름으로 들어간다', async () => {
    const entries = await readZipEntries(buildXlsxFromModel(baseModel))
    expect([...entries.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/worksheets/sheet1.xml',
    ])
  })

  test('제목·표·문단이 행 순서대로 시트에 배치된다', async () => {
    const entries = await readZipEntries(buildXlsxFromModel(baseModel))
    const sheet = dec.decode(entries.get('xl/worksheets/sheet1.xml')!)
    // 1행 제목, 2행 빈 행, 3행 헤더, 4~5행 데이터, 6행 빈 행, 7행 문단
    expect(sheet).toContain('<row r="1"><c r="A1" t="inlineStr"><is><t xml:space="preserve">주간 보고</t></is></c></row>')
    expect(sheet).toContain('<row r="2"></row>')
    expect(sheet).toContain('>이름</t>')
    expect(sheet).toContain('<c r="B4"><v>1000</v></c>') // 숫자는 값 셀
    expect(sheet).toContain('<c r="B5"/>') // null은 빈 셀
    expect(sheet).toContain('<row r="7">')
    expect(sheet).toContain('요약 문단')
  })

  test('"="로 시작하는 문자열은 수식 셀이 된다', async () => {
    const model: OfficeDocModel = { title: 't', paragraphs: [], table: { headers: ['수식'], rows: [['=SUM(A1:A2)']] } }
    const entries = await readZipEntries(buildXlsxFromModel(model))
    const sheet = dec.decode(entries.get('xl/worksheets/sheet1.xml')!)
    expect(sheet).toContain('<f>SUM(A1:A2)</f><v>0</v>')
  })

  test('특수문자는 XML 이스케이프되고 시트 이름은 31자로 잘린다', async () => {
    const title = '<긴제목> & "인용" ' + '가'.repeat(40)
    const entries = await readZipEntries(buildXlsxFromModel({ title, paragraphs: [], table: null }))
    const wb = dec.decode(entries.get('xl/workbook.xml')!)
    expect(wb).toContain('&lt;긴제목&gt; &amp; &quot;인용&quot;')
    const name = /<sheet name="([^"]*)"/.exec(wb)![1]
    // 이스케이프된 문자열 기준이 아니라 원제목 31자분만 들어가야 한다
    expect(name).not.toContain('가'.repeat(20))
    const sheet = dec.decode(entries.get('xl/worksheets/sheet1.xml')!)
    expect(sheet).not.toContain('<긴제목>')
  })

  test('빈 제목이면 시트 이름은 Sheet1', async () => {
    const entries = await readZipEntries(buildXlsxFromModel({ title: '', paragraphs: [], table: null }))
    const wb = dec.decode(entries.get('xl/workbook.xml')!)
    expect(wb).toContain('<sheet name="Sheet1"')
  })

  test('열이 Z를 넘으면 AA·AB 표기를 쓴다', async () => {
    const headers = Array.from({ length: 28 }, (_, i) => `h${i}`)
    const entries = await readZipEntries(buildXlsxFromModel({ title: 't', paragraphs: [], table: { headers, rows: [] } }))
    const sheet = dec.decode(entries.get('xl/worksheets/sheet1.xml')!)
    expect(sheet).toContain('<c r="AA3"')
    expect(sheet).toContain('<c r="AB3"')
  })

  test('표가 없으면 문단만으로 구성된다', async () => {
    const entries = await readZipEntries(buildXlsxFromModel({ title: '제목', paragraphs: ['p1', 'p2'], table: null }))
    const sheet = dec.decode(entries.get('xl/worksheets/sheet1.xml')!)
    expect(sheet).toContain('<row r="3">')
    expect(sheet).toContain('p1')
    expect(sheet).toContain('p2')
  })
})

function hwpxTemplate(sectionXml: string): Uint8Array {
  return buildStoredZip([
    { name: 'mimetype', data: enc.encode('application/hwp+zip') },
    { name: 'Contents/section0.xml', data: enc.encode(sectionXml) },
    { name: 'Contents/content.hpf', data: enc.encode('<opf/>') },
  ])
}
const SECTION = '<hs:sec><hp:p id="0"><hp:run><hp:t/></hp:run></hp:p></hs:sec>'

describe('buildHwpxFromModel', () => {
  test('제목이 첫 문단에 들어가고 나머지 줄이 문단으로 뒤에 붙는다', async () => {
    const out = await buildHwpxFromModel(hwpxTemplate(SECTION), baseModel)
    const entries = await readZipEntries(out)
    const section = dec.decode(entries.get('Contents/section0.xml')!)
    expect(section).toContain('<hp:t>주간 보고</hp:t>')
    expect(section).toContain('요약 문단')
    // 표는 " | " 결합 행으로
    expect(section).toContain('이름 | 금액')
    expect(section).toContain('철수 | 1000')
    expect(section).toContain('영희 | ')
    // 추가 문단은 </hs:sec> 앞에 들어간다
    expect(section.indexOf('요약 문단')).toBeLessThan(section.indexOf('</hs:sec>'))
    // 다른 엔트리는 보존된다
    expect(dec.decode(entries.get('Contents/content.hpf')!)).toBe('<opf/>')
  })

  test('mimetype이 첫 엔트리로 유지된다', async () => {
    const out = await buildHwpxFromModel(hwpxTemplate(SECTION), baseModel)
    const nameLen = new DataView(out.buffer, out.byteOffset).getUint16(26, true)
    expect(dec.decode(out.subarray(30, 30 + nameLen))).toBe('mimetype')
  })

  test('제목의 특수문자는 이스케이프된다', async () => {
    const out = await buildHwpxFromModel(hwpxTemplate(SECTION), { title: 'A & B', paragraphs: [], table: null })
    const section = dec.decode((await readZipEntries(out)).get('Contents/section0.xml')!)
    expect(section).toContain('<hp:t>A &amp; B</hp:t>')
  })

  test('section0.xml이 없는 템플릿은 명시적으로 실패한다', async () => {
    const bad = buildStoredZip([{ name: 'mimetype', data: enc.encode('x') }])
    await expect(buildHwpxFromModel(bad, baseModel)).rejects.toThrow('section0.xml이 없습니다')
  })

  test('첫 문단 구조(<hp:t/>)가 없는 템플릿은 명시적으로 실패한다', async () => {
    const bad = hwpxTemplate('<hs:sec><hp:p><hp:run><hp:t>이미 있음</hp:t></hp:run></hp:p></hs:sec>')
    await expect(buildHwpxFromModel(bad, baseModel)).rejects.toThrow('템플릿 첫 문단 구조가 다릅니다')
  })
})

function makeDb() {
  const db = createLocalD1()
  db.exec(mig('0001_init.sql'))
  db.exec(
    'ALTER TABLE memos ADD COLUMN is_locked INTEGER DEFAULT 0; ' +
      'ALTER TABLE memos ADD COLUMN sensitivity INTEGER DEFAULT 1; ' +
      "ALTER TABLE memos ADD COLUMN locked_blocks TEXT DEFAULT '[]';",
  )
  return db
}

async function seedMemo(db: any, text: string, isLocked = 0, sensitivity = 1): Promise<number> {
  const r = await db
    .prepare('INSERT INTO memos (text, is_locked, sensitivity) VALUES (?, ?, ?)')
    .bind(text, isLocked, sensitivity)
    .run()
  return Number(r.meta.last_row_id)
}

const DOC_CHAT_TEXT =
  '[OFFICE_DOC]{"title":"주간 보고","paragraphs":["첫 문단"],"table":{"headers":["항목","값"],"rows":[["건수",3]]}}[/OFFICE_DOC]'

describe('generateDocFromMemo — 종단', () => {
  test('excel: 모델→xlsx 바이트·파일명·메타가 일관된다', async () => {
    const db = makeDb()
    const memoId = await seedMemo(db, '주간 업무 정리\n건수는 세 건')
    const captured: Array<{ bytes: Uint8Array; filename: string; mime: string }> = []
    const chatCalls: any[] = []
    const result = await generateDocFromMemo(
      { DB: db } as never,
      { memoId, target: 'excel', dateLabel: '2026-11-08' },
      {
        chat: async (_env, _policy, messages) => {
          chatCalls.push(messages)
          return { text: DOC_CHAT_TEXT }
        },
        saveFile: async (_env, bytes, filename, mime) => {
          captured.push({ bytes, filename, mime })
          return { id: 42 }
        },
      },
    )
    expect(result).toEqual({ fileId: 42, filename: '주간 보고 2026-11-08.xlsx', title: '주간 보고', target: 'excel' })
    expect(captured[0].mime).toContain('spreadsheetml.sheet')
    const sheet = dec.decode((await readZipEntries(captured[0].bytes)).get('xl/worksheets/sheet1.xml')!)
    expect(sheet).toContain('주간 보고')
    expect(sheet).toContain('<v>3</v>')
    // 메모 원문이 모델 입력으로 전달된다
    expect(chatCalls[0][1].content).toContain('주간 업무 정리')
  })

  test('hangul: 주입된 템플릿으로 hwpx를 만든다', async () => {
    const db = makeDb()
    const memoId = await seedMemo(db, '회의 정리')
    const captured: Array<{ filename: string; mime: string }> = []
    const result = await generateDocFromMemo(
      { DB: db } as never,
      { memoId, target: 'hangul', dateLabel: '2026-11-08' },
      {
        chat: async () => ({ text: DOC_CHAT_TEXT }),
        loadTemplate: async () => hwpxTemplate(SECTION),
        saveFile: async (_env, _bytes, filename, mime) => {
          captured.push({ filename, mime })
          return { id: 7 }
        },
      },
    )
    expect(result.filename).toBe('주간 보고 2026-11-08.hwpx')
    expect(captured[0].mime).toBe('application/hwp+zip')
  })

  test('dateLabel이 없으면 오늘 날짜(ISO)가 파일명에 쓰인다', async () => {
    const db = makeDb()
    const memoId = await seedMemo(db, '메모')
    const result = await generateDocFromMemo(
      { DB: db } as never,
      { memoId, target: 'excel' },
      { chat: async () => ({ text: DOC_CHAT_TEXT }), saveFile: async () => ({ id: 1 }) },
    )
    expect(result.filename).toMatch(/주간 보고 \d{4}-\d{2}-\d{2}\.xlsx$/)
  })

  test('없는 메모는 memo_not_found', async () => {
    const db = makeDb()
    await expect(
      generateDocFromMemo({ DB: db } as never, { memoId: 999, target: 'excel' }, { chat: async () => ({ text: DOC_CHAT_TEXT }) }),
    ).rejects.toThrow('memo_not_found')
  })

  test('잠긴 메모와 민감도 2 메모는 존재하지 않는 것처럼 거부된다', async () => {
    const db = makeDb()
    const lockedId = await seedMemo(db, '잠긴 메모 본문', 1, 1)
    const secretId = await seedMemo(db, '민감 메모 본문', 0, 2)
    for (const id of [lockedId, secretId]) {
      await expect(
        generateDocFromMemo({ DB: db } as never, { memoId: id, target: 'excel' }, { chat: async () => ({ text: DOC_CHAT_TEXT }) }),
      ).rejects.toThrow('memo_not_found')
    }
  })

  test('잠긴 블록은 모델 입력에 닿기 전에 제거된다', async () => {
    const db = makeDb()
    const memoId = await seedMemo(db, '공개 문단\n<span class="locked">절대 비밀 문구</span>\n다음 문단')
    let seenUser = ''
    await generateDocFromMemo(
      { DB: db } as never,
      { memoId, target: 'excel' },
      {
        chat: async (_env, _policy, messages) => {
          seenUser = messages[1].content
          return { text: DOC_CHAT_TEXT }
        },
        saveFile: async () => ({ id: 1 }),
      },
    )
    expect(seenUser).not.toContain('절대 비밀 문구')
    expect(seenUser).toContain('[LOCKED_BLOCK]')
    expect(seenUser).toContain('공개 문단')
  })

  test('템플릿 소스가 없으면 hangul 생성은 template_unavailable로 실패한다', async () => {
    const db = makeDb()
    const memoId = await seedMemo(db, '메모')
    await expect(
      generateDocFromMemo(
        { DB: db } as never,
        { memoId, target: 'hangul' },
        { chat: async () => ({ text: DOC_CHAT_TEXT }), saveFile: async () => ({ id: 1 }) },
      ),
    ).rejects.toThrow('template_unavailable')
  })
})
