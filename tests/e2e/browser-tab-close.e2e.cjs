// 탭 닫기 버튼 실브라우저 검증 (사용자 보고 2026-11-20: 탭 우측 X를
// 눌러도 탭이 안 꺼진다). 원인: 3단계 드래그의 setPointerCapture가
// pointerup을 탭 버튼으로 다시 겨냥해 click 타깃이 닫기 span이 아니라
// 탭 버튼이 되고, 탭만 활성화됐다. jsdom은 포인터 캡처의 click
// 재겨냥을 재현하지 못하므로 이 회귀는 실브라우저로만 잡힌다.
'use strict';

const { runScenario, attachErrorCollector, assert, assertEq } = require('./harness.cjs');

const SEED = {
  tabs: [
    { id: 't1', url: 'https://www.naver.com', history: ['https://www.naver.com'], hIndex: 0, remoteTargetId: null, title: null, pinned: false },
    { id: 't2', url: 'https://www.google.com', history: ['https://www.google.com'], hIndex: 0, remoteTargetId: null, title: null, pinned: false },
    { id: 't3', url: 'https://github.com', history: ['https://github.com'], hIndex: 0, remoteTargetId: null, title: null, pinned: false },
  ],
  activeTabId: 't2',
};

runScenario('browser-tab-close', async (t) => {
  const { base } = await t.server({});
  const browser = await t.browser();
  const { page } = await t.newPage(browser, { width: 1440, height: 900 });
  const errors = attachErrorCollector(page);
  await page.addInitScript((seed) => {
    window.localStorage.setItem('myhub.browser.tabs.v1', JSON.stringify(seed));
  }, SEED);
  await page.goto(`${base}/browser.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('.bw-tab').length === 3, { timeout: 10000 });

  const tabNames = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('.bw-tab .bw-tab-name')).map((el) => el.textContent),
    );
  const activeName = () =>
    page.evaluate(() => {
      const el = document.querySelector('.bw-tab.is-active .bw-tab-name');
      return el ? el.textContent : null;
    });
  const storedIds = () =>
    page.evaluate(() =>
      JSON.parse(window.localStorage.getItem('myhub.browser.tabs.v1')).tabs.map((x) => x.id),
    );
  const closeCenter = (index) =>
    page.evaluate((i) => {
      const el = document.querySelectorAll('.bw-tab')[i].querySelector('.bw-tab-close');
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, index);

  // 1. 비활성 탭(naver)의 X를 실제 마우스로 클릭하면 탭이 닫히고,
  //    활성 탭(google)은 그대로 유지된다.
  const c0 = await closeCenter(0);
  await page.mouse.click(c0.x, c0.y);
  await new Promise((r) => setTimeout(r, 400));
  assertEq((await tabNames()).join(','), 'google.com,github.com', '비활성 탭 X 클릭 후 탭 목록');
  assertEq(await activeName(), 'google.com', '비활성 탭을 닫아도 활성 탭 유지');
  assertEq((await storedIds()).join(','), 't2,t3', '닫힌 탭이 저장소에서도 제거된다');

  // 2. 활성 탭(google)의 X를 클릭하면 탭이 닫히고 이웃 탭이 활성화된다.
  const c1 = await closeCenter(0);
  await page.mouse.click(c1.x, c1.y);
  await new Promise((r) => setTimeout(r, 400));
  assertEq((await tabNames()).join(','), 'github.com', '활성 탭 X 클릭 후 탭 목록');
  assertEq(await activeName(), 'github.com', '활성 탭을 닫으면 이웃 탭이 활성화된다');
  assertEq((await storedIds()).join(','), 't3', '활성 탭 닫기가 저장소에 반영된다');

  assertEq(errors.pageErrors.length, 0, `페이지 오류가 없어야 한다: ${errors.pageErrors.slice(0, 3).join(' | ')}`);
  assert(errors.httpErrors.length === 0, `HTTP 오류가 없어야 한다: ${errors.httpErrors.slice(0, 3).join(' | ')}`);
});
