// 브라우저 크롬 사파리 정렬 검증 (2026-11-14 실제 맥 사파리 26 캡처 대조):
// 툴바가 탭 줄 위에 있고, 탭은 네 모서리 둥근 카드(파비콘+제목 가운데),
// 새로고침은 주소 캡슐 안에, 뒤로/앞으로는 하나의 알약 안에 있다.
'use strict';

const { runScenario, attachErrorCollector, assert, assertEq } = require('./harness.cjs');

runScenario('browser-safari-chrome', async (t) => {
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
  await page.goto(`${base}/browser.html`, { waitUntil: 'networkidle' });

  // NAVER 즐겨찾기 클릭 → 활성 탭에 URL이 생겨 파비콘 글자 'N'이 붙는다.
  await page.click('.bw-fav[data-url="https://www.naver.com"]');
  await page.waitForFunction(() => {
    const f = document.getElementById('bwLiveFrame');
    return f && f.getAttribute('src') === '/api/browse/view/';
  }, { timeout: 10000 });
  // 새 탭을 열어 탭이 2개가 되게 한다 (폭 상한 해제 확인용).
  await page.click('#bwNewTabBtn');
  await new Promise((r) => setTimeout(r, 500));

  const chrome = await page.evaluate(() => {
    const toolbar = document.querySelector('.bw-toolbar');
    const tabstrip = document.getElementById('bwTabstrip');
    const tabs = Array.from(document.querySelectorAll('.bw-tab'));
    const first = tabs[0];
    const cs = getComputedStyle(first);
    const navgroup = document.querySelector('.bw-navgroup');
    const reload = document.getElementById('bwReloadBtn');
    return {
      // (a) 툴바가 탭 줄보다 DOM 순서상 앞
      toolbarBeforeTabstrip:
        toolbar && tabstrip
          ? (toolbar.compareDocumentPosition(tabstrip) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
          : false,
      // (b) 탭 카드 계산 스타일
      radii: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomLeftRadius, cs.borderBottomRightRadius],
      justify: cs.justifyContent,
      height: cs.height,
      maxWidth: cs.maxWidth,
      tabWidths: tabs.map((el) => Math.round(el.getBoundingClientRect().width)),
      // (c) 파비콘 타일
      favText: first.querySelector('.bw-tab-fav')
        ? first.querySelector('.bw-tab-fav').textContent
        : null,
      // (d) 새로고침이 주소 캡슐 안
      reloadInCapsule: !!(reload && reload.closest('.bw-url-wrap')),
      reloadInNavgroup: !!(reload && reload.closest('.bw-navgroup')),
      // (e) 뒤로/앞으로가 알약 navgroup 안
      navRadius: navgroup ? getComputedStyle(navgroup).borderRadius : null,
      backInNav: !!document.getElementById('bwBackBtn').closest('.bw-navgroup'),
      fwdInNav: !!document.getElementById('bwFwdBtn').closest('.bw-navgroup'),
    };
  });

  assert(chrome.toolbarBeforeTabstrip, '툴바가 탭 줄보다 DOM 순서상 앞에 있어야 한다 (사파리 순서)');
  chrome.radii.forEach((r, i) => {
    assertEq(r, '10px', `탭 카드 모서리 ${i}번 반경이 10px이어야 한다 (실제: ${r})`);
  });
  assertEq(chrome.justify, 'center', `탭 내용은 가운데 정렬이어야 한다 (실제: ${chrome.justify})`);
  assertEq(chrome.height, '34px', `탭 카드 높이는 34px이어야 한다 (실제: ${chrome.height})`);
  assertEq(chrome.maxWidth, 'none', `탭 폭 상한이 없어야 한다 (실제 max-width: ${chrome.maxWidth})`);
  assertEq(chrome.favText, 'N', `네이버 탭 파비콘 글자는 'N'이어야 한다 (실제: ${chrome.favText})`);
  assert(chrome.reloadInCapsule, '새로고침 버튼은 주소 캡슐(.bw-url-wrap) 안에 있어야 한다');
  assert(!chrome.reloadInNavgroup, '새로고침 버튼은 navgroup 안에 없어야 한다');
  assert(chrome.backInNav && chrome.fwdInNav, '뒤로/앞으로 버튼은 navgroup 안에 있어야 한다');
  assertEq(chrome.navRadius, '999px', `navgroup은 알약(999px)이어야 한다 (실제: ${chrome.navRadius})`);
  chrome.tabWidths.forEach((w, i) => {
    assert(w > 400, `탭 ${i}번이 늘어나서 채워야 한다 (실제 너비: ${w}px, 200px 상한이면 실패)`);
  });
  assertEq(errors.pageErrors.length, 0, `페이지 오류가 없어야 한다: ${errors.pageErrors.slice(0, 3).join(' | ')}`);
});
