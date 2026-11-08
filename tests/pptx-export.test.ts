/**
 * PPTX 내보내기 (트랙 9: ppt-master 패턴) 테스트
 *
 * - ZIP 작성기: 중앙 디렉토리 파싱 + CRC32 독립 재계산으로 왕복 검증
 * - PPTX 빌더: 필수 파트 존재, 모든 XML well-formed (DOMParser),
 *   네이티브 차트 존재, 한글 텍스트 왕복
 * - 덱 조립: 순수 함수 단위 테스트 (DB 없음)
 * - 라우트: better-sqlite3 인메모리 D1 어댑터로 실DB 검증 —
 *   잠긴 메모·Restricted 메모가 PPTX에 포함되지 않음을 확인
 * - 인증: 전역 미들웨어 경유 시 쿠키 없이 /api/pptx/* → 401
 *
 * 실행: npx jest tests/pptx-export.test.ts
 */

import { buildPptx, type PptxDeck } from '../src/services/pptx-builder'
import { crc32, createZip } from '../src/services/pptx-zip'
import {
  addDays,
  kstDateStr,
  morningBriefingDeck,
  weekMonday,
  weeklyReportDeck,
} from '../src/services/briefing-export'
import { pptxApp } from '../src/modules/pptx/routes'

const Database = require('better-sqlite3')

// ---------- 테스트용 독립 구현: ZIP 중앙 디렉토리 파서 + CRC32 ----------

function testCrc32(data: Uint8Array): number {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

interface ParsedEntry {
  path: string
  method: number
  crc: number
  data: Uint8Array
}

/** store ZIP을 파싱해 엔트리 목록을 반환한다 (중앙 디렉토리 기준). */
function parseZip(bytes: Uint8Array): ParsedEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // EOCD는 마지막 22바이트 (코멘트 없음)
  const eocd = bytes.length - 22
  expect(view.getUint32(eocd, true)).toBe(0x06054b50)
  const count = view.getUint16(eocd + 10, true)
  const cdSize = view.getUint32(eocd + 12, true)
  const cdOffset = view.getUint32(eocd + 16, true)
  expect(cdSize).toBeGreaterThan(0)

  const entries: ParsedEntry[] = []
  let pos = cdOffset
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(pos, true)).toBe(0x02014b50)
    const method = view.getUint16(pos + 10, true)
    const crc = view.getUint32(pos + 16, true)
    const compSize = view.getUint32(pos + 20, true)
    const nameLen = view.getUint16(pos + 28, true)
    const extraLen = view.getUint16(pos + 30, true)
    const commentLen = view.getUint16(pos + 32, true)
    const localOffset = view.getUint32(pos + 42, true)
    const path = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLen))
    // 로컬 헤더에서 데이터 위치 확인
    expect(view.getUint32(localOffset, true)).toBe(0x04034b50)
    const localNameLen = view.getUint16(localOffset + 26, true)
    const localExtraLen = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const data = bytes.subarray(dataStart, dataStart + compSize)
    entries.push({ path, method, crc, data: new Uint8Array(data) })
    pos += 46 + nameLen + extraLen + commentLen
  }
  expect(pos).toBe(cdOffset + cdSize)
  return entries
}

/**
 * XML well-formed 검사 (테스트 내 독립 구현).
 * jest 환경이 CommonJS라 ESM 전용 jsdom을 import할 수 없어, 태그 균형·중첩·
 * 속성 인용부호·엔티티 이스케이프를 직접 검사한다. 실제 파서 검증은
 * LibreOffice 변환 단계에서 별도로 수행한다.
 */
function assertWellFormedXml(xml: string, label: string): void {
  const stack: string[] = []
  let i = 0
  const fail = (msg: string): never => {
    throw new Error(
      `${label} XML 오류 (${msg}) at offset ${i}: ...${xml.slice(Math.max(0, i - 40), i + 40)}...`,
    )
  }
  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    if (lt === -1) break
    // 텍스트 구간: '&'는 엔티티 형태로만 허용 (이스케이프 누락 검출)
    const text = xml.slice(i, lt)
    if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(text)) {
      fail('이스케이프되지 않은 &')
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2)
      if (end === -1) fail('닫히지 않은 처리 지시문')
      i = end + 2
      continue
    }
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4)
      if (end === -1) fail('닫히지 않은 주석')
      i = end + 3
      continue
    }
    // 태그 끝 찾기 (인용부호 안의 '>'는 무시)
    let j = lt + 1
    let quote: string | null = null
    while (j < xml.length) {
      const ch = xml[j]
      if (quote) {
        if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '>') {
        break
      }
      j++
    }
    if (j >= xml.length) fail('닫히지 않은 태그')
    const raw = xml.slice(lt + 1, j).trim()
    if (raw.startsWith('/')) {
      const name = raw.slice(1).split(/\s/)[0]
      const open = stack.pop()
      if (open !== name) fail(`닫는 태그 불일치: </${name}> (열린 태그 <${open}>)`)
    } else if (!raw.endsWith('/')) {
      const name = raw.split(/\s/)[0]
      if (!/^[A-Za-z_][\w.:-]*$/.test(name)) fail(`잘못된 태그명: ${name}`)
      stack.push(name)
    }
    i = j + 1
  }
  if (stack.length > 0) fail(`닫히지 않은 태그 남음: ${stack.join(', ')}`)
}

function sampleDeck(): PptxDeck {
  return {
    title: '테스트 덱',
    slides: [
      { kind: 'title', title: '아침 브리핑', subtitle: '2026-10-25 · 오늘 일정 2건', meta: 'MyHub' },
      { kind: 'bullets', title: '오늘 일정', bullets: ['09:00 팀 회의 (회의실)', '14:00 병원 예약'] },
      {
        kind: 'chart',
        title: '할 일 우선순위 분포',
        categories: ['높음', '보통', '낮음'],
        series: [{ name: '미완료 할 일', values: [1, 2, 0] }],
      },
    ],
  }
}

// ---------- D1 어댑터 (기존 tests/integration 패턴) ----------

function createD1Adapter(db: any): any {
  // 실제 D1PreparedStatement와 동일하게 prepare() 직후 all/first/run 사용 가능,
  // bind()는 바인딩된 문장을 반환한다.
  const wrap = (stmt: any, params: any[] = []): any => ({
    bind(...p: any[]) {
      return wrap(stmt, p)
    },
    all() {
      try {
        return Promise.resolve({ results: stmt.all(...params) })
      } catch (e) {
        return Promise.reject(e)
      }
    },
    first() {
      try {
        return Promise.resolve(stmt.get(...params))
      } catch (e) {
        return Promise.reject(e)
      }
    },
    run() {
      try {
        return Promise.resolve(stmt.run(...params))
      } catch (e) {
        return Promise.reject(e)
      }
    },
  })
  return {
    prepare(query: string) {
      return wrap(db.prepare(query))
    },
  }
}

function seedDb(): any {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
      start_at TEXT NOT NULL, end_at TEXT, location TEXT DEFAULT '',
      status TEXT DEFAULT 'active'
    );
    CREATE TABLE todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
      due_at TEXT, priority INTEGER DEFAULT 1, status TEXT DEFAULT 'pending'
    );
    CREATE TABLE memos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      is_locked INTEGER DEFAULT 0, sensitivity INTEGER DEFAULT 0
    );
  `)
  return db
}

describe('pptx-zip (store ZIP 작성기)', () => {
  it('CRC32 표준 벡터: "123456789" → 0xCBF43926', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('왕복: 엔트리 내용·CRC·method가 보존된다', () => {
    const hello = new TextEncoder().encode('안녕하세요 PowerPoint')
    const bytes = createZip([
      { path: 'a.txt', data: hello },
      { path: 'dir/b.xml', data: new TextEncoder().encode('<x/>') },
      { path: 'empty.bin', data: new Uint8Array(0) },
    ])
    const entries = parseZip(bytes)
    expect(entries.map((e) => e.path)).toEqual(['a.txt', 'dir/b.xml', 'empty.bin'])
    for (const e of entries) {
      expect(e.method).toBe(0) // store
      expect(testCrc32(e.data)).toBe(e.crc) // 독립 재계산과 일치
    }
    expect(new TextDecoder().decode(entries[0].data)).toBe('안녕하세요 PowerPoint')
    expect(entries[2].data.length).toBe(0)
  })

  it('중복 경로·빈 엔트리 목록을 거부한다', () => {
    const data = new Uint8Array([1])
    expect(() => createZip([{ path: 'a', data }, { path: 'a', data }])).toThrow('중복된 ZIP 경로')
    expect(() => createZip([])).toThrow('ZIP 엔트리가 비어 있습니다')
    expect(() => createZip([{ path: '/abs', data }])).toThrow('잘못된 ZIP 경로')
  })
})

describe('pptx-builder (PPTX 패키지 조립)', () => {
  it('필수 파트를 모두 포함하고 모든 XML이 well-formed이다', () => {
    const bytes = buildPptx(sampleDeck())
    const entries = parseZip(bytes)
    const paths = entries.map((e) => e.path)
    for (const required of [
      '[Content_Types].xml',
      '_rels/.rels',
      'ppt/presentation.xml',
      'ppt/_rels/presentation.xml.rels',
      'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideLayouts/slideLayout1.xml',
      'ppt/theme/theme1.xml',
      'ppt/slides/slide1.xml',
      'ppt/slides/slide2.xml',
      'ppt/slides/slide3.xml',
      'ppt/slides/_rels/slide1.xml.rels',
      'ppt/charts/chart1.xml',
    ]) {
      expect(paths).toContain(required)
    }
    // Content-Type은 OOXML 규격 값이어야 한다 (presentation은 .main, 차트는 drawingml).
    // 잘못된 값(presentation+xml)은 LibreOffice/PowerPoint가 패키지를 열지 못한다.
    const ct = new TextDecoder().decode(entries.find((e) => e.path === '[Content_Types].xml')!.data)
    expect(ct).toContain('presentationml.presentation.main+xml')
    expect(ct).toContain('drawingml.chart+xml')
    expect(ct).not.toContain('presentationml.presentation+xml"')
    expect(ct).not.toContain('presentationml.chart+xml')
    for (const e of entries) {
      expect(testCrc32(e.data)).toBe(e.crc)
      if (e.path.endsWith('.xml') || e.path.endsWith('.rels')) {
        assertWellFormedXml(new TextDecoder().decode(e.data), e.path)
      }
    }
  })

  it('한글 텍스트가 슬라이드 XML에 그대로 들어간다', () => {
    const bytes = buildPptx(sampleDeck())
    const entries = parseZip(bytes)
    const slide2 = new TextDecoder().decode(entries.find((e) => e.path === 'ppt/slides/slide2.xml')!.data)
    expect(slide2).toContain('오늘 일정')
    expect(slide2).toContain('팀 회의')
    expect(slide2).toContain('Malgun Gothic')
  })

  it('차트 슬라이드는 네이티브 barChart + 값 캐시를 포함한다', () => {
    const bytes = buildPptx(sampleDeck())
    const entries = parseZip(bytes)
    const chart = new TextDecoder().decode(entries.find((e) => e.path === 'ppt/charts/chart1.xml')!.data)
    expect(chart).toContain('<c:barChart>')
    expect(chart).toContain('<c:barDir val="col"/>')
    expect(chart).toContain('<c:v>1</c:v>')
    expect(chart).toContain('<c:v>2</c:v>')
    // 슬라이드 rels가 차트 파트를 가리킨다
    const rels = new TextDecoder().decode(entries.find((e) => e.path === 'ppt/slides/_rels/slide3.xml.rels')!.data)
    expect(rels).toContain('Target="../charts/chart1.xml"')
    expect(rels).toContain('/chart"')
  })

  it('차트 슬라이드가 2개면 chart1/chart2 파트와 rels가 각각 맞는다', () => {
    const deck: PptxDeck = {
      title: '두 차트',
      slides: [
        { kind: 'chart', title: '차트 A', categories: ['a'], series: [{ name: 'S1', values: [1] }] },
        { kind: 'chart', title: '차트 B', categories: ['a'], series: [{ name: 'S2', values: [2] }] },
      ],
    }
    const entries = parseZip(buildPptx(deck))
    const paths = entries.map((e) => e.path)
    expect(paths).toContain('ppt/charts/chart1.xml')
    expect(paths).toContain('ppt/charts/chart2.xml')
    const rels2 = new TextDecoder().decode(entries.find((e) => e.path === 'ppt/slides/_rels/slide2.xml.rels')!.data)
    expect(rels2).toContain('Target="../charts/chart2.xml"')
    const chart2 = new TextDecoder().decode(entries.find((e) => e.path === 'ppt/charts/chart2.xml')!.data)
    expect(chart2).toContain('<c:v>2</c:v>')
  })

  it('빈 덱·차트 값 개수 불일치를 거부한다', () => {
    expect(() => buildPptx({ title: 'x', slides: [] })).toThrow('슬라이드가 비어 있습니다')
    expect(() =>
      buildPptx({
        title: 'x',
        slides: [{ kind: 'chart', title: 'c', categories: ['a', 'b'], series: [{ name: 's', values: [1] }] }],
      }),
    ).toThrow('값 개수')
  })

  it('빈 목록 슬라이드는 emptyText를 표시하고 차트를 생략한다', () => {
    const deck = morningBriefingDeck({ date: '2026-10-25', schedules: [], todos: [], memos: [] })
    expect(deck.slides.length).toBe(4) // 표지 + 일정 + 할 일 + 메모 (차트 없음)
    const entries = parseZip(buildPptx(deck))
    const slide2 = new TextDecoder().decode(entries.find((e) => e.path === 'ppt/slides/slide2.xml')!.data)
    expect(slide2).toContain('오늘 일정이 없습니다')
    expect(entries.map((e) => e.path).some((p) => p.startsWith('ppt/charts/'))).toBe(false)
  })
})

describe('briefing-export (덱 조립, 순수 함수)', () => {
  it('아침 브리핑 덱: 표지·일정·할 일·메모·차트 슬라이드', () => {
    const deck = morningBriefingDeck({
      date: '2026-10-25',
      schedules: [{ id: 1, title: '팀 회의', start_at: '2026-10-25T09:00:00', end_at: null, location: '회의실' }],
      todos: [
        { id: 1, title: '보고서 작성', due_at: '2026-10-26T18:00', priority: 2, status: 'pending' },
        { id: 2, title: '장보기', due_at: null, priority: 0, status: 'pending' },
      ],
      memos: [{ id: 1, text: '아이디어 메모', created_at: '2026-10-25 08:00:00' }],
    })
    expect(deck.slides.length).toBe(5)
    expect(deck.slides[0]).toMatchObject({ kind: 'title', title: '아침 브리핑' })
    const chart = deck.slides[4] as any
    expect(chart.kind).toBe('chart')
    expect(chart.categories).toEqual(['높음', '보통', '낮음'])
    expect(chart.series[0].values).toEqual([1, 0, 1])
    const bullets = deck.slides[1] as any
    expect(bullets.bullets[0]).toContain('09:00')
    expect(bullets.bullets[0]).toContain('회의실')
  })

  it('주간 보고서 덱: 월~일 범위, 요일별 일정, 완료율', () => {
    // 2026-10-25는 일요일 → 해당 주 월요일은 2026-10-19
    expect(weekMonday('2026-10-25')).toBe('2026-10-19')
    expect(addDays('2026-10-19', 6)).toBe('2026-10-25')
    const deck = weeklyReportDeck({
      weekStart: '2026-10-19',
      weekEnd: '2026-10-25',
      schedules: [
        { id: 1, title: '월요 회의', start_at: '2026-10-19T10:00:00', end_at: null, location: '' },
        { id: 2, title: '금요 리뷰', start_at: '2026-10-23T15:00:00', end_at: null, location: '' },
      ],
      todosDone: 3,
      todosPending: 1,
      memos: [{ id: 1, text: '주간 메모', created_at: '2026-10-20 09:00:00' }],
    })
    expect(deck.slides.length).toBe(5)
    const status = deck.slides[2] as any
    expect(status.bullets).toContain('완료: 3건 (현재 기준)')
    expect(status.bullets).toContain('미완료: 1건 (현재 기준)')
    expect(status.bullets).toContain('완료율: 75%')
    const chart = deck.slides[4] as any
    expect(chart.values ?? chart.series[0].values).toEqual([1, 0, 0, 0, 1, 0, 0])
    const sched = deck.slides[1] as any
    expect(sched.bullets.join('\n')).toContain('월요 회의')
    expect(sched.bullets.join('\n')).toContain('금요 리뷰')
  })
})

describe('pptx routes (실DB + HTTP)', () => {
  let db: any
  let d1: any

  beforeEach(() => {
    db = seedDb()
    d1 = createD1Adapter(db)
    const today = kstDateStr(new Date())
    // 오늘 일정 1건 (어제 일정은 제외되어야 함)
    db.prepare(`INSERT INTO schedules (title, start_at, location, status) VALUES (?, ?, ?, 'active')`).run(
      '오늘 회의',
      `${today}T09:00:00`,
      '회의실',
    )
    db.prepare(`INSERT INTO schedules (title, start_at, location, status) VALUES (?, ?, ?, 'active')`).run(
      '어제 회의',
      `${addDays(today, -1)}T09:00:00`,
      '',
    )
    db.prepare(`INSERT INTO todos (title, due_at, priority, status) VALUES (?, ?, ?, 'pending')`).run(
      '긴급 보고',
      null,
      2,
    )
    // 메모 3종: 공개 / 잠금 / Restricted — 후자 2개는 PPTX에 나와선 안 된다
    db.prepare(`INSERT INTO memos (text, created_at, is_locked, sensitivity) VALUES (?, ?, 0, 0)`).run(
      '공개메모-아침-테스트',
      `${today} 08:00:00`,
    )
    db.prepare(`INSERT INTO memos (text, created_at, is_locked, sensitivity) VALUES (?, ?, 1, 0)`).run(
      '잠금메모-절대노출금지',
      `${today} 08:00:00`,
    )
    db.prepare(`INSERT INTO memos (text, created_at, is_locked, sensitivity) VALUES (?, ?, 0, 2)`).run(
      '제한메모-노출금지',
      `${today} 08:00:00`,
    )
  })

  afterEach(() => {
    db.close()
  })

  it('GET /briefing → PPTX 다운로드, 잠긴/제한 메모 제외', async () => {
    const res = await pptxApp.request('/briefing', {}, { DB: d1 } as any)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    )
    expect(res.headers.get('Content-Disposition')).toContain('morning-briefing-')
    expect(res.headers.get('Content-Disposition')).toContain('.pptx')

    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(bytes[0]).toBe(0x50) // 'P'
    expect(bytes[1]).toBe(0x4b) // 'K'
    const entries = parseZip(bytes)
    const allText = entries
      .filter((e) => e.path.endsWith('.xml'))
      .map((e) => new TextDecoder().decode(e.data))
      .join('\n')
    for (const e of entries) {
      if (e.path.endsWith('.xml') || e.path.endsWith('.rels')) {
        assertWellFormedXml(new TextDecoder().decode(e.data), e.path)
      }
    }
    expect(allText).toContain('오늘 회의')
    expect(allText).toContain('긴급 보고')
    expect(allText).toContain('공개메모-아침-테스트')
    expect(allText).not.toContain('어제 회의')
    expect(allText).not.toContain('잠금메모-절대노출금지')
    expect(allText).not.toContain('제한메모-노출금지')
    expect(allText).toContain('<c:barChart>') // 할 일 차트 슬라이드 포함
  })

  it('GET /weekly → 주간 보고서 PPTX, 이번 주 밖 메모·잠금 메모 제외', async () => {
    const today = kstDateStr(new Date())
    const monday = weekMonday(today)
    // 이번 주 메모 1건 + 지난주 메모 1건 + 이번 주 잠금 메모 1건
    db.prepare(`INSERT INTO memos (text, created_at, is_locked, sensitivity) VALUES (?, ?, 0, 0)`).run(
      '주간공개메모-테스트',
      `${addDays(monday, 1)} 10:00:00`,
    )
    db.prepare(`INSERT INTO memos (text, created_at, is_locked, sensitivity) VALUES (?, ?, 0, 0)`).run(
      '지난주메모-제외대상',
      `${addDays(monday, -1)} 10:00:00`,
    )
    db.prepare(`INSERT INTO memos (text, created_at, is_locked, sensitivity) VALUES (?, ?, 1, 0)`).run(
      '주간잠금메모-노출금지',
      `${addDays(monday, 1)} 11:00:00`,
    )

    const res = await pptxApp.request('/weekly', {}, { DB: d1 } as any)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Disposition')).toContain('weekly-report-')
    const bytes = new Uint8Array(await res.arrayBuffer())
    const entries = parseZip(bytes)
    const allText = entries
      .filter((e) => e.path.endsWith('.xml'))
      .map((e) => new TextDecoder().decode(e.data))
      .join('\n')
    expect(allText).toContain('주간 보고서')
    expect(allText).toContain('주간공개메모-테스트')
    expect(allText).not.toContain('지난주메모-제외대상')
    expect(allText).not.toContain('주간잠금메모-노출금지')
    expect(allText).not.toContain('잠금메모-절대노출금지')
  })
})

describe('pptx 인증 (전역 미들웨어)', () => {
  it('쿠키 없이 /api/pptx/briefing, /api/pptx/weekly → 401', async () => {
    // 전체 앱의 default export는 { fetch, scheduled, queue }이므로 fetch로 호출한다
    const { default: app } = await import('../src/index')
    const env = { SESSION_SECRET: 'test-secret', APP_NAME: 'MyHub' } as any
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as any
    const res = await app.fetch(new Request('http://localhost/api/pptx/briefing'), env, ctx)
    expect(res.status).toBe(401)
    const res2 = await app.fetch(new Request('http://localhost/api/pptx/weekly'), env, ctx)
    expect(res2.status).toBe(401)
  })
})
