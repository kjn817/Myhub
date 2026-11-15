// Noto CFF dsf=2 재촬영 (대용량 폰트 로딩 대기 연장).
'use strict';
const fs = require('fs');
const path = require('path');
const { createServer, launchBrowser } = require('../../tests/e2e/harness.cjs');
const DIR = __dirname;
async function main() {
  const { base, close } = await createServer({
    fixtures: { '/probe/noto-pdf.pdf': path.join(DIR, 'fixtures', 'noto-pdf.pdf') },
  });
  const browser = await launchBrowser();
  try {
    for (const zoom of [2.0, 3.0]) {
      const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
      const pg = await ctx.newPage();
      const errors = [];
      pg.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
      await pg.goto(`${base}/pdf-viewer/web/viewer.html?file=%2Fprobe%2Fnoto-pdf.pdf`, { waitUntil: 'domcontentloaded' });
      await pg.waitForTimeout(12000);
      await pg.evaluate((z) => {
        const app = window.PDFViewerApplication;
        if (app) app.pdfViewer.currentScale = z;
      }, zoom);
      await pg.waitForTimeout(6000);
      const name = `pdf-noto-cff-p1-z${String(zoom).replace('.', '')}-dsf2-p1.png`;
      await pg.screenshot({ path: path.join(DIR, 'shots', name), clip: { x: 0, y: 60, width: 1200, height: 500 } });
      console.log(`[shot] ${name} errors=${errors.length}`);
      await ctx.close();
    }
  } finally {
    await browser.close();
    await close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
