// 뷰 iframe Ctrl+화살표 → 셸 중계 종단 검증 (사용자 보고 2026-11-20:
// 브라우저 최대화 시 Ctrl+←/→ 미션컨트롤 전환이 안 먹힘).
//
// 체인: 사이드카가 Selkies 뷰 페이지 <head> 뒤에 주입한 스크립트
// (sidecar.js NAV_KEY_RELAY_SCRIPT, 실제 코드를 읽어 쓴다 — 복사본 아님)
// → Ctrl+화살표를 캡처 단계에서 가로채 원격 전송을 막고
// myhub:desktop-nav-key로 부모에 전달 → 실제 nav.js 중계 → 셸 수신.
// 가짜 Selkies 리스너는 모듈 스크립트(지연 실행)로 등록해 실제와 같은
// 등록 순서(주입 스크립트 먼저, Selkies 나중)를 재현한다.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runScenario, attachErrorCollector, assert, assertEq } = require('./harness.cjs');

const SIDECAR = '/home/hatch/workspace/oci-tools/bootstrap/sidecar/sidecar.js';

function extractInjectedScript() {
  const src = fs.readFileSync(SIDECAR, 'utf8');
  const m = src.match(/const NAV_KEY_RELAY_SCRIPT =\n([\s\S]*?);\n/);
  if (!m) throw new Error('NAV_KEY_RELAY_SCRIPT를 sidecar.js에서 찾지 못했다');
  // 문자열 연결 표현식 그대로 평가해 실제 주입 스크립트를 얻는다.
  const script = eval(m[1]); // eslint-disable-line no-eval
  if (typeof script !== 'string' || !script.includes('myhub:desktop-nav-key')) {
    throw new Error('추출한 주입 스크립트가 올바르지 않다');
  }
  return script;
}

function buildViewHtml(injected) {
  return (
    '<!doctype html><html lang="en"><head>' +
    injected +
    '<meta charset="utf-8"><title>Selkies</title>' +
    '<script type="module">' +
    // 가짜 Selkies 클라이언트: window 캡처 단계 keydown 리스너.
    // 모듈이라 파싱 뒤에 실행돼 주입 스크립트보다 나중에 등록된다.
    'window.__selkiesKeys = [];' +
    'window.addEventListener("keydown", function (e) {' +
    'window.__selkiesKeys.push((e.ctrlKey ? "ctrl+" : "") + e.key);' +
    '}, true);' +
    '</script></head><body><input id="probe" type="text"><div id="app"></div></body></html>'
  );
}

runScenario('browser-navkey-relay', async (t) => {
  const injected = extractInjectedScript();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'navkey-view-'));
  const viewPath = path.join(tmpDir, 'view.html');
  fs.writeFileSync(viewPath, buildViewHtml(injected), 'utf8');

  const fixturesDir = path.join(__dirname, 'fixtures', 'navkey');
  const { base } = await t.server({
    fixtures: {
      '/navkey/top.html': path.join(fixturesDir, 'top.html'),
      '/navkey/app.html': path.join(fixturesDir, 'app.html'),
      '/navkey/view.html': viewPath,
    },
  });
  const browser = await t.browser();
  const { page } = await t.newPage(browser, { width: 1440, height: 900 });
  const errors = attachErrorCollector(page);
  await page.goto(`${base}/navkey/top.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => document.getElementById('appFrame') && document.getElementById('appFrame').contentWindow,
    { timeout: 10000 },
  );
  const viewFrame = () => page.frame({ url: /\/navkey\/view\.html$/ });
  // 뷰 iframe의 모듈 스크립트(가짜 Selkies)가 등록될 때까지 대기한다.
  for (let i = 0; i < 50; i++) {
    const vf = viewFrame();
    if (vf) {
      const ready = await vf.evaluate(() => typeof window.__selkiesKeys !== 'undefined').catch(() => false);
      if (ready) break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(viewFrame() !== null, '뷰 프레임이 열려야 한다');

  const receivedKeys = () => page.evaluate(() => window.__receivedKeys.slice());
  const selkiesKeys = async () => {
    const vf = viewFrame();
    return vf.evaluate(() => window.__selkiesKeys.slice());
  };

  // 뷰 안의 입력 칸에 포커스를 두고 실제 키보드로 Ctrl+←를 누른다.
  await page.frameLocator('#appFrame').frameLocator('#viewFrame').locator('#probe').click();
  await page.keyboard.press('Control+ArrowLeft');
  await page.waitForFunction(() => window.__receivedKeys.length === 1, { timeout: 5000 });
  assertEq((await receivedKeys()).join(','), 'ArrowLeft', 'Ctrl+←가 셸까지 중계된다');
  // Control 키 자체의 keydown은 Selkies에 가야 한다 (수식자 상태 유지) —
  // 가로채는 건 Ctrl+화살표 조합이지 Control 단독이 아니다.
  assertEq((await selkiesKeys()).join(','), 'ctrl+Control', 'Ctrl+← 화살표는 Selkies에 닿지 않는다');

  // Ctrl+↑도 같은 경로로 중계된다.
  await page.keyboard.press('Control+ArrowUp');
  await page.waitForFunction(() => window.__receivedKeys.length === 2, { timeout: 5000 });
  assertEq((await receivedKeys()).join(','), 'ArrowLeft,ArrowUp', 'Ctrl+↑가 셸까지 중계된다');
  assertEq((await selkiesKeys()).join(','), 'ctrl+Control,ctrl+Control', 'Ctrl+↑ 화살표도 Selkies에 닿지 않는다');

  // Ctrl 없는 일반 화살표는 중계되지 않고 Selkies에 그대로 간다.
  await page.keyboard.press('ArrowRight');
  await new Promise((r) => setTimeout(r, 300));
  assertEq((await receivedKeys()).join(','), 'ArrowLeft,ArrowUp', '일반 화살표는 셸로 중계되지 않는다');
  assertEq((await selkiesKeys()).join(','), 'ctrl+Control,ctrl+Control,ArrowRight', '일반 화살표는 Selkies에 그대로 간다');

  assertEq(errors.pageErrors.length, 0, `페이지 오류가 없어야 한다: ${errors.pageErrors.slice(0, 3).join(' | ')}`);
});
