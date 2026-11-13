/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 2단계 저위험 정리 회귀 (2026-11-13 전수 감사 S4·S5).
 *
 * 검증하는 성질 (깨지면 실패해야 한다):
 * - push 라우트는 modules 루프를 통해 한 번만 장착된다 (B-L1).
 *   index.ts의 별도 장착을 지웠으니, modules.ts의 push 항목이
 *   사라지면 /api/push가 통째로 없어진다 — 양쪽을 함께 단언한다.
 * - 죽은 파일이 다시 생기지 않는다: public/js/nav.js(루트 /nav.js와
 *   주석 1줄만 다른 사본), memo/inedit.js(호출자 없는 startEdit).
 *   단, 살아있는 쌍은 유지된다: public/nav.js, pane.js의
 *   cleanupOrphanFiles 호출 (F-D1·F-D2).
 * - 죽은 함수가 다시 생기지 않는다: finder.js의 trashFolder/trashFile
 *   (trashRows로 대체됨), memo/utils.js의 extractTags(서버 동명
 *   함수는 살아 있다), pane.js의 window.openPaneForEdit
 *   (window.openPane은 살아 있다) (F-D3~D5).
 * - 죽은 재익스포트가 다시 생기지 않는다: 배럴의 재노출 줄만
 *   없어지고 원본 정의는 살아 있다 (9개 파일).
 * - findSuccessClaims가 다시 생기지 않는다 — 공유 정규식은
 *   guardUnverifiedSuccessClaims가 계속 쓴다.
 * - selectModel의 error 레벨 진단 로그가 다시 생기지 않는다 —
 *   정상 경로에서 매 턴 error가 쌓이면 진짜 오류가 묻힌다.
 *   실제 장애 신호(no_candidates)와 오버라이드 미적용 경고는 유지.
 * - 죽은 CSS가 다시 생기지 않는다: Finder AI 정리 패널(.fo-*),
 *   구 오피스 탭 접미사, 유령 .fv-window, 빈 독 peek 규칙.
 *   살아있는 대응 규칙(탭 본체·hover·is-active, 독 peek 실효
 *   규칙)은 유지된다.
 * - 시트 메뉴줄 CSS는 살아 있다 (C-D1 오판 정정): fortune.js
 *   벤더 번들이 .sheet-menurow 등을 렌더하므로 sheet.css 규칙을
 *   지우면 [파일] 메뉴줄이 무스타일이 된다. 감사 때 벤더를
 *   빼먹고 죽었다고 한 것을 이 테스트가 고정한다.
 * - finder-format-hwp.js에 리터럴 NUL 바이트가 없다 — NUL이
 *   있으면 grep이 파일을 binary로 취급해 검색에서 빠진다.
 *   정규식은 \x00 이스케이프 텍스트로 같은 동작을 한다.
 * - 메모 번들은 ORDER에 적힌 소스들의 연결 그 자체다 (소스-번들
 *   동기). 섹션 번호 "11."은 라이트박스 1개만, init.js는 12다.
 *
 * 카나리아: 삭제한 코드를 되돌리면 해당 단언이 실패한다 (수동 실증).
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
const readBuf = (rel: string) => fs.readFileSync(path.join(ROOT, rel))
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel))

const INDEX_TS = read('src/index.ts')
const MODULES_TS = read('src/modules.ts')
const NEWS_SUMMARY = read('src/lib/news-summary.ts')
const NEWS_CORE = read('src/lib/news-core.ts')
const NEWS_SOURCE_LINKS = read('src/lib/news-source-links.ts')
const AUTH_ROUTES = read('src/modules/auth/routes.ts')
const AUTH_ROUTES_OTP = read('src/modules/auth/routes-otp.ts')
const FACT_GRAPH = read('src/services/fact-graph.ts')
const FACT_GRAPH_EXPAND = read('src/services/fact-graph-expand.ts')
const MEMORY_CONSOLIDATION = read('src/services/memory-consolidation.ts')
const MEMORY_SCAN = read('src/services/memory-scan.ts')
const NEWS_SOURCES = read('src/services/news-sources.ts')
const NEWS_SOURCE_LEGS = read('src/services/news-source-legs.ts')
const OFFICE_OPS = read('src/services/office-ops.ts')
const OFFICE_OPS_SLIDE = read('src/services/office-ops-slide.ts')
const AI_ROUTES = read('src/modules/ai/routes.ts')
const ASSISTANT_TYPES = read('src/modules/ai/assistant-types.ts')
const APPROVAL_FLOW = read('src/services/approval-flow.ts')
const APPROVAL_TEXT = read('src/services/approval-text.ts')
const KEY_ROTATION_ROUTES = read('src/modules/key-rotation/routes.ts')
const RESPONSE_POSTPROCESS = read('src/modules/ai/response-postprocess.ts')
const AI_MODEL_SELECTION = read('src/services/ai-model-selection.ts')
const FINDER_JS = read('public/js/finder.js')
const MEMO_UTILS = read('public/js/memo/utils.js')
const MEMO_PANE = read('public/js/memo/pane.js')
const MEMO_BUNDLE = read('public/js/memo-bundle.js')
const BUILD_SCRIPT = read('scripts/build-memo-bundle.sh')
const MEMO_HELPERS = read('src/modules/memo/helpers.ts')
const FINDER_CSS = read('public/css/finder.css')
const DESKTOP_CSS = read('public/css/desktop.css')
const SHEET_CSS = read('public/css/sheet.css')
const FORTUNE_JS = read('public/vendor/fortune/fortune.js')
const DROP_UPLOAD_JS = read('public/js/desktop/drop-upload.js')

/** `export { ... } from '<mod>'` 블록 본문만 뽑는다 (재노출 여부 판정용). */
function exportBlock(src: string, mod: string): string {
  const re = new RegExp(`export\\s*\\{([\\s\\S]*?)\\}\\s*from\\s*'${mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`)
  const m = src.match(re)
  return m ? m[1] : ''
}

describe('B-L1 — push 라우트 단일 장착', () => {
  test('modules 루프가 push를 장착하고 index.ts에 별도 장착이 없다', () => {
    expect(MODULES_TS).toMatch(/id:\s*'push'[^}]*app:\s*pushApp/)
    expect(INDEX_TS).toMatch(/for\s*\(const m of modules\)\s*\{[^}]*app\.route\(`\/api\/\$\{m\.id\}`/)
    expect(INDEX_TS).not.toContain("app.route('/api/push'")
    expect(INDEX_TS).not.toContain("from './modules/push/routes'")
  })
})

describe('F-D1·F-D2 — 죽은 파일 제거', () => {
  test('public/js/nav.js가 없고 루트 public/nav.js는 살아 있다', () => {
    expect(exists('public/js/nav.js')).toBe(false)
    expect(exists('public/nav.js')).toBe(true)
  })

  test('memo/inedit.js가 없고 ORDER·번들에서 사라졌다', () => {
    expect(exists('public/js/memo/inedit.js')).toBe(false)
    expect(BUILD_SCRIPT).not.toContain('inedit.js')
    expect(MEMO_BUNDLE).not.toContain('startEdit')
    expect(MEMO_BUNDLE).not.toContain('9. 인라인 수정')
  })

  test('번들은 ORDER 소스들의 연결 그 자체다 (소스-번들 동기)', () => {
    const order = [...BUILD_SCRIPT.matchAll(/"(public\/js\/memo\/[^"]+)"/g)].map((m) => m[1])
    expect(order.length).toBeGreaterThan(0)
    const memoFiles = fs
      .readdirSync(path.join(ROOT, 'public/js/memo'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => `public/js/memo/${f}`)
    // ORDER 밖의 소스가 있으면 번들에 안 실리는 고아가 된다.
    expect([...order].sort()).toEqual([...memoFiles].sort())
    const expected = order.map((f) => read(f) + '\n').join('')
    expect(MEMO_BUNDLE).toBe(expected)
  })

  test('섹션 번호 11은 라이트박스 1개만, init.js는 12다', () => {
    expect(MEMO_BUNDLE.match(/11\. /g)?.length ?? 0).toBe(1)
    expect(MEMO_BUNDLE).toContain('11. 라이트박스')
    expect(MEMO_BUNDLE).toContain('12. 시작')
  })

  test('살아있는 메모 코드는 번들에 남아 있다', () => {
    // 부분 문자열이 아니라 실제 연결을 단언한다 — 'window.openPane'만
    // 보면 undefined 대입 같은 파괴가 안 잡힌다 (카나리아로 확인).
    expect(MEMO_BUNDLE).toContain('window.openPane = openPane')
    expect(MEMO_BUNDLE).toContain('async function cleanupOrphanFiles')
  })
})

describe('F-D3~D5 — 죽은 함수 제거', () => {
  test('finder.js에 trashFolder/trashFile이 없고 trashRows는 살아 있다', () => {
    expect(FINDER_JS).not.toContain('trashFolder')
    expect(FINDER_JS).not.toContain('trashFile')
    expect(FINDER_JS).toContain('trashRows')
    // 다른 객체의 메서드(drop-upload 매니저)는 건드리지 않는다.
    expect(DROP_UPLOAD_JS).toContain('trashFile')
  })

  test('프론트 extractTags가 없고 서버 동명 함수는 살아 있다', () => {
    expect(MEMO_UTILS).not.toContain('extractTags')
    expect(MEMO_BUNDLE).not.toContain('extractTags')
    expect(MEMO_HELPERS).toContain('extractTags')
  })

  test('window.openPaneForEdit이 없고 window.openPane은 살아 있다', () => {
    expect(MEMO_PANE).not.toContain('openPaneForEdit')
    expect(MEMO_BUNDLE).not.toContain('openPaneForEdit')
    expect(MEMO_PANE).toContain('window.openPane = openPane')
  })
})

describe('죽은 재익스포트 제거 — 배럴만 정리, 원본 유지', () => {
  test('news-summary: SOURCE_MAX_AGE_DAYS·SourceLink 재노출 없음', () => {
    expect(exportBlock(NEWS_SUMMARY, './news-core')).not.toContain('SOURCE_MAX_AGE_DAYS')
    expect(exportBlock(NEWS_SUMMARY, './news-source-links')).not.toContain('SourceLink')
    expect(NEWS_CORE).toContain('export const SOURCE_MAX_AGE_DAYS')
    expect(NEWS_SOURCE_LINKS).toContain('export interface SourceLink')
  })

  test('auth/routes: maskAuthEmail 재노출 없음, 원본 유지', () => {
    expect(AUTH_ROUTES).not.toContain('export { maskAuthEmail }')
    expect(AUTH_ROUTES_OTP).toContain('export function maskAuthEmail')
  })

  test('fact-graph: MAX_GRAPH_RESULTS 재노출 없음, 원본 유지', () => {
    expect(exportBlock(FACT_GRAPH, './fact-graph-expand')).not.toContain('MAX_GRAPH_RESULTS')
    expect(exportBlock(FACT_GRAPH, './fact-graph-expand')).toContain('expandGraphFacts')
    expect(FACT_GRAPH_EXPAND).toContain('export const MAX_GRAPH_RESULTS')
  })

  test('memory-consolidation: NEGATION_MARKERS 재노출 없음, 원본 유지', () => {
    expect(exportBlock(MEMORY_CONSOLIDATION, './memory-scan')).not.toContain('NEGATION_MARKERS')
    expect(exportBlock(MEMORY_CONSOLIDATION, './memory-scan')).toContain('hasNegationMarker')
    expect(MEMORY_SCAN).toContain('export const NEGATION_MARKERS')
  })

  test('news-sources: 죽은 4종 재노출 없음, 내부 사용·원본 유지', () => {
    const block = exportBlock(NEWS_SOURCES, './news-source-legs')
    expect(block).not.toContain('LEG_FETCH_TIMEOUT_MS')
    expect(block).not.toContain('parseNaverNewsResponse')
    expect(block).not.toContain('FetchFn')
    expect(block).not.toContain('PressRssFeed')
    // 살아있는 재노출과 내부 사용은 그대로다.
    expect(block).toContain('PRESS_RSS_FEEDS')
    expect(NEWS_SOURCES).toContain('LEG_FETCH_TIMEOUT_MS')
    expect(NEWS_SOURCES).toContain('as FetchFn')
    expect(NEWS_SOURCE_LEGS).toContain('export const LEG_FETCH_TIMEOUT_MS')
    expect(NEWS_SOURCE_LEGS).toContain('export function parseNaverNewsResponse')
    expect(NEWS_SOURCE_LEGS).toContain('export type FetchFn')
    expect(NEWS_SOURCE_LEGS).toContain('export interface PressRssFeed')
  })

  test('office-ops: slide 재노출 없음, 원본 유지', () => {
    expect(OFFICE_OPS).not.toContain('validateSlideOps')
    expect(OFFICE_OPS).not.toContain('SLIDE_OPS_GUIDE')
    expect(OFFICE_OPS_SLIDE).toContain('export function validateSlideOps')
    expect(OFFICE_OPS_SLIDE).toContain('export const SLIDE_OPS_GUIDE')
  })

  test('ai/routes: 타입 재노출 없음, 내부 사용·원본 유지', () => {
    expect(AI_ROUTES).not.toContain("export type { RawChatMessage, AssistantCallResult }")
    expect(AI_ROUTES).toContain('RawChatMessage[]')
    expect(ASSISTANT_TYPES).toContain('export interface RawChatMessage')
    expect(ASSISTANT_TYPES).toContain('export interface AssistantCallResult')
  })

  test('approval-flow: 승인 타입 재노출 없음, 원본 유지', () => {
    const block = exportBlock(APPROVAL_FLOW, './approval-text')
    expect(block).not.toContain('ApprovalReplyKind')
    expect(block).not.toContain('ToolActionDescription')
    expect(block).toContain('parseApprovalReply')
    expect(APPROVAL_TEXT).toContain('export type ApprovalReplyKind')
    expect(APPROVAL_TEXT).toContain('export interface ToolActionDescription')
  })

  test('key-rotation/routes: default export 없음, named export 유지', () => {
    expect(KEY_ROTATION_ROUTES).not.toContain('export default')
    expect(KEY_ROTATION_ROUTES).toContain('export const keyRotationApp')
  })
})

describe('findSuccessClaims·selectModel 진단 로그 제거', () => {
  test('findSuccessClaims가 없고 공유 정규식의 살아있는 사용자 유지', () => {
    expect(RESPONSE_POSTPROCESS).not.toContain('findSuccessClaims')
    expect(RESPONSE_POSTPROCESS).toContain('guardUnverifiedSuccessClaims')
    expect(RESPONSE_POSTPROCESS).toContain('successDomainForTool')
  })

  test('selectModel의 error 진단 로그가 없고 실제 장애 신호는 유지', () => {
    expect(AI_MODEL_SELECTION).not.toContain('selectModel_enter')
    expect(AI_MODEL_SELECTION).not.toContain('selectModel_builder_direct')
    expect(AI_MODEL_SELECTION).not.toContain('selectModel_builder_fallthrough')
    expect(AI_MODEL_SELECTION).toContain('selectModel_no_candidates')
    expect(AI_MODEL_SELECTION).toContain('selectModel_override_not_applied')
  })
})

describe('죽은 CSS 제거 — 살아있는 대응 규칙 유지', () => {
  test('Finder AI 정리 패널(.fo-*) 규칙이 없다', () => {
    for (const cls of ['.fo-panel', '.fo-head', '.fo-close', '.fo-body', '.fo-item', '.fo-apply', '.fo-result']) {
      expect(FINDER_CSS).not.toContain(cls)
    }
  })

  test('구 오피스 탭 접미사 규칙이 없고 본체·hover·is-active는 살아 있다', () => {
    for (const cls of ['.dt-office-tab-file', '.dt-office-tab-sep', '.dt-office-tab-fold', '.dt-office-tab-chevron']) {
      expect(DESKTOP_CSS).not.toContain(cls)
    }
    expect(DESKTOP_CSS).toContain('.dt-office-tab {')
    expect(DESKTOP_CSS).toContain('.dt-office-tab:hover')
    expect(DESKTOP_CSS).toContain('.dt-office-tab.is-active')
    expect(DESKTOP_CSS).toContain('body.dt-fullscreen .dt-office-tab {')
  })

  test('빈 독 peek 규칙이 없고 실효 peek 규칙은 살아 있다', () => {
    expect(DESKTOP_CSS).not.toContain('#dt-dock.dt-dock-peek { }')
    expect(DESKTOP_CSS).toContain('#dt-dock.dt-autohide.dt-dock-peek')
  })

  test('시트 메뉴줄 CSS는 살아 있다 — fortune.js가 렌더한다 (C-D1 오판 고정)', () => {
    // fortune.js(벤더)가 이 클래스들을 렌더하므로 sheet.css 규칙은 live다.
    // 부분 문자열이 아니라 렌더 호출·규칙 선택자 자체를 단언한다 —
    // '.sheet-menurow'만 보면 -spacer·[hidden] 파생 규칙에 가려져
    // 본체 규칙 삭제가 안 잡힌다 (카나리아로 확인).
    // [렌더 증거(벤더), CSS 규칙 선택자] — 셰브론은 up/down 결합
    // 클래스명으로만 렌더되므로 결합 문자열로 단언한다.
    const rendered: Array<[string, string]> = [
      ['className:"sheet-menurow"', '.sheet-menurow {'],
      ['className:"sheet-filemenu"', '.sheet-filemenu {'],
      ['className:"sheet-fold-btn"', '.sheet-fold-btn, .sheet-close-btn {'],
      ['className:"sheet-close-btn"', '.sheet-fold-btn, .sheet-close-btn {'],
      ['"sheet-chevron sheet-chevron-down"', '.sheet-chevron {'],
    ]
    for (const [needle, rule] of rendered) {
      expect(FORTUNE_JS).toContain(needle)
      expect(SHEET_CSS).toContain(rule)
    }
    expect(SHEET_CSS).toContain('.sheet-menurow-spacer {')
  })
})

describe('NUL 바이트 교체', () => {
  test('finder-format-hwp.js에 리터럴 제어 바이트가 없고 \\x00·\\x7f 이스케이프가 있다', () => {
    const buf = readBuf('public/js/finder-format-hwp.js')
    expect(buf.indexOf(0)).toBe(-1)
    // NUL과 같은 정규식 안에 있던 리터럴 DEL(0x7F)도 이스케이프 텍스트로
    // 바꿨다 — 제어 바이트가 남아 있으면 도구가 파일을 이상하게 다룬다.
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i]
      expect(b === 9 || b === 10 || b === 13 || b >= 0x20).toBe(true)
    }
    const hwp = read('public/js/finder-format-hwp.js')
    expect(hwp).toContain("[\\x00- \\x7f]")
  })

  test('파일 안의 정규식이 NUL·DEL을 걷어낸다', () => {
    // 파일에서 정규식을 직접 뽑아 실행한다 — 이스케이프 텍스트가
    // 바뀌어 NUL을 못 걷어내면 이 테스트가 실패한다.
    const hwp = read('public/js/finder-format-hwp.js')
    const m = hwp.match(/\.replace\(\/\[(.+?)\]\+\/g/)
    expect(m).not.toBeNull()
    const re = new RegExp(`[${m![1]}]+`, 'g')
    const s = 'a' + String.fromCharCode(0) + 'b' + String.fromCharCode(127) + 'c'
    expect(s.replace(re, '')).toBe('abc')
    expect('한글abc'.replace(re, '')).toBe('한글abc')
  })
})
