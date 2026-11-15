// PDF 폰트 렌더링·글리프 채움 프로브 (오피스 무결성 검증).
// font-pdf.pdf(나눔고딕 임베드 p1·맑은 고딕 비임베드 p2),
// noto-pdf.pdf(Noto Sans CJK KR Bold CFF)를 viewer.html(pdf.js)로 열어
// 줌·dpr 조합별 제목 영역을 스크린샷으로 남긴다.
// 분석은 analyze-glyph.py로 (image-54 결함 서명: 상단 흰 사각형).
// 실행: node probe-pdf-glyph.cjs (myhub 트리 안에서)
'use strict';

const fs = require('fs');
const path = require('path');
const { createServer, launchBrowser } = require('../../tests/e2e/harness.cjs');

const DIR = __dirname;
const SHOTS = path.join(DIR, 'shots');
const FIX = path.join(DIR, 'fixtures');

const CASES = [
  // [pdf, page, zoom, dsf, label]
  ['font-pdf.pdf', 1, 1.0, 1, 'nanum-p1'],
  ['font-pdf.pdf', 1, 2.0, 1, 'nanum-p1'],
  ['font-pdf.pdf', 1, 2.0, 2, 'nanum-p1'],
  ['font-pdf.pdf', 1, 3.0, 2, 'nanum-p1'],
  ['font-pdf.pdf', 2, 2.0, 1, 'malgun-fallback-p2'],
  ['font-pdf.pdf', 2, 2.0, 2, 'malgun-fallback-p2'],
  ['noto-pdf.pdf', 1, 2.0, 1, 'noto-cff-p1'],
  ['noto-pdf.pdf', 1, 2.0, 2, 'noto-cff-p1'],
  ['noto-pdf.pdf', 1, 3.0, 2, 'noto-cff-p1'],
];

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const fixtures = {};
  for (const f of ['font-pdf.pdf', 'noto-pdf.pdf']) {
    fixtures['/probe/' + f] = path.join(FIX, f);
  }
  const { base, close } = await createServer({ fixtures });
  const browser = await launchBrowser();
  const manifest = [];
  try {
    for (const [pdf, page, zoom, dsf, label] of CASES) {
      const ctx = await browser.newContext({
        viewport: { width: 1200, height: 900 },
        deviceScaleFactor: dsf,
      });
      const pg = await ctx.newPage();
      const errors = [];
      pg.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
      await pg.goto(
        `${base}/pdf-viewer/web/viewer.html?file=%2Fprobe%2F${pdf}`,
        { waitUntil: 'domcontentloaded' },
      );
      await pg.waitForTimeout(5000);
      await pg.evaluate(({ page, zoom }) => {
        const app = window.PDFViewerApplication;
        if (app) {
          app.pdfViewer.currentPageNumber = page;
          app.pdfViewer.currentScale = zoom;
        }
      }, { page, zoom });
      await pg.waitForTimeout(3000);
      // 제목이 있는 상단 영역만 캡처 (뷰어 툴바 아래).
      const name = `pdf-${label}-z${String(zoom).replace('.', '')}-dsf${dsf}-p${page}.png`;
      const shot = path.join(SHOTS, name);
      await pg.screenshot({ path: shot, clip: { x: 0, y: 60, width: 1200, height: 500 } });
      console.log(`[shot] ${name} errors=${errors.length}`);
      manifest.push({ file: name, pdf, page, zoom, dsf, errors });
      await ctx.close();
    }
  } finally {
    await browser.close();
    await close();
  }
  fs.writeFileSync(path.join(DIR, 'pdf-glyph-manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('manifest written,', manifest.length, 'shots');
}

main().catch((e) => { console.error(e); process.exit(1); });
