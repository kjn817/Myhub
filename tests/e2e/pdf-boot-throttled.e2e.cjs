// 스로틀링 PDF 부팅 검증: 400KB/s 회선에서 47MB PdfCraft 엔진을
// 프리패치 게이트로 데운 뒤 오피스 앱이 메뉴까지 열리는지 검증한다.
// (2026-11-15 부팅 강건화의 PDF 적용 — 1dc37bf가 한글·PPT·엑셀만
// 커버하고 PDF는 45초 고정 워치독이 남아, 느린 네트워크에서 메뉴
// 없는 뷰어로 폴백했다.)
// 단언:
//  1) 부팅 중 상태 표시줄에 'PDF 엔진 받는 중… XMB' 진행이 보인다.
//  2) wasm 파트(.part0/.part1)가 실제로 다운로드된다 (게이트가 돈다).
//  3) 결국 메뉴 6개(파일·편집·보기·서명·창·도움말)가 셸 탭에 뜬다.
//  4) 페이지 오류가 없다.
//  5) 두 번째 부팅(페이지 리로드 후 다시 열기)은 CacheStorage에서
//     파트를 읽어 60초 안에 메뉴가 뜨고, 파트 네트워크 요청이
//     늘어나지 않는다 (재다운로드 없음).
// 카나리아: 게이트를 빼고 iframe src를 즉시 붙이면(구 코드) 45초
// 워치독이 터져 뷰어로 폴백하고 3)이 실패한다 — 47MB는 400KB/s에서
// 약 120초가 걸리므로 45초 안에 ready가 올 수 없다. Blob URL
// 핸드오프를 빼면 로더가 47MB를 다시 받아 3)이 실패하고,
// CacheStorage 저장을 빼면 5)의 파트 요청 수가 늘어난다.
'use strict';

const { runScenario, waitForDesktop, throttleNetwork, attachErrorCollector, assert, assertEq } = require('./harness.cjs');

const FILES = [
  { id: 101, filename: '2026 서울특별시 공모휴.pdf', mime: 'application/pdf', folder_id: 1, size: 12345, created_at: '2026-11-13T00:00:00Z', version: 1 },
];

const EXPECTED_MENUS = ['파일', '편집', '보기', '서명', '창', '도움말'];

runScenario('pdf-boot-throttled', async (t) => {
  const { base } = await t.server({ driveFiles: FILES });
  const browser = await t.browser();
  const { ctx, page } = await t.newPage(browser);
  const errors = attachErrorCollector(page);
  // 스로틀링(400KB/s): 47MB 엔진은 약 120초 — 구 45초 워치독이면 실패한다.
  await throttleNetwork(ctx, page);
  const partRequests = { part0: 0, part1: 0 };
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('_bg.wasm.part0')) partRequests.part0 += 1;
    if (u.includes('_bg.wasm.part1')) partRequests.part1 += 1;
  });
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await waitForDesktop(page);
  await page.waitForSelector('.dt-desk-icon.is-file', { timeout: 30000 });
  await page.waitForTimeout(800);
  await page.locator('.dt-desk-icon.is-file[data-file-id="101"]').dblclick();
  const office = await page.waitForSelector('.dt-frame[src*="office.html?app=pdf"]', { timeout: 30000 });
  const frame = await office.contentFrame();
  console.log('  office iframe opened, polling for boot progress + menus...');

  // 진행 표시와 메뉴를 폴링한다 (최대 270초). 상태 텍스트는
  // textContent로 읽는다 — 3.6초 뒤 hidden이 되지만 텍스트는 남는다.
  const t0 = Date.now();
  let progressSeen = false;
  let maxMb = 0;
  let menus = [];
  while (Date.now() - t0 < 270000) {
    const status = await frame.evaluate(() => {
      const el = document.querySelector('#fvStatus');
      return el ? el.textContent || '' : '';
    }).catch(() => '');
    const m = status.match(/PDF 엔진 받는 중…\s*([\d.]+)MB/);
    if (m) {
      progressSeen = true;
      maxMb = Math.max(maxMb, parseFloat(m[1]));
    }
    menus = await page.evaluate(() =>
      [...document.querySelectorAll('#dt-office-tabs .dt-office-tab')].map((b) => (b.textContent || '').trim()),
    );
    if (menus.length >= EXPECTED_MENUS.length) break;
    if ((Date.now() - t0) % 30000 < 1200) {
      console.log(`  +${Math.round((Date.now() - t0) / 1000)}s status=${JSON.stringify(status.slice(0, 60))} menus=${menus.length} parts=${partRequests.part0}/${partRequests.part1}`);
    }
    await page.waitForTimeout(1000);
  }
  const elapsedS = Math.round((Date.now() - t0) / 1000);
  console.log(`  done in ${elapsedS}s: progressSeen=${progressSeen} maxMb=${maxMb} menus=${JSON.stringify(menus)} parts=${partRequests.part0}/${partRequests.part1}`);
  assert(progressSeen, '부팅 중 "PDF 엔진 받는 중… XMB" 진행 표시가 보여야 한다');
  assert(maxMb >= 10, `진행 표시가 최소 10MB까지 올라가야 한다 (실제: ${maxMb}MB)`);
  assert(partRequests.part0 >= 1 && partRequests.part1 >= 1, `wasm 파트가 둘 다 다운로드돼야 한다 (실제: ${partRequests.part0}/${partRequests.part1})`);
  assertEq(menus.length, EXPECTED_MENUS.length, `메뉴 ${EXPECTED_MENUS.length}개가 떠야 한다 (실제: ${JSON.stringify(menus)})`);
  EXPECTED_MENUS.forEach((label) => {
    assert(menus.includes(label), `메뉴에 "${label}"이 있어야 한다 (실제: ${JSON.stringify(menus)})`);
  });
  assertEq(errors.pageErrors.length, 0, `페이지 오류가 없어야 한다: ${errors.pageErrors.slice(0, 3).join(' | ')}`);

  // 두 번째 부팅: 페이지를 리로드하고 PDF를 다시 연다. 파트는
  // CacheStorage에 있으므로 네트워크를 안 타고 수 초 안에 메뉴가
  // 떠야 한다 (스로틀링은 그대로 유지된다).
  const partsAfterFirst = { ...partRequests };
  console.log(`  first boot done (${elapsedS}s), reloading for second boot (parts so far: ${partsAfterFirst.part0}/${partsAfterFirst.part1})...`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForDesktop(page);
  await page.waitForSelector('.dt-desk-icon.is-file', { timeout: 30000 });
  await page.waitForTimeout(800);
  await page.locator('.dt-desk-icon.is-file[data-file-id="101"]').dblclick();
  const office2 = await page.waitForSelector('.dt-frame[src*="office.html?app=pdf"]', { timeout: 30000 });
  await office2.contentFrame();
  const t2 = Date.now();
  let menus2 = [];
  while (Date.now() - t2 < 60000) {
    menus2 = await page.evaluate(() =>
      [...document.querySelectorAll('#dt-office-tabs .dt-office-tab')].map((b) => (b.textContent || '').trim()),
    );
    if (menus2.length >= EXPECTED_MENUS.length) break;
    await page.waitForTimeout(1000);
  }
  const elapsed2S = Math.round((Date.now() - t2) / 1000);
  console.log(`  second boot in ${elapsed2S}s: menus=${JSON.stringify(menus2)} parts=${partRequests.part0}/${partRequests.part1}`);
  assertEq(menus2.length, EXPECTED_MENUS.length, `두 번째 부팅도 메뉴 ${EXPECTED_MENUS.length}개가 떠야 한다 (실제: ${JSON.stringify(menus2)})`);
  assertEq(
    partRequests.part0, partsAfterFirst.part0,
    `두 번째 부팅은 part0을 다시 받으면 안 된다 (전: ${partsAfterFirst.part0}, 후: ${partRequests.part0})`,
  );
  assertEq(
    partRequests.part1, partsAfterFirst.part1,
    `두 번째 부팅은 part1을 다시 받으면 안 된다 (전: ${partsAfterFirst.part1}, 후: ${partRequests.part1})`,
  );
  assertEq(errors.pageErrors.length, 0, `페이지 오류가 없어야 한다: ${errors.pageErrors.slice(0, 3).join(' | ')}`);
}, { timeoutMs: 300000 });
