// pdfcraft 셸 메뉴 버튼 클래스 + 속성 대화상자 Escape 회귀 (2026-11-25).
//
// 2026-11-25 표면 점검에서 발견된 두 결함을 풀 데스크톱에서 검증한다:
//  1. 셸 메뉴 닫힘 시 탭 버튼 기본 클래스 소실 — markOfficeMenuBtnClosed가
//     dt-office-tab을 지워 메뉴를 열고 닫은 뒤 버튼이 스타일을 잃었다.
//     이제 열림 표시는 is-expanded로만 하고 기본 클래스는 남아야 한다
//     (미션 계약이 windows.js에서 is-open 문자열을 금지한다).
//  2. 속성 대화상자 Escape 포커스 — 셸 정보 버튼으로 대화상자를 연 직후
//     포커스가 셸 버튼에 있어 Escape이 엔진에 안 닿았다. 이제 명령 뒤에
//     엔진 프레임으로 포커스를 옮기므로, 캔버스를 클릭하지 않고 Escape만
//     눌러도 대화상자가 닫혀야 한다.
//
// 카나리아: markOfficeMenuBtnClosed를 옛날처럼 remove('dt-office-tab')로
// 되돌리면 1이 실패하고, onQuick의 frame.focus()를 빼면 2가 실패한다.
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const {
  runScenario,
  waitForDesktop,
  attachErrorCollector,
  assert,
} = require('./harness.cjs');

const FILES = [
  { id: 101, filename: 'probe.pdf', mime: 'application/pdf', folder_id: 1, size: 12345, created_at: '2026-11-13T00:00:00Z', version: 1 },
];

const SHOT_DIR = path.join(__dirname, '..', '..', '.scratch', 'shell-menu-escape');

// 가운데 영역(가로·세로 각 30%~70%)의 휘도 맵 — 다이얼로그 열림·닫힘을
// 픽셀 변화율로 잰다 (pdfcraft-shell-chrome.e2e.cjs와 동일).
async function centerLums(page, box) {
  const clip = {
    x: box.x + box.width * 0.3,
    y: box.y + box.height * 0.3,
    width: box.width * 0.4,
    height: box.height * 0.4,
  };
  const buf = await page.screenshot({ clip });
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const out = new Float32Array(info.width * info.height);
  for (let i = 0; i < out.length; i++) {
    out[i] = (data[i * info.channels] + data[i * info.channels + 1] + data[i * info.channels + 2]) / 3;
  }
  return { lums: out, width: info.width, height: info.height };
}

function changedFrac(a, b) {
  assert(a.width === b.width && a.height === b.height, '비교할 두 캡처의 크기가 같아야 한다');
  let changed = 0;
  for (let i = 0; i < a.lums.length; i++) {
    if (Math.abs(a.lums[i] - b.lums[i]) > 20) changed++;
  }
  return changed / a.lums.length;
}

runScenario('pdfcraft-shell-menu-escape', async (t) => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const { base } = await t.server({ driveFiles: FILES });
  const browser = await t.browser();
  const { page } = await t.newPage(browser, { width: 1440, height: 900 });
  const errors = attachErrorCollector(page);
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await waitForDesktop(page);
  await page.waitForSelector('.dt-desk-icon.is-file', { timeout: 15000 });
  await page.waitForTimeout(800);
  await page.locator('.dt-desk-icon.is-file[data-file-id="101"]').dblclick();
  await page.waitForSelector('.dt-frame[src*="office.html?app=pdf"]', { timeout: 15000 });
  await page.waitForSelector('#dt-office-tabs button[data-tab^="menu:"]', { timeout: 150000 });
  await page.waitForTimeout(2000);

  // --- 1. 메뉴 버튼 기본 클래스 유지 ---
  const fileBtn = page.locator('#dt-office-tabs button[data-tab="menu:file"]');
  const clsBefore = await fileBtn.evaluate((el) => el.className);
  assert(clsBefore.includes('dt-office-tab'), `열기 전 기본 클래스가 있어야 한다: ${clsBefore}`);
  assert(clsBefore.includes('has-menu'), `메뉴 버튼에는 has-menu가 있어야 한다: ${clsBefore}`);
  await fileBtn.click();
  await page.waitForSelector('.dt-ctx-menu', { timeout: 10000 });
  const clsOpen = await fileBtn.evaluate((el) => el.className);
  assert(clsOpen.includes('is-expanded'), `열린 동안 is-expanded가 붙어야 한다: ${clsOpen}`);
  assert(clsOpen.includes('dt-office-tab'), `열린 동안 기본 클래스가 남아 있어야 한다: ${clsOpen}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  const clsAfter = await fileBtn.evaluate((el) => el.className);
  assert(clsAfter.includes('dt-office-tab'), `닫은 뒤 기본 클래스가 남아 있어야 한다: ${clsAfter}`);
  assert(clsAfter.includes('has-menu'), `닫은 뒤 has-menu가 남아 있어야 한다: ${clsAfter}`);
  assert(!clsAfter.includes('is-expanded'), `닫은 뒤 is-expanded가 사라져야 한다: ${clsAfter}`);

  // --- 2. 정보 버튼으로 연 속성 대화상자가 캔버스 클릭 없이 Escape으로 닫힌다 ---
  const officeFrame = page.frames().find((f) => /office\.html/.test(f.url()));
  const craftEl = await officeFrame.$('.fv-pdfcraft-frame');
  assert(craftEl, 'pdfcraft 프레임을 찾지 못했다');
  const craftBox = await craftEl.boundingBox();
  assert(craftBox && craftBox.width > 100, 'craft 프레임 크기를 재지 못했다');

  const closedLums = await centerLums(page, craftBox);
  await page.locator('.dt-window[data-module="pdf"] .myhub-win-quick button[title="문서 속성"]').first().click();
  await page.waitForTimeout(1500);
  const openLums = await centerLums(page, craftBox);
  const openFrac = changedFrac(closedLums, openLums);
  assert(openFrac > 0.03, `대화상자가 열리면 가운데가 바뀌어야 한다 (변화율 ${(openFrac * 100).toFixed(1)}%)`);
  await page.screenshot({ path: path.join(SHOT_DIR, 'props-open.png') });

  // 캔버스를 클릭하지 않고 Escape만 누른다 — 수정 전에는 포커스가 셸
  // 버튼에 남아 대화상자가 닫히지 않았다.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1200);
  const afterEsc = await centerLums(page, craftBox);
  const escFrac = changedFrac(openLums, afterEsc);
  const backFrac = changedFrac(closedLums, afterEsc);
  assert(escFrac > 0.03, `Escape 후 대화상자가 닫혀 화면이 바뀌어야 한다 (변화율 ${(escFrac * 100).toFixed(1)}%)`);
  assert(backFrac < 0.05, `Escape 후 대화상자 열기 전 상태로 돌아와야 한다 (잔차 ${(backFrac * 100).toFixed(1)}%)`);
  await page.screenshot({ path: path.join(SHOT_DIR, 'props-after-escape.png') });

  assert(
    (errors.pageErrors || []).length === 0,
    '페이지 오류가 없어야 한다: ' + (errors.pageErrors || []).join(' | '),
  );
  // favicon.ico 404는 하네스 서버가 파비콘을 서빙하지 않는 기존 아티팩트라
  // 제외한다 (locale.json 404는 아래에서 별도로 단언한다).
  const consoleErrors = (errors.consoleErrors || []).filter(
    (e) => !e.includes('favicon.ico') && !e.includes('Failed to load resource'),
  );
  assert(
    consoleErrors.length === 0,
    '콘솔 오류가 없어야 한다: ' + consoleErrors.join(' | '),
  );
  // 항목 8: locale.json이 있으면 PDF를 열 때 404가 나지 않는다.
  assert(
    !(errors.httpErrors || []).some((e) => e.includes('locale/locale.json')),
    'locale.json 404가 없어야 한다: ' + (errors.httpErrors || []).join(' | '),
  );
}, { timeoutMs: 300000 });
