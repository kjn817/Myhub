/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * DeckCraft 폰트 적용 후 재-shaping 넛지 회귀 (2026-11-10)
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - deckcraft:fonts-applied를 받으면 호스트가 exec로 view.zoomIn을
 *   보내고, 그 결과가 돌아온 뒤 별도 exec로 view.fit을 보낸다
 *   (한 배치로 묶거나 fit을 빼면 플레이스홀더 .notdef 고정이 풀리지
 *   않는 것을 실브라우저 프로브로 확정한 계약 — ppt-korean-fix).
 * - 이 넛지는 세션당 1회만 나간다 (fonts-applied 반복에도 재발 없음).
 * - fonts-applied가 없으면 exec는 절대 나가지 않는다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const BRIDGE_JS = fs.readFileSync(path.join(ROOT, 'public/js/finder-deckcraft.js'), 'utf-8')
const FONTS_JS = fs.readFileSync(path.join(ROOT, 'public/js/fonts.js'), 'utf-8')
const HTTP_JSON_JS = fs.readFileSync(path.join(ROOT, 'public/js/common/http-json.js'), 'utf-8')

const getWin = (): any => (globalThis as any).window
const getDoc = (): any => (globalThis as any).document

function flush(ms = 0) {
  return new Promise((r) => setTimeout(r, ms))
}

function setupHost() {
  const win = getWin()
  const doc = getDoc()
  doc.body.innerHTML = '<div id="host-parent"></div>'
  // F-L10: 폴백 폰트 fetch 본문은 fonts.js의 loadFontBytes를 쓴다 —
  // 운영에서 fonts.js는 정적 태그라 deckcraft보다 항상 먼저 뜬다.
  // fonts.js는 http-json.js 코어를 먼저 받아야 한다.
  new Function('window', 'document', HTTP_JSON_JS)(win, doc)
  new Function('window', 'document', FONTS_JS)(win, doc)
  new Function('window', 'document', BRIDGE_JS)(win, doc)
  const api = win.MyHubFinderDeckCraft
  const fetchFn = jest.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(8),
  }))
  const host: any = api.createHost({
    doc,
    win,
    parentEl: doc.getElementById('host-parent'),
    fetchFn,
    fonts: null,
  })
  const posts: any[] = []
  const cw = host.frame.contentWindow
  cw.postMessage = (msg: any) => {
    posts.push(msg)
  }
  const fromEngine = (data: any) => {
    const ev = new win.MessageEvent('message', {
      data,
      origin: win.location.origin,
      source: cw,
    })
    win.dispatchEvent(ev)
  }
  const execPosts = () => posts.filter((m) => m && m.type === 'deckcraft:exec')
  const answerExec = (post: any, results: any) => {
    fromEngine({ type: 'deckcraft:exec-result', tag: post.tag, results })
  }
  return { win, host, posts, fromEngine, execPosts, answerExec }
}

describe('deckcraft fonts-applied zoom reshape nudge', () => {
  test('fonts-applied → exec view.zoomIn, 결과 후 별도 exec view.fit', async () => {
    const { host, posts, fromEngine, execPosts, answerExec } = setupHost()
    fromEngine({ type: 'deckcraft:ready', version: 'test' })
    await flush(10)
    // ready 직후 폰트 푸시가 나갔는지 (넛지의 전제)
    expect(posts.some((m) => m && m.type === 'deckcraft:fonts')).toBe(true)
    expect(execPosts()).toHaveLength(0)

    fromEngine({ type: 'deckcraft:fonts-applied', faces: 13 })
    await flush(10)
    const first = execPosts()
    expect(first).toHaveLength(1)
    expect(first[0].commands).toEqual([{ id: 'view.zoomIn', params: {} }])

    answerExec(first[0], [{ ok: true, result: null }])
    await flush(10)
    const second = execPosts()
    expect(second).toHaveLength(2)
    expect(second[1].commands).toEqual([{ id: 'view.fit', params: {} }])
    expect(second[1].tag).not.toBe(second[0].tag)

    answerExec(second[1], [{ ok: true, result: null }])
    await flush(10)
    expect(execPosts()).toHaveLength(2)
    host.destroy()
    await flush(350)
  })

  test('fonts-applied가 반복돼도 넛지는 세션당 1회만', async () => {
    const { host, fromEngine, execPosts, answerExec } = setupHost()
    fromEngine({ type: 'deckcraft:ready', version: 'test' })
    await flush(10)
    fromEngine({ type: 'deckcraft:fonts-applied', faces: 13 })
    await flush(10)
    const first = execPosts()
    expect(first).toHaveLength(1)
    answerExec(first[0], [{ ok: true, result: null }])
    await flush(10)
    const second = execPosts()
    answerExec(second[1], [{ ok: true, result: null }])
    await flush(10)

    fromEngine({ type: 'deckcraft:fonts-applied', faces: 13 })
    await flush(10)
    expect(execPosts()).toHaveLength(2)
    host.destroy()
    await flush(350)
  })

  test('fonts-applied가 없으면 exec는 나가지 않는다', async () => {
    const { host, fromEngine, execPosts } = setupHost()
    fromEngine({ type: 'deckcraft:ready', version: 'test' })
    await flush(20)
    expect(execPosts()).toHaveLength(0)
    host.destroy()
    await flush(350)
  })
})
