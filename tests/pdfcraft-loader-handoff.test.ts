/// <reference types="jest" />
/**
 * pdfcraft 로더 게이트 핸드오프 (2026-11-15).
 *
 * 배경: 23MB WASM 조각은 HTTP 캐시에 남지 않아(실측: 동일 문서
 * 재-fetch도 transferSize 전문) 부팅 게이트가 받아도 로더가 47MB를
 * 다시 받았다. 그래서 호스트가 게이트에서 모은 조각 바이트를 Blob
 * URL로 바꿔 iframe src 쿼리(wasmPart0/wasmPart1)로 넘기고, 로더는
 * 쿼리가 있으면 그 URL을 fetch한다.
 *
 * 검증 성질:
 * - 패키징 스크립트의 로더 템플릿이 wasmPart0/wasmPart1 쿼리를 읽어
 *   파트 URL로 쓴다 (다음 패키징 때 핸드오프가 유지돼야 한다).
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
 * 카나리아: 템플릿에서 wasmPart0 폴백을 빼면 첫 테스트가, 벤더본에서
 * 빼면 두 번째 테스트가 실패한다.
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

describe('pdfcraft 로더 게이트 핸드오프', () => {
  test('패키징 템플릿이 wasmPart 쿼리를 읽어 파트 URL로 쓴다', () => {
    expect(TEMPLATE).toContain('new URLSearchParams(location.search)');
    expect(TEMPLATE).toContain("PART_PARAMS.get('wasmPart0') || './${part0}'");
    expect(TEMPLATE).toContain("PART_PARAMS.get('wasmPart1') || './${part1}'");
  });

  test('벤더본 loader.js가 템플릿과 같은 핸드오프를 한다', () => {
    expect(LOADER).toContain('new URLSearchParams(location.search)');
    expect(LOADER).toContain("PART_PARAMS.get('wasmPart0')");
    expect(LOADER).toContain("PART_PARAMS.get('wasmPart1')");
  });

  test('쿼리가 없으면 상대경로 파트 URL로 폴백한다', () => {
    expect(LOADER).toMatch(
      /get\('wasmPart0'\) \|\| '\.\/pdfcraft-web-.*_bg\.wasm\.part0'/,
    );
    expect(LOADER).toMatch(
      /get\('wasmPart1'\) \|\| '\.\/pdfcraft-web-.*_bg\.wasm\.part1'/,
    );
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
