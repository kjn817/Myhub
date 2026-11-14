// 탭이 1개면 탭 줄이 사라지는지 검증한다 (2026-11-14 실제 맥 사파리 26 캡처
// image-46 대조: 탭이 하나면 사파리는 탭 줄 자체가 없고 주소 캡슐만 있다).
// 단독 모드: #bwTabstrip hidden + 높이 0, 새 탭 + 버튼은 툴바에 남아 클릭 가능.
// 창 모드: 탭 줄은 iframe 안의 #bwTabstrip이 담당한다 (제목 바는 내비만 맡고
// 탭 카드는 없다 — 2026-11-14 타이틀바 한 줄 통일). iframe 툴바는 숨겨지고
// 셸 제목 바에 내비 한 줄이 뜬다. 탭이 2개가 되면 탭 줄이 나타나고,
// 다시 1개가 되면 사라진다.
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
  // iframe이 내비를 게시할 때까지 대기 (주소 입력이 렌더링되면 게시 완료).
  await page.waitForSelector('.myhub-win-bnav .myhub-bnav-input', { timeout: 15000 });
  const frame = page.frame({ url: /browser\.html/ });
  assert(frame, '창 모드: 브라우저 iframe을 찾을 수 없다');
  // 창 모드(호스팅)에서는 iframe 툴바 자체가 숨겨져야 한다
  // (내비는 셸 제목 바가 대신한다).
  await frame.waitForFunction(
    () => {
      const tb = document.getElementById('bwToolbar');
      return tb && tb.hidden;
    },
    { timeout: 10000 },
  );
  const hostedToolbar = await frame.evaluate(() => {
    const tb = document.getElementById('bwToolbar');
    const r = tb.getBoundingClientRect();
    return { hidden: tb.hidden, w: Math.round(r.width), h: Math.round(r.height) };
  });
  assert(hostedToolbar.hidden, '창 모드: iframe 툴바는 hidden이어야 한다');
  assertEq(hostedToolbar.h, 0, `창 모드: iframe 툴바는 안 보여야 한다 (실제 높이: ${hostedToolbar.h}px)`);

  const frameStripState = () => frame.evaluate(() => {
    const strip = document.getElementById('bwTabstrip');
    const r = strip.getBoundingClientRect();
    return {
      hidden: strip.hidden,
      h: Math.round(r.height),
      tabs: document.querySelectorAll('.bw-tab').length,
    };
  });
  const barState = () => page.evaluate(() => {
    const winEl = document.querySelector('.dt-window[data-id="browser"]');
    const box = winEl.querySelector('.myhub-win-bnav');
    const title = winEl.querySelector('.dt-title-flow');
    return {
      cards: winEl.querySelectorAll('.myhub-btab').length,
      navHidden: box.hidden,
      navOn: winEl.classList.contains('dt-win-bnav-on'),
      titleVisible: !!(title && getComputedStyle(title).display !== 'none'),
      hasInput: !!box.querySelector('.myhub-bnav-input'),
      hasOverview: !!box.querySelector('.myhub-bnav-overview'),
      hasSidebar: !!box.querySelector('.myhub-bnav-sidebar'),
      hasNew: !!box.querySelector('.myhub-bnav-new'),
    };
  });

  // (1) 탭 1개: 제목 바에 내비 한 줄·탭 카드 없음·제목 숨김, iframe 탭 줄 숨김.
  let s = await barState();
  assertEq(s.cards, 0, `창 모드: 제목 바에 탭 카드가 없어야 한다 (실제: ${s.cards}개)`);
  assert(!s.navHidden, '창 모드: 내비가 보여야 한다');
  assert(s.navOn, '창 모드: dt-win-bnav-on 클래스가 있어야 한다');
  assert(!s.titleVisible, '창 모드: 내비가 앉으면 창 제목이 숨겨져야 한다');
  assert(s.hasInput && s.hasOverview && s.hasSidebar && s.hasNew,
    '창 모드: 내비에 주소 입력·탭 개요·사이드바·새 탭이 있어야 한다');
  let f = await frameStripState();
  assertEq(f.tabs, 1, `창 모드: 시작 탭은 1개여야 한다 (실제: ${f.tabs}개)`);
  assert(f.hidden, '창 모드: 탭 1개면 iframe 탭 줄이 hidden이어야 한다');
  assertEq(f.h, 0, `창 모드: 탭 1개면 iframe 탭 줄 높이가 0이어야 한다 (실제: ${f.h}px)`);

  // (2) 제목 바 + 클릭 → 탭 2개 → iframe 탭 줄 나타남.
  await page.click('.myhub-win-bnav .myhub-bnav-new');
  await frame.waitForFunction(() => document.querySelectorAll('.bw-tab').length === 2, { timeout: 10000 });
  f = await frameStripState();
  assertEq(f.tabs, 2, `창 모드: 새 탭 후 탭은 2개여야 한다 (실제: ${f.tabs}개)`);
  assert(!f.hidden, '창 모드: 탭 2개면 iframe 탭 줄이 보여야 한다');
  assert(f.h > 0, `창 모드: 탭 2개면 iframe 탭 줄 높이가 있어야 한다 (실제: ${f.h}px)`);
  s = await barState();
  assertEq(s.cards, 0, '창 모드: 탭 2개여도 제목 바에 탭 카드가 없어야 한다');
  assert(!s.navHidden, '창 모드: 탭 2개여도 내비가 보여야 한다');

  // (3) iframe 탭 줄에서 두 번째 탭 닫기 → 다시 1개 → 탭 줄 사라짐.
  await frame.click('.bw-tab:nth-child(2) .bw-tab-close');
  await frame.waitForFunction(() => document.getElementById('bwTabstrip').hidden, { timeout: 10000 });
  f = await frameStripState();
  assertEq(f.tabs, 1, `창 모드: 탭 닫은 후 탭은 1개여야 한다 (실제: ${f.tabs}개)`);
  assert(f.hidden, '창 모드: 다시 1개가 되면 iframe 탭 줄이 hidden이어야 한다');
  assertEq(f.h, 0, `창 모드: 다시 1개가 되면 iframe 탭 줄 높이가 0이어야 한다 (실제: ${f.h}px)`);
  assertEq(errors.pageErrors.length, 0, `창 모드: 페이지 오류가 없어야 한다: ${errors.pageErrors.slice(0, 3).join(' | ')}`);
  await page.context().close();
}

runScenario('browser-single-tab', async (t) => {
  const { base } = await t.server();
  const browser = await t.browser();
  await standalonePart(t, browser, base);
  await windowPart(t, browser, base);
});
