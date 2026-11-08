/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/// <reference types="node" />
/**
 * F5 프론트 회귀 테스트 (2026-11-07 운영 QA 3차 실패의 카나리아).
 *
 * 검증하는 성질:
 * 1. 사진 오버레이(결함 ①): 셸 windows.js의 일반 액션 프록시는 오피스 전용
 *    비서 버튼(#officeAssistantBtn)을 복사하지 않는다 — 복사하면 내부 아바타
 *    img(1600px 원본)가 크기 제약 없이 상단바에 붙어 화면 전체를 덮는다.
 *    desktop.css도 프록시 img에 크기 상한을 둬 이중으로 막는다.
 * 2. syncChrome(결함 ②b): office.js host는 존재하지 않는 syncChrome()을
 *    부르지 않고 실제 크롬 갱신 함수 publishTitle()을 쓴다 — 한글 세션이
 *    host.markDirty()를 부르면 ReferenceError로 연산이 실패하던 결함.
 * 3. PDF 스냅샷(결함 ③): 페이지 수만이 아니라 페이지별 크기·회전 메타를
 *    싣고, 미저장 새 문서에서도 엔진 기본 문서(blank.pdf)의 메타가 실려
 *    모델이 연산을 만들 수 있다 (pageCount: null이면 모델이 대화 막다른
 *    길로 빠진다).
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const PUB = path.join(ROOT, 'public')
function readPub(p: string): string {
  return fs.readFileSync(path.join(PUB, p), 'utf-8')
}

describe('F5-1 셸 액션 프록시 — 비서 버튼 제외 + img 크기 상한', () => {
  const win = readPub('/js/desktop/windows.js')
  const css = readPub('/css/desktop.css')

  test('proxyBtn이 #officeAssistantBtn을 innerHTML 복사 전에 제외한다', () => {
    const start = win.indexOf('var proxyBtn')
    const end = win.indexOf("querySelectorAll('button')", start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const region = win.slice(start, end)
    expect(region).toContain("real.id === 'awAvatarBtn'")
    expect(region).toContain("real.id === 'officeAssistantBtn'")
    expect(region.indexOf("real.id === 'officeAssistantBtn'")).toBeLessThan(region.indexOf('proxy.innerHTML'))
  })

  test('desktop.css가 .dt-app-action img에 크기 상한을 둔다', () => {
    const m = css.match(/\.dt-app-action img\s*\{[^}]*\}/)
    expect(m).not.toBeNull()
    expect(m![0]).toMatch(/max-width\s*:/)
    expect(m![0]).toMatch(/max-height\s*:/)
  })
})

describe('F5-2 office.js host — syncChrome 참조 제거', () => {
  const office = readPub('/js/office.js')

  test('office.js 어디에도 syncChrome 식별자가 없다', () => {
    expect(office).not.toContain('syncChrome')
  })

  test('host.markDirty가 publishTitle()로 크롬을 갱신한다', () => {
    const start = office.indexOf('markDirty: function')
    expect(start).toBeGreaterThan(-1)
    expect(office.slice(start, start + 90)).toContain('publishTitle()')
  })
})

describe('F5-3 PDF 세션 스냅샷 — 문서 메타', () => {
  let S: any
  beforeAll(() => {
    ;(globalThis as any).eval(readPub('/vendor/pdf-lib/pdf-lib.min.js'))
    ;(globalThis as any).eval(readPub('/js/office-sessions.js'))
    S = (globalThis as any).MyHubOfficeSessions
  })

  test('pdfSnapshotFromMeta: 페이지별 메타를 싣고 상한에서 pagesCapped를 세운다', () => {
    const one = S.pdfSnapshotFromMeta(3, [{ page: 1, width: 595, height: 842, rotation: 0 }])
    expect(one.pageCount).toBe(3)
    expect(one.pages).toEqual([{ page: 1, width: 595, height: 842, rotation: 0 }])
    expect(one.pagesCapped).toBe(false)

    const many = Array.from({ length: 150 }, (_, i) => ({ page: i + 1, width: 595, height: 842, rotation: 0 }))
    const capped = S.pdfSnapshotFromMeta(150, many)
    expect(capped.pageCount).toBe(150)
    expect(capped.pages).toHaveLength(100)
    expect(capped.pagesCapped).toBe(true)
  })

  test('미저장 새 문서 스냅샷: blank.pdf 실바이트에서 pageCount와 페이지 메타가 나온다', async () => {
    // jsdom 렐름의 Uint8Array로 복사해야 pdf-lib의 타입 검사를 통과한다.
    const ab = new Uint8Array(Array.from(fs.readFileSync(path.join(PUB, 'templates/blank.pdf')))).buffer as ArrayBuffer
    const realFetch = (globalThis as any).fetch
    ;(globalThis as any).fetch = async (url: string) => {
      if (String(url).includes('/templates/blank.pdf')) return { arrayBuffer: async () => ab }
      throw new Error('unexpected fetch ' + url)
    }
    try {
      const session = S.create({
        app: 'pdf',
        officeFetch: () => { throw new Error('미저장 문서에서는 Drive를 읽지 않는다') },
        getFile: () => null,
        isDirty: () => false,
      })
      const snap = await session.snapshot()
      expect(snap.pageCount).toBeGreaterThanOrEqual(1)
      expect(snap.pages[0].page).toBe(1)
      expect(snap.pages[0].width).toBeGreaterThan(0)
      expect(snap.pages[0].height).toBeGreaterThan(0)
      expect(typeof snap.pages[0].rotation).toBe('number')
    } finally {
      ;(globalThis as any).fetch = realFetch
    }
  })

  test('저장된 문서 스냅샷: Drive 바이트에서 페이지 메타를 읽는다', async () => {
    const src = await (globalThis as any).PDFLib.PDFDocument.create()
    src.addPage([595, 842])
    const second = src.addPage([842, 595])
    second.setRotation((globalThis as any).PDFLib.degrees(90))
    const bytes = await src.save()
    // jsdom Blob에는 arrayBuffer()가 없어 표면만 흉내 낸다 (실브라우저는 네이티브).
    const blob = { arrayBuffer: async () => new Uint8Array(Array.from(bytes as Uint8Array)).buffer }
    const session = S.create({
      app: 'pdf',
      // 정본 규약: office.js host의 officeFetch는 함수형 접근자다
      // (office-assistant도 host.officeFetch()로 호출한다).
      officeFetch: () => ({ loadFile: async () => ({ blob }) }),
      getFile: () => ({ id: 42, name: '문서.pdf', version: 'v1' }),
      isDirty: () => false,
    })
    const snap = await session.snapshot()
    expect(snap.pageCount).toBe(2)
    expect(snap.pages[1]).toEqual({ page: 2, width: 842, height: 595, rotation: 90 })
  })

  test('저장된 문서 회전 적용 왕복: loadFile → 회전 → saveFile 바이트에 90도가 남는다', async () => {
    // F6 회귀 고정: PDF 세션이 officeFetch를 객체로 직접 받으면 함수형
    // host에서 F.loadFile이 undefined가 돼 동기 TypeError로 패널이
    // 영원히 멈췄다. 실제 office.js 규약(함수형 접근자)으로 검증한다.
    const PDFLib = (globalThis as any).PDFLib
    const src = await PDFLib.PDFDocument.create()
    src.addPage([595, 842])
    const bytes = await src.save()
    const blob = { arrayBuffer: async () => new Uint8Array(Array.from(bytes as Uint8Array)).buffer }
    let savedBytes: Uint8Array | null = null
    let reloaded = false
    // jsdom Blob에는 arrayBuffer()가 없다 — 세션이 만드는 Blob을 읽어야
    // 하므로 이 테스트 동안만 Node Blob으로 바꾼다 (실브라우저는 네이티브).
    const RealBlob = (globalThis as any).Blob
    ;(globalThis as any).Blob = require('buffer').Blob
    try {
      const session = S.create({
        app: 'pdf',
        officeFetch: () => ({
          loadFile: async () => ({ blob, version: 'v1', name: '문서.pdf' }),
          saveFile: async (_id: number, out: any) => {
            savedBytes = new Uint8Array(await out.arrayBuffer())
            return { ok: true, version: 'v2' }
          },
        }),
        getFile: () => ({ id: 42, name: '문서.pdf', version: 'v1' }),
        isDirty: () => false,
        setFileVersion: () => {},
        reloadFile: () => { reloaded = true },
      })
      const results = await session.applyOps([{ type: 'rotate_page', page: 1 }])
      expect(results).toHaveLength(1)
      expect(results[0].ok).toBe(true)
    } finally {
      ;(globalThis as any).Blob = RealBlob
    }
    expect(savedBytes).not.toBeNull()
    const back = await PDFLib.PDFDocument.load(savedBytes!)
    expect(back.getPage(0).getRotation().angle).toBe(90)
    expect(reloaded).toBe(true)
  })
})
