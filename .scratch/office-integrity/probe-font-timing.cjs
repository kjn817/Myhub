// 사용자 폰트 로딩 타이밍 진단: 시트 프레임의 MyHubFonts.faces()가
// 언제 채워지는지, gridcraft:fonts 푸시가 언제 일어나는지 샘플링한다.
// 실행: node probe-font-timing.cjs (myhub 트리 안에서, USER_FONT=small 가능)
'use strict';

const fs = require('fs');
const path = require('path');
const { createServer, launchBrowser } = require('../../tests/e2e/harness.cjs');

const DIR = __dirname;
const FIX = path.join(DIR, 'fixtures');
const SMALL = process.env.USER_FONT === 'small';
const USER_FONT = SMALL
  ? { name: 'TestUserFont.ttf', bytes: fs.readFileSync(path.join(FIX, 'TestUserFont-small.ttf')), mime: 'font/ttf' }
  : { name: 'TestUserFont.otf', bytes: fs.readFileSync('/tmp/NotoSansCJK-KR-Bold.otf'), mime: 'font/otf' };
const XLSX = fs.readFileSync(path.join(FIX, 'font-xlsx.xlsx'));

async function main() {
  const { base, close } = await createServer({});
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    window.__msgs = [];
    window.addEventListener('message', (e) => {
      const d = e.data || {};
      if (typeof d.type !== 'string') return;
      const rec = { type: d.type, t: Date.now() };
      if (d.fonts && Array.isArray(d.fonts)) rec.families = d.fonts.map((f) => f.family);
      window.__msgs.push(rec);
    });
  });
  await page.route('**/api/drive/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === '/api/drive/list') {
      const folder = url.searchParams.get('folder');
      if (folder && Number(folder) === 99) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, files: [{ id: 98, filename: USER_FONT.name, mime: USER_FONT.mime, size: USER_FONT.bytes.length }] }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, folders: [{ id: 99, name: '폰트' }], files: [{ id: 11, filename: 'font-xlsx.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: XLSX.length, version: 'v1' }] }) });
      return;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    const id = parts[3] ? decodeURIComponent(parts[3]) : null;
    if (req.method() === 'GET' && parts[4] === 'content') {
      if (id === '11') { await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: XLSX }); return; }
      if (id === '98') { await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: USER_FONT.bytes }); return; }
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });

  const t0 = Date.now();
  const log = (s) => console.log(`${String(Date.now() - t0).padStart(6)}ms  ${s}`);
  await page.goto(`${base}/office.html?app=excel&file=11&name=font-xlsx.xlsx&mime=application%2Fvnd.openxmlformats-officedocument.spreadsheetml.sheet`, { waitUntil: 'load' });

  let lastFaces = -1;
  let seenFonts = false;
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    const sheet = page.frames().find((f) => f.url().includes('sheet.html'));
    let faces = null;
    if (sheet) {
      try {
        faces = await sheet.evaluate(() => {
          const api = window.MyHubFonts;
          return api ? api.faces().map((f) => f.family) : null;
        });
      } catch (e) { /* 무시 */ }
    }
    if (faces && faces.length !== lastFaces) {
      log(`sheet MyHubFonts.faces() = [${faces.join(', ')}]`);
      lastFaces = faces.length;
    }
    // 폰트 푸시 확인
    let pushed = null;
    for (const f of page.frames()) {
      try {
        const list = await f.evaluate(() => window.__msgs || []);
        const hit = list.find((m) => m.type === 'gridcraft:fonts');
        if (hit) pushed = hit;
      } catch (e) { /* 무시 */ }
    }
    if (pushed && !seenFonts) {
      log(`gridcraft:fonts pushed families=[${(pushed.families || []).join(', ')}]`);
      seenFonts = true;
      break;
    }
  }
  if (!seenFonts) log('NO gridcraft:fonts push observed in 30s');
  await browser.close();
  await close();
}

main().catch((e) => { console.error(e); process.exit(1); });
