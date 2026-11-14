/// <reference types="jest" />
/**
 * F-L11 menu-items 래퍼 + windows.js 내부 헬퍼 테스트 (5-5)
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - windows.js·office-tabs.js에 로컬 메뉴 매핑 본문이 없다
 *   (separator·children 재귀 본문은 코어에만 있다).
 * - windows.js의 iframe 식별·메시지 서두가 각 1곳으로 합쳐졌다
 *   (findWinIdBySource·sameOriginData 정의 1개씩, 남은 직접 조회 0건).
 * - toggleMaximize·toggleZoom이 beginModeToggle 서두를 공유한다.
 * - HTML 로딩 순서와 에셋 등록이 맞다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

describe('F-L11 menu-items 래퍼', () => {
  test('windows.js·office-tabs.js에 로컬 매핑 본문이 없다', () => {
    for (const f of ['public/js/desktop/windows.js', 'public/js/office-tabs.js']) {
      const src = read(f)
      expect(src).not.toMatch(/out\.push\(\{ separator: true \}\)/)
      expect(src).not.toMatch(/item\.children = map\w+\(n\.children/)
      expect(src).toMatch(/MyHubMenuItems/)
      expect(src).toMatch(/MyHubMenuItems\.mapMenuItems/)
    }
  })

  test('office-tabs는 menu-exec dispatch를 onSelect로 넘긴다', () => {
    const src = read('public/js/office-tabs.js')
    expect(src).toMatch(/dispatch\(\{ type: 'menu-exec', id: menuId, path: p \}\)/)
  })

  test('windows.js의 iframe 식별이 findWinIdBySource 1곳으로 합쳐졌다', () => {
    const src = read('public/js/desktop/windows.js')
    expect(src.match(/function findWinIdBySource\(source\)/g)).toHaveLength(1)
    expect(src.match(/findWinIdBySource\(e\.source\)/g)?.length).toBeGreaterThanOrEqual(
      10,
    )
    // 헬퍼 본문 1건만 직접 조회가 남는다
    expect(
      src.match(/rec\.frame\.contentWindow === e\.source/g) ?? [],
    ).toHaveLength(0)
    expect(src.match(/contentWindow === source/g)?.length).toBe(1)
  })

  test('windows.js의 메시지 서두가 sameOriginData 1곳으로 합쳐졌다', () => {
    const src = read('public/js/desktop/windows.js')
    expect(src.match(/function sameOriginData\(e\)/g)).toHaveLength(1)
    expect(src.match(/var d = sameOriginData\(e\);/g)?.length).toBe(11)
    expect(src.match(/e\.origin !== window\.location\.origin/g)?.length).toBe(1)
  })

  test('toggleMaximize·toggleZoom이 beginModeToggle를 공유한다', () => {
    const src = read('public/js/desktop/windows.js')
    expect(src.match(/function beginModeToggle\(id\)/g)).toHaveLength(1)
    expect(src.match(/var t = beginModeToggle\(id\);/g)).toHaveLength(2)
    // 서두의 findWin·focusById·재조회 패턴이 헬퍼 안에만 있다
    expect(src.match(/focusById\(id\);\n      cur = findWin\(id\);/g)?.length).toBe(1)
  })

  test('HTML이 menu-items를 소비자보다 먼저 받는다', () => {
    const desktop = read('public/desktop.html')
    expect(desktop.indexOf('/js/common/menu-items.js')).toBeLessThan(
      desktop.indexOf('/js/desktop/windows.js'),
    )
    const office = read('public/office.html')
    expect(office.indexOf('/js/common/menu-items.js')).toBeLessThan(
      office.indexOf('/js/office-tabs.js'),
    )
  })

  test('menu-items가 static-assets.json + DYNAMIC_ASSETS에 등록됐다', () => {
    const manifest = JSON.parse(read('scripts/static-assets.json'))
    expect(manifest.files).toContain('/js/common/menu-items.js')
    expect(read('public/js/asset-url.js')).toContain("'/js/common/menu-items.js'")
  })
})
