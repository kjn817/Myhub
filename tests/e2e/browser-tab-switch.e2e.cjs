// 탭 전환 시 라이브 iframe이 display:none이 아니라 visibility:hidden으로
// 주차되는지 검증한다. display:none은 iframe 문서를 hidden으로 만들어
// Selkies 스트림을 멈추고 복귀 시 재연결 갭을 만든다 (2026-11-14 전환 시
// 끊김 보고). visibility:hidden은 문서를 살려 둬 복귀가 즉시 된다.
// 전제: iframe 안에는 동일 출처 스텁 페이지가 로드된다.
'use strict';

const { runScenario, attachErrorCollector, assert, assertEq } = require('./harness.cjs');

runScenario('browser-tab-switch', async (t) => {
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

  // NAVER 즐겨찾기 클릭 → 라이브 시작, iframe 스텁 로드 대기.
  await page.click('.bw-fav[data-url="https://www.naver.com"]');
  await page.waitForFunction(() => {
    const f = document.getElementById('bwLiveFrame');
    return f && f.getAttribute('src') === '/api/browse/view/' && f.contentDocument && f.contentDocument.body && f.contentDocument.body.textContent.includes('selkies stub');
  }, { timeout: 10000 });

  // 새 탭을 열어 전환한다.
  await page.click('#bwNewTabBtn');
  await new Promise((r) => setTimeout(r, 500));
  const parked = await page.evaluate(() => {
    const f = document.getElementById('bwLiveFrame');
    const r = f.getBoundingClientRect();
    return {
      hidden: f.hidden,
      parked: f.classList.contains('bw-frame-parked'),
      w: Math.round(r.width),
      h: Math.round(r.height),
      vis: f.contentDocument ? f.contentDocument.visibilityState : 'no-doc',
    };
  });
  assert(!parked.hidden, `전환 후 iframe은 hidden이 아니어야 한다 (실제 hidden=${parked.hidden})`);
  assert(parked.parked, '전환 후 iframe에 bw-frame-parked 클래스가 있어야 한다');
  assert(parked.w > 0 && parked.h > 0, `전환 후 iframe은 렌더링 크기를 유지해야 한다 (실제: ${parked.w}x${parked.h})`);
  assertEq(parked.vis, 'visible', `전환 후 iframe 문서는 visible이어야 한다 (실제: ${parked.vis})`);

  // 라이브 탭(NAVER)으로 복귀한다.
  await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('.bw-tab'));
    const live = tabs.find((el) => el.textContent.includes('naver.com'));
    if (!live) throw new Error('live tab not found');
    live.click();
  });
  await new Promise((r) => setTimeout(r, 500));
  const back = await page.evaluate(() => {
    const f = document.getElementById('bwLiveFrame');
    const cs = getComputedStyle(f);
    return { hidden: f.hidden, parked: f.classList.contains('bw-frame-parked'), visibility: cs.visibility };
  });
  assert(!back.hidden && !back.parked, '복귀 후 iframe은 hidden도 parked도 아니어야 한다');
  assertEq(back.visibility, 'visible', '복귀 후 iframe은 보여야 한다');
  assertEq(errors.pageErrors.length, 0, `페이지 오류가 없어야 한다: ${errors.pageErrors.slice(0, 3).join(' | ')}`);
});
