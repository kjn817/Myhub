// 미션 종료 시 합성 mouseenter로 오피스 프리패치가 시작되지 않는지 검증
// (2026-11-18 미션 종료 회귀 — missionClose p95 83.2ms).
//
// 원인 (LoAF 실측): 미션 종료 finalize가 dt-mission-open을 떼면 숨겨졌던
// 바탕화면 아이콘이 고정된 마우스 아래에 다시 나타나고, 브라우저가
// mouseenter를 쏜다. 그 자리에 오피스 아이콘이 있으면 호버 프리패치가
// 시작돼 18~47MB drain이 메인 스레드를 90~150ms씩 막았다.
// 단언:
//  1) 미션 중 마우스를 Excel 아이콘 자리에 두고 닫으면, 엔진 프리패치
//     요청(/vendor/gridcraft|deckcraft|pdfcraft/)이 0건이다.
//  2) 그 뒤 진짜로 마우스를 움직여 Excel 아이콘에 호버하면 프리패치가
//     돈다 (gridcraft index.html 요청 — 게이트가 진짜 호버를 막으면 안 된다).
//  3) 두 구간 모두 페이지 오류가 없다.
// 카나리아: 게이트(200ms mousemove 신선도)를 빼면 1)이 실패한다 —
// 구 코드에서는 닫은 뒤 300ms에 프리패치가 시작돼 gridcraft 요청이 보인다.
'use strict';

const { runScenario, waitForDesktop, attachErrorCollector, assert, assertEq } = require('./harness.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ENGINE_RE = /\/vendor\/(gridcraft|deckcraft|pdfcraft|rhwp-studio)\//;

runScenario('mission-close-no-prefetch', async (t) => {
  const { base } = await t.server();
  const browser = await t.browser();
  const { page } = await t.newPage(browser);
  const errors = attachErrorCollector(page);
  const requested = [];
  page.on('request', (req) => requested.push({ t: Date.now(), url: req.url() }));
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await waitForDesktop(page);

  // 창 3개 + 스페이스 3개 (새벽 측정 하네스와 동일 구성).
  await page.evaluate(() => {
    window.MyHubDesktop.openModule('memo');
    window.MyHubDesktop.openModule('schedule');
    window.MyHubDesktop.openModule('todo');
  });
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    window.MyHubDesktop.addSpace();
    window.MyHubDesktop.addSpace();
    window.MyHubDesktop.switchSpace(1);
  });
  await page.waitForTimeout(1000);

  // 전제: Excel 바탕화면 아이콘이 실제로 보여야 한다.
  const excelBox = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.dt-desk-icon')].find((n) =>
      (n.textContent || '').includes('Excel'),
    );
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  });
  assert(excelBox, 'Excel 바탕화면 아이콘이 보여야 한다');
  console.log(`  excel icon at (${excelBox.x.toFixed(0)}, ${excelBox.y.toFixed(0)})`);

  // 미션 열기 — 아이콘이 숨겨진다.
  await page.evaluate(() => window.MyHubDesktop.toggleMission());
  await page.waitForTimeout(900);
  const missionState = await page.evaluate(() => ({
    open: window.MyHubDesktop.isMissionOpen(),
    iconsVisibility: getComputedStyle(document.querySelector('#dt-icons')).visibility,
  }));
  assert(missionState.open, '미션이 열려 있어야 한다');
  assertEq(missionState.iconsVisibility, 'hidden', '미션 중에는 아이콘이 숨겨져야 한다');

  // 마우스를 Excel 아이콘 자리로 옮기고 600ms 가만히 둔다 — 마우스는
  // 움직이지 않았는데 finalize(+280ms)가 아이콘을 다시 보이게 하면
  // 합성 mouseenter가 오는 상황이다.
  await page.mouse.move(excelBox.x, excelBox.y, { steps: 10 });
  await page.waitForTimeout(600);

  // ── 1) 미션 닫기 (마우스 움직임 없이) — 엔진 프리패치 0건 ──
  const closeAt = Date.now();
  await page.evaluate(() => window.MyHubDesktop.toggleMission());
  await page.waitForTimeout(2500);
  const closed = await page.evaluate(() => window.MyHubDesktop.isMissionOpen());
  assert(!closed, '미션이 닫혀 있어야 한다');
  const afterClose = requested.filter((r) => r.t >= closeAt && ENGINE_RE.test(r.url));
  console.log(`  engine requests after close: ${afterClose.length}`);
  assertEq(afterClose.length, 0, '미션 종료 뒤 엔진 프리패치 요청이 없어야 한다 (합성 mouseenter)');

  // ── 2) 진짜 호버 — 프리패치가 돌아야 한다 (긍정 대조) ──
  await page.mouse.move(200, 800, { steps: 10 });
  await page.waitForTimeout(300);
  await page.mouse.move(excelBox.x, excelBox.y, { steps: 10 });
  const hoverAt = Date.now();
  // 프리패치는 index.html 발견부터 시작한다 — 5초 안에 와야 한다.
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    if (requested.some((r) => r.t >= hoverAt && /\/vendor\/gridcraft\/index\.html/.test(r.url))) break;
    await sleep(100);
  }
  const gridIndex = requested.filter((r) => r.t >= hoverAt && /\/vendor\/gridcraft\/index\.html/.test(r.url));
  console.log(`  gridcraft index.html after genuine hover: ${gridIndex.length}`);
  assert(gridIndex.length >= 1, '진짜 호버에서는 gridcraft 프리패치가 돌아야 한다');

  // ── 3) 페이지 오류 없음 (기존 e2e와 같이 pageErrors만 본다 —
  // favicon 등 하네스 404 콘솔 로그는 제외) ──
  assertEq(errors.pageErrors.length, 0, `페이지 오류가 없어야 한다: ${errors.pageErrors.join(' | ')}`);
});
