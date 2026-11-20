// browser-live nav 키 중계 종단 검증 (사용자 보고 2026-11-20:
// 브라우저 최대화 시 Ctrl+←/→ 미션컨트롤 전환이 안 먹힘).
//
// 체인: 실제 browser-live.js가 라이브 프레임 load 때 contentWindow에
// 캡처 단계 keydown 리스너를 걸고, Ctrl+←/→/↑를 셸에
// myhub:desktop-nav-key로 직접 postMessage한다. top 픽스처는
// windows.js onNavKeyMessage와 같은 출처 검증(앱 프레임에서 온
// 경우에만 수신)을 한다. 타이틀바를 클릭하지 않고 라이브 프레임 안
// 입력 칸에만 포커스를 둔 채 실제 키보드로 누른다.
// 뷰 페이지는 주입 없는 Selkies 대역(모듈 캡처 리스너)이라 서버
// 재시작 전 상태를 재현한다. 등록 순서 한계(Selkies 캡처 리스너가
// load 때 거는 이 리스너보다 먼저 등록됨) 때문에 원격도 키를 본다 —
// 이 e2e는 그 사실까지 단언한다. 사이드카 주입(재시작 후)이 그쪽을
// 막고 이 리스너보다 우선한다.
// 2단계는 카나리아: 중계 배선을 뺀 변이본을 서빙하면 셸로 아무것도
// 가지 않아야 한다 (이 시나리오가 중계 부재를 잡는지 증명한다).
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runScenario, attachErrorCollector, assert, assertEq } = require('./harness.cjs');

const LIVE_JS = path.resolve(__dirname, '..', '..', 'public', 'js', 'browser-live.js');

function buildViewHtml() {
  return (
    '<!doctype html><html lang="en"><head>' +
    '<meta charset="utf-8"><title>Selkies</title>' +
    '<script type="module">' +
    // 가짜 Selkies 클라이언트: window 캡처 단계 keydown 리스너.
    // 모듈이라 파싱 뒤에 실행되지만 iframe load(중계 부착)보다는
    // 먼저 등록된다 — 실제와 같은 등록 순서.
    'window.__selkiesKeys = [];' +
    'window.addEventListener("keydown", function (e) {' +
    'window.__selkiesKeys.push((e.ctrlKey ? "ctrl+" : "") + e.key);' +
    '}, true);' +
    '</script></head><body><input id="probe" type="text"><div id="app"></div></body></html>'
  );
}

function buildMutatedLiveJs() {
  const src = fs.readFileSync(LIVE_JS, 'utf8');
  const wiring = "      liveFrame.addEventListener('load', attachNavKeyRelay);\n";
  assert(src.includes(wiring), '변이 대상 배선 라인을 browser-live.js에서 찾지 못했다');
  const mutated = src.replace(wiring, '');
  assert(
    !mutated.includes("addEventListener('load', attachNavKeyRelay)"),
    '변이본에 중계 배선이 남아 있다',
  );
  return mutated;
}

async function runPhase(t, browser, { viewPath, fixturesDir, liveJsOverride }) {
  const fixtures = {
    '/navkey-live/top.html': path.join(fixturesDir, 'top.html'),
    '/navkey-live/app.html': path.join(fixturesDir, 'app.html'),
    '/navkey-live/view.html': viewPath,
  };
  if (liveJsOverride) fixtures['/js/browser-live.js'] = liveJsOverride;
  const { base } = await t.server({ fixtures });
  const { page } = await t.newPage(browser, { width: 1440, height: 900 });
  const errors = attachErrorCollector(page);
  await page.goto(`${base}/navkey-live/top.html`, { waitUntil: 'networkidle' });
  const viewFrame = () => page.frame({ url: /\/navkey-live\/view\.html$/ });
  // 뷰 프레임의 모듈 스크립트(가짜 Selkies)가 등록될 때까지 대기한다.
  for (let i = 0; i < 50; i++) {
    const vf = viewFrame();
    if (vf) {
      const ready = await vf.evaluate(() => typeof window.__selkiesKeys !== 'undefined').catch(() => false);
      if (ready) break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(viewFrame() !== null, '뷰 프레임이 열려야 한다');
  // load 이벤트(중계 부착)가 끝날 때까지 대기한다 — load 핸들러는
  // load 이벤트 디스패치 중에 동기적으로 돌므로, load 상태가 된
  // 뒤에는 중계가 붙어 있다.
  await viewFrame().waitForLoadState('load', { timeout: 10000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 200));

  const receivedKeys = () => page.evaluate(() => window.__receivedKeys.slice());
  const selkiesKeys = () => viewFrame().evaluate(() => window.__selkiesKeys.slice());

  // 라이브 프레임 안 입력 칸에 포커스 (타이틀바 클릭 없음).
  await page.frameLocator('#appFrame').frameLocator('#bwLiveFrame').locator('#probe').click();
  await page.keyboard.press('Control+ArrowLeft');
  await page.keyboard.press('Control+ArrowUp');
  return { page, errors, receivedKeys, selkiesKeys };
}

runScenario('browser-live-navkey', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'navkey-live-'));
  const viewPath = path.join(tmpDir, 'view.html');
  fs.writeFileSync(viewPath, buildViewHtml(), 'utf8');
  const mutatedPath = path.join(tmpDir, 'browser-live.mutated.js');
  fs.writeFileSync(mutatedPath, buildMutatedLiveJs(), 'utf8');

  const fixturesDir = path.join(__dirname, 'fixtures', 'navkey-live');
  const browser = await t.browser();

  // 1단계: 실제 browser-live.js — 중계가 동작한다.
  const p1 = await runPhase(t, browser, { viewPath, fixturesDir });
  await p1.page.waitForFunction(() => window.__receivedKeys.length === 2, { timeout: 5000 });
  assertEq((await p1.receivedKeys()).join(','), 'ArrowLeft,ArrowUp', 'Ctrl+←·Ctrl+↑가 셸까지 중계된다');

  // 일반 화살표·Ctrl+일반 키는 중계되지 않는다.
  await p1.page.keyboard.press('ArrowRight');
  await p1.page.keyboard.press('Control+KeyA');
  await new Promise((r) => setTimeout(r, 300));
  assertEq((await p1.receivedKeys()).join(','), 'ArrowLeft,ArrowUp', '일반 키는 셸로 중계되지 않는다');
  // 등록 순서 한계: Selkies도 Ctrl+화살표를 본다 (차단은 사이드카
  // 주입이 재시작 후 맡는다). 이 단언이 깨지면 전제가 바뀐 것이다.
  assertEq(
    (await p1.selkiesKeys()).join(','),
    'ctrl+Control,ctrl+ArrowLeft,ctrl+Control,ctrl+ArrowUp,ArrowRight,ctrl+Control,ctrl+a',
    'Selkies는 모든 키를 본다 (중계가 원격 전송을 막지는 못한다)',
  );
  assertEq(p1.errors.pageErrors.length, 0, `페이지 오류가 없어야 한다: ${p1.errors.pageErrors.slice(0, 3).join(' | ')}`);

  // 2단계 카나리아: 중계 배선을 뺀 변이본 — 셸로 아무것도 가지 않는다.
  const p2 = await runPhase(t, browser, { viewPath, fixturesDir, liveJsOverride: mutatedPath });
  await new Promise((r) => setTimeout(r, 500));
  assertEq((await p2.receivedKeys()).join(','), '', '중계 배선이 없으면 셸로 가지 않는다');
  assert(
    (await p2.selkiesKeys()).includes('ctrl+ArrowLeft'),
    '변이본에서는 Selkies만 키를 본다',
  );
  assertEq(p2.errors.pageErrors.length, 0, `변이본 페이지 오류가 없어야 한다: ${p2.errors.pageErrors.slice(0, 3).join(' | ')}`);
});
