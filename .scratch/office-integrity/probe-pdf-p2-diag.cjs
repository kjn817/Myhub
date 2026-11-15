// p2 비임베드 폰트 진단: pdf.js 콘솔 경고 + operator list 확인.
'use strict';
const path = require('path');
const { createServer, launchBrowser } = require('../../tests/e2e/harness.cjs');
const DIR = __dirname;
async function main() {
  const { base, close } = await createServer({
    fixtures: { '/probe/font-pdf.pdf': path.join(DIR, 'fixtures', 'font-pdf.pdf') },
  });
  const browser = await launchBrowser();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    const pg = await ctx.newPage();
    const logs = [];
    pg.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`); });
    pg.on('pageerror', (e) => logs.push('[pageerror] ' + String((e && e.message) || e).slice(0, 300)));
    await pg.goto(`${base}/pdf-viewer/web/viewer.html?file=%2Fprobe%2Ffont-pdf.pdf#page=2`, { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(8000);
    const info = await pg.evaluate(async () => {
      const app = window.PDFViewerApplication;
      const page = await app.pdfDocument.getPage(2);
      const tc = await page.getTextContent();
      const ops = await page.getOperatorList();
      const opNames = ops.fnArray.map((fn) => app.pdfDocument ? String(fn) : fn);
      return {
        textItems: tc.items.length,
        text: tc.items.map((i) => i.str).join(''),
        opCount: ops.fnArray.length,
        opSample: opNames.slice(0, 20),
        fonts: Object.keys(tc.styles || {}),
      };
    });
    console.log(JSON.stringify(info, null, 2));
    console.log('--- console warnings/errors ---');
    logs.slice(0, 15).forEach((l) => console.log(l));
    await ctx.close();
  } finally {
    await browser.close();
    await close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
