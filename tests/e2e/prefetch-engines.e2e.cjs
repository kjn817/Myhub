// Finder 노출 시 엔진 프리패치 1회 + office.html 자동 실행 금지 검증 (F-L1 통합, 5-1).
// 단언:
//  1) Finder 목록에 .pptx가 보이면 deckcraft 프리패치 모듈이 동적 import되고
//     코어(craft-prefetch-core.js)를 먼저 받은 뒤 shell을 받아 자산을 데운다.
//  2) 목록을 다시 불러도 shell 요청은 1회뿐이다 (once 플래그 + 엔진 가드).
//  3) office.html을 직접 열면 프리패치가 자동으로 실행되지 않는다
//     (vendor shell·manifest 요청 0건 — 오피스 서면 게이트).
//  4) 두 서면 모두 페이지 오류가 없다.
// 카나리아: 게이트를 빼면 3)이, once 플래그를 깨면 2)가 실패한다.
'use strict';

const { runScenario, attachErrorCollector, assert, assertEq } = require('./harness.cjs');

const FILES = [
  { id: 201, filename: '분기 보고.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', folder_id: 1, size: 54321, created_at: '2026-11-13T00:00:00Z', version: 1 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function countMatches(urls, re) {
  return urls.filter((u) => re.test(typeof u === 'string' ? u : u.url)).length;
}

// 수집된 요청 목록을 폴링한다 — waitForRequest는 호출 뒤의 요청만
// 보므로, 행 렌더와 동시에 나간 import 요청을 놓칠 수 있다.
async function waitForUrl(requested, re, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (requested.some((r) => re.test(r.url))) return;
    await sleep(100);
  }
  throw new Error(`${label} 요청이 ${timeoutMs}ms 안에 오지 않았다`);
}

runScenario('prefetch-engines', async (t) => {
  const { base } = await t.server({
    driveFiles: FILES,
    // 루트 목록에도 파일을 실어 Finder 첫 화면에서 바로 노출되게 한다
    // (실제 보관함 루트에도 파일이 있을 수 있다 — 스텁이 폴더를 가리지 않는다).
    onApi: async ({ path }) => {
      if (path === '/api/drive/list') {
        return { body: { ok: true, folders: [{ id: 1, name: '바탕화면' }], files: FILES } };
      }
      return null;
    },
  });
  const browser = await t.browser();

  // ── 1) Finder: .pptx 노출 → deck 프리패치 1회 ──
  {
    const { page } = await t.newPage(browser);
    const errors = attachErrorCollector(page);
    const requested = [];
    page.on('request', (req) => requested.push({ url: req.url(), type: req.resourceType() }));
    await page.goto(`${base}/finder.html`, { waitUntil: 'domcontentloaded' });
    // 전제: 목록에 .pptx 행이 실제로 렌더돼야 노출이 의미를 갖는다.
    await page.locator('.finder-row-name', { hasText: '분기 보고.pptx' }).waitFor({ timeout: 15000 });
    // 동적 import → 자동 부팅(idle 또는 load+1500ms) → shell fetch.
    await waitForUrl(requested, /\/js\/deckcraft-prefetch\.js/, 20000, 'deckcraft-prefetch.js 동적 import');
    await waitForUrl(requested, /\/vendor\/deckcraft\/index\.html/, 20000, 'deck shell');
    // 자산 체인이 돌 시간을 주고, 목록을 두 번 다시 불러 재렌더를 유발한다.
    await sleep(1500);
    await page.evaluate(() => {
      window.MyHubFinderApp.loadDrive();
    });
    await sleep(800);
    await page.evaluate(() => {
      window.MyHubFinderApp.loadDrive();
    });
    await sleep(2500);

    const shellCount = countMatches(requested, /\/vendor\/deckcraft\/index\.html/);
    const glueCount = countMatches(requested, /\/vendor\/deckcraft\/deckcraft-web-[^/]+\.js/);
    const wasmCount = countMatches(requested, /\/vendor\/deckcraft\/deckcraft-web-[^/]+_bg\.wasm/);
    const gridShellCount = countMatches(requested, /\/vendor\/gridcraft\/index\.html/);
    const coreCount = countMatches(requested, /\/js\/craft-prefetch-core\.js/);
    console.log(`  finder: shell=${shellCount} glue=${glueCount} wasm=${wasmCount} gridShell=${gridShellCount} core=${coreCount}`);
    assertEq(shellCount, 1, 'deck shell은 1회만 받아야 한다 (재렌더에도 다시 받지 않음)');
    assert(glueCount >= 1, 'deck JS 글루를 받아야 한다 (shell만 받고 체인이 안 돌면 프리패치가 아니다)');
    assert(wasmCount >= 1, 'deck WASM을 받아야 한다');
    assertEq(gridShellCount, 0, '시트 파일이 없는데 grid shell을 받으면 안 된다');
    assert(coreCount >= 1, '코어(craft-prefetch-core.js)를 동적 import로 먼저 받아야 한다');
    assertEq(errors.pageErrors.length, 0, `Finder 페이지 오류가 없어야 한다: ${errors.pageErrors.slice(0, 3).join(' | ')}`);
    await page.context().close();
  }

  // ── 2) office.html: 자동 프리패치 없음 ──
  {
    const { page } = await t.newPage(browser);
    const errors = attachErrorCollector(page);
    const requested = [];
    page.on('request', (req) => requested.push({ url: req.url(), type: req.resourceType() }));
    await page.goto(`${base}/office.html`, { waitUntil: 'domcontentloaded' });
    // 자동 부팅 창(idle 또는 load+1500ms)을 충분히 지나게 기다린다.
    await sleep(4000);
    // 프리패치는 fetch()로 shell·manifest를 받는다. 에디터 iframe 탐색
    // (?host=parent… 쿼리가 붙은 document 타입)은 오피스 앱 자체의
    // 문서 열기라 프리패치가 아니니 구분한다.
    const prefetchFetches = requested.filter(
      (r) =>
        r.type === 'fetch' &&
        /\/vendor\/(deckcraft|gridcraft|pdfcraft)\/(index\.html|manifest\.json)/.test(r.url),
    );
    const docNavs = requested.filter(
      (r) =>
        r.type === 'document' &&
        /\/vendor\/(deckcraft|gridcraft|pdfcraft)\//.test(r.url),
    );
    console.log(`  office: 프리패치 fetch ${prefetchFetches.length}건: ${prefetchFetches.map((r) => r.url).join(', ')}`);
    console.log(`  office: (참고) 에디터 iframe 탐색 ${docNavs.length}건 — 문서 열기라 게이트 대상이 아님`);
    assertEq(prefetchFetches.length, 0, 'office.html에서는 프리패치가 자동으로 실행되면 안 된다 (오피스 서면 게이트)');
    assertEq(errors.pageErrors.length, 0, `오피스 페이지 오류가 없어야 한다: ${errors.pageErrors.slice(0, 3).join(' | ')}`);
    await page.context().close();
  }
});
