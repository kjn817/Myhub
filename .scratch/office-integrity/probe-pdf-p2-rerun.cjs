// font-pdf p2(맑은 고딕 비임베드) 재촬영 — 페이지 이동 확인 후 촬영.
// 이전 실행은 페이지 이동이 안 돼 p1이 찍혔다.
'use strict';
const fs = require('fs');
const path = require('path');
const { createServer, launchBrowser } = require('../../tests/e2e/harness.cjs');
const DIR = __dirname;
async function main() {
  const { base, close } = await createServer({
    fixtures: { '/probe/font-pdf.pdf': path.join(DIR, 'fixtures', 'font-pdf.pdf') },
  });
  const browser = await launchBrowser();
  try {
    for (const dsf of [1, 2]) {
      const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: dsf });
      const pg = await ctx.newPage();
      const errors = [];
      pg.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
      await pg.goto(`${base}/pdf-viewer/web/viewer.html?file=%2Fprobe%2Ffont-pdf.pdf#page=2`, { waitUntil: 'domcontentloaded' });
      await pg.waitForTimeout(5000);
      await pg.evaluate(() => {
        const app = window.PDFViewerApplication;
        if (app) app.pdfViewer.currentScale = 2.0;
      });
      await pg.waitForTimeout(3000);
      const info = await pg.evaluate(async () => {
        const app = window.PDFViewerApplication;
        const page = await app.pdfDocument.getPage(2);
        const tc = await page.getTextContent();
        return { current: app.pdfViewer.currentPageNumber, text: tc.items.map((i) => i.str).join('') };
      });
      console.log(`[dsf=${dsf}] currentPage=${info.current} text=${JSON.stringify(info.text)}`);
      const name = `pdf-malgun-fallback-p2-z2-dsf${dsf}-p2.png`;
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
