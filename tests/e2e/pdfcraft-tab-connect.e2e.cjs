// pdfcraft 탭-메뉴줄 연결 + 모드바 우측 버튼 정리 회귀 (2026-11-21 사용자 지적:
// "탭이 살짝 떠있는거같아" + "저장이랑 인쇄도 중복된거같고").
//
// 원인 (실측): 활성 탭이 줄 아래쪽에 1pt가량 못 미치고, 모드바 프레임의
// 상단 스트로크(divider 1pt)가 그 틈에 덧그려져 탭과 흰 메뉴줄 사이에
// 2px 회색 선이 남았다. 또 모드바 우측에 인쇄·저장·정보 버튼이 있어
// 셸 제목 줄의 저장·인쇄와 중복됐다. 엔진 패치(chrome.rs, downstream):
// 탭 배경을 줄 끝까지 늘이고, 모드바 프레임 스트로크를 빼 하단 구분선만
// 손으로 그리고, 인쇄·저장 버튼을 뺐다 (정보만 남는다).
//
// 이 테스트는 엔진을 실브라우저로 부팅해 문서를 열고 상단 영역을
// 스크린샷으로 찍어 픽셀로 단언한다:
//  1. 탭 열에서 탭 흰색과 메뉴줄 흰색 사이에 회색이 없다 (연결됨).
//  2. 모드바 하단 구분선은 그대로 있다 (상단만 뺀 것).
//  3. 모드바 우측 영역에 아이콘이 1개만 있다 (정보만, 인쇄·저장 없음).
// 기하는 이미지에서 직접 잰다 (줄 높이로 스케일을 유도) — 하네스의
// 2x 렌더링 quirks와 무관하게 동작한다.
// 카나리아: 패치 전 엔진에서는 1·3이 실패한다 (2px 틈, 아이콘 3개).
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { runScenario, attachErrorCollector, assert } = require('./harness.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const SHOT = path.join(__dirname, '..', '..', '.scratch', 'tab-gap', 'tab-connect-e2e.png');

function lum(data, channels, w, x, y) {
  const i = (y * w + x) * channels;
  return (data[i] + data[i + 1] + data[i + 2]) / 3;
}

runScenario('pdfcraft-tab-connect', async (t) => {
  const { base } = await t.server({
    fixtures: {
      '/probe/pdfcraft-tab-connect.html': path.join(__dirname, 'fixtures', 'pdfcraft-tab-connect.html'),
      '/probe/pdfcraft-tab-connect.js': path.join(__dirname, 'fixtures', 'pdfcraft-tab-connect.js'),
    },
  });
  const browser = await t.browser();
  const { page } = await t.newPage(browser, { width: 1280, height: 800 }, { deviceScaleFactor: 2 });
  const errors = attachErrorCollector(page);
  await page.goto(`${base}/probe/pdfcraft-tab-connect.html`, { waitUntil: 'load' });

  const deadline = Date.now() + 90000;
  let opened = false;
  let logText = '';
  while (Date.now() < deadline) {
    const log = await page.evaluate(() => window.__log || []).catch(() => []);
    logText = log.join('\n');
    if (/FALLBACK/.test(logText)) throw new Error('부팅 FALLBACK:\n' + logText.slice(-1500));
    if (/OPENED ok=true/.test(logText)) { opened = true; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert(opened, '문서가 열려야 한다:\n' + logText.slice(-1500));
  await new Promise((r) => setTimeout(r, 5000));
  const box = await page.evaluate(() => {
    const el = document.getElementById('host');
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  // 상단 200 CSS px: 탭 줄 + 모드바 + 하단 구분선까지.
  fs.mkdirSync(path.dirname(SHOT), { recursive: true });
  await page.screenshot({ path: SHOT, clip: { x: box.x, y: box.y, width: box.width, height: 200 } });
  const { data, info } = await sharp(SHOT).raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels } = info;
  const L = (x, y) => lum(data, channels, W, x, y);

  // 줄 경계: 탭도 우측 컨트롤도 없는 가운데 열에서 회색→흰색 전환.
  const cx = Math.floor(W * 0.7);
  let stripBottom = -1;
  for (let y = 0; y < H - 10; y++) {
    if (L(cx, y) < 245) continue;
    let white = true;
    for (let k = 0; k < 10; k++) if (L(cx, y + k) < 250) { white = false; break; }
    if (white) { stripBottom = y; break; }
  }
  assert(stripBottom > 20, `탭 줄 하단을 찾아야 한다 (cx=${cx})`);
  // 스케일: 탭 줄은 38pt.
  const scale = stripBottom / 38;

  // 탭 찾기: 줄 중간 행에서 회색이 아닌(흰 배경·글자·아이콘) 구간.
  const midY = Math.floor(stripBottom / 2);
  const isStripGray = (x) => { const l = L(x, midY); return l >= 225 && l < 245; };
  let tabLeft = -1;
  for (let x = Math.floor(40 * scale); x < W; x++) {
    if (!isStripGray(x)) { tabLeft = x; break; }
  }
  assert(tabLeft > 0, '탭 왼쪽 끝을 찾아야 한다');
  let tabRight = -1;
  let grayRun = 0;
  for (let x = tabLeft; x < W; x++) {
    if (isStripGray(x)) { grayRun++; if (grayRun >= Math.floor(10 * scale)) { tabRight = x - grayRun; break; } }
    else grayRun = 0;
  }
  assert(tabRight > tabLeft + 20 * scale, `탭 오른쪽 끝을 찾아야 한다 (left=${tabLeft})`);
  const tabX = Math.floor((tabLeft + tabRight) / 2);

  // 1. 탭-메뉴줄 연결: 줄 경계 앞뒤 밴드에 회색이 없어야 한다.
  const band = Math.max(3, Math.floor(2 * scale));
  let darkest = 255;
  let darkestY = -1;
  for (let y = stripBottom - band; y <= stripBottom + band; y++) {
    const l = L(tabX, y);
    if (l < darkest) { darkest = l; darkestY = y; }
  }
  assert(
    darkest >= 250,
    `탭 흰색이 메뉴줄 흰색과 이어져야 한다 (tabX=${tabX}, 경계 y=${stripBottom}, ` +
    `가장 어두운 픽셀 y=${darkestY} 휘도=${darkest.toFixed(0)} — 패치 전에는 divider 232가 여기 있다)`,
  );

  // 2. 모드바 하단 구분선 (회귀 가드): 모드바는 48pt. 그 하단 경계 행이
  // 너비 대부분에 걸쳐 divider 색이어야 한다 — 상단 스트로크를 뺄 때
  // 하단 구분선까지 잃으면 안 된다. 패치 전후 모두 통과해야 한다.
  const modeBottom = Math.floor(stripBottom + 48 * scale);
  let bestFrac = 0;
  for (let y = modeBottom - Math.floor(2 * scale); y <= modeBottom + Math.floor(2 * scale) && y < H; y++) {
    let div = 0;
    let total = 0;
    for (let x = Math.floor(W * 0.1); x < Math.floor(W * 0.9); x++) {
      total++;
      const l = L(x, y);
      if (l >= 225 && l < 245) div++;
    }
    bestFrac = Math.max(bestFrac, div / total);
  }
  assert(bestFrac > 0.8, `모드바 하단 구분선이 너비 대부분을 덮어야 한다 (최대 비율 ${(bestFrac * 100).toFixed(0)}%, 예상 y≈${modeBottom})`);

  // 3. 모드바 우측 아이콘 개수: 정보 1개만. (패치 전에는 인쇄·저장·정보 3개.)
  // 모드바 중간 밴드에서 우측 200 CSS px 안의 어두운 덩어리를 센다.
  const modeMidY = Math.floor(stripBottom + 24 * scale);
  const bandH = Math.floor(16 * scale);
  // 우측 버튼 영역: 버튼 3개분(116pt)에 여유를 둔 140pt. 검색 상자의
  // 오른쪽 빈 필드가 들어갈 수 있지만 글자·아이콘은 상자 왼쪽에 있다.
  const right0 = W - Math.floor(140 * scale);
  // 어두운 덩어리를 flood fill로 모은 뒤, 8pt 안에 있는 조각은 한
  // 아이콘으로 합친다 (프린터 아이콘의 분리된 부분 같은 것). 아이콘
  // 사이 간격은 21pt라 합쳐지지 않는다. 최소 크기는 스케일 연동.
  const seen = new Set();
  const parts = [];
  const key = (x, y) => y * W + x;
  for (let y = modeMidY - bandH; y <= modeMidY + bandH; y++) {
    for (let x = right0; x < W; x++) {
      if (L(x, y) >= 128 || seen.has(key(x, y))) continue;
      let size = 0;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      const stack = [[x, y]];
      seen.add(key(x, y));
      while (stack.length) {
        const [cx2, cy2] = stack.pop();
        size++;
        if (cx2 < minX) minX = cx2;
        if (cx2 > maxX) maxX = cx2;
        if (cy2 < minY) minY = cy2;
        if (cy2 > maxY) maxY = cy2;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx2 + dx;
            const ny = cy2 + dy;
            if (nx < right0 || nx >= W || ny < modeMidY - bandH || ny > modeMidY + bandH) continue;
            if (seen.has(key(nx, ny))) continue;
            if (L(nx, ny) < 128) { seen.add(key(nx, ny)); stack.push([nx, ny]); }
          }
        }
      }
      parts.push({ size, minX, maxX, minY, maxY });
    }
  }
  const mergeGap = 8 * scale;
  const groups = [];
  for (const p of parts) {
    let g = groups.find(
      (q) =>
        p.minX - q.maxX <= mergeGap && q.minX - p.maxX <= mergeGap &&
        p.minY - q.maxY <= mergeGap && q.minY - p.maxY <= mergeGap,
    );
    if (!g) { g = { size: 0, minX: p.minX, maxX: p.maxX, minY: p.minY, maxY: p.maxY }; groups.push(g); }
    g.size += p.size;
    g.minX = Math.min(g.minX, p.minX);
    g.maxX = Math.max(g.maxX, p.maxX);
    g.minY = Math.min(g.minY, p.minY);
    g.maxY = Math.max(g.maxY, p.maxY);
  }
  // 아이콘 판정: 15pt 글리프(높이 약 13pt 이상)만 센다. 검색 상자 오른편의
  // 'Ctrl+K' 힌트 글자(높이 약 8pt)는 크기가 작아 아이콘이 아니다 — 패치로
  // 상자가 오른쪽으로 늘면서 힌트 전체가 영역 안에 들어와 합쳐진 크기가
  // 아이콘과 비슷해졌기 때문에 높이로 가른다.
  const blobs = groups.filter(
    (g) => g.size >= 10 * scale * scale && g.maxY - g.minY >= 10 * scale,
  ).length;
  assert(blobs === 1, `모드바 우측에 아이콘이 1개(정보)만 있어야 한다 (측정: ${blobs}개)`);
  assert(
    (errors.consoleErrors || []).length === 0,
    '콘솔 오류가 없어야 한다: ' + (errors.consoleErrors || []).join(' | '),
  );
}, { timeoutMs: 180000 });
