// 원격 브라우저 핀치 줌 차단 실브라우저 검증 (2026-11-16, 네이버 90% 사고).
// 트랙패드 핀치는 Ctrl+휠로 들어오고 Selkies 클라이언트가 이를 원격에
// 전달해 Chromium 페이지 줌을 바꾼다. browser-live.js의 캡처 단계 가드가
// iframe 안에서 Ctrl+휠만 막는지, 실제 CDP 휠 이벤트로 확인한다.
// 전제: 가드가 없으면 Ctrl+휠도 하위 리스너에 닿아 카운터가 오른다.
'use strict';

const { runScenario, attachErrorCollector, assert, assertEq } = require('./harness.cjs');

const VIEW_STUB = '<html><body style="height:2000px">selkies stub'
  + '<script>window.__wheelSeen = 0;'
  + 'window.addEventListener("wheel", function () { window.__wheelSeen++; }, { passive: true });'
  + '</script></body></html>';

runScenario('browser-pinch-zoom', async (t) => {
  const { base } = await t.server({
    onApi: async ({ method, path, body }) => {
      if (path === '/api/browse/navigate' && method === 'POST') {
        return { body: { ok: true, nav: 'ok', navStage: 'ok' } };
      }
      if (path === '/api/browse/view/' && method === 'GET') {
        return { body: VIEW_STUB, contentType: 'text/html' };
      }
      return null;
    },
  });
  const browser = await t.browser();
  const { page } = await t.newPage(browser, { width: 1920, height: 1080 });
  const errors = attachErrorCollector(page);
  await page.goto(`${base}/browser.html`, { waitUntil: 'networkidle' });

  await page.click('.bw-fav[data-url="https://www.naver.com"]');
  // iframe 스텁 로드 + load 핸들러(가드 부착) 완료 대기.
  await page.waitForFunction(() => {
    const f = document.getElementById('bwLiveFrame');
    return f && f.contentWindow && f.contentWindow.__wheelSeen !== undefined
      && f.contentDocument && f.contentDocument.readyState === 'complete';
  }, { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 500));

  const box = await page.evaluate(() => {
    const f = document.getElementById('bwLiveFrame');
    const r = f.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const wheelSeen = () => page.evaluate(() => {
    const f = document.getElementById('bwLiveFrame');
    return f.contentWindow.__wheelSeen;
  });

  const cdp = await page.context().newCDPSession(page);
  // Ctrl+휠 (핀치): 가드가 막아 하위 리스너에 닿지 않아야 한다.
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: 100, modifiers: 2,
  });
  await new Promise((r) => setTimeout(r, 300));
  assertEq(await wheelSeen(), 0, 'Ctrl+휠(핀치)은 하위 리스너에 닿지 않아야 한다');

  // 일반 휠: 그대로 통과해 하위 리스너가 받아야 한다.
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: 100, modifiers: 0,
  });
  await new Promise((r) => setTimeout(r, 300));
  assertEq(await wheelSeen(), 1, '일반 휠은 하위 리스너에 닿아야 한다');

  assertEq(errors.pageErrors.length, 0, `페이지 오류가 없어야 한다: ${errors.pageErrors.slice(0, 3).join(' | ')}`);
});
