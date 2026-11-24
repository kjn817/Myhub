// pdfcraft 로더 쿼리 WASM fetch 가드 회귀 (2026-11-25).
//
// loader.js가 wasmPart0..2 쿼리 값을 그대로 fetch하면, 악성 URL을 쿼리에
// 넣은 링크를 열어 공격자 WASM이 같은 출처 iframe에서 실행될 수 있다.
// 쿼리 값은 blob:만 허용하고(호스트 부팅 게이트가 넘기는 Blob URL이 유일한
// 정당한 쿼리 값), 그 외는 상대 경로 파트로 폴백해야 한다.
//
// 이 테스트는 벤더 페이지를 악성 쿼리와 함께 직접 열어 단언한다:
//  1. 악성 URL을 fetch하지 않는다 (요청 기록에 악성 호스트가 없다).
//  2. 상대 경로 파트로 폴백해 엔진이 정상 부팅한다 (캔버스 렌더링 확인).
//
// 부팅 신호는 pdfcraft:ready가 아니다 — 벤더 페이지를 최상위 프레임으로
// 열면 엔진이 ready를 부모(자기 자신)에게 보내지 않아 메시지가 오지
// 않는다. 대신 egui 캔버스가 그려지는지(픽셀 분산)로 부팅을 확인한다.
//
// 카나리아: partFromQuery 가드를 빼고 쿼리 값을 그대로 fetch하면, 악성
// 호스트 요청이 생기고 부팅이 실패해 1·2가 둘 다 실패한다.
'use strict';

const sharp = require('sharp');
const { runScenario, assert } = require('./harness.cjs');

runScenario('pdfcraft-loader-query-guard', async (t) => {
  const { base } = await t.server({});
  const browser = await t.browser();
  const { page } = await t.newPage(browser, { width: 1280, height: 800 });
  const requested = [];
  page.on('request', (req) => requested.push(req.url()));
  let failed = null;
  page.on('pageerror', (e) => { failed = failed || String(e).slice(0, 300); });
  const pageUrl = `${base}/vendor/pdfcraft/index.html?wasmPart0=https://127.0.0.1:9/evil.wasm&wasmPart1=javascript:alert(1)`;
  await page.goto(pageUrl, { waitUntil: 'load' });
  // 엔진 캔버스가 나타나고 실제로 그려질 때까지 기다린다 (최대 120초).
  const deadline = Date.now() + 120000;
  let painted = false;
  while (Date.now() < deadline) {
    const hasCanvas = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      return !!c && c.width > 100 && c.height > 100;
    });
    if (hasCanvas) {
      await page.waitForTimeout(3000);
      const buf = await page.screenshot();
      const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
      const n = info.width * info.height;
      const lum0 = (data[0] + data[1] + data[2]) / 3;
      let diff = 0;
      for (let i = 0; i < n; i += 7) {
        const lum = (data[i * info.channels] + data[i * info.channels + 1] + data[i * info.channels + 2]) / 3;
        if (Math.abs(lum - lum0) > 10) diff++;
      }
      if (diff / (n / 7) > 0.01) { painted = true; break; }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  assert(!failed, `악성 쿼리가 있어도 페이지 오류가 나면 안 된다: ${failed}`);
  assert(painted, '악성 쿼리가 있어도 상대 경로 파트로 폴백해 엔진이 그려져야 한다');
  // 페이지 이동 URL 자체는 쿼리에 악성값을 담고 있으니 제외하고, 로더가
  // 추가로 fetch한 요청만 본다.
  const evil = requested.filter(
    (u) => u !== pageUrl && (u.includes('127.0.0.1:9') || u.includes('evil')),
  );
  assert(evil.length === 0, `악성 URL을 fetch하면 안 된다: ${evil.join(', ')}`);
  const part0 = requested.filter((u) => u.includes('.wasm.part0'));
  assert(part0.length > 0, '상대 경로 파트0을 받아야 한다 (폴백 증거)');
  assert(
    part0.every((u) => u.startsWith(base)),
    `파트0은 같은 출처 상대 경로여야 한다: ${part0.join(', ')}`,
  );
}, { timeoutMs: 300000 });
