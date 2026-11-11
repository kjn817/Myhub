/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 루트 nav.js 설정 메뉴 — 원본(운영 전사본 544줄) 계약 회귀 테스트.
 *
 * 검증 성질:
 * - 메뉴는 #myhubSettingsMenu(백드롭+패널) 싱크톱으로 열리고, 기본 항목은
 *   링크(데스크톱 열기·데이터 백업·암호화 키 교체)와 로그아웃 버튼이다.
 * - label 없는 그룹 항목({group, children})은 "undefined"로 찍히지 않고
 *   그룹 행 + 숨은 서브메뉴로 렌더링되며, 행을 눌러 서브메뉴를 열면
 *   자식이 실제로 동작하고 메뉴가 닫힌다.
 * (2026-11-10 라이브에서 재구축본 nav.js가 배경 그룹을 "undefined"로
 * 찍은 결함 + 그룹/서브메뉴 장치 자체가 없던 발산의 재발 방지.)
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const NAV_SRC = fs.readFileSync(path.join(ROOT, 'public', 'nav.js'), 'utf-8')

const getDoc = (): any => (globalThis as any).document
const getWin = (): any => (globalThis as any).window

function loadNav() {
  const doc = getDoc()
  doc.body.innerHTML = '<nav class="g-nav"></nav>'
  getWin().eval(NAV_SRC)
  return getWin().MyHubNav
}

describe('nav.js 설정 메뉴 — 원본 구조', () => {
  test('열면 백드롭+패널에 기본 링크 3개와 로그아웃이 렌더링된다', () => {
    const nav = loadNav()
    expect(nav).toBeTruthy()
    nav.openSettingsMenu()
    const root = getDoc().getElementById('myhubSettingsMenu')
    expect(root).not.toBeNull()
    expect(root.hidden).toBe(false)
    expect(root.querySelector('.myhub-settings-backdrop')).not.toBeNull()
    const panel = root.querySelector('.myhub-settings-panel')
    expect(panel).not.toBeNull()
    const links = [...panel.querySelectorAll('a.myhub-settings-item')].map(
      (a: any) => [a.textContent.trim(), a.getAttribute('href')],
    )
    expect(links).toEqual([
      ['데스크톱 열기', '/desktop.html'],
      ['데이터 백업', '/backup.html'],
      ['암호화 키 교체', '/key-rotation.html'],
    ])
    const logout = getDoc().getElementById('myhubSettingsLogoutBtn')
    expect(logout).not.toBeNull()
    expect(logout.textContent).toContain('로그아웃')
    expect(logout.className).toContain('danger')
  })

  test('그룹은 undefined가 아니라 행+서브메뉴로 렌더링되고 자식이 동작한다', () => {
    const nav = loadNav()
    const onSelect = jest.fn()
    nav.addSettingsItems([
      {
        id: 'wp-group',
        group: '배경',
        children: [
          { id: 'wp-today', label: '오늘의 사진', checked: () => true, onSelect },
        ],
      },
    ])
    nav.openSettingsMenu()
    const root = getDoc().getElementById('myhubSettingsMenu')
    expect(root.textContent).not.toContain('undefined')
    const wrap = root.querySelector('.myhub-settings-group-wrap')
    expect(wrap).not.toBeNull()
    const row = wrap.querySelector('.myhub-settings-group')
    expect(row.textContent).toContain('배경')
    const sub = wrap.querySelector('.myhub-settings-submenu')
    expect(sub.hidden).toBe(true)
    ;(row as any).click()
    expect(sub.hidden).toBe(false)
    const child = [...sub.querySelectorAll('.myhub-settings-item')].find((b: any) =>
      b.textContent.includes('오늘의 사진'),
    )!
    expect(child).toBeTruthy()
    expect(child.querySelector('.myhub-settings-check')).not.toBeNull()
    ;(child as any).click()
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(root.hidden).toBe(true)
  })

  test('label도 children도 없는 항목은 그려지지 않는다', () => {
    const nav = loadNav()
    nav.addSettingsItems([{ id: 'broken' }])
    nav.openSettingsMenu()
    const root = getDoc().getElementById('myhubSettingsMenu')
    expect(root.textContent).not.toContain('undefined')
    const pageItems = getDoc().getElementById('myhubSettingsPageItems')
    expect(pageItems.hidden).toBe(true)
  })

  test('MyHubNav 공개 API가 원본 표면을 제공한다 (데스크톱·구글 연동 소비자 계약)', () => {
    const nav = loadNav()
    for (const key of [
      'DESKTOP_URL',
      'BACKUP_URL',
      'KEY_ROTATION_URL',
      'openBackupInDesktop',
      'buildSettingsMenu',
      'addSettingsItemsProvider',
    ]) {
      expect(nav[key]).toBeDefined()
    }
    expect(nav.DESKTOP_URL).toBe('/desktop.html')
    expect(typeof nav.addSettingsItemsProvider).toBe('function')
  })
})
