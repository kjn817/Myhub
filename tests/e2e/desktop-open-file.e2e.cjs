// 바탕화면 파일 더블클릭 → 파인더 + 오피스 앱 창이 열리는지 검증한다.
// (2026-11-13 결함 수정 38d30c6의 가드: fileItemsByKey가 init 지역 변수라
// 지연 로드 항목이 조회표에 없어 openFileIcon이 조용히 포기하던 결함.
// 카나리아: main.js의 지연 로드 채우기를 빼면 이 테스트가 실패해야 한다.)
// 원본: .scratch/perf4/probe-desktop-open-file.cjs, probe-desktop-open-pdf.cjs
'use strict';

const { runScenario, waitForDesktop, attachErrorCollector, assert, assertEq } = require('./harness.cjs');

const FILES = [
  { id: 101, filename: '2026 서울특별시 공모휴.pdf', mime: 'application/pdf', folder_id: 1, size: 12345, created_at: '2026-11-13T00:00:00Z', version: 1 },
  { id: 102, filename: '1.서울특별시청 부설주차장.hwp', mime: 'application/x-hwp', folder_id: 1, size: 23456, created_at: '2026-11-13T00:00:00Z', version: 1 },
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

  // 파인더 창과 오피스 창이 둘 다 열려야 한다.
  await page.waitForSelector('.dt-frame[src*="finder.html"]', { timeout: 15000 });
  const office = await page.waitForSelector(`.dt-frame[src*="office.html?app=${appKey}"]`, { timeout: 15000 });
  assert(office, `오피스(${appKey}) iframe이 열리지 않았다`);
  const wins = await page.evaluate(() => [...document.querySelectorAll('.dt-window')].map((w) => w.getAttribute('data-module')));
  assert(wins.length >= 2, `창이 2개 이상 열려야 한다 (열린 창: ${wins.join(',')})`);
  assert(wins.includes('finder'), `파인더 창이 열려야 한다 (열린 창: ${wins.join(',')})`);
  assert(wins.includes(appKey), `${appKey} 창이 열려야 한다 (열린 창: ${wins.join(',')})`);
  assertEq(errors.pageErrors.length, 0, `페이지 오류가 없어야 한다: ${errors.pageErrors.slice(0, 3).join(' | ')}`);
  await page.context().close();
}

runScenario('desktop-open-file', async (t) => {
  const { base } = await t.server({ driveFiles: FILES });
  const browser = await t.browser();
  await openAndCheck(t, browser, base, 102, 'hangul');
  await openAndCheck(t, browser, base, 101, 'pdf');
});
