// 일정 앱 높이 채움 검증: 창 높이에 달력이 딱 맞게 늘어나는지 실브라우저로 잰다.
// (2026-11-13 수정 22e6de3의 가드: 최대화 시 달력 아래가 텅 비던 문제.
// ≥900px에서 flex 체인으로 그리드가 남는 높이를 채우고, 주 행이 균등 분배된다.)
// 원본: .scratch/perf4/probe-schedule-fill.cjs
// 기준값 (부모 실측): 3개 창 크기 모두 하단 간격 24px·주 행 균등
// (1920x1040: 144px, 1440x900: 121px, 1024x700: 88px), 짧은 창(500px)은
// 셀 최소 84px 유지 + 스크롤.
'use strict';

const { runScenario, assert, assertNear } = require('./harness.cjs');

async function measureMonth(page, label) {
  await page.waitForSelector('#calGrid .cal-cell', { timeout: 15000 });
  await page.waitForTimeout(400);
  return page.evaluate((lbl) => {
    const grid = document.getElementById('calGrid');
    const g = grid.getBoundingClientRect();
    const dows = [...grid.querySelectorAll('.cal-dow')];
    const cells = [...grid.querySelectorAll('.cal-cell')];
    const rows = {};
    for (const c of cells) {
      const r = c.getBoundingClientRect();
      const key = Math.round(r.top);
      if (!rows[key]) rows[key] = [];
      rows[key].push(Math.round(r.height));
    }
    const rowHeights = Object.values(rows).map((hs) => hs[0]);
    const wrap = document.querySelector('.wrap').getBoundingClientRect();
    return {
      label: lbl,
      viewportH: window.innerHeight,
      viewportW: window.innerWidth,
      gapBelow: Math.round(window.innerHeight - g.bottom),
      gridWidth: Math.round(g.width),
      // 기대 너비: 뷰포트 - wrap 패딩 80 - 우측 패널 380 - 간격 48.
      expectedGridW: window.innerWidth - 80 - 380 - 48,
      dowH: dows.length ? Math.round(dows[0].getBoundingClientRect().height) : null,
      weekRows: rowHeights.length,
      rowHeights,
      pageScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    };
  }, label);
}

function checkMonthFill(m) {
  assertNear(m.gapBelow, 24, 2, `${m.label}: 달력 하단 간격이 24px 근처여야 한다`);
  assert(m.weekRows >= 5, `${m.label}: 주 행이 5개 이상이어야 한다 (실제: ${m.weekRows})`);
  const spread = Math.max(...m.rowHeights) - Math.min(...m.rowHeights);
  assert(spread <= 1, `${m.label}: 주 행 높이가 균등해야 한다 (행 높이: ${m.rowHeights.join(',')})`);
  assertNear(m.gridWidth, m.expectedGridW, 2, `${m.label}: 그리드 너비가 기대값과 맞아야 한다`);
  assert(m.dowH !== null && m.dowH <= 40, `${m.label}: 요일 행은 늘어나지 않아야 한다 (실제: ${m.dowH}px)`);
  assert(m.rowHeights[0] > m.dowH, `${m.label}: 주 행이 요일 행보다 커야 한다`);
  assert(!m.pageScrolls, `${m.label}: 페이지는 스크롤되지 않아야 한다`);
  console.log(`  ${m.label}: gap ${m.gapBelow}px, rows ${m.weekRows} x ${m.rowHeights[0]}px, gridW ${m.gridWidth}`);
}

runScenario('schedule-fill', async (t) => {
  const { base } = await t.server();
  const browser = await t.browser();

  for (const [w, h] of [[1920, 1040], [1440, 900], [1024, 700]]) {
    const { page } = await t.newPage(browser, { width: w, height: h });
    await page.goto(`${base}/schedule.html`, { waitUntil: 'load', timeout: 30000 });
    checkMonthFill(await measureMonth(page, `month ${w}x${h}`));
    if (w === 1920) {
      await page.click('.vs-btn[data-view="week"]');
      await page.waitForTimeout(500);
      const wk = await page.evaluate(() => {
        const g = document.getElementById('weekGrid').getBoundingClientRect();
        return { gapBelow: Math.round(window.innerHeight - g.bottom) };
      });
      assertNear(wk.gapBelow, 24, 2, 'week 1920x1040: 주 뷰 하단 간격이 24px 근처여야 한다');
      await page.click('.vs-btn[data-view="day"]');
      await page.waitForTimeout(500);
      const dy = await page.evaluate(() => {
        const g = document.getElementById('dayView').getBoundingClientRect();
        return { gapBelow: Math.round(window.innerHeight - g.bottom) };
      });
      assertNear(dy.gapBelow, 24, 2, 'day 1920x1040: 일 뷰 하단 간격이 24px 근처여야 한다');
      console.log(`  week/day 1920x1040: gap ${wk.gapBelow}/${dy.gapBelow}px`);
    }
    await page.context().close();
  }

  // 짧은 창: 셀 최소 높이가 지켜지고 페이지가 스크롤로 빠진다.
  const { page } = await t.newPage(browser, { width: 1440, height: 500 });
  await page.goto(`${base}/schedule.html`, { waitUntil: 'load', timeout: 30000 });
  const short = await measureMonth(page, 'month 1440x500 (short)');
  assert(short.pageScrolls, '짧은 창(500px)에서는 페이지가 스크롤되어야 한다');
  const minRow = Math.min(...short.rowHeights);
  assert(minRow >= 83, `짧은 창에서도 셀 최소 높이 84px가 지켜져야 한다 (실제 최소: ${minRow}px)`);
  console.log(`  short 1440x500: scrolls, min row ${minRow}px`);
});
