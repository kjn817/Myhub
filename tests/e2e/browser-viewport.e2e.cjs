// 원격 브라우저 뷰포트 검증: hidden iframe 대신 보이는 .bw-stage 크기가
// POST /api/browse/navigate에 실리는지, iframe src가 /api/browse/view/로
// 걸리는지 확인한다.
// (2026-11-12 수정 04cd131의 가드: enterLive가 hidden iframe 자기 크기를 재서
// 항상 0x0이었고, 원격이 기본 1280x720으로 확대 표시되던 결함.
// 2026-11-14: 세션 발급 폐기 — 뷰포트는 navigate에, 화면은 view 프록시로.)
// 원본: .scratch/verify-browser-viewport.cjs
'use strict';

const { runScenario, attachErrorCollector, assert, assertNear, assertEq } = require('./harness.cjs');

runScenario('browser-viewport', async (t) => {
  let captured = null;
  const { base } = await t.server({
    onApi: async ({ method, path, body }) => {
      if (path === '/api/browse/navigate' && method === 'POST') {
        captured = JSON.parse(body || '{}');
        return { body: { ok: true, nav: 'ok', navStage: 'ok' } };
      }
      if (path === '/api/browse/view/' && method === 'GET') {
        return { body: '<html><body>selkies stub</body></html>', contentType: 'text/html' };
      }
      return null;
    },
  });
  const browser = await t.browser();
  // 사용자 화면과 같은 1920x1080 최대화 창 가정.
  const { page } = await t.newPage(browser, { width: 1920, height: 1080 });
  const errors = attachErrorCollector(page);
  await page.goto(`${base}/browser.html`, { waitUntil: 'networkidle' });

  const rects = await page.evaluate(() => {
    const stage = document.querySelector('.bw-stage');
    const frame = document.getElementById('bwLiveFrame');
    const sr = stage.getBoundingClientRect();
    const fr = frame.getBoundingClientRect();
    return {
      stage: { w: Math.round(sr.width), h: Math.round(sr.height) },
      frame: { w: Math.round(fr.width), h: Math.round(fr.height), hidden: frame.hidden },
    };
  });
  // 전제 확인: 시작 중 iframe은 hidden이라 자기 크기가 0x0이다. 이 전제가
  // 깨지면(iframe이 보이면) 뷰포트 소스가 달라질 수 있어 테스트가 무의미해진다.
  assertEq(rects.frame.w, 0, `시작 중 #bwLiveFrame 너비는 0이어야 한다 (실제: ${rects.frame.w})`);
  assert(rects.frame.hidden, '#bwLiveFrame은 hidden 상태여야 한다');

  // NAVER 즐겨찾기 클릭 → enterLive → iframe src + POST 캡처.
  await page.click('.bw-fav[data-url="https://www.naver.com"]');
  const deadline = Date.now() + 10000;
  while (!captured && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  assert(captured, 'POST /api/browse/navigate가 10초 안에 오지 않았다');
  assertEq(captured.url, 'https://www.naver.com', 'navigate 요청에 즐겨찾기 URL이 실려야 한다');
  assert(captured.viewport, `navigate 요청에 viewport가 있어야 한다 (실제: ${JSON.stringify(captured)})`);
  assertNear(captured.viewport.width, rects.stage.w, 1, '.bw-stage 너비가 뷰포트로 전송되어야 한다');
  assertNear(captured.viewport.height, rects.stage.h, 1, '.bw-stage 높이가 뷰포트로 전송되어야 한다');
  console.log(`  stage ${rects.stage.w}x${rects.stage.h} -> viewport ${captured.viewport.width}x${captured.viewport.height}`);
  const frameSrc = await page.evaluate(() => document.getElementById('bwLiveFrame').getAttribute('src'));
  assertEq(frameSrc, '/api/browse/view/', `iframe src는 view 프록시여야 한다 (실제: ${frameSrc})`);
  assertEq(errors.pageErrors.length, 0, `페이지 오류가 없어야 한다: ${errors.pageErrors.slice(0, 3).join(' | ')}`);
});
