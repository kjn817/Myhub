/// <reference types="jest" />
/**
 * 오피스 벤더 라이브러리 지연 로딩 회귀 테스트 (2026-11-13 성능 4라운드).
 *
 * 배경: office.html이 xlsx(882KB)+jszip(98KB)+mammoth(643KB)를 eager
 * <script>로 매번 로딩해 오피스 앱 열기마다 1.6MB를 먼저 받았다.
 * 형식 핸들러는 이미 finder-viewer.js의 loadLib(동적 import) 경로를
 * 쓰므로 eager 태그 3개를 제거했다.
 *
 * 이 테스트가 검증하는 성질:
 * - office.html에 세 라이브러리의 eager 태그가 다시 생기면 실패한다.
 * - 지연 로딩 경로(LIB_URLS·loadLib)가 사라지면 실패한다.
 * - 형식 핸들러가 loadLib을 우회해 전역을 직접 쓰면 실패한다
 *   (정적 스캔: XLSX./JSZip./mammoth. 사용 지점이 loadLib 콜백
 *   안에 있어야 한다는 것을, loadLib 호출 존재로 근사 검증한다).
 * - 벤더 파일이 트리·매니페스트에서 빠지면 실패한다
 *   (지연 import가 404가 되는 것을 막는다).
 *
 * 카나리아: office.html에 eager 태그 하나를 다시 넣으면 첫 테스트가 실패한다.
 * 실브라우저 검증은 .scratch/perf4/probe-office-lazylib.cjs가 담당한다
 * (파일 열기 시 전역이 실제로 resolve되는지 확인).
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const LIBS = [
  { name: 'xlsx', file: '/vendor/xlsx.full.min.js', global: 'XLSX' },
  { name: 'jszip', file: '/vendor/jszip.min.js', global: 'JSZip' },
  { name: 'mammoth', file: '/vendor/mammoth.browser.min.js', global: 'mammoth' },
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('office lazy libs', () => {
  it('office.html에 xlsx/jszip/mammoth eager 태그가 없다', () => {
    const html = read('public/office.html');
    for (const lib of LIBS) {
      expect(html).not.toContain(`<script src="${lib.file}"`);
    }
  });

  it('finder-viewer.js가 세 라이브러리의 지연 로딩 경로를 갖고 있다', () => {
    const viewer = read('public/js/finder-viewer.js');
    expect(viewer).toContain('function loadLib(name)');
    for (const lib of LIBS) {
      expect(viewer).toContain(`${lib.name}: '${lib.file}'`);
    }
    // 동적 import가 실제 로딩 수단이다.
    expect(viewer).toContain('import(versionedAssetUrl(url))');
  });

  it('형식 핸들러가 세 라이브러리를 loadLib으로만 푼다', () => {
    const sheet = read('public/js/finder-format-sheet.js');
    const slide = read('public/js/finder-format-slide.js');
    const doc = read('public/js/finder-format-doc.js');
    expect(sheet).toContain("loadLib('xlsx')");
    expect(sheet).toContain("loadLib('jszip')");
    expect(slide).toContain("loadLib('jszip')");
    expect(doc).toContain("loadLib('mammoth')");
    // 전역 직접 참조가 loadLib 콜백 밖에서 일어나면 안 된다:
    // 각 파일에서 전역 사용이 loadLib 호출보다 먼저 나오면 실패.
    for (const [src, lib] of [
      [sheet, 'XLSX'],
      [sheet, 'JSZip'],
      [slide, 'JSZip'],
      [doc, 'mammoth'],
    ] as const) {
      const firstGlobal = src.search(new RegExp(`\\b${lib}\\.`));
      const firstLoad = src.indexOf(`loadLib('${lib === 'XLSX' ? 'xlsx' : lib === 'JSZip' ? 'jszip' : 'mammoth'}')`);
      expect(firstGlobal).toBeGreaterThan(-1);
      expect(firstLoad).toBeGreaterThan(-1);
      expect(firstLoad).toBeLessThan(firstGlobal);
    }
  });

  it('벤더 파일이 트리와 매니페스트에 남아 있다', () => {
    const manifest = JSON.parse(read('scripts/static-assets.json')) as {
      files?: string[];
      versioned?: string[];
    };
    const all = [...(manifest.files || []), ...(manifest.versioned || [])];
    for (const lib of LIBS) {
      expect(fs.existsSync(path.join(PUBLIC, lib.file))).toBe(true);
      expect(all).toContain(lib.file);
    }
  });
});
