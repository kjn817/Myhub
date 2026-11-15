// kordoc 파싱 진단 프로브 (재빌드 바이트 검증).
// axis-E kordoc.mjs의 현행 트리판 + 에러 캡처: parse 실패 시 오류 메시지를
// 그대로 보고한다 (finder-format-hwp.js readText는 .catch로 삼켜버려
// 레거시 폴백으로 넘어가므로, 실패 원인이 안 보인다).
// 실행: node probe-kordoc.cjs (myhub 트리 안에서)
'use strict';

const fs = require('fs');
const path = require('path');
const { createServer, launchBrowser } = require('../../tests/e2e/harness.cjs');

const DIR = __dirname;
const OUT = path.join(DIR, 'out');
const AX = '/home/hatch/workspace/analysis2-20261105/axis-e';

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const tableBytes = fs.readFileSync(path.join(AX, 'fixtures', 'table.hwpx'));
  const bigBytes = fs.readFileSync(path.join(AX, 'fixtures', 'big.hwpx'));
  const { base, close } = await createServer({});
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const consoleErrs = [];
  page.on('pageerror', (e) => consoleErrs.push('[pageerror] ' + String(e).slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrs.push('[console] ' + m.text().slice(0, 300));
  });
  await page.goto(base + '/login.html', { waitUntil: 'load' });

  const out = await page.evaluate(async ({ tB64, bB64 }) => {
    const res = {};
    const dec = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    try {
      const t0 = performance.now();
      await import('/vendor/kordoc/kordoc.js');
      res.loadMs = Math.round(performance.now() - t0);
      const mod = window.__kordoc;
      res.hasModule = !!mod;
      res.hasParse = mod && typeof mod.parse === 'function';
      res.hasGen = mod && typeof mod.markdownToHwpx === 'function';
      if (!mod || typeof mod.parse !== 'function') return res;
      // table.hwpx
      try {
        const s = performance.now();
        const r = await mod.parse(dec(tB64));
        res.tableParseMs = Math.round(performance.now() - s);
        res.tableSuccess = r && r.success;
        res.tableError = r && r.error ? String(r.error).slice(0, 300) : null;
        const md = (r && r.markdown) || '';
        res.tableMdLen = md.length;
        res.tableMarkersFound = new Set([...md.matchAll(/합성셀(\d{3})/g)].map((m) => m[1])).size;
        res.tableMdTableLines = md.split('\n').filter((l) => l.trim().startsWith('|')).length;
        res.tableMdHead = md.slice(0, 400);
      } catch (e) {
        res.tableThrow = String((e && e.message) || e).slice(0, 500);
        res.tableStack = e && e.stack ? String(e.stack).slice(0, 800) : null;
      }
      // big.hwpx
      try {
        const s = performance.now();
        const rb = await mod.parse(dec(bB64));
        res.bigParseMs = Math.round(performance.now() - s);
        res.bigSuccess = rb && rb.success;
        res.bigError = rb && rb.error ? String(rb.error).slice(0, 300) : null;
        res.bigMdLen = ((rb && rb.markdown) || '').length;
        res.bigParaFound = ((rb && rb.markdown) || '').split('대용량 문단').length - 1;
      } catch (e) {
        res.bigThrow = String((e && e.message) || e).slice(0, 500);
      }
      // markdownToHwpx 왕복
      try {
        const srcMd = '# 주차 협조 공문 (합성)\n\n## 개요\n지상주차장 협조 요청 건입니다.\n\n| 구분 | 내용 |\n| --- | --- |\n| 일시 | 2026-11-06 09:00 |\n| 장소 | 서소문청사 지상주차장 |\n| 담당 | 김합성 |\n\n## 요청 사항\n- 차량 이동 협조\n- 안내 표지 설치';
        const s = performance.now();
        const gen = await mod.markdownToHwpx(srcMd, { gongmun: { preset: '보고서' } });
        res.genMs = Math.round(performance.now() - s);
        const u8 = gen instanceof Uint8Array ? gen : new Uint8Array(gen);
        res.genBytes = u8.length;
        res.genIsZip = u8[0] === 0x50 && u8[1] === 0x4b;
        const r2 = await mod.parse(u8);
        res.genReparseSuccess = r2 && r2.success;
        const md2 = (r2 && r2.markdown) || '';
        res.genKeeps = {
          title: md2.includes('주차 협조 공문'),
          tableDate: md2.includes('2026-11-06 09:00'),
          bullet: md2.includes('차량 이동 협조'),
        };
      } catch (e) {
        res.genThrow = String((e && e.message) || e).slice(0, 500);
      }
    } catch (e) {
      res.loadThrow = String((e && e.message) || e).slice(0, 500);
    }
    return res;
  }, { tB64: tableBytes.toString('base64'), bB64: bigBytes.toString('base64') });

  out.consoleErrs = consoleErrs;
  console.log(JSON.stringify(out, null, 1));
  fs.writeFileSync(path.join(OUT, 'kordoc.json'), JSON.stringify(out, null, 1));
  await browser.close();
  await close();
  const ok = out.tableSuccess === true && out.tableMarkersFound === 247;
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
