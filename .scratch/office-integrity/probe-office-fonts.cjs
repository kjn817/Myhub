// 오피스 폰트 렌더링 프로브 (Excel·PPT·한글).
// 폰트 픽스처(font-xlsx/font-pptx/font-hwpx)를 office.html로 열어
// 실브라우저 스크린샷을 찍고, 엔진에 푸시되는 폰트 목록(풀+사용자)을
// postMessage로 확인한다. Drive '폰트' 폴더에는 TestUserFont.otf를
// 스텁으로 넣어 사용자 폰트 로딩 경로를 검증한다.
// 실행: node probe-office-fonts.cjs [excel|ppt|hangul|all] (myhub 트리 안에서)
'use strict';

const fs = require('fs');
const path = require('path');
const { createServer, launchBrowser } = require('../../tests/e2e/harness.cjs');

const DIR = __dirname;
const SHOTS = path.join(DIR, 'shots');
const FIX = path.join(DIR, 'fixtures');
const OUT = path.join(DIR, 'out');

// USER_FONT=small 이면 사용자 폰트로 133KB DancingScript를 쓴다
// (16MB CJK 폰트와의 타이밍 대조용).
const USER_FONT_SMALL = process.env.USER_FONT === 'small';
const STORE = {
  11: { name: 'font-xlsx.xlsx', bytes: fs.readFileSync(path.join(FIX, 'font-xlsx.xlsx')), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  12: { name: 'font-pptx.pptx', bytes: fs.readFileSync(path.join(FIX, 'font-pptx.pptx')), mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  13: { name: 'font-hwpx.hwpx', bytes: fs.readFileSync(path.join(FIX, 'font-hwpx.hwpx')), mime: 'application/hwp+zip' },
  98: USER_FONT_SMALL
    ? { name: 'TestUserFont.ttf', bytes: fs.readFileSync(path.join(FIX, 'TestUserFont-small.ttf')), mime: 'font/ttf' }
    : { name: 'TestUserFont.otf', bytes: fs.readFileSync('/tmp/NotoSansCJK-KR-Bold.otf'), mime: 'font/otf' },
};
const FONT_FOLDER_ID = 99;

function extractFilePart(body, contentType) {
  const m = /boundary=([^\s;]+)/.exec(contentType || '');
  if (!m) return null;
  const boundary = Buffer.from('--' + m[1].replace(/"/g, ''));
  const nameIdx = body.indexOf('name="file"');
  if (nameIdx < 0) return null;
  const headEnd = body.indexOf('\r\n\r\n', nameIdx);
  if (headEnd < 0) return null;
  const start = headEnd + 4;
  const end = body.indexOf(Buffer.concat([Buffer.from('\r\n'), boundary]), start);
  if (end < 0) return null;
  return body.subarray(start, end);
}

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('TIMEOUT: ' + label);
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function runApp(app, browser, base) {
  const spec = {
    excel: { id: 11, app: 'excel', readyType: 'gridcraft:ready', fontsType: 'gridcraft:fonts' },
    ppt: { id: 12, app: 'powerpoint', readyType: 'deckcraft:ready', fontsType: 'deckcraft:fonts' },
    hangul: { id: 13, app: 'hangul', readyType: null, fontsType: null },
  }[app];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = { pageErrors: [], consoleErrors: [], failedRequests: [] };
  page.on('pageerror', (e) => errors.pageErrors.push(String((e && e.message) || e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors.consoleErrors.push(m.text().slice(0, 200)); });
  page.on('response', (res) => { if (res.status() >= 400) errors.failedRequests.push(`${res.status()} ${res.url()}`); });

  await page.addInitScript(() => {
    window.__msgs = [];
    window.addEventListener('message', (e) => {
      try {
        const d = e.data || {};
        if (typeof d.type !== 'string') return;
        const rec = { type: d.type, t: Date.now() };
        if (d.fonts && Array.isArray(d.fonts)) {
          rec.families = d.fonts.map((f) => `${f.family}:${f.weight || ''}`).sort();
        }
        if (d.type === 'myhub:office-ready') rec.app = d.app || null;
        if ((d.type === 'myhub-sheet:snapshot' || d.type === 'gridcraft:snapshot-result') && d.snapshot) {
          const cells = d.snapshot.cells || [];
          rec.cellRows = Array.isArray(cells) ? cells.length : 0;
          rec.firstRow = Array.isArray(cells) && cells[0] ? JSON.stringify(cells[0]).slice(0, 300) : null;
        }
        window.__msgs.push(rec);
      } catch (err) { /* 무시 */ }
    });
  });

  await page.route('**/api/drive/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method();
    if (url.pathname === '/api/drive/list') {
      const folder = url.searchParams.get('folder');
      if (folder && Number(folder) === FONT_FOLDER_ID) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, files: [{ id: 98, filename: STORE[98].name, mime: STORE[98].mime, size: STORE[98].bytes.length }] }) });
        return;
      }
      const files = Object.entries(STORE)
        .filter(([id]) => Number(id) !== 98)
        .map(([id, f]) => ({ id: Number(id), filename: f.name, mime: f.mime, size: f.bytes.length, version: 'v1' }));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, folders: [{ id: FONT_FOLDER_ID, name: '폰트' }], files }) });
      return;
    }
    const id = parts[3] ? decodeURIComponent(parts[3]) : null;
    const isContent = parts[4] === 'content';
    if (method === 'GET' && isContent && STORE[id]) {
      await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: STORE[id].bytes });
      return;
    }
    if (method === 'GET' && id && STORE[id]) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id, name: STORE[id].name, version: 'v1' }) });
      return;
    }
    if (method === 'PUT' && isContent && STORE[id]) {
      const body = req.postDataBuffer();
      const fileBytes = extractFilePart(body, req.headers()['content-type']);
      if (fileBytes) STORE[id].bytes = Buffer.from(fileBytes);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 'v2' }) });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });

  const result = { app, errors };
  const t0 = Date.now();
  const file = STORE[spec.id];
  await page.goto(
    `${base}/office.html?app=${spec.app}&file=${spec.id}&name=${encodeURIComponent(file.name)}&mime=${encodeURIComponent(file.mime)}`,
    { waitUntil: 'load' },
  );

  // 모든 프레임의 __msgs를 합친다 (addInitScript는 전 프레임에 적용됨).
  // gridcraft:ready는 엔진→시트 호스트, gridcraft:fonts는 호스트→엔진으로
  // 가므로 최상위 프레임만 봐서는 잡히지 않는다.
  const msgs = async () => {
    const all = [];
    for (const f of page.frames()) {
      try {
        const list = await f.evaluate(() => window.__msgs || []);
        all.push(...list);
      } catch (e) { /* 접근 불가 프레임 무시 */ }
    }
    return all;
  };
  try {
    if (spec.readyType) {
      await waitFor(async () => (await msgs()).find((m) => m.type === spec.readyType), 120000, app + ' ' + spec.readyType);
      result.readyMs = Date.now() - t0;
      if (app === 'excel') {
        // 스냅샷으로 문서 내용 로딩을 확인한다 (현행 계약: myhub-sheet:request-snapshot)
        const sheetFrame = page.frames().find((f) => f.url().includes('sheet.html'));
        if (sheetFrame) {
          await page.evaluate(() => {
            const fr = [...document.querySelectorAll('iframe')].find((el) => (el.src || '').includes('sheet.html'));
            if (fr && fr.contentWindow) fr.contentWindow.postMessage({ type: 'myhub-sheet:request-snapshot' }, location.origin);
          });
          const snap = await waitFor(async () => (await msgs()).find((m) => m.type === 'myhub-sheet:snapshot' || m.type === 'myhub-sheet:snapshot-error'), 20000, 'excel snapshot').catch(() => null);
          result.snapshot = snap || null;
        }
      }
    } else {
      // 한글: 스튜디오 iframe이 뜨고 문서가 렌더될 때까지 대기
      await waitFor(async () => {
        const frames = page.frames().map((f) => f.url());
        return frames.some((u) => u.includes('rhwp-studio')) || null;
      }, 120000, 'hangul studio frame');
      result.readyMs = Date.now() - t0;
      await page.waitForTimeout(8000);
    }
    // 폰트 푸시 대기 (최대 20초)
    if (spec.fontsType) {
      try {
        const fontsMsg = await waitFor(async () => (await msgs()).find((m) => m.type === spec.fontsType), 20000, app + ' fonts push');
        result.fontsPushed = fontsMsg.families || [];
      } catch (e) {
        result.fontsPushTimeout = true;
      }
    }
    await page.waitForTimeout(3000);
    // 엔진 프레임의 FontFaceSet 확인 + MyHubFonts 상태
    const frameInfos = [];
    for (const f of page.frames()) {
      try {
        const faces = await f.evaluate(() => [...document.fonts].map((x) => `${x.family}:${x.weight}:${x.status}`));
        let myhubFonts = null;
        try {
          myhubFonts = await f.evaluate(() => {
            const api = window.MyHubFonts;
            if (!api) return null;
            return { families: api.families(), faces: api.faces() };
          });
        } catch (e) { /* 무시 */ }
        if (faces.length || myhubFonts) frameInfos.push({ url: f.url().split('?')[0].slice(-40), faces, myhubFonts });
      } catch (e) { /* 접근 불가 프레임 무시 */ }
    }
    result.fontFaces = frameInfos;
    const shot = path.join(SHOTS, `office-font-${app}.png`);
    await page.screenshot({ path: shot, fullPage: false });
    result.shot = shot;
    result.totalMs = Date.now() - t0;
  } catch (e) {
    result.error = String((e && e.message) || e).slice(0, 300);
    result.totalMs = Date.now() - t0;
    const shot = path.join(SHOTS, `office-font-${app}-FAIL.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    result.shot = shot;
  }
  result.messages = await msgs().catch(() => []);
  await page.close();
  return result;
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  const which = process.argv[2] || 'all';
  const apps = which === 'all' ? ['excel', 'ppt', 'hangul'] : [which];
  const { base, close } = await createServer({});
  const browser = await launchBrowser();
  const all = {};
  try {
    for (const app of apps) {
      console.log(`\n=== ${app} ===`);
      const r = await runApp(app, browser, base);
      all[app] = r;
      fs.writeFileSync(path.join(OUT, `office-fonts-${app}.json`), JSON.stringify(r, null, 1));
      console.log(JSON.stringify({ app: r.app, readyMs: r.readyMs, fontsPushed: r.fontsPushed, fontsPushTimeout: r.fontsPushTimeout, error: r.error, shot: r.shot }, null, 1));
      console.log('fontFaces:', JSON.stringify(r.fontFaces, null, 1));
    }
  } finally {
    await browser.close();
    await close();
  }
  const failed = apps.filter((a) => all[a].error || all[a].fontsPushTimeout);
  console.log('\n=== 요약 ===');
  apps.forEach((a) => console.log(`${failed.includes(a) ? 'FAIL' : 'PASS'} | ${a} | ready=${all[a].readyMs}ms fonts=${(all[a].fontsPushed || []).length}개${all[a].error ? ' error=' + all[a].error : ''}`));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
