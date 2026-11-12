/// <reference types="jest" />
/**
 * 열기/저장 패널(office-picker.js)의 DOM 계약 테스트.
 *
 * 검증 성질: office-picker.js의 createPicker가 el()로 찾는 모든 요소 ID가
 * 패널을 쓰는 문서(office.html·finder.html)에 실제로 존재한다. 마크업이
 * 빠지면 createPicker의 조회가 전부 null이 되어 패널이 열리지 않고
 * 저장 흐름이 '저장 중'에서 영원히 멈춘다 (2026-11-09 실브라우저에서
 * 재현·수정한 결함). ID 목록은 하드코딩하지 않고 office-picker.js
 * 소스에서 추출하므로 계약이 늘면 테스트도 따라간다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')

function pickerElementIds(): string[] {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/office-picker.js'), 'utf8')
  const ids = new Set<string>()
  for (const m of src.matchAll(/\bel\('([A-Za-z][A-Za-z0-9]*)'\)/g)) ids.add(m[1])
  return [...ids]
}

describe('office-picker DOM 계약', () => {
  const ids = pickerElementIds()

  it('office-picker.js에서 조회 ID가 추출된다', () => {
    expect(ids.length).toBeGreaterThanOrEqual(10)
    expect(ids).toContain('officePicker')
    expect(ids).toContain('officePickConfirm')
  })

  // 유일한 예외: officePickImport. office-picker.js는 이 버튼의 모든
  // 사용처를 if (pickImportBtn) 로 null 가드하는 선택 요소로 취급하고,
  // 원본 finder.html의 패널은 '이 기기에서 가져오기'를 제공하지 않아
  // 버튼 자체가 없다 (office.html에는 hidden 버튼으로 실재한다).
  // 2026-11-11 운영 원본 설치 때 드러난 원본 계약.
  const OPTIONAL_BY_PAGE: Record<string, string[]> = { 'finder.html': ['officePickImport'] }

  it.each(['office.html', 'finder.html'])('%s에 패널 요소가 전부 있다', (page) => {
    const html = fs.readFileSync(path.join(ROOT, 'public', page), 'utf8')
    const optional = OPTIONAL_BY_PAGE[page] ?? []
    const missing = ids.filter((id) => !optional.includes(id) && !html.includes(`id="${id}"`))
    expect(missing).toEqual([])
  })

  it('officePickImport 예외의 전제: office-picker.js가 사용처를 null 가드한다', () => {
    // 가드가 사라지면 finder.html(버튼 부재)에서 패널이 깨진다 — 그때는
    // 예외가 무효이므로 이 테스트가 먼저 실패해 예외를 재검토하게 한다.
    const src = fs.readFileSync(path.join(ROOT, 'public/js/office-picker.js'), 'utf8')
    expect(src.match(/if \(pickImportBtn\)/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
  })

  it('office.html의 패널은 처음에 숨겨져 있다', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public/office.html'), 'utf8')
    // 원본 마크업은 class가 id보다 앞이다: <div class="office-picker-backdrop" id="officePicker" hidden>
    const tag = html.match(/<div[^>]*id="officePicker"[^>]*>/)
    expect(tag).not.toBeNull()
    expect(tag![0]).toContain('hidden')
  })
})

describe('데스크톱 오피스 탭 메뉴 꺽쇠 제거 (2026-11-12 사용자 지적)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'desktop.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'desktop.css'), 'utf8');
  const win = fs.readFileSync(path.join(ROOT, 'public', 'js', 'desktop', 'windows.js'), 'utf8');
  test('오피스 메뉴 탭에 꺽쇠 아이콘을 붙이지 않는다 (macOS 메뉴 막대·MyHubMenus와 동일)', () => {
    // macOS 메뉴 막대 항목과 MyHubMenus 버튼에는 꺽쇠가 없다. 오피스
    // 메뉴에만 꺽쇠가 붙어 상단바에서 튀어 디자인을 해쳤다는 지적.
    expect(win).not.toContain('dt-office-tab-menu-icon');
    expect(win).not.toContain('#i-chevron-down');
    expect(css).not.toContain('.dt-office-tab-menu-icon');
  });
  test('죽은 #i-chevron-down 스프라이트 심볼이 없다 (유일한 사용처가 메뉴 아이콘이었다)', () => {
    expect(html).not.toContain('id="i-chevron-down"');
  });
});

describe('rhwp 파일 메뉴 브리지 계약 (회귀: 임베드 파일 메뉴 소실)', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'public', 'rhwp-studio', 'myhub-file-menu.js'), 'utf8');
  const studioHtml = fs.readFileSync(path.join(ROOT, 'public', 'rhwp-studio', 'index.html'), 'utf8');
  test('스튜디오 index.html이 브리지를 로드한다', () => {
    expect(studioHtml).toContain('myhub-file-menu.js');
  });
  test('브리지는 호스트 계약 전역(__myhubFileMenu.enable·__myhubFileMenuOk)을 제공한다', () => {
    expect(bridge).toContain('__myhubFileMenu');
    expect(bridge).toContain('enable');
    // 운영 원본(2026-11-10 회수본)의 값은 '= 1'이다 — 재구성 스텁의 '= true'가 아님.
    expect(bridge).toContain('__myhubFileMenuOk = 1');
  });
  test('브리지는 메뉴 호스트·찾기 전역(__myhubMenuHost·__myhubFind)까지 한 파일로 제공한다 (운영 원본 구성)', () => {
    expect(bridge).toContain('window.__myhubMenuHost = {');
    expect(bridge).toContain('__myhubMenuHostOk = 1');
    expect(bridge).toContain('window.__myhubFind = { search: searchStudio }');
    expect(bridge).toContain("auto.registerCommand");
  });
  test('보관함 항목이 myhub-hwp:file-action(open·save)으로 위임된다', () => {
    expect(bridge).toContain("'myhub-hwp:file-action'");
    expect(bridge).toContain("'open'");
    expect(bridge).toContain("'save'");
  });
});
