/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 일정·할일 페이지 비서 브리지 계약 (2026-11-10, ③ 발산 13건 트랙에서 복원)
 *
 * 검증하는 성질: schedule.html·todo.html은 CSP가 script-src 'self'를
 * enforce하므로(canonical 11-01의 인라인 AssistantWidget.init은 차단됨),
 * 캘리 위젯의 유일한 init/declare 경로는 assistant-bridge.js 태그의
 * data-persona-* 뿐이다. 이 태그가 없으면 두 페이지에서 비서 아바타가
 * 뜨지 않고(단독 실행), 셸 창 모드에서는 assistant-declare가 나가지
 * 않는다 — 재건 때 태그째 누락됐던 발산이 정확히 이것이다.
 *
 * - 계약: 두 페이지가 위젯 스크립트 뒤에 정확한 persona 값으로 브리지를
 *   로드한다 (태그를 지우거나 값을 바꾸면 실패).
 * - 동작: 실제 HTML에서 뽑은 data-*를 단 실제 브리지 코드를 실행하면
 *   단독 실행 조건에서 AssistantWidget.init이 그 값으로 1회 불린다.
 *   data-*가 없는 태그로는 init이 불리지 않는다 (카나리아 대조군).
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const PUB = path.join(ROOT, 'public')
const BRIDGE_SRC = fs.readFileSync(path.join(PUB, 'js/assistant-bridge.js'), 'utf-8')

const PAGES = ['schedule.html', 'todo.html']
const EXPECTED = { personaId: 'scheduler', personaName: '캘리', avatar: '/avatars/cali.webp' }

function bridgeTag(html: string): { attrs: string; index: number } | null {
  const m = html.match(/<script[^>]*src="\/js\/assistant-bridge\.js"[^>]*>/)
  if (!m) return null
  return { attrs: m[0], index: m.index ?? -1 }
}

function dataAttrs(tagAttrs: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tagAttrs.matchAll(/(data-[\w-]+)="([^"]*)"/g)) out[m[1]] = m[2]
  return out
}

describe('일정·할일 페이지 — 비서 브리지 계약', () => {
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(PUB, page), 'utf-8')

    test(`${page}: assistant-widget.js 뒤에 scheduler persona로 브리지를 로드한다`, () => {
      const tag = bridgeTag(html)
      expect(tag).not.toBeNull()
      const attrs = dataAttrs((tag as { attrs: string }).attrs)
      expect(attrs['data-persona-id']).toBe(EXPECTED.personaId)
      expect(attrs['data-persona-name']).toBe(EXPECTED.personaName)
      expect(attrs['data-avatar']).toBe(EXPECTED.avatar)
      const widgetIdx = html.indexOf('src="/assistant-widget.js"')
      expect(widgetIdx).toBeGreaterThanOrEqual(0)
      // 브리지는 실행 시점에 window.AssistantWidget를 확인하므로 위젯 뒤여야 한다
      expect((tag as { index: number }).index).toBeGreaterThan(widgetIdx)
      // CSP enforce 페이지이므로 인라인 init이 되돌아와도 안 된다 (차단돼 죽은 코드가 된다)
      expect(html).not.toMatch(/<script>[\s\S]*?AssistantWidget\.init/)
    })
  }
})

describe('브리지 동작 — 실제 HTML의 data-*로 init이 불린다', () => {
  const W: any = (globalThis as any).window
  const DOC: any = (globalThis as any).document

  function runBridge(attrs: Record<string, string>): { calls: any[] } {
    const calls: any[] = []
    W.AssistantWidget = { init: (cfg: any) => calls.push(cfg) }
    const el = DOC.createElement('script')
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    // jsdom의 eval 실행에서는 currentScript가 비므로, 태그 자신을 심어 둔다
    Object.defineProperty(DOC, 'currentScript', { value: el, configurable: true })
    try {
      W.eval(BRIDGE_SRC)
    } finally {
      delete (DOC as any).currentScript
      delete W.AssistantWidget
    }
    return { calls }
  }

  for (const page of PAGES) {
    test(`${page}: 단독 실행에서 캘리 config로 init 1회`, () => {
      const html = fs.readFileSync(path.join(PUB, page), 'utf-8')
      const tag = bridgeTag(html)
      expect(tag).not.toBeNull()
      const { calls } = runBridge(dataAttrs((tag as { attrs: string }).attrs))
      expect(calls).toEqual([EXPECTED])
    })
  }

  test('카나리아 대조군: data-* 없는 태그로는 init이 불리지 않는다', () => {
    const { calls } = runBridge({})
    expect(calls).toEqual([])
  })
})
