// 창 모드 타이틀바 한 줄 내비 검증 (2026-11-14 실제 맥 사파리 26 캡처
// image-48 대조): 제목 바에 사이드바 → 뒤로/앞으로 → 주소 → 공유 →
// 새 탭 → 탭 개요가 한 줄로 있고, 탭 줄은 iframe 안에 있다. 탭 1개면
// 탭 줄이 없고 2개면 나타난다. 주소 입력 이동·사이드바·탭 개요가 실동작한다.
'use strict';

const { runScenario, waitForDesktop, attachErrorCollector, assert, assertEq } = require('./harness.cjs');

runScenario('browser-titlebar-nav', async (t) => {
  const { base } = await t.server({
    onApi: async ({ method, path, body }) => {
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

  const navOrder = () => page.evaluate(() => {
    const box = document.querySelector('.myhub-win-bnav');
    const r = (sel) => {
      const el = box.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.x), cx: Math.round(b.x + b.width / 2), cy: Math.round(b.y + b.height / 2) };
    };
    return {
      sidebar: r('.myhub-bnav-sidebar'),
      navgroup: r('.myhub-bnav-navgroup'),
      url: r('.myhub-bnav-url'),
      trail: r('.myhub-bnav-trail'),
      cards: document.querySelectorAll('.myhub-btab').length,
      titleVisible: (() => {
        const title = document.querySelector('.dt-window[data-id="browser"] .dt-title-flow');
        return !!(title && getComputedStyle(title).display !== 'none');
      })(),
    };
  });
  const frameStrip = () => frame.evaluate(() => {
    const strip = document.getElementById('bwTabstrip');
    const r = strip.getBoundingClientRect();
    return {
      hidden: strip.hidden,
      h: Math.round(r.height),
      tabs: document.querySelectorAll('.bw-tab').length,
      activeName: (() => {
        const a = document.querySelector('.bw-tab.is-active .bw-tab-name');
        return a ? a.textContent : null;
      })(),
    };
  });
  const shellInputValue = () => page.evaluate(() => {
    const input = document.querySelector('.myhub-win-bnav .myhub-bnav-input');
    return input ? input.value : null;
  });

  // (1) 탭 1개: 제목 바 내비 한 줄·탭 카드 없음·제목 숨김, iframe 탭 줄 숨김.
  let o = await navOrder();
  assertEq(o.cards, 0, `제목 바에 탭 카드가 없어야 한다 (실제: ${o.cards}개)`);
  assert(!o.titleVisible, '내비가 앉으면 창 제목이 숨겨져야 한다');
  assert(
    o.sidebar && o.navgroup && o.url && o.trail &&
    o.sidebar.x < o.navgroup.x && o.navgroup.x < o.url.x && o.url.x < o.trail.x,
    `내비 순서는 사이드바 → 알약 → 캡슐 → 트레일이어야 한다 (x: ${o.sidebar?.x}, ${o.navgroup?.x}, ${o.url?.x}, ${o.trail?.x})`,
  );
  assert(
    Math.abs(o.sidebar.cy - o.url.cy) <= 2 && Math.abs(o.trail.cy - o.url.cy) <= 2,
    '내비 요소들이 한 줄(같은 세로 중심)에 있어야 한다',
  );
  let f = await frameStrip();
  assertEq(f.tabs, 1, `시작 탭은 1개여야 한다 (실제: ${f.tabs}개)`);
  assert(f.hidden, '탭 1개면 iframe 탭 줄이 hidden이어야 한다');

  // (2) 제목 바 + → 탭 2개 → iframe 탭 줄 나타남.
  await page.click('.myhub-win-bnav .myhub-bnav-new');
  await frame.waitForFunction(() => document.querySelectorAll('.bw-tab').length === 2, { timeout: 10000 });
  f = await frameStrip();
  assertEq(f.tabs, 2, `새 탭 후 탭은 2개여야 한다 (실제: ${f.tabs}개)`);
  assert(!f.hidden, '탭 2개면 iframe 탭 줄이 보여야 한다');

  // (3) 제목 바 주소 입력 후 이동: example.com으로 가면 캡슐에 호스트가 보인다.
  await page.fill('.myhub-win-bnav .myhub-bnav-input', 'example.com');
  await page.press('.myhub-win-bnav .myhub-bnav-input', 'Enter');
  await page.waitForFunction(() => {
    const input = document.querySelector('.myhub-win-bnav .myhub-bnav-input');
    return input && input.value === 'example.com';
  }, { timeout: 10000 });
  assertEq(await shellInputValue(), 'example.com', '이동 후 캡슐에는 호스트가 보여야 한다');
  f = await frameStrip();
  assertEq(f.activeName, 'example.com', `활성 탭 이름이 example.com이어야 한다 (실제: ${f.activeName})`);
  const liveSrc = await frame.evaluate(() => document.getElementById('bwLiveFrame').getAttribute('src'));
  assertEq(liveSrc, '/api/browse/view/', '이동하면 원격 뷰 iframe이 켜져야 한다');
  // 하단 "원격 브라우저" 필은 제거됐다 (2026-11-14) — 라이브가 켜진
  // 상태에도 필·경과 시간·종료 버튼이 DOM에 없어야 한다.
  const pillGone = await frame.evaluate(() => ({
    pill: !!document.getElementById('bwPill'),
    msg: !!document.getElementById('bwLiveMsg'),
    time: !!document.getElementById('bwLiveTime'),
    end: !!document.getElementById('bwLiveEnd'),
  }));
  assert(!pillGone.pill && !pillGone.msg && !pillGone.time && !pillGone.end,
    `라이브 뷰에 필이 없어야 한다 (pill:${pillGone.pill} msg:${pillGone.msg} time:${pillGone.time} end:${pillGone.end})`);

  // (4) 사이드바: 제목 바 버튼으로 열면 즐겨찾기·열린 탭이 있고,
  // 즐겨찾기를 누르면 이동하고 사이드바가 닫힌다.
  await page.click('.myhub-win-bnav .myhub-bnav-sidebar');
  await frame.waitForFunction(() => !document.getElementById('bwSidebar').hidden, { timeout: 5000 });
  const side = await frame.evaluate(() => ({
    favs: document.querySelectorAll('#bwSidebarFavs .bw-side-item').length,
    tabs: document.querySelectorAll('#bwSidebarTabs .bw-side-item').length,
    activeTab: (() => {
      const a = document.querySelector('#bwSidebarTabs .bw-side-item.is-active .bw-side-name');
      return a ? a.textContent : null;
    })(),
  }));
  assertEq(side.favs, 6, `사이드바 즐겨찾기는 6개여야 한다 (실제: ${side.favs}개)`);
  assertEq(side.tabs, 2, `사이드바 열린 탭은 2개여야 한다 (실제: ${side.tabs}개)`);
  assertEq(side.activeTab, 'example.com', `사이드바 활성 탭은 example.com이어야 한다 (실제: ${side.activeTab})`);
  await frame.click('#bwSidebarFavs .bw-side-item:has-text("Google")');
  await page.waitForFunction(() => {
    const input = document.querySelector('.myhub-win-bnav .myhub-bnav-input');
    return input && input.value === 'google.com';
  }, { timeout: 10000 });
  assertEq(await shellInputValue(), 'google.com', '사이드바 Google을 누르면 google.com으로 이동해야 한다');
  const sideClosed = await frame.evaluate(() => document.getElementById('bwSidebar').hidden);
  assert(sideClosed, '즐겨찾기를 누르면 사이드바가 닫혀야 한다');

  // (5) 사이드바 배경 클릭으로 닫기.
  await page.click('.myhub-win-bnav .myhub-bnav-sidebar');
  await frame.waitForFunction(() => !document.getElementById('bwSidebar').hidden, { timeout: 5000 });
  await frame.click('#bwSidebarBackdrop');
  await frame.waitForFunction(() => document.getElementById('bwSidebar').hidden, { timeout: 5000 });
  assert(true, '배경 클릭으로 사이드바가 닫혀야 한다');

  // (6) 탭 개요: 열면 카드 2개, 첫 카드를 누르면 그 탭으로 전환된다.
  await page.click('.myhub-win-bnav .myhub-bnav-overview');
  await frame.waitForFunction(() => !document.getElementById('bwOverview').hidden, { timeout: 5000 });
  const ov = await frame.evaluate(() => ({
    cards: document.querySelectorAll('#bwOverviewGrid .bw-ov-card').length,
    names: Array.from(document.querySelectorAll('#bwOverviewGrid .bw-ov-name')).map((el) => el.textContent),
  }));
  assertEq(ov.cards, 2, `탭 개요 카드는 2개여야 한다 (실제: ${ov.cards}개)`);
  assert(ov.names.includes('새 탭') && ov.names.includes('google.com'),
    `탭 개요에 두 탭이 있어야 한다 (실제: ${ov.names.join(', ')})`);
  await frame.click('#bwOverviewGrid .bw-ov-card:has-text("새 탭")');
  await frame.waitForFunction(() => document.getElementById('bwOverview').hidden, { timeout: 5000 });
  await page.waitForFunction(() => {
    const input = document.querySelector('.myhub-win-bnav .myhub-bnav-input');
    return input && input.value === '';
  }, { timeout: 10000 });
  assertEq(await shellInputValue(), '', '빈 탭으로 전환하면 캡슐이 비워져야 한다');
  f = await frameStrip();
  assertEq(f.activeName, '새 탭', `전환 후 활성 탭은 새 탭이어야 한다 (실제: ${f.activeName})`);

  // (7) 탭 개요에서 카드 ×로 탭 닫기: 남은 카드 1개, 탭 줄 다시 사라짐.
  await page.click('.myhub-win-bnav .myhub-bnav-overview');
  await frame.waitForFunction(() => !document.getElementById('bwOverview').hidden, { timeout: 5000 });
  await frame.click('#bwOverviewGrid .bw-ov-card:has-text("google.com") .bw-ov-close');
  await frame.waitForFunction(
    () => document.querySelectorAll('#bwOverviewGrid .bw-ov-card').length === 1,
    { timeout: 10000 },
  );
  f = await frameStrip();
  assertEq(f.tabs, 1, `탭 닫은 후 탭은 1개여야 한다 (실제: ${f.tabs}개)`);
  assert(f.hidden, '다시 1개가 되면 iframe 탭 줄이 hidden이어야 한다');
  await frame.click('#bwOverviewClose');
  await frame.waitForFunction(() => document.getElementById('bwOverview').hidden, { timeout: 5000 });

  assertEq(errors.pageErrors.length, 0, `페이지 오류가 없어야 한다: ${errors.pageErrors.slice(0, 3).join(' | ')}`);
});
