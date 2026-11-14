/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 데스크톱 부팅 init 비차단화 회귀 (성능 5라운드, 2026-11-13).
 *
 * 배경: start()가 /api/artifact(최대 1.5s)를 기다린 뒤에야 init()을
 * 불러 부팅 완료가 DCL보다 ~1.9s 늦었다 (실측: DCL 374ms인데 부팅 완료
 * 2306ms). 이제 init을 먼저 하고, artifact 응답 뒤에 스튜디오 모듈을
 * 등록 + init 시 parse에서 버려진 스튜디오 창을 늦은 복원으로 되살린다.
 *
 * 검증 성질:
 * - artifact 응답이 오기 전에 init이 끝나고 부팅 오버레이가 사라진다.
 * - artifact 응답 뒤에 저장된 스튜디오 창이 저장된 rect로 복원된다.
 * - artifact 조회가 실패해도 데스크톱은 뜨고 기본 모듈만으로 진행한다.
 *
 * 카나리아: main.js에서 init()을 artifact .then 안으로 되돌리면 첫
 * 테스트가 실패하고, restoreDroppedStudioWindows 호출을 지우면 두 번째
 * 테스트가 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const STATE_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'state.js'), 'utf-8')
const TILES_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'tiles.js'), 'utf-8')
const MENU_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'menu.js'), 'utf-8')
const DOCK_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'dock.js'), 'utf-8')
const WINDOWS_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'windows.js'), 'utf-8')
const MAIN_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'main.js'), 'utf-8')
const CONSTANTS_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'common', 'constants.js'), 'utf-8')

const getWin = (): any => (globalThis as any).window
const getDoc = (): any => (globalThis as any).document

function flush(ms = 0) {
  return new Promise((r) => setTimeout(r, ms))
}

const SAVED_STATE = {
  version: 2,
  windows: [
    { id: 'memo', module: 'memo', x: 60, y: 60, w: 720, h: 520, z: 1, minimized: false, space: 1, mode: null, prev: null },
    { id: 'app-123', module: 'app-123', x: 100, y: 80, w: 880, h: 620, z: 5, minimized: false, space: 1, mode: null, prev: null },
  ],
  activeId: 'app-123',
  zCounter: 5,
  spaces: [1],
  activeSpace: 1,
}

function setupBoot(artifactImpl: any) {
  const win = getWin()
  const doc = getDoc()
  // /api/artifact만 테스트 스텁이 맡고, 그 밖의 fetch(독 휴지통 새로고침 등)는
  // 빈 정상 응답을 돌려준다 — artifact 실패 테스트가 다른 경로까지 오염시키지
  // 않게 한다.
  const fetchImpl = jest.fn((url: any, opts: any) => {
    if (String(url).includes('/api/artifact')) return artifactImpl(url, opts)
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: async () => '' })
  })
  doc.body.innerHTML = `
<div id="dt-boot"></div>
<header class="g-nav">
  <button type="button" id="dt-active-title" class="dt-active-title"></button>
  <div id="dt-app-actions"></div>
  <div id="dt-office-tabs"></div>
  <div id="dt-bar-assistant"></div>
</header>
<div id="dt-wallpaper"></div>
<div id="dt-wp-caption"></div>
<div id="dt-icons"></div>
<div id="dt-widgets"></div>
<main id="dt-root"></main>
<div id="dt-mission"></div>
<nav id="dt-dock"></nav>`
  win.localStorage.clear()
  win.localStorage.setItem('myhub.desktop.v1', JSON.stringify(SAVED_STATE))
  // 전역 fetch를 테스트 스텁으로 교체한다 (main.js는 bare fetch를 쓴다).
  const origFetch = (globalThis as any).fetch
  ;(globalThis as any).fetch = fetchImpl
  // 5-9: 공용 상수를 가장 먼저 뜬다 (운영 desktop.html 태그 순서와 동일).
  new Function('window', 'document', CONSTANTS_JS)(win, doc)
  new Function('window', 'document', STATE_JS)(win, doc)
  new Function('window', 'document', TILES_JS)(win, doc)
  new Function('window', 'document', MENU_JS)(win, doc)
  new Function('window', 'document', DOCK_JS)(win, doc)
  new Function('window', 'document', WINDOWS_JS)(win, doc)
  new Function('window', 'document', MAIN_JS)(win, doc)
  return {
    win,
    doc,
    fetchFn: fetchImpl,
    restoreFetch: () => {
      ;(globalThis as any).fetch = origFetch
    },
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: any) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function artifactResponse(data: any[]) {
  return { ok: true, status: 200, json: async () => ({ data }) }
}

describe('부팅 init 비차단화', () => {
  test('artifact 응답 전에 init이 끝나고 부팅 오버레이가 사라진다', async () => {
    const d = deferred<any>()
    const { win, doc, fetchFn, restoreFetch } = setupBoot(() => d.promise)
    try {
      await flush(50)
      // fetch가 아직 안 끝났는데도 데스크톱이 붙어 있다.
      expect(fetchFn).toHaveBeenCalledWith('/api/artifact', expect.anything())
      expect(win.MyHubDesktop).toBeTruthy()
      expect(win.MyHubDesktop.getState().windows.map((w: any) => w.id)).toContain('memo')
      // 부팅 오버레이도 fetch를 기다리지 않고 사라진다 (300ms 페이드아웃).
      await flush(400)
      expect(doc.getElementById('dt-boot')).toBeNull()
    } finally {
      // 남은 artifact 요청을 정리한다 (다음 테스트로 안 새게).
      d.resolve(artifactResponse([]))
      await flush(10)
      restoreFetch()
    }
  })

  test('artifact 응답 뒤에 저장된 스튜디오 창이 저장된 rect로 복원된다', async () => {
    const d = deferred<any>()
    const { win, restoreFetch } = setupBoot(() => d.promise)
    try {
      await flush(50)
      // init 시점에는 스튜디오 모듈이 몰라서 app-123 창이 버려져 있다.
      const before = win.MyHubDesktop.getState().windows.map((w: any) => w.id)
      expect(before).toContain('memo')
      expect(before).not.toContain('app-123')
      d.resolve(artifactResponse([{ id: 123, title: '진단 앱' }]))
      await flush(50)
      const state = win.MyHubDesktop.getState()
      const restored = state.windows.find((w: any) => w.id === 'app-123')
      expect(restored).toBeTruthy()
      // 저장된 rect 그대로 — 기본 중앙 배치가 아니다.
      expect(restored.x).toBe(100)
      expect(restored.y).toBe(80)
      expect(restored.w).toBe(880)
      expect(restored.h).toBe(620)
      expect(restored.z).toBe(5)
      // 저장된 활성 창이었으므로 activeId도 따라간다.
      expect(state.activeId).toBe('app-123')
      // 창 DOM도 실제로 만들어졌다 (상태만 바뀐 게 아님).
      expect(win.document.querySelectorAll('.dt-window').length).toBe(2)
    } finally {
      restoreFetch()
    }
  })

  test('artifact 조회가 실패해도 데스크톱은 뜨고 기본 모듈만으로 진행한다', async () => {
    const { win, restoreFetch } = setupBoot(async () => {
      throw new Error('network down')
    })
    try {
      await flush(50)
      expect(win.MyHubDesktop).toBeTruthy()
      const ids = win.MyHubDesktop.getState().windows.map((w: any) => w.id)
      expect(ids).toContain('memo')
      expect(ids).not.toContain('app-123')
    } finally {
      restoreFetch()
    }
  })
})
