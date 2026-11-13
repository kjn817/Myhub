/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 바탕화면 파일 더블클릭 회귀 (2026-11-13 사용자 지적).
 *
 * 배경: 바탕화면의 파일 아이콘(PDF·한글)을 더블클릭해도 아무것도 열리지
 * 않았다. 원인은 fileItemsByKey가 init()의 지역 변수였는데, 파일 목록이
 * 지연 로드(loadDesktopFileItemsDeferred)로 init 뒤에 도착해 조회표에
 * 등록되지 않았기 때문이다 — openFileIcon이 항목을 못 찾아 조용히 포기했다.
 * 수정: 조회표를 모듈 스코프로 올리고 지연 로드에서도 채운다.
 *
 * 검증 성질:
 * - 지연 로드로 들어온 파일 아이콘을 더블클릭하면 파인더 창이 열린다
 *   (파인더가 파일을 받아 오피스로 넘기는 체인의 첫 단추).
 * - 아이콘이 보이기 전에는 더블클릭할 대상이 없다 (지연 로드 완료 대기).
 *
 * 카나리아: main.js의 loadDesktopFileItemsDeferred에서 fileItemsByKey
 * 채우기를 지우면 이 테스트가 실패한다 (창이 열리지 않음).
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const STATE_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'state.js'), 'utf-8')
const TILES_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'tiles.js'), 'utf-8')
const MENU_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'menu.js'), 'utf-8')
const DOCK_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'dock.js'), 'utf-8')
const WINDOWS_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'windows.js'), 'utf-8')
const ICONS_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'desktop-icons.js'), 'utf-8')
const DROP_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'drop-upload.js'), 'utf-8')
const MAIN_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'main.js'), 'utf-8')

const getWin = (): any => (globalThis as any).window
const getDoc = (): any => (globalThis as any).document

function flush(ms = 0) {
  return new Promise((r) => setTimeout(r, ms))
}

function setupDesktop() {
  const win = getWin()
  const doc = getDoc()
  const fetchImpl = jest.fn((url: any) => {
    const u = String(url)
    if (u === '/api/artifact') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) })
    }
    if (u === '/api/drive/list') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, folders: [{ id: 1, name: '바탕화면' }], files: [] }),
      })
    }
    if (u === '/api/drive/list?folder=1') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          folders: [],
          files: [
            { id: 102, filename: '1.서울특별시청 부설주차장.hwp', mime: 'application/x-hwp', size: 23456 },
          ],
        }),
      })
    }
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
  const origFetch = (globalThis as any).fetch
  ;(globalThis as any).fetch = fetchImpl
  new Function('window', 'document', STATE_JS)(win, doc)
  new Function('window', 'document', TILES_JS)(win, doc)
  new Function('window', 'document', MENU_JS)(win, doc)
  new Function('window', 'document', DOCK_JS)(win, doc)
  new Function('window', 'document', WINDOWS_JS)(win, doc)
  new Function('window', 'document', ICONS_JS)(win, doc)
  new Function('window', 'document', DROP_JS)(win, doc)
  new Function('window', 'document', MAIN_JS)(win, doc)
  return {
    win,
    doc,
    restoreFetch: () => {
      ;(globalThis as any).fetch = origFetch
    },
  }
}

async function waitForFileIcon(doc: any, timeoutMs = 2000) {
  const started = Date.now()
  for (;;) {
    const el = doc.querySelector('.dt-desk-icon.is-file[data-file-id="102"]')
    if (el) return el
    if (Date.now() - started > timeoutMs) throw new Error('파일 아이콘이 나타나지 않았다')
    await flush(20)
  }
}

describe('바탕화면 파일 더블클릭', () => {
  test('지연 로드된 파일 아이콘 더블클릭이 파인더 창을 연다', async () => {
    const { win, doc, restoreFetch } = setupDesktop()
    try {
      await flush(50)
      expect(win.MyHubDesktop).toBeTruthy()
      const icon = await waitForFileIcon(doc)
      expect(icon).not.toBeNull()
      // 더블클릭 전에는 창이 없다.
      expect(win.MyHubDesktop.getState().windows.length).toBe(0)
      icon.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true, cancelable: true }))
      await flush(50)
      const ids = win.MyHubDesktop.getState().windows.map((w: any) => w.module)
      expect(ids).toContain('finder')
      expect(doc.querySelectorAll('.dt-window').length).toBeGreaterThanOrEqual(1)
    } finally {
      restoreFetch()
    }
  })
})
