/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 배경화면 부팅 레이어 삭제 (2026-11-13 사용자 지적).
 *
 * 배경: 데스크톱이 뜰 때 MyHub 로딩 원형(#dt-boot)이 사라진 뒤에도
 * 배경화면 레이어 위에 "JN" 마크 + 진행 막대(.dt-wp-boot)가 남아 있어
 * 로딩 화면이 두 겹으로 중첩되는 느낌이었다. 수정: 부팅 레이어를
 * 통째로 삭제했다 — 사진이 준비되기 전에는 레이어의 근검정 배경색
 * (.dt-wallpaper background-color #0b0b0f)이 그대로 보인다. 로딩
 * 화면은 MyHub 로딩 원형(#dt-boot) 하나만 남는다.
 *
 * 검증 성질:
 * - 정적: wallpaper.js·desktop.css에 부팅 레이어 흔적이 없고,
 *   desktop.html의 #dt-boot(MyHub 로딩)는 그대로 있다.
 * - 동작: 사진을 받는 동안·받기 실패·받기 성공 어느 때에도
 *   .dt-wp-boot 요소가 생기지 않는다.
 *
 * 카나리아: wallpaper.js에 ensureBoot를 다시 넣으면 동작 테스트가
 * 실패하고, desktop.css에 .dt-wp-boot 규칙을 다시 넣으면 정적
 * 테스트가 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const WALLPAPER_JS = fs.readFileSync(
  path.join(ROOT, 'public', 'js', 'desktop', 'wallpaper.js'),
  'utf-8',
)
const DESKTOP_CSS = fs.readFileSync(path.join(ROOT, 'public', 'css', 'desktop.css'), 'utf-8')
const DESKTOP_HTML = fs.readFileSync(path.join(ROOT, 'public', 'desktop.html'), 'utf-8')

const getWin = (): any => (globalThis as any).window
const getDoc = (): any => (globalThis as any).document

function flush(ms = 0) {
  return new Promise((r) => setTimeout(r, ms))
}

function setupWallpaper() {
  const win = getWin()
  const doc = getDoc()
  doc.body.innerHTML = ''
  new Function('window', 'document', WALLPAPER_JS)(win, doc)
  const layer = doc.createElement('div')
  layer.className = 'dt-wallpaper'
  doc.body.appendChild(layer)
  const caption = doc.createElement('div')
  doc.body.appendChild(caption)
  const probes: any[] = []
  class ImageStub {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    // naturalWidth 0이면 syncToneFromImage가 캔버스를 건드리기 전에
    // 돌아간다 (jsdom에는 canvas가 없어 경고만 나온다 — 이 테스트의
    // 대상은 톤 동기화가 아니다).
    naturalWidth = 0
    constructor() {
      probes.push(this)
    }
    set src(_v: string) {
      // 로딩을 시작하지 않는다 — 테스트가 onload/onerror를 직접 친다.
    }
  }
  const api = win.MyHubDesktopWallpaper
  const manager = api.createManager({
    layer,
    caption,
    storage: null,
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ wallpaper: null }) }),
    imageCtor: ImageStub,
  })
  return { doc, layer, manager, probes }
}

describe('배경화면 부팅 레이어 삭제 (정적)', () => {
  test('wallpaper.js·desktop.css에 부팅 레이어 흔적이 없다', () => {
    expect(WALLPAPER_JS).not.toContain('dt-wp-boot')
    expect(WALLPAPER_JS).not.toContain('ensureBoot')
    expect(WALLPAPER_JS).not.toContain('showBoot')
    expect(WALLPAPER_JS).not.toContain('hideBoot')
    expect(DESKTOP_CSS).not.toContain('dt-wp-boot')
    expect(DESKTOP_CSS).not.toContain('dtWpBootSlide')
  })

  test('MyHub 로딩 원형(#dt-boot)은 그대로 남는다', () => {
    expect(DESKTOP_HTML).toContain('id="dt-boot"')
    expect(DESKTOP_HTML).toContain('dt-boot-spin')
    expect(DESKTOP_HTML).toContain('MyHub')
  })
})

describe('배경화면 부팅 레이어 삭제 (동작)', () => {
  test('사진을 받는 동안 부팅 레이어가 생기지 않는다', async () => {
    const { layer, probes } = setupWallpaper()
    await flush(20)
    expect(probes.length).toBe(1)
    expect(layer.querySelector('.dt-wp-boot')).toBeNull()
  })

  test('사진 받기 실패에도 부팅 레이어가 생기지 않는다', async () => {
    const { layer, probes } = setupWallpaper()
    await flush(20)
    probes[0].onerror()
    await flush(20)
    expect(layer.querySelector('.dt-wp-boot')).toBeNull()
    // 실패 시에도 레이어에는 사진이 없고 근검정 배경만 남는다.
    expect(layer.style.backgroundImage).toBe('')
  })

  test('사진이 붙은 뒤에도 부팅 레이어가 생기지 않는다', async () => {
    const { layer, probes } = setupWallpaper()
    await flush(20)
    probes[0].onload()
    await flush(20)
    expect(layer.className).toContain('dt-wp-photo')
    expect(layer.style.backgroundImage).toContain('/api/desktop/wallpaper/image')
    expect(layer.querySelector('.dt-wp-boot')).toBeNull()
  })
})
