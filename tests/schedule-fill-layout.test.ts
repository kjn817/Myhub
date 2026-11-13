/**
 * 일정 앱 높이 채움 레이아웃 계약 (2026-11-13 사용자 지시).
 *
 * 최대화한 창에서 달력이 위쪽에만 붙고 아래가 텅 비는 문제를 고친다:
 * 넓은 화면(≥900px)에서 달력이 창 높이에 딱 맞게 늘어나고, 창이 줄면
 * 함께 줄어야 한다. flex 체인(.g-main → .wrap → .cal-layout → .cal-left →
 * .cal-grid)이 끊기면 달력이 다시 내용 높이로 쪼그라드니, 각 고리를
 * CSS에서 직접 확인한다. jsdom은 레이아웃을 안 하므로 실제 높이는
 * 실브라우저 프로브(.scratch/perf4/probe-schedule-fill.cjs)가 잰다.
 *
 * @jest-environment jsdom
 */
import * as fs from 'fs'
import * as path from 'path'

const CSS = fs.readFileSync(path.join(__dirname, '../public/css/schedule.css'), 'utf8')
const HTML = fs.readFileSync(path.join(__dirname, '../public/schedule.html'), 'utf8')
const doc = (): any => (globalThis as any).document

/** `@media (min-width: 900px) { ... }` 블록들을 전부 모아 반환한다 (중괄호 짝 맞추기). */
function wideBlocks(css: string): string[] {
  const blocks: string[] = []
  const re = /@media\s*\(min-width:\s*900px\)\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) {
    let depth = 1
    let i = m.index + m[0].length
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') depth--
      i++
    }
    blocks.push(css.slice(m.index + m[0].length, i - 1))
  }
  return blocks
}

/**
 * 블록들 안에서 `선택자 { ... }` 규칙 본문을 전부 모아 합친다.
 * 같은 선택자가 여러 ≥900px 블록에 나뉘어 있을 수 있다(.wrap·.cal-grid) —
 * 첫 번째만 보면 채움 규칙을 놓친다.
 */
function ruleBody(blocks: string[], selector: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts: string[] = []
  for (const b of blocks) {
    const re = new RegExp(`${esc}\\s*\\{([^}]*)\\}`, 'gs')
    let m: RegExpExecArray | null
    while ((m = re.exec(b)) !== null) parts.push(m[1])
  }
  return parts.length > 0 ? parts.join('\n') : null
}

const WIDE = wideBlocks(CSS)

describe('일정 높이 채움 레이아웃 (≥900px)', () => {
  it('flex 체인이 끊기지 않는다 — .g-main부터 .cal-grid까지', () => {
    // .g-main이 flex column이어야 .wrap이 min-height: 100vh 높이를 물려받는다.
    expect(ruleBody(WIDE, '.g-main')).toMatch(/display:\s*flex/)
    expect(ruleBody(WIDE, '.g-main')).toMatch(/flex-direction:\s*column/)
    expect(ruleBody(WIDE, '.wrap')).toMatch(/flex:\s*1/)
    expect(ruleBody(WIDE, '.wrap')).toMatch(/display:\s*flex/)
    // auto 마진이 있으면 flex stretch가 안 먹혀 .wrap이 내용 너비로
    // 쪼그라든다 — 좌우 마진을 0으로 지워야 달력이 창 너비를 쓴다.
    expect(ruleBody(WIDE, '.wrap')).toMatch(/margin-left:\s*0/)
    expect(ruleBody(WIDE, '.wrap')).toMatch(/margin-right:\s*0/)
    expect(ruleBody(WIDE, '.cal-layout')).toMatch(/flex:\s*1/)
    expect(ruleBody(WIDE, '.cal-left')).toMatch(/display:\s*flex/)
    expect(ruleBody(WIDE, '.cal-left')).toMatch(/flex-direction:\s*column/)
    expect(ruleBody(WIDE, '.cal-grid')).toMatch(/flex:\s*1/)
  })

  it('요일 행은 auto, 주 행은 1fr로 균등 분배한다 (5주/6주 모두)', () => {
    // grid-template-rows: auto가 첫 행(요일)만 고정하고, 나머지 주 행은
    // grid-auto-rows: 1fr로 남은 높이를 나눈다 — 주 행 개수와 무관하다.
    const grid = ruleBody(WIDE, '.cal-grid')
    expect(grid).toMatch(/grid-template-rows:\s*auto/)
    expect(grid).toMatch(/grid-auto-rows:\s*1fr/)
  })

  it('주 뷰·일 뷰도 같은 높이 채움을 받는다', () => {
    expect(ruleBody(WIDE, '.week-grid')).toMatch(/flex:\s*1/)
    expect(ruleBody(WIDE, '.day-view')).toMatch(/flex:\s*1/)
    // 일 뷰는 목록이라 내용이 넘치면 안에서 스크롤한다.
    expect(ruleBody(WIDE, '.day-view')).toMatch(/overflow-y:\s*auto/)
  })

  it('.cal-layout이 align-items: start로 칼럼 늘이기를 막지 않는다', () => {
    // start면 .cal-left가 내용 높이로 쪼그라들어 flex 체인이 소용없어진다.
    for (const b of WIDE) {
      expect(b).not.toMatch(/\.cal-layout\s*\{[^}]*align-items:\s*start/)
    }
    expect(ruleBody(WIDE, '.cal-layout')).toMatch(/align-items:\s*stretch/)
  })

  it('채움 체인의 선택자가 실제 schedule.html 구조에 매칭된다', () => {
    doc().body.innerHTML = HTML
    // .g-main > .wrap > .cal-layout > .cal-left > .cal-grid/.week-grid/.day-view
    expect(doc().querySelector('.g-main > .wrap > .cal-layout > .cal-left')).not.toBeNull()
    expect(doc().querySelector('.cal-left > .cal-grid#calGrid')).not.toBeNull()
    expect(doc().querySelector('.cal-left > .week-grid#weekGrid')).not.toBeNull()
    expect(doc().querySelector('.cal-left > .day-view#dayView')).not.toBeNull()
    doc().body.innerHTML = ''
  })

  it('죽은 .cal-grid .cell 규칙이 되살아나지 않는다', () => {
    // .cell 클래스는 schedule.html에 없다 — 2026-11-13에 제거한 잔재다.
    expect(CSS).not.toMatch(/\.cal-grid\s+\.cell\s*\{/)
  })
})
