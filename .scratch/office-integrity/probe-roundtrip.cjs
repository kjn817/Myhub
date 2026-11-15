// 오피스 왕복 무결성 프로브 (Finder 표면 + 세션 API).
// axis-E roundtrip.mjs(2026-11-05)의 현행 트리 재검증판:
// 열기 → 세션 편집 1건 → 저장(PUT 캡처) → 저장본 바이트는 verify-saved.py로 대조.
// 시나리오: xlsx | pptx | hwpx | pdf | all
// 실행: node probe-roundtrip.cjs [scenario] (myhub 트리 안에서)
'use strict';

const fs = require('fs');
const path = require('path');
const { createServer, launchBrowser } = require('../../tests/e2e/harness.cjs');

const DIR = __dirname;
const OUT = path.join(DIR, 'out');
const AX = '/home/hatch/workspace/analysis2-20261105/axis-e';

const SCEN = {
  xlsx: { file: 'roundtrip.xlsx', id: 21, name: '분기실적.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', mod: 'MyHubFinderFormatSheet', saved: 'saved.xlsx' },
  pptx: { file: 'roundtrip.pptx', id: 23, name: '분기리뷰.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', mod: 'MyHubFinderFormatSlide', saved: 'saved.pptx' },
  hwpx: { file: 'table.hwpx', id: 24, name: '당직일지-합성.hwpx', mime: 'application/hwp+zip', mod: 'MyHubFinderFormatHwp', saved: 'saved.hwpx' },
  pdf: { file: 'form.pdf', id: 25, name: '협조요청서.pdf', mime: 'application/pdf', mod: 'MyHubFinderFormatPdf', saved: 'saved.pdf' },
};

function extractZip(buf) {
  const start = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (start < 0) return null;
  const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const e = buf.lastIndexOf(eocdSig);
  if (e < 0) return buf.subarray(start);
  const commentLen = buf.readUInt16LE(e + 20);
  return buf.subarray(start, e + 22 + commentLen);
}
function extractPdf(buf) {
  const start = buf.indexOf(Buffer.from('%PDF'));
  if (start < 0) return null;
  const tail = buf.lastIndexOf(Buffer.from('%%EOF'));
  return tail > start ? buf.subarray(start, tail + 5) : buf.subarray(start);
}

async function runScenario(name, browser, base) {
  const S = SCEN[name];
  const bytes = fs.readFileSync(path.join(AX, 'fixtures', S.file));
  let savedBuf = null;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (p === '/api/drive/list') {
      return json({ ok: true, folder: null, folders: [], files: [{ id: S.id, folder_id: null, filename: S.name, mime: S.mime, size: bytes.length, version: 'v1' }] });
    }
    if (p === `/api/drive/files/${S.id}/content`) {
      if (req.method() === 'PUT') {
        const raw = req.postDataBuffer();
        savedBuf = S.saved.endsWith('.pdf') ? extractPdf(raw) : extractZip(raw);
        if (!savedBuf) savedBuf = raw;
        fs.writeFileSync(path.join(OUT, S.saved), savedBuf);
        return json({ ok: true, version: 'v2' });
      }
      return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: bytes });
    }
    return json({ ok: true, items: [], memos: [], schedules: [], todos: [], files: [], folders: [] });
  });

  const result = { scenario: name, errors };
  const t0 = Date.now();
  await page.goto(`${base}/finder.html?file=${S.id}`, { waitUntil: 'load' });
  try {
    await page.waitForFunction((m) => window[m] && window[m].getSession(), S.mod, { timeout: 60000 });
    result.openMs = Date.now() - t0;
  } catch (e) {
    result.openMs = Date.now() - t0;
    result.openFailed = String(e).slice(0, 200);
    await page.close();
    return result;
  }

  async function waitReady(fn, timeoutMs = 90000) {
    const start = Date.now();
    let lastErr = null;
    while (Date.now() - start < timeoutMs) {
      try { return await fn(); } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 700)); }
    }
    throw lastErr || new Error('ready timeout');
  }

  try {
    if (S.mod === 'MyHubFinderFormatSheet') {
      const snap = await waitReady(() => page.evaluate(async () => {
        const s = window.MyHubFinderFormatSheet.getSession();
        const sn = await s.snapshot();
        if (!sn || !sn.cells || sn.cells.length < 2) throw new Error('empty snapshot');
        return sn;
      }));
      result.snapshotMs = Date.now() - t0;
      result.rowsCaptured = snap.cells.length;
      result.head = snap.cells.slice(0, 9).map((r) => (r || []).slice(0, 6));
      const ts = Date.now();
      result.editRes = await page.evaluate(async () => {
        const s = window.MyHubFinderFormatSheet.getSession();
        return s.applyOps([{ type: 'set_cell', cell: 'D3', value: 1500 }]);
      });
      result.editMs = Date.now() - ts;
      result.afterEdit = await page.evaluate(async () => {
        const s = window.MyHubFinderFormatSheet.getSession();
        const sn = await s.snapshot();
        return { d3: sn.cells[2] && sn.cells[2][3], e3: sn.cells[2] && sn.cells[2][4] };
      });
    } else if (S.mod === 'MyHubFinderFormatSlide') {
      result.info = await waitReady(() => page.evaluate(async () => {
        const s = window.MyHubFinderFormatSlide.getSession();
        return s.snapshot();
      }));
      const ts = Date.now();
      result.editRes = await page.evaluate(async () => {
        const s = window.MyHubFinderFormatSlide.getSession();
        return s.applyOps([{ id: 'text.replace', params: { text: '131건', with: '140건' } }]);
      });
      result.editMs = Date.now() - ts;
    } else if (S.mod === 'MyHubFinderFormatHwp') {
      const rt = await waitReady(() => page.evaluate(async () => {
        const s = window.MyHubFinderFormatHwp.getSession();
        return s.readText();
      }), 120000);
      result.readTextMs = Date.now() - t0;
      const md = rt.markdown || (rt.paragraphs || []).join('\n');
      result.usedMarkdown = typeof rt.markdown === 'string';
      result.markersFound = new Set([...md.matchAll(/합성셀(\d{3})/g)].map((m) => m[1])).size;
      result.mdLen = md.length;
      result.mdTableLines = md.split('\n').filter((l) => l.trim().startsWith('|')).length;
      // E-1 재검증: 표 셀 치환(합성셀001) + 본문 치환(합성셀117) 각각 시도
      const ts = Date.now();
      result.editCellRes = await page.evaluate(async () => {
        const s = window.MyHubFinderFormatHwp.getSession();
        return s.applyOps([{ type: 'replace_text', find: '합성셀001', replace: '수정셀999' }]);
      }).catch((e) => ({ error: String(e).slice(0, 200) }));
      result.editBodyRes = await page.evaluate(async () => {
        const s = window.MyHubFinderFormatHwp.getSession();
        return s.applyOps([{ type: 'replace_text', find: '합성셀117', replace: '수정셀888' }]);
      }).catch((e) => ({ error: String(e).slice(0, 200) }));
      result.editMs = Date.now() - ts;
    } else if (S.mod === 'MyHubFinderFormatPdf') {
      result.state = await waitReady(() => page.evaluate(async () => {
        const s = window.MyHubFinderFormatPdf.getSession();
        return s.getState();
      }));
      const ts = Date.now();
      result.editRes = await page.evaluate(async () => {
        const s = window.MyHubFinderFormatPdf.getSession();
        return s.applyOps([{ type: 'rotate_page', page: 1 }]);
      });
      result.editMs = Date.now() - ts;
    }
  } catch (e) {
    result.sessionError = String((e && e.message) || e).slice(0, 300);
  }

  result.engineFrames = page.frames().map((f) => f.url()).filter((u) => u.includes('vendor') || u.includes('sheet') || u.includes('rhwp') || u.includes('deckcraft'));
  if (!savedBuf) {
    const clicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('#finderViewer button, .fv-save, button')];
      const b = btns.find((x) => (x.textContent || '').replace(/\s/g, '').includes('저장') && !x.disabled && x.offsetParent !== null);
      if (b) { b.click(); return b.textContent.trim(); }
      return null;
    });
    result.saveButton = clicked;
    for (let i = 0; i < 16 && !savedBuf; i++) await page.waitForTimeout(500);
  }
  if (!savedBuf) {
    await page.mouse.click(700, 450).catch(() => {});
    await page.keyboard.press('Control+s');
    result.saveViaCtrlS = true;
    for (let i = 0; i < 40 && !savedBuf; i++) await page.waitForTimeout(500);
  }
  result.savedCaptured = !!savedBuf;
  result.savedBytes = savedBuf ? savedBuf.length : 0;
  result.totalMs = Date.now() - t0;
  await page.close();
  return result;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const which = process.argv[2] || 'all';
  const names = which === 'all' ? ['xlsx', 'pptx', 'hwpx', 'pdf'] : [which];
  if (!names.every((n) => SCEN[n])) { console.error('unknown scenario:', which); process.exit(2); }
  const { base, close } = await createServer({});
  const browser = await launchBrowser();
  const all = {};
  try {
    for (const n of names) {
      console.log(`\n=== ${n} ===`);
      const r = await runScenario(n, browser, base);
      all[n] = r;
      fs.writeFileSync(path.join(OUT, `roundtrip-${n}.json`), JSON.stringify(r, null, 1));
      console.log(JSON.stringify(r, null, 1));
    }
  } finally {
    await browser.close();
    await close();
  }
  const failed = names.filter((n) => all[n].openFailed || all[n].sessionError || !all[n].savedCaptured);
  console.log('\n=== 요약 ===');
  names.forEach((n) => {
    const r = all[n];
    console.log(`${failed.includes(n) ? 'FAIL' : 'PASS'} | ${n} | open=${r.openMs}ms saved=${r.savedCaptured ? r.savedBytes + 'B' : 'NO'}${r.openFailed ? ' openFailed=' + r.openFailed : ''}${r.sessionError ? ' sessionError=' + r.sessionError : ''}`);
  });
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
