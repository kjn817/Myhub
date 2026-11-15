// 바탕화면 파일 더블클릭 → 오피스 앱 창이 직접 열리는지 검증한다.
// (2026-11-13 결함 수정 38d30c6의 가드: fileItemsByKey가 init 지역 변수라
// 지연 로드 항목이 조회표에 없어 openFileIcon이 조용히 포기하던 결함.
// 카나리아: main.js의 지연 로드 채우기를 빼면 이 테스트가 실패해야 한다.)
// 2026-11-15 변경: 오피스 파일은 파인더를 거치지 않고 앱으로 직접 연다
// (이전에는 파인더 창이 먼저 떠서 오피스 창 뒤에 남았다).
// 오피스가 아닌 파일(이미지)은 파인더 자체가 뷰어라 파인더가 뜬다.
// 원본: .scratch/perf4/probe-desktop-open-file.cjs, probe-desktop-open-pdf.cjs
'use strict';

const { runScenario, waitForDesktop, attachErrorCollector, assert, assertEq } = require('./harness.cjs');

const FILES = [
  { id: 101, filename: '2026 서울특별시 공모휴.pdf', mime: 'application/pdf', folder_id: 1, size: 12345, created_at: '2026-11-13T00:00:00Z', version: 1 },
  { id: 102, filename: '1.서울특별시청 부설주차장.hwp', mime: 'application/x-hwp', folder_id: 1, size: 23456, created_at: '2026-11-13T00:00:00Z', version: 1 },
  { id: 103, filename: '사진.png', mime: 'image/png', folder_id: 1, size: 12345, created_at: '2026-11-13T00:00:00Z', version: 1 },
];

async function openAndCheck(t, browser, base, fileId, appKey) {
  const { page } = await t.newPage(browser);
  const errors = attachErrorCollector(page);
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await waitForDesktop(page);
  await page.waitForSelector('.dt-desk-icon.is-file', { timeout: 15000 });
  await page.waitForTimeout(800);
  const icons = await page.evaluate(() => [...document.querySelectorAll('.dt-desk-icon.is-file')].map((el) => el.dataset.fileId));
  assert(icons.includes(String(fileId)), `파일 아이콘 ${fileId}가 바탕화면에 없다 (보이는 아이콘: ${icons.join(',')})`);

  await page.locator(`.dt-desk-icon.is-file[data-file-id="${fileId}"]`).dblclick();

  // 오피스 창만 열리고 파인더 창은 열리지 않아야 한다.
  const office = await page.waitForSelector(`.dt-frame[src*="office.html?app=${appKey}"]`, { timeout: 15000 });
  assert(office, `오피스(${appKey}) iframe이 열리지 않았다`);
  // 파인더가 뜰 시간(구 경로면 즉시 뜸)을 주고 없음을 확인한다.
  await page.waitForTimeout(1500);
  const finderFrames = await page.$$('.dt-frame[src*="finder.html"]');
  assertEq(finderFrames.length, 0, `파인더 창이 열리면 안 된다 (오피스 직접 열기)`);
  const wins = await page.evaluate(() => [...document.querySelectorAll('.dt-window')].map((w) => w.getAttribute('data-module')));
  assert(wins.includes(appKey), `${appKey} 창이 열려야 한다 (열린 창: ${wins.join(',')})`);
  assert(!wins.includes('finder'), `파인더 창이 열리면 안 된다 (열린 창: ${wins.join(',')})`);
  assertEq(errors.pageErrors.length, 0, `페이지 오류가 없어야 한다: ${errors.pageErrors.slice(0, 3).join(' | ')}`);
  await page.context().close();
}

async function openAndCheckFinder(t, browser, base, fileId) {
  const { page } = await t.newPage(browser);
  const errors = attachErrorCollector(page);
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await waitForDesktop(page);
  await page.waitForSelector('.dt-desk-icon.is-file', { timeout: 15000 });
  await page.waitForTimeout(800);
  await page.locator(`.dt-desk-icon.is-file[data-file-id="${fileId}"]`).dblclick();
  // 오피스가 아닌 파일은 파인더가 뷰어라 파인더 창이 열린다.
  const finder = await page.waitForSelector('.dt-frame[src*="finder.html"]', { timeout: 15000 });
  assert(finder, '파인더 iframe이 열리지 않았다');
  const wins = await page.evaluate(() => [...document.querySelectorAll('.dt-window')].map((w) => w.getAttribute('data-module')));
  assert(wins.includes('finder'), `파인더 창이 열려야 한다 (열린 창: ${wins.join(',')})`);
  assertEq(errors.pageErrors.length, 0, `페이지 오류가 없어야 한다: ${errors.pageErrors.slice(0, 3).join(' | ')}`);
  await page.context().close();
}

runScenario('desktop-open-file', async (t) => {
  const { base } = await t.server({ driveFiles: FILES });
  const browser = await t.browser();
  await openAndCheck(t, browser, base, 102, 'hangul');
  await openAndCheck(t, browser, base, 101, 'pdf');
  await openAndCheckFinder(t, browser, base, 103);
});
