// 한글 로딩 화면 검증: office.html 실제 경로(chromeFold: true)로 .hwpx를 열어
// .fv-hwp-loading 오버레이가 엔진 로드 전에 보이는지 확인한다.
// (2026-11-13 수정 38d30c6의 가드: 로딩 오버레이를 loadLib 뒤가 아니라 앞으로
// 이동해 빈 흰 화면 대신 정식 로딩 화면이 먼저 뜨게 했다.)
// 원본: .scratch/perf4/probe-hangul-loading.cjs
// 주의: 오버레이 세부 정보는 폴링에서 처음 본 순간에 함께 캡처한다 —
// 로딩이 끝나면 오버레이가 사라져 나중에 읽으면 null이 될 수 있다.
'use strict';

const path = require('path');
const { runScenario, waitForDesktop, throttleNetwork, assert, ROOT } = require('./harness.cjs');

async function readOverlay(frame) {
  return frame.evaluate(() => {
    const o = document.querySelector('.fv-hwp-loading');
    if (!o) return null;
    const r = o.getBoundingClientRect();
    const cs = getComputedStyle(o);
    return {
      title: o.querySelector('.fv-hwp-loading-title')?.textContent || null,
      status: o.querySelector('.fv-hwp-loading-status')?.textContent || null,
      spin: !!o.querySelector('.fv-hwp-loading-spin'),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      display: cs.display,
      bg: cs.backgroundColor,
    };
  });
}

runScenario('hangul-loading', async (t) => {
  const { base } = await t.server({
    fixtures: { '/probe/blank.hwpx': path.join(ROOT, 'public', 'templates', 'blank.hwpx') },
  });
  const browser = await t.browser();
  const { ctx, page } = await t.newPage(browser);
  // 스로틀링: 엔진 WASM 로딩이 오래 걸려 로딩 화면이 유지된다.
  await throttleNetwork(ctx, page);
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await waitForDesktop(page);
  await page.waitForTimeout(1000);

  await page.evaluate(() => window.MyHubDesktop.openModule('hangul'));
  const el = await page.waitForSelector('.dt-frame[src*="office.html"]', { timeout: 15000 });
  const frame = await el.contentFrame();
  await frame.waitForLoadState('load', { timeout: 60000 }).catch(() => null);
  await page.waitForTimeout(1500);

  // viewer.open을 await하면 로딩이 끝난 뒤에야 돌아오므로, 띄워만 두고
  // 로딩 중에 샘플링한다.
  await frame.evaluate(async () => {
    // office.js와 같은 조건: chromeFold true (오피스 앱 경로).
    const viewer = window.MyHubFinderViewer.createViewer({ doc: document, minimalChrome: true, chromeFold: true });
    const bytes = await fetch('/probe/blank.hwpx').then((r) => r.arrayBuffer());
    window.__hangulOpen = viewer.open({ fileId: 999, name: 'blank.hwpx', bytes });
    window.__hangulOpen.catch(() => {});
  });

  // 오버레이가 나타날 때까지 폴링 (최대 20초). 나타난 순간의 세부 정보를
  // 함께 캡처한다.
  let seen = null;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(500);
    seen = await readOverlay(frame);
    if (seen) break;
  }
  assert(seen, '한글 로딩 화면(.fv-hwp-loading)이 20초 안에 나타나지 않았다');
  assert(seen.title && seen.title.includes('한글'), `로딩 화면 제목에 '한글'이 있어야 한다 (실제: ${JSON.stringify(seen.title)})`);
  assert(seen.status && seen.status.length > 0, '로딩 화면 상태 문구가 있어야 한다');
  assert(seen.spin, '로딩 화면에 스피너(.fv-hwp-loading-spin)가 있어야 한다');
  assert(seen.display !== 'none', '로딩 화면이 display:none이면 안 된다');
  assert(seen.rect.w > 0 && seen.rect.h > 0, `로딩 화면이 보이는 크기를 가져야 한다 (실제: ${seen.rect.w}x${seen.rect.h})`);
  console.log(`  overlay: title=${JSON.stringify(seen.title)} status=${JSON.stringify(seen.status)} rect=${seen.rect.w}x${seen.rect.h} bg=${seen.bg}`);
}, { timeoutMs: 180000 });
