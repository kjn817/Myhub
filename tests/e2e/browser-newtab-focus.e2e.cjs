// 새 탭 포커스 종단 검증 (2026-11-20 QA 결함: 새 탭 직후 키 입력이
// 주소창에 안 들어감).
//
// 원인: 셸 포커스가 + 버튼의 일회성 플래그 + 다음 내비 상태 게시에만
// 의존했다. ① 연속 빈 탭은 상태 서명이 같아 게시 자체가 안 되고,
// ② 메뉴 경로는 플래그가 없으며, ③ 빈 탭 선택은 포커스 요청이
// 없었다. 호스팅 모드에서는 iframe 주소창이 숨겨져 있어 newTab()의
// urlInput.focus()도 무용지물이었다. 수정: browser.js가 빈 탭이 될
// 때 셸에 myhub:browser-nav-focus를 명시적으로 요청한다.
// ④ closeTab도 activateTab을 거치지 않아 빈 탭으로 넘어가도 포커스
// 요청이 없었다 — S5가 이 경로를 검증한다.
//
// "한 탭에서만" 모달은 2026-11-26 실제 브라우저 탭 동작으로 폐기됐다:
// S2는 이제 모달이 뜨지 않는 상태에서 포커스·타이핑이 동작하는지를
// 본다. 각 시나리오는 포커스 여부 + 실제 키보드 타이핑이 주소창에
// 들어가는지를 함께 단언한다 (QA 증상 그대로).
'use strict';

const { runScenario, waitForDesktop, attachErrorCollector, assert, assertEq } = require('./harness.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

runScenario('browser-newtab-focus', async (t) => {
  const { base } = await t.server({
    onApi: async ({ method, path }) => {
      if (path === '/api/browse/navigate' && method === 'POST') {
        return { body: { ok: true, nav: 'ok', navStage: 'ok' } };
      }
      if (path === '/api/browse/view/' && method === 'GET') {
        return { body: '<html><body>selkies stub</body></html>', contentType: 'text/html' };
      }
      return null;
    },
  });
  const browser = await t.browser();
  const { page } = await t.newPage(browser, { width: 1920, height: 1080 });
  const errors = attachErrorCollector(page);
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await waitForDesktop(page);
  await page.evaluate(() => window.MyHubDesktop.openModule('browser'));
  await page.waitForSelector('.dt-frame[src*="browser.html"]', { timeout: 15000 });
  await page.waitForSelector('.myhub-win-bnav .myhub-bnav-input', { timeout: 15000 });
  const frame = page.frame({ url: /browser\.html/ });
  assert(frame, '브라우저 iframe을 찾을 수 없다');
  await frame.waitForFunction(() => {
    const tb = document.getElementById('bwToolbar');
    return tb && tb.hidden;
  }, { timeout: 10000 });

  const shellInputFocused = () => page.evaluate(() => {
    const input = document.querySelector('.myhub-win-bnav .myhub-bnav-input');
    return !!(input && document.activeElement === input);
  });
  const shellInputValue = () => page.evaluate(() => {
    const input = document.querySelector('.myhub-win-bnav .myhub-bnav-input');
    return input ? input.value : null;
  });
  const modalShown = () => frame.evaluate(() => {
    const el = document.getElementById('bwElsewhere');
    return !!el && !el.hidden;
  });
  const waitTabs = async (n) => {
    await frame.waitForFunction((want) => document.querySelectorAll('.bw-tab').length === want, n, { timeout: 10000 });
  };
  // 포커스 + 실제 타이핑 단언. 끝나면 Esc로 빠져나온다 (빈 탭이면
  // 값이 ''로 복원된다).
  async function expectFocusAndTyping(label) {
    await sleep(500);
    assert(await shellInputFocused(), `${label}: 셸 주소창에 포커스가 있어야 한다`);
    await page.keyboard.type('ex');
    await sleep(200);
    assertEq(await shellInputValue(), 'ex', `${label}: 타이핑이 주소창에 들어가야 한다`);
    await page.keyboard.press('Escape');
    await sleep(100);
  }

  // S1: 연속 빈 탭 (서명 중복) — 첫 탭이 빈 상태에서 셸 + 클릭.
  await page.click('.myhub-win-bnav .myhub-bnav-new');
  await waitTabs(2);
  await expectFocusAndTyping('S1 연속 빈 탭');

  // S2: URL 탭에서 새 탭 — "한 탭에서만" 모달은 폐기됐으므로 뜨지
  // 않아야 하고, 그래도 포커스·타이핑이 동작해야 한다.
  await page.fill('.myhub-win-bnav .myhub-bnav-input', 'example.com');
  await page.press('.myhub-win-bnav .myhub-bnav-input', 'Enter');
  await page.waitForFunction(() => {
    const input = document.querySelector('.myhub-win-bnav .myhub-bnav-input');
    return input && input.value === 'example.com';
  }, { timeout: 10000 });
  await page.click('.myhub-win-bnav .myhub-bnav-new');
  await waitTabs(3);
  assert(!(await modalShown()), 'S2: 한 탭에서만 모달이 떠 있으면 안 된다 (2026-11-26 폐기)');
  await expectFocusAndTyping('S2 URL 탭에서 새 탭 (모달 없음)');

  // S3: 메뉴 경로 — MyHubMenus 탭 → 새 탭 run() (셸이 메뉴 클릭 때
  // 호출하는 것과 같은 함수, 셸 플래그 없음).
  const menuRes = await frame.evaluate(() => {
    const menus = window.MyHubMenus || [];
    const tabMenu = menus.find((m) => m.label === '탭');
    if (!tabMenu) return 'no-tab-menu';
    const items = tabMenu.items();
    const item = items.find((i) => i.label === '새 탭');
    if (!item) return 'no-newtab-item';
    item.run();
    return 'ran';
  });
  assertEq(menuRes, 'ran', `S3: 메뉴 새 탭을 실행해야 한다 (실제: ${menuRes})`);
  await waitTabs(4);
  await expectFocusAndTyping('S3 메뉴 새 탭');

  // S4: 기존 빈 탭 선택 — URL 탭으로 갔다가 빈 탭을 탭 줄에서 클릭.
  await frame.click('.bw-tab:has-text("example.com")');
  await frame.waitForFunction(() => {
    const a = document.querySelector('.bw-tab.is-active .bw-tab-name');
    return a && a.textContent === 'example.com';
  }, { timeout: 5000 });
  await frame.click('.bw-tab:has-text("새 탭")');
  await frame.waitForFunction(() => {
    const a = document.querySelector('.bw-tab.is-active .bw-tab-name');
    return a && a.textContent === '새 탭';
  }, { timeout: 5000 });
  await expectFocusAndTyping('S4 기존 빈 탭 선택');

  // S5: 활성 탭 닫기 — URL 탭의 X를 눌러 빈 탭으로 넘어가면
  // 포커스·타이핑이 동작해야 한다.
  await frame.click('.bw-tab:has-text("example.com")');
  await frame.waitForFunction(() => {
    const a = document.querySelector('.bw-tab.is-active .bw-tab-name');
    return a && a.textContent === 'example.com';
  }, { timeout: 5000 });
  await frame.click('.bw-tab:has-text("example.com") .bw-tab-close');
  await waitTabs(3);
  await frame.waitForFunction(() => {
    const a = document.querySelector('.bw-tab.is-active .bw-tab-name');
    return a && a.textContent === '새 탭';
  }, { timeout: 5000 });
  await expectFocusAndTyping('S5 활성 탭 닫아 빈 탭으로');

  assertEq(errors.pageErrors.length, 0, `페이지 오류가 없어야 한다: ${errors.pageErrors.slice(0, 3).join(' | ')}`);
});
