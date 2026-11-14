// 탭이 1개면 탭 줄이 사라지는지 검증한다 (2026-11-14 실제 맥 사파리 26 캡처
// image-46 대조: 탭이 하나면 사파리는 탭 줄 자체가 없고 주소 캡슐만 있다).
// 단독 모드: #bwTabstrip hidden + 높이 0, 새 탭 + 버튼은 툴바에 남아 클릭 가능.
// 창 모드: 창 바에 탭 카드 없음·제목 보임·+ 버튼만 남음.
// 탭이 2개가 되면 둘 다 나타나고, 다시 1개가 되면 사라진다.
'use strict';

const { runScenario, waitForDesktop, attachErrorCollector, assert, assertEq } = require('./harness.cjs');

async function standalonePart(t, browser, base) {
  const { page } = await t.newPage(browser, { width: 1920, height: 1080 });
  const errors = attachErrorCollector(page);
  await page.goto(`${base}/browser.html`, { waitUntil: 'networkidle' });

  const stripState = () => page.evaluate(() => {
    const strip = document.getElementById('bwTabstrip');
    const r = strip.getBoundingClientRect();
    const btn = document.getElementById('bwNewTabBtn');
    const br = btn.getBoundingClientRect();
    return {
      hidden: strip.hidden,
      h: Math.round(r.height),
      tabs: document.querySelectorAll('.bw-tab').length,
      btnInToolbar: !!(btn && btn.closest('.bw-toolbar')),
      btnVisible: br.width > 0 && br.height > 0,
    };
  });

  // (1) 탭 1개: 탭 줄 숨김, + 버튼은 툴바에 보임.
  let s = await stripState();
  assertEq(s.tabs, 1, `단독: 시작 탭은 1개여야 한다 (실제: ${s.tabs}개)`);
  assert(s.hidden, '단독: 탭 1개면 탭 줄이 hidden이어야 한다');
  assertEq(s.h, 0, `단독: 탭 1개면 탭 줄 높이가 0이어야 한다 (실제: ${s.h}px)`);
  assert(s.btnInToolbar, '단독: 새 탭 + 버튼은 툴바 안에 있어야 한다');
  assert(s.btnVisible, '단독: 탭 1개여도 새 탭 + 버튼은 보여야 한다');

  // (2) 새 탭 추가 → 탭 줄 나타남.
  await page.click('#bwNewTabBtn');
  await page.waitForFunction(() => !document.getElementById('bwTabstrip').hidden, { timeout: 5000 });
  s = await stripState();
  assertEq(s.tabs, 2, `단독: 새 탭 후 탭은 2개여야 한다 (실제: ${s.tabs}개)`);
  assert(!s.hidden, '단독: 탭 2개면 탭 줄이 보여야 한다');
  assert(s.h > 0, `단독: 탭 2개면 탭 줄 높이가 있어야 한다 (실제: ${s.h}px)`);
  // 탭이 다 들어가면 오버플로(⌄) 버튼은 안 보여야 한다
  // (.bw-icon-btn의 display:flex가 UA [hidden]을 이겨 계속 보이던 결함).
  const overflow = await page.evaluate(() => {
    const btn = document.getElementById('bwTabsOverflow');
    const r = btn.getBoundingClientRect();
    return { hidden: btn.hidden, w: Math.round(r.width), h: Math.round(r.height) };
  });
  assert(overflow.hidden, '단독: 탭이 다 들어가면 오버플로 버튼은 hidden이어야 한다');
  assertEq(overflow.w, 0, `단독: 오버플로 버튼은 안 보여야 한다 (실제 너비: ${overflow.w}px)`);

  // (3) 두 번째 탭 닫기 → 다시 1개, 탭 줄 사라짐.
  await page.click('.bw-tab:nth-child(2) .bw-tab-close');
  await page.waitForFunction(() => document.getElementById('bwTabstrip').hidden, { timeout: 5000 });
  s = await stripState();
  assertEq(s.tabs, 1, `단독: 탭 닫은 후 탭은 1개여야 한다 (실제: ${s.tabs}개)`);
  assert(s.hidden, '단독: 다시 1개가 되면 탭 줄이 hidden이어야 한다');
  assertEq(s.h, 0, `단독: 다시 1개가 되면 탭 줄 높이가 0이어야 한다 (실제: ${s.h}px)`);
  assert(s.btnVisible, '단독: 다시 1개가 되어도 새 탭 + 버튼은 보여야 한다');
  assertEq(errors.pageErrors.length, 0, `단독: 페이지 오류가 없어야 한다: ${errors.pageErrors.slice(0, 3).join(' | ')}`);
  await page.context().close();
}

async function windowPart(t, browser, base) {
  const { page } = await t.newPage(browser, { width: 1920, height: 1080 });
  const errors = attachErrorCollector(page);
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await waitForDesktop(page);
  await page.evaluate(() => window.MyHubDesktop.openModule('browser'));
  await page.waitForSelector('.dt-frame[src*="browser.html"]', { timeout: 15000 });
  // iframe이 탭을 게시할 때까지 대기 (+ 버튼이 렌더링되면 게시 완료).
  await page.waitForSelector('.myhub-win-btabs .myhub-btab-new', { timeout: 15000 });
  // 창 모드(호스팅)에서는 iframe 툴바의 +가 숨겨져야 한다
  // (창 바 +와 두 개가 겹쳐 보이지 않게).
  const frame = page.frame({ url: /browser\.html/ });
  assert(frame, '창 모드: 브라우저 iframe을 찾을 수 없다');
  await frame.waitForFunction(
    () => {
      const btn = document.getElementById('bwNewTabBtn');
      return btn && btn.hidden;
    },
    { timeout: 10000 },
  );
  const hostedPlus = await frame.evaluate(() => {
    const btn = document.getElementById('bwNewTabBtn');
    const r = btn.getBoundingClientRect();
    return { hidden: btn.hidden, w: Math.round(r.width), h: Math.round(r.height) };
  });
  assert(hostedPlus.hidden, '창 모드: iframe 툴바의 + 버튼은 hidden이어야 한다');
  assertEq(hostedPlus.w, 0, `창 모드: iframe 툴바의 + 버튼은 안 보여야 한다 (실제 너비: ${hostedPlus.w}px)`);

  const barState = () => page.evaluate(() => {
    const winEl = document.querySelector('.dt-window[data-id="browser"]');
    const box = winEl.querySelector('.myhub-win-btabs');
    const title = winEl.querySelector('.dt-title-flow');
    const btn = box.querySelector('.myhub-btab-new');
    const br = btn ? btn.getBoundingClientRect() : null;
    return {
      cards: box.querySelectorAll('.myhub-btab').length,
      newBtn: box.querySelectorAll('.myhub-btab-new').length,
      tabsOn: winEl.classList.contains('dt-win-btabs-on'),
      titleVisible: !!(title && getComputedStyle(title).display !== 'none'),
      btnAtRight: br ? Math.round(br.right) : null,
      boxRight: Math.round(box.getBoundingClientRect().right),
    };
  });

  // (1) 탭 1개: 카드 없음·제목 보임·+ 남음.
  let s = await barState();
  assertEq(s.cards, 0, `창 모드: 탭 1개면 카드가 없어야 한다 (실제: ${s.cards}개)`);
  assertEq(s.newBtn, 1, `창 모드: 탭 1개여도 + 버튼이 있어야 한다 (실제: ${s.newBtn}개)`);
  assert(!s.tabsOn, '창 모드: 탭 1개면 dt-win-btabs-on 클래스가 없어야 한다');
  assert(s.titleVisible, '창 모드: 탭 1개면 창 제목이 보여야 한다');
  assert(s.btnAtRight !== null && s.boxRight - s.btnAtRight <= 2,
    `창 모드: 탭 1개일 때 + 버튼은 바 오른쪽 끝에 있어야 한다 (버튼 우단: ${s.btnAtRight}, 박스 우단: ${s.boxRight})`);

  // (2) 창 바 + 클릭 → 탭 2개 → 카드 나타남·제목 숨김.
  await page.click('.myhub-win-btabs .myhub-btab-new');
  await page.waitForFunction(
    () => document.querySelectorAll('.myhub-win-btabs .myhub-btab').length === 2,
    { timeout: 10000 },
  );
  s = await barState();
  assertEq(s.cards, 2, `창 모드: 새 탭 후 카드는 2개여야 한다 (실제: ${s.cards}개)`);
  assert(s.tabsOn, '창 모드: 탭 2개면 dt-win-btabs-on 클래스가 있어야 한다');
  assert(!s.titleVisible, '창 모드: 탭 2개면 창 제목이 숨겨져야 한다');

  // (3) 두 번째 카드 닫기 → 다시 1개 → 카드 사라짐·제목 돌아옴.
  await page.click('.myhub-btab:nth-child(2) .myhub-btab-close');
  await page.waitForFunction(
    () => document.querySelectorAll('.myhub-win-btabs .myhub-btab').length === 0,
    { timeout: 10000 },
  );
  s = await barState();
  assertEq(s.cards, 0, `창 모드: 탭 닫은 후 카드가 없어야 한다 (실제: ${s.cards}개)`);
  assertEq(s.newBtn, 1, `창 모드: 다시 1개가 되어도 + 버튼이 있어야 한다 (실제: ${s.newBtn}개)`);
  assert(!s.tabsOn, '창 모드: 다시 1개가 되면 dt-win-btabs-on 클래스가 없어야 한다');
  assert(s.titleVisible, '창 모드: 다시 1개가 되면 창 제목이 보여야 한다');
  assertEq(errors.pageErrors.length, 0, `창 모드: 페이지 오류가 없어야 한다: ${errors.pageErrors.slice(0, 3).join(' | ')}`);
  await page.context().close();
}

runScenario('browser-single-tab', async (t) => {
  const { base } = await t.server();
  const browser = await t.browser();
  await standalonePart(t, browser, base);
  await windowPart(t, browser, base);
});
