/// <reference types="jest" />
/**
 * pdfcraft 로더 게이트 핸드오프 (2026-11-15).
 *
 * 배경: 큰 WASM 조각은 HTTP 캐시에 남지 않아(실측: 동일 문서
 * 재-fetch도 transferSize 전문) 부팅 게이트가 받아도 로더가 WASM
 * 전문을 다시 받았다. 그래서 호스트가 게이트에서 모은 조각 바이트를
 * Blob URL로 바꿔 iframe src 쿼리(wasmPart0..wasmPartN)로 넘기고,
 * 로더는 쿼리가 있으면 그 URL을 fetch한다.
 *
 * 파트 개수는 가변이다 (v0.22.0부터 3개 — WASM 54MB라 2분할로는
 * 25MB 한도를 넘는다). 로더는 매니페스트를 안 읽으므로 파트 목록이
 * 패키징 시점에 리터럴로 박힌다. 이 테스트는 매니페스트 wasmParts를
 * 기준으로 삼아 개수와 무관하게 핸드오프를 검증한다.
 *
 * 검증 성질:
 * - 패키징 스크립트가 파트마다 wasmPart<i> 쿼리 줄을 생성한다
 *   (다음 패키징 때 핸드오프가 유지돼야 한다).
 * - 벤더본 loader.js가 템플릿과 같은 핸드오프를 한다 — 둘이 어긋나면
 *   다음 리베이스·패키징 때 수정이 한쪽에서만 사라진다.
 * - 쿼리가 없으면 상대경로 파트 URL로 폴백한다 (직접 열기·구 호스트
 *   하위호환 — 쿼리 없이는 엔진이 안 뜨면 안 된다).
 * - fetch/init 실패를 부모에 pdfcraft:failed로 보고한다 (2026-11-21):
 *   보고 없이는 호스트가 45초 워치독까지 기다렸다가 원인도 모른 채
 *   폴백만 했다. 보고를 받으면 호스트가 Blob 없이 재시도한다.
 *
 * 로더 자체의 동작(Blob URL fetch → init)은 실브라우저 e2e
 * (tests/e2e/pdf-boot-throttled.e2e.cjs)가 검증한다 — 로더는
 * top-level await + 글루 import라 jsdom에서 직접 실행할 수 없다.
 * 이 파일은 템플릿·벤더본 드리프트를 잡는 것이 목적이다.
 *
 * 카나리아: 템플릿에서 파트 줄 생성기를 빼면 첫 테스트가, 벤더본에서
 * 파트 줄을 빼면 두 번째·세 번째 테스트가 실패한다.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE = fs.readFileSync(
  path.join(ROOT, 'scripts/build-pdfcraft-package.mjs'),
  'utf-8',
);
const LOADER = fs.readFileSync(
  path.join(ROOT, 'public/vendor/pdfcraft/loader.js'),
  'utf-8',
);
const MANIFEST = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'public/vendor/pdfcraft/manifest.json'),
    'utf-8',
  ),
) as { wasmParts: string[]; wasmPartBytes: number[] };
const PART_NAMES = MANIFEST.wasmParts;

describe('pdfcraft 로더 게이트 핸드오프', () => {
  test('패키징 템플릿이 파트마다 wasmPart 쿼리 줄을 생성한다', () => {
    expect(TEMPLATE).toContain('new URLSearchParams(location.search)');
    // 파트 줄은 parts 배열에서 생성된다 — 리터럴 2줄 고정이 아니다.
    // 쿼리 값은 partFromQuery가 blob:만 받아들이고 나머지는 상대
    // 경로로 폴백한다 (2026-11-25) — 임의 URL fetch로 공격자 WASM이
    // 같은 출처 iframe에서 실행되는 경로를 막는다.
    expect(TEMPLATE).toContain("partFromQuery(${i}, './${p}')");
    expect(TEMPLATE).toContain('partLines');
    expect(TEMPLATE).toContain('function partFromQuery');
    expect(TEMPLATE).toContain("v.indexOf('blob:') === 0");
    // 파트당 상한이 있어 한도를 넘는 벤더가 조용히 안 만들어진다.
    expect(TEMPLATE).toContain('MAX_PART_BYTES');
  });

  test('벤더본 loader.js가 매니페스트의 모든 파트에 핸드오프를 한다', () => {
    expect(PART_NAMES.length).toBeGreaterThanOrEqual(2);
    expect(LOADER).toContain('new URLSearchParams(location.search)');
    expect(LOADER).toContain('function partFromQuery');
    for (let i = 0; i < PART_NAMES.length; i++) {
      expect(LOADER).toContain(
        `partFromQuery(${i}, './${PART_NAMES[i]}')`,
      );
    }
  });

  test('쿼리가 없으면 상대경로 파트 URL로 폴백한다', () => {
    for (let i = 0; i < PART_NAMES.length; i++) {
      const name = PART_NAMES[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(LOADER).toMatch(
        new RegExp(`partFromQuery\\(${i}, '\\./${name}'\\)`),
      );
    }
  });

  test('쿼리 파트 URL은 blob:만 허용하고 그 외는 폴백한다', () => {
    // 가드 로직이 템플릿·벤더본 양쪽에 있어야 다음 패키징 때 사라지지
    // 않는다. 쿼리 값을 직접 읽는 곳은 헬퍼 안 단 한 곳이어야 한다 —
    // 다른 곳에서 PART_PARAMS.get을 쓰면 가드를 우회한다.
    for (const src of [TEMPLATE, LOADER]) {
      expect(src).toContain("v.indexOf('blob:') === 0");
      expect(src).toContain("PART_PARAMS.get('wasmPart' + i)");
      expect(src.match(/PART_PARAMS\.get\(/g)?.length).toBe(1);
    }
    // 동작 검증은 실브라우저 e2e(tests/e2e/pdfcraft-loader-query-guard.e2e.cjs)가
    // 맡는다 — 악성 쿼리를 넣고 부팅해도 상대 경로 파트로 떠야 한다.
  });

  test('매니페스트 파트 길이가 25MB 한도 아래다', () => {
    expect(MANIFEST.wasmPartBytes.length).toBe(PART_NAMES.length);
    for (const n of MANIFEST.wasmPartBytes) {
      expect(n).toBeLessThan(25_000_000);
    }
  });

  test('템플릿과 벤더본이 fetch/init 실패를 pdfcraft:failed로 보고한다', () => {
    // 보고가 한쪽에서만 빠지면 다음 패키징 때 사라진다 — 둘 다 본다.
    for (const src of [TEMPLATE, LOADER]) {
      expect(src).toContain('reportFailure');
      expect(src).toContain("parent.postMessage({ type: 'pdfcraft:failed'");
      expect(src).toContain('} catch (e) {');
    }
  });

  test('글루는 try 안에서 동적 import한다 (정적 import 실패는 보고가 안 된다)', () => {
    // 정적 import 실패(손상된 캐시 글루·404)는 모듈 로딩 단계에서 죽어
    // try/catch에 안 잡히고 보고도 없어 45초 워치독만 터졌다 (사용자
    // 실화면 '엔진 시작 시간 초과'). 동적 import면 실패가 보고된다.
    for (const src of [TEMPLATE, LOADER]) {
      expect(src).not.toContain('import init, * as bindings from');
      expect(src).toMatch(/const bindings = await import\('\.\//);
      // 동적 import가 try 블록 안에 있어야 catch가 잡는다. 템플릿 파일
      // (build-pdfcraft-package.mjs)에는 로더 외의 try/catch도 있어
      // import 기준으로 앞뒤를 잡는다.
      const importIdx = src.indexOf('await import(');
      const tryIdx = src.lastIndexOf('try {', importIdx);
      const catchIdx = src.indexOf('} catch (e) {', importIdx);
      expect(importIdx).toBeGreaterThanOrEqual(0);
      expect(tryIdx).toBeGreaterThanOrEqual(0);
      expect(tryIdx).toBeLessThan(importIdx);
      expect(catchIdx).toBeGreaterThan(importIdx);
    }
  });

  test('동적 import한 글루의 default를 init으로 쓴다', () => {
    for (const src of [TEMPLATE, LOADER]) {
      expect(src).toContain('bindings.default({ module_or_path: bytes })');
      expect(src).toContain('window.wasmBindings = bindings;');
    }
  });
});
