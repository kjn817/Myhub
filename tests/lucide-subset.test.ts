/// <reference types="jest" />
/**
 * Lucide 서브셋 회귀 테스트 (2026-11-13 성능 4라운드).
 *
 * 배경: 전 페이지가 477KB짜리 전체 lucide(2,292개 아이콘)를 로드해 앱
 * 열기마다 60~160ms의 파싱 비용을 냈다. scripts/build-lucide-subset.mjs가
 * 실제 사용하는 86개 아이콘만 번들링해 20.7KB로 줄였다.
 *
 * 이 테스트가 검증하는 성질:
 * - 코드가 새로 쓰는 아이콘이 서브셋 매니페스트에 없으면 실패한다
 *   (서브셋을 다시 빌드하지 않고 아이콘을 추가하는 실수 방지).
 *   카나리아: 매니페스트에서 아이콘 하나를 지우면 이 테스트가 실패한다.
 * - 빌드 산출물이 전체 빌드(477KB)로 되돌아가면 실패한다 (60KB 상한).
 * - login.html의 SRI 해시가 산출물과 어긋나면 실패한다 (해시가 틀리면
 *   로그인 페이지에서 lucide 로딩 자체가 거부된다).
 * - 매니페스트 버전이 설치된 lucide 버전과 어긋나면 실패한다.
 *
 * 스캔 로직은 빌드 스크립트와 scripts/lucide-scan.cjs를 공유하므로,
 * 패턴이 바뀌면 양쪽이 함께 바뀐다.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { scanPublicIcons } = require('../scripts/lucide-scan.cjs') as {
  scanPublicIcons: (
    publicDir: string,
    rootDir: string,
  ) => { strict: Map<string, string>; lenient: Map<string, string> };
};

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const MANIFEST_PATH = path.join(ROOT, 'scripts/lucide-subset.json');
const BUNDLE_PATH = path.join(PUBLIC, 'vendor/lucide/lucide.min.js');

function readManifest(): { version: string; icons: string[] } {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as {
    version: string;
    icons: string[];
  };
}

describe('lucide subset', () => {
  it('코드가 쓰는 모든 아이콘(strict)이 서브셋 매니페스트에 있다', () => {
    const { strict } = scanPublicIcons(PUBLIC, ROOT);
    const manifest = readManifest();
    const inSubset = new Set(manifest.icons);
    const missing = [...strict.keys()].filter((n) => !inSubset.has(n));
    expect(missing).toEqual([]);
    // 스캔이 비어 있으면 테스트 자체가 무의미하다 — 하한을 둔다.
    expect(strict.size).toBeGreaterThan(50);
  });

  it('서브셋 번들은 전체 빌드(477KB)가 아니라 60KB 미만이다', () => {
    const size = fs.statSync(BUNDLE_PATH).size;
    expect(size).toBeLessThan(60 * 1024);
    expect(size).toBeGreaterThan(1024);
  });

  it('login.html의 SRI 해시가 빌드 산출물과 일치한다', () => {
    const login = fs.readFileSync(path.join(PUBLIC, 'login.html'), 'utf8');
    const m = login.match(
      /<script src="\/vendor\/lucide\/lucide\.min\.js" integrity="sha384-([^"]+)"/,
    );
    expect(m).not.toBeNull();
    const digest = crypto
      .createHash('sha384')
      .update(fs.readFileSync(BUNDLE_PATH))
      .digest('base64');
    expect(m![1]).toBe(digest);
  });

  it('매니페스트 버전이 설치된 lucide 버전과 같다', () => {
    const manifest = readManifest();
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'node_modules/lucide/package.json'), 'utf8'),
    ) as { version: string };
    expect(manifest.version).toBe(pkg.version);
  });
});
