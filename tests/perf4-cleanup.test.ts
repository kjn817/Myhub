/// <reference types="jest" />
/**
 * 성능 4라운드 정리 회귀 테스트 (2026-11-13).
 *
 * 검증하는 성질:
 * - backup.js는 메뉴를 정의하지 않는다. 구형식 항목 배열을
 *   MyHubMenus.push하던 죽은 코드(메뉴가 아예 안 뜸)를 삭제했고,
 *   백업은 단일 목적 페이지라 메뉴 없음이 설계이다. 다시 생기면 실패.
 * - kordoc 번들은 kordoc.js 하나만 존재한다. 구 kordoc.bundle.js는
 *   kordoc.js와 바이트 동일(3.3MB 중복)이라 트리·매니페스트에서
 *   제거했고, 런타임은 kordoc.js만 로드한다. 부활하면 실패.
 * - kordoc 빌드 산출물 이름이 배포 파일명과 일치한다
 *   (build-kordoc.mjs의 outfile이 kordoc.js).
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function manifestFiles(): string[] {
  const manifest = JSON.parse(read('scripts/static-assets.json')) as {
    files?: string[];
    versioned?: string[];
  };
  return [...(manifest.files || []), ...(manifest.versioned || [])];
}

describe('perf4 cleanup', () => {
  it('backup.js는 메뉴를 정의하지 않는다', () => {
    expect(read('public/js/backup.js')).not.toContain('MyHubMenus');
  });

  it('kordoc 번들은 kordoc.js 하나만 존재한다', () => {
    expect(fs.existsSync(path.join(PUBLIC, 'vendor/kordoc/kordoc.js'))).toBe(true);
    expect(fs.existsSync(path.join(PUBLIC, 'vendor/kordoc/kordoc.bundle.js'))).toBe(false);
    const files = manifestFiles();
    expect(files).toContain('/vendor/kordoc/kordoc.js');
    expect(files).not.toContain('/vendor/kordoc/kordoc.bundle.js');
  });

  it('kordoc 빌드 산출물 이름이 배포 파일명과 일치한다', () => {
    expect(read('scripts/build-kordoc.mjs')).toContain("new URL('./kordoc.js'");
    expect(read('scripts/build-kordoc.mjs')).not.toContain('kordoc.bundle.js');
  });

  it('런타임은 kordoc.js만 로드한다', () => {
    expect(read('public/js/finder-viewer.js')).toContain('/vendor/kordoc/kordoc.js');
    expect(read('public/js/office-assistant.js')).toContain('/vendor/kordoc/kordoc.js');
    expect(read('public/js/finder-viewer.js')).not.toContain('kordoc.bundle');
    expect(read('public/js/office-assistant.js')).not.toContain('kordoc.bundle');
  });
});
