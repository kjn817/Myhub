/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 셸의 "파인더에서 파일 열기" 중계 (2026-11-20 브라우저 2단계).
 *
 * 배경: 브라우저 다운로드 목록에서 비오피스 파일을 클릭하면 셸에
 * myhub:open-module(finder)만 보내 파인더 창만 열리고 해당 파일로
 * 이동하지 않았다. 데스크톱 아이콘 더블클릭은 main.js의
 * pendingFinderOpen 핸드셰이크로 파인더에 myhub:open-file을 보내
 * 파일까지 이동하는데, 앱 메시지는 셸이 중계하지 않았다.
 * 수정: windows.js의 onFinderMessage가 myhub:open-file-in-finder를
 * 받아 finderFilePending을 두고, 파인더 ready 때 myhub:open-file
 * (folderId·fileId·name·mime)을 파인더 iframe에 보낸다. ack가 오면
 * pending을 비운다 (오피스 ack은 app이 있어 구분된다).
 *
 * 검증 성질:
 * - open-file-in-finder를 받으면 파인더 창이 열리고, finder-ready 후
 *   파인더 iframe에 myhub:open-file이 파일 정보와 함께 간다.
 * - ack 후에는 중복 ready에도 다시 보내지 않는다 (pending 소멸).
 * - fileId 없는 무효 요청은 무시한다 (창이 안 열린다).
 *
 * 카나리아: onFinderMessage의 open-file-in-finder 분기를 지우면
 * 첫 테스트가 실패한다 (파인더 창이 안 열림). ack 소멸을 지우면
 * 두 번째 테스트가 실패한다 (중복 전송).
 *
 * 로딩 패턴은 tests/desktop-browser-nav.test.ts와 동일하다 (실제
 * windows.js + state.js + 공용 전역, 스텁 아님).
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const STATE_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'state.js'), 'utf-8')
const TILES_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'tiles.js'), 'utf-8')
const MENU_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'menu.js'), 'utf-8')
const DOCK_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'dock.js'), 'utf-8')
const ANIM_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'common', 'anim.js'), 'utf-8')
const MENU_ITEMS_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'common', 'menu-items.js'), 'utf-8')
const CONSTANTS_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'common', 'constants.js'), 'utf-8')
const WINDOWS_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'windows.js'), 'utf-8')

const VIEWPORT = { w: 1280, h: 800 }

const getWin = (): any => (globalThis as any).window
const getDoc = (): any => (globalThis as any).document

function loadStateApi(): any {
  new Function('window', 'document', STATE_JS)(getWin(), getDoc())
  return getWin().MyHubDesktopState
}

function loadDesktopGlobals(): void {
  new Function('window', 'document', CONSTANTS_JS)(getWin(), getDoc())
  new Function('window', 'document', ANIM_JS)(getWin(), getDoc())
  new Function('window', 'document', MENU_ITEMS_JS)(getWin(), getDoc())
  new Function('window', 'document', TILES_JS)(getWin(), getDoc())
  new Function('window', 'document', MENU_JS)(getWin(), getDoc())
  new Function('window', 'document', DOCK_JS)(getWin(), getDoc())
}

function loadWindowsApi(): any {
  new Function('window', 'document', WINDOWS_JS)(getWin(), getDoc())
  return getWin().MyHubDesktopWindows
}

class MemoryStorage {
  store: Record<string, string> = {}
  getItem(k: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null
  }
  setItem(k: string, v: string): void {
    this.store[k] = String(v)
  }
}

function makeManager(): any {
  const doc = getDoc()
  doc.body.innerHTML = `
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
  const stateApi = loadStateApi()
  loadDesktopGlobals()
  const windowsApi = loadWindowsApi()
  return windowsApi.createManager({
    root: doc.getElementById('dt-root'),
    taskbar: doc.getElementById('dt-dock'),
    stateApi,
    storage: new MemoryStorage(),
    getViewport: () => ({ ...VIEWPORT }),
    state: stateApi.load(new MemoryStorage(), { ...VIEWPORT }),
    activeTitleEl: doc.getElementById('dt-active-title'),
    appActionsEl: doc.getElementById('dt-app-actions'),
    officeTabsEl: doc.getElementById('dt-office-tabs'),
    missionEl: doc.getElementById('dt-mission'),
    navApi: getWin().MyHubNav || null,
    wallpaperEl: doc.getElementById('dt-wallpaper'),
    menuApi: getWin().MyHubDesktopMenu || null,
  })
}

function postMsg(win: any, data: any): void {
  const ev = new win.MessageEvent('message', {
    data,
    origin: win.location.origin,
  })
  win.dispatchEvent(ev)
}

function finderFrame(doc: any): any {
  const el = doc.querySelector('.dt-window[data-id="finder"]')
  if (!el) return null
  return el.querySelector('iframe.dt-frame')
}

describe('파인더에서 파일 열기 중계', () => {
  test('open-file-in-finder를 받으면 파인더가 열리고 ready 후 open-file이 간다', () => {
    makeManager()
    const win = getWin()
    const doc = getDoc()
    expect(finderFrame(doc)).toBeNull()
    postMsg(win, {
      type: 'myhub:open-file-in-finder',
      fileId: 77,
      name: '사진.png',
      mime: 'image/png',
      folderId: 4,
      folderName: '다운로드',
    })
    const frame = finderFrame(doc)
    expect(frame).not.toBeNull()
    const postMessage = jest.fn()
    frame.contentWindow.postMessage = postMessage
    // ready 전에는 보내지 않는다.
    expect(postMessage).not.toHaveBeenCalled()
    postMsg(win, { type: 'myhub:finder-ready' })
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: 'myhub:open-file',
        folderId: 4,
        folderName: '다운로드',
        fileId: 77,
        name: '사진.png',
        mime: 'image/png',
      },
      win.location.origin,
    )
  })

  test('ack 후에는 중복 ready에도 다시 보내지 않는다', () => {
    makeManager()
    const win = getWin()
    const doc = getDoc()
    postMsg(win, {
      type: 'myhub:open-file-in-finder',
      fileId: 78,
      name: '문서.txt',
      mime: 'text/plain',
      folderId: 4,
      folderName: '다운로드',
    })
    const frame = finderFrame(doc)
    expect(frame).not.toBeNull()
    const postMessage = jest.fn()
    frame.contentWindow.postMessage = postMessage
    postMsg(win, { type: 'myhub:finder-ready' })
    expect(postMessage).toHaveBeenCalledTimes(1)
    // 파인더 ack에는 app이 없다 (오피스 ack과 구분).
    postMsg(win, { type: 'myhub:open-file-ack', fileId: 78 })
    postMsg(win, { type: 'myhub:finder-ready' })
    expect(postMessage).toHaveBeenCalledTimes(1)
  })

  test('fileId 없는 무효 요청은 무시한다', () => {
    makeManager()
    const win = getWin()
    const doc = getDoc()
    postMsg(win, { type: 'myhub:open-file-in-finder', name: '이름만.txt' })
    expect(finderFrame(doc)).toBeNull()
  })
})
