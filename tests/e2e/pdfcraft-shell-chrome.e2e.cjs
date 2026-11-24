// pdfcraft 셸 크롬 통합 회귀 (2026-11-22 사용자 결정: 메뉴 줄 정리).
//
// 오피스 PDF는 창에 제목 줄+탭 줄만 남기고 엔진 모드바 행을 없앤다
// (chrome=nomodebar,noabsorb). 모드 탭·메뉴는 셸 JN 상단바로, 검색·
// 정보는 제목 줄로 옮기므로, 엔진은 모드바 행 없이도 모드·메뉴 상태를
// 보고하고 셸의 모드 전환·메뉴 명령을 받아야 한다.
//
// 이 테스트는 호스트 URL로 엔진을 실브라우저로 부팅해 빈 문서를 열고
// 단언한다:
//  1. 모드바 행이 없다: 탭 줄 아래 구간에 검색 상자 글자·아이콘이
//     없다 (모드바가 있으면 그 자리에 검색 상자가 그려진다).
//  2. 탭 줄에 흡수가 없다: 검색 상자·정보 버튼이 탭 줄에 그려지지
//     않는다 (noabsorb).
//  3. 엔진이 모드·메뉴 상태를 보고한다 (MODE-STATE·MENUS-STATE).
//  4. 셸의 모드 전환(pdfcraft:mode)이 동작한다.
//  5. 셸의 메뉴 명령이 동작한다: view.palette로 명령 팔레트가 열리고
//     다시 닫히며, file.properties로 문서 속성 대화상자가 열린다.
// 기하는 이미지에서 직접 잰다 (줄 높이로 스케일을 유도).
// 카나리아: noabsorb를 빼면 2가 실패하고, nomodebar를 빼면 1이
// 실패하며, 메뉴 명령 채널을 끊으면 4·5가 실패한다.
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { runScenario, attachErrorCollector, assert } = require('./harness.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const SHOT = path.join(__dirname, '..', '..', '.scratch', 'shell-chrome', 'shell-chrome-e2e.png');

function lum(data, channels, w, x, y) {
  const i = (y * w + x) * channels;
  return (data[i] + data[i + 1] + data[i + 2]) / 3;
}

async function logTextOf(page) {
  const log = await page.evaluate(() => window.__log || []).catch(() => []);
  return log.join('\n');
}

async function waitForLog(page, re, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    text = await logTextOf(page);
    if (re.test(text)) return text;
    if (/FALLBACK/.test(text)) throw new Error('부팅 FALLBACK:\n' + text.slice(-1500));
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what} 로그가 오지 않았다:\n` + text.slice(-1500));
}

// 가운데 영역(가로·세로 각 30%~70%)의 휘도 맵을 뽑는다 —
// 다이얼로그 열림·닫힘을 픽셀 변화율로 잰다.
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

runScenario('pdfcraft-shell-chrome', async (t) => {
  const { base } = await t.server({
    fixtures: {
      '/probe/pdfcraft-shell-chrome.html': path.join(__dirname, 'fixtures', 'pdfcraft-shell-chrome.html'),
      '/probe/pdfcraft-shell-chrome.js': path.join(__dirname, 'fixtures', 'pdfcraft-shell-chrome.js'),
    },
  });
  const browser = await t.browser();
  const { page } = await t.newPage(browser, { width: 1280, height: 800 }, { deviceScaleFactor: 2 });
  const errors = attachErrorCollector(page);
  await page.goto(`${base}/probe/pdfcraft-shell-chrome.html`, { waitUntil: 'load' });

  const logText = await waitForLog(page, /OPENED ok=true/, 90000, 'OPENED');
  assert(!/FALLBACK/.test(logText), '부팅 FALLBACK이 없어야 한다');
  await waitForLog(page, /MODE-STATE all/, 10000, 'MODE-STATE all');
  const menusLog = await waitForLog(page, /MENUS-STATE/, 10000, 'MENUS-STATE');
  await new Promise((r) => setTimeout(r, 3000));

  // 3. 메뉴 상태: 파일·편집·보기 메뉴가 보고된다.
  const menusLine = (menusLog.match(/MENUS-STATE .*/) || [''])[0];
  for (const id of ['file', 'edit', 'view']) {
    assert(menusLine.includes(id), `MENUS-STATE에 ${id} 메뉴가 있어야 한다 (보고: ${menusLine})`);
  }

  const box = await page.evaluate(() => {
    const el = document.getElementById('host');
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  fs.mkdirSync(path.dirname(SHOT), { recursive: true });
  await page.screenshot({ path: SHOT, clip: { x: box.x, y: box.y, width: box.width, height: 220 } });
  const { data, info } = await sharp(SHOT).raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels } = info;
  const L = (x, y) => lum(data, channels, W, x, y);

  // 탭 줄 하단: 왼쪽 열(사이드바 위)에서 탭 줄 회색이 끝나는 지점.
  // 사이드바 패널은 흰색이라 회색→흰색 전환이 줄 경계다.
  const cx = Math.floor(W * 0.05);
  let stripBottom = -1;
  for (let y = 0; y < H - 10; y++) {
    if (L(cx, y) < 245) continue;
    let white = true;
    for (let k = 0; k < 10; k++) if (L(cx, y + k) < 250) { white = false; break; }
    if (white) { stripBottom = y; break; }
  }
  assert(stripBottom > 20, `탭 줄 하단을 찾아야 한다 (cx=${cx})`);
  const scale = stripBottom / 38;

  // 1. 모드바 행이 없다: 탭 줄 아래 구간(모드바가 있던 자리)에 검색
  // 상자가 없어야 한다. 모드바가 있으면 검색 상자 글자·아이콘이 이
  // 구간 오른쪽에 어두운 픽셀로 그려진다 (전체 레이아웃 실측 2645개).
  // 휘도로는 못 가른다 — 사이드바·페이지도 희고 캔버스도 밝기 때문.
  let modeBarDark = 0;
  for (let y = Math.floor(stripBottom + 5 * scale); y <= Math.floor(stripBottom + 35 * scale); y++) {
    for (let x = Math.floor(W * 0.55); x < Math.floor(W * 0.85); x++) {
      if (L(x, y) < 128) modeBarDark++;
    }
  }
  assert(
    modeBarDark === 0,
    `탭 줄 아래에 모드바(검색 상자)가 없어야 한다 (어두운 픽셀 ${modeBarDark}개 — 전체 레이아웃이면 2645개)`,
  );

  // 2. 탭 줄에 흡수가 없다: 줄 중간 밴드에서 가운데~오른쪽 구간에
  // 어두운 픽셀(검색 상자 글자·정보 아이콘)이 없어야 한다. 흡수가
  // 있으면 검색 상자(~200pt)가 이 구간에 들어간다.
  const bandTop = Math.floor(stripBottom * 0.3);
  const bandBottom = Math.floor(stripBottom * 0.7);
  let dark = 0;
  for (let y = bandTop; y <= bandBottom; y++) {
    for (let x = Math.floor(W * 0.5); x < Math.floor(W * 0.8); x++) {
      if (L(x, y) < 128) dark++;
    }
  }
  assert(dark === 0, `탭 줄에 흡수된 검색 상자·버튼이 없어야 한다 (어두운 픽셀 ${dark}개)`);

  // 4. 모드 전환: 편집 모드로 보내면 엔진이 edit을 보고한다.
  await page.evaluate(() => window.__pdfcraftHost.sendMode('edit'));
  await waitForLog(page, /MODE-STATE edit/, 10000, 'MODE-STATE edit');

  // 5. 메뉴 명령: 팔레트 열기→닫기, 속성 대화상자 열기.
  // 대화상자는 흰 패널이라 흰 페이지 위에서는 휘도 변화가 작다
  // (팔레트 열림 실측 7% — 글자·아이콘·선택 행만 바뀐다). 열림
  // 기준은 3%, 닫힘 기준은 5%로 — 안 열리면 0%라 가려진다.
  const before = await centerLums(page, box);
  await page.evaluate(() => window.__pdfcraftHost.sendMenuCommand('view.palette'));
  await new Promise((r) => setTimeout(r, 1200));
  const paletteOpen = await centerLums(page, box);
  const openFrac = changedFrac(before, paletteOpen);
  assert(openFrac > 0.03, `팔레트가 열리면 가운데가 바뀌어야 한다 (변화율 ${(openFrac * 100).toFixed(0)}% — 안 열리면 0%)`);
  // 닫기는 첫 행(선택 도구) 클릭으로 — 팔레트가 열려 있는 동안은
  // 메뉴 게이트(modal)가 모든 메뉴 명령을 막아 view.palette 재전송이
  // 무효다 (menus.rs menu_gate, upstream 동작). Escape 키는 하네스에서
  // iframe 안까지 닿지 않았고, 행 선택은 실제 사용자 흐름이면서
  // 팔레트를 닫는다 (palette.rs). '선택'은 이미 선택된 도구라 화면이
  // 닫히기 전 상태로 돌아간다.
  await page.mouse.click(640, 135);
  await new Promise((r) => setTimeout(r, 800));
  const paletteClosed = await centerLums(page, box);
  const closeFrac = changedFrac(before, paletteClosed);
  assert(closeFrac < 0.05, `팔레트를 닫으면 가운데가 원래대로 돌아와야 한다 (변화율 ${(closeFrac * 100).toFixed(0)}%)`);

  await page.evaluate(() => window.__pdfcraftHost.sendMenuCommand('file.properties'));
  await new Promise((r) => setTimeout(r, 1200));
  const propsOpen = await centerLums(page, box);
  const propsFrac = changedFrac(paletteClosed, propsOpen);
  assert(propsFrac > 0.03, `문서 속성을 열면 가운데가 바뀌어야 한다 (변화율 ${(propsFrac * 100).toFixed(0)}% — 안 열리면 0%)`);

  assert(
    (errors.consoleErrors || []).length === 0,
    '콘솔 오류가 없어야 한다: ' + (errors.consoleErrors || []).join(' | '),
  );
}, { timeoutMs: 180000 });
