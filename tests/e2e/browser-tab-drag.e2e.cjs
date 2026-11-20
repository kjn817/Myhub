// 탭 드래그 순서 변경 실브라우저 검증 (2026-11-20 브라우저 3단계).
// jsdom 테스트는 포인터 이벤트를 직접 디스패치해 로직만 재현한다 —
// 실제 마우스 드래그(포인터 캡처·좌표·리렌더)가 순서 변경까지 이어지는지,
// 드롭 직후 클릭이 탭 전환을 안 하는지(억제 플래그)는 실브라우저로만
// 확인할 수 있다.
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

runScenario('browser-tab-drag', async (t) => {
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

  assertEq((await tabNames()).join(','), 'naver.com,google.com,github.com', '초기 탭 순서');
  assertEq(await activeName(), 'google.com', '초기 활성 탭은 google');

  // 첫 탭(naver)을 세 번째 탭(github) 자리까지 실제 마우스로 드래그한다.
  // 드롭 지점은 github 가운데보다 30px 오른쪽 — 삽입 판정이 형제 탭
  // 가운데를 넘는지를 보므로, 정확히 가운데에 떨구면 경계 조건에 걸린다
  // (실제 사용에선 가운데에 정확히 멈추는 일이 없다).
  const boxes = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.bw-tab')).map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }),
  );
  assertEq(boxes.length, 3, '탭 3개의 좌표');
  await page.mouse.move(boxes[0].x, boxes[0].y);
  await page.mouse.down();
  await page.mouse.move(boxes[2].x + 30, boxes[2].y, { steps: 12 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 400));

  assertEq((await tabNames()).join(','), 'google.com,github.com,naver.com', '드래그 후 탭 순서');
  // 드롭 직후 클릭이 탭을 전환하면 안 된다 (억제 플래그).
  assertEq(await activeName(), 'google.com', '드롭 후에도 활성 탭은 google 유지');
  const stored = await page.evaluate(() => {
    const data = JSON.parse(window.localStorage.getItem('myhub.browser.tabs.v1'));
    return data.tabs.map((tb) => tb.id).join(',');
  });
  assertEq(stored, 't2,t3,t1', 'localStorage 순서도 함께 바뀐다');
  assertEq(errors.pageErrors.length, 0, `페이지 오류가 없어야 한다: ${errors.pageErrors.slice(0, 3).join(' | ')}`);
});
