/**
 * kordoc 로더 계약 (2026-11-15 무결성 검증 P0).
 *
 * 재빌드된 public/vendor/kordoc/kordoc.js는 ESM 번들이라 window.__kordoc을
 * 설정하지 않는다. 로더가 import 반환값을 버리고 전역만 읽으면 undefined가
 * 되어 레거시 폴백으로 떨어지고, 표 위주 HWPX 문서의 텍스트 추출이
 * 247개 마커 중 2개만 나온다. 두 로더(finder-viewer.js의 loadLib 'kordoc'
 * 분기, office-assistant.js의 loadKordocGen)는 import 반환값(기본은
 * default 객체)을 써야 한다.
 *
 * 동적 import를 jest에서 모킹할 수 없어 소스 계약으로 검증한다
 * (office-lazy-libs.test.ts의 loadLib 계약 검증과 같은 패턴).
 * 번들 자체의 export 형태(default·parse·readText·markdownToHwpx)는
 * Node 네이티브 ESM import로 직접 확인했고, 무결성 프로브
 * (.scratch/office-integrity/)가 네임스페이스 직접 import 시 247/247을
 * 실증했다.
 */
import * as fs from 'fs';
import * as path from 'path';

function read(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

/** kordoc.js import 지점부터 이어지는 분기 본문을 잘라낸다. */
function kordocBranch(src: string): string {
  const at = src.indexOf('/vendor/kordoc/kordoc.js');
  expect(at).toBeGreaterThan(-1);
  return src.slice(at, at + 600);
}

describe('kordoc 로더 계약', () => {
  it('finder-viewer loadLib kordoc 분기가 import 반환값을 쓴다', () => {
    const branch = kordocBranch(read('public/js/finder-viewer.js'));
    // .then 콜백이 import 결과(모듈 네임스페이스)를 인자로 받는다.
    expect(branch).toMatch(/\.then\(function\s*\(\s*\w+\s*\)/);
    // default 객체를 우선 사용한다.
    expect(branch).toContain('mod.default');
    // 전역에만 의존하지 않는다 — ESM 번들은 전역을 설정하지 않는다.
    expect(branch).not.toContain('window.__kordoc');
  });

  it('office-assistant loadKordocGen이 import 반환값을 쓴다', () => {
    const branch = kordocBranch(read('public/js/office-assistant.js'));
    expect(branch).toMatch(/\.then\(function\s*\(\s*\w+\s*\)/);
    expect(branch).toContain('mod.default');
    expect(branch).not.toContain('window.__kordoc');
  });

  it('kordoc 번들이 default·named export를 모두 제공한다', () => {
    const bundle = read('public/vendor/kordoc/kordoc.js');
    expect(bundle).toContain('entry_default as default');
    expect(bundle).toContain('readText2 as readText');
    expect(bundle).toContain('markdownToHwpx');
  });
});
