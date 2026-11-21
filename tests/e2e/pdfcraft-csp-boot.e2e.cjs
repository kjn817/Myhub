// pdfcraft 부팅 CSP 회귀 (2026-11-21 사용자 보고: PDF 편집기가 안 뜬다).
// 원인: /vendor/pdfcraft/index.html은 이름 없는 .html이라 GENERAL_HTML_CSP를
// 받는데, connect-src 'self'에 blob:이 없어 부팅 게이트가 Blob URL로 넘긴
// WASM 조각을 로더가 fetch하지 못했다 ("Failed to fetch" → ready 없음 →
// 45초 워치독 → "전용 편집기를 불러오지 못했습니다" 배너). 로컬 하네스는
// CSP 헤더를 안 붙여서 이 결함을 재현하지 못했다 — 그래서 이 테스트는
// 배포 CSP(GENERAL_HTML_CSP, src/index.ts에서 직접 읽음)를 붙여 서빙하고
// 실제 부팅이 READY까지 가는지 확인한다. CSP에서 blob:을 빼면 FALLBACK
// timeout으로 실패한다 (카나리아 확인).
'use strict';

const fs = require('fs');
const path = require('path');
const { runScenario, attachErrorCollector, assert } = require('./harness.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const INDEX_TS = fs.readFileSync(path.join(ROOT, 'src', 'index.ts'), 'utf-8');
const CSP_MATCH = INDEX_TS.match(/const GENERAL_HTML_CSP =\s*"([^"]+)"/);
if (!CSP_MATCH) throw new Error('GENERAL_HTML_CSP를 src/index.ts에서 찾지 못했습니다');
const CSP = CSP_MATCH[1];

runScenario('pdfcraft-csp-boot', async (t) => {
  assert(
    CSP.includes("connect-src 'self' blob:"),
    'GENERAL_HTML_CSP에 connect-src blob:이 있어야 한다 (부팅 게이트 Blob URL 핸드오프)',
  );
  const { base } = await t.server({
    fixtures: {
      '/probe/pdfcraft-boot.html': path.join(__dirname, 'fixtures', 'pdfcraft-boot.html'),
      '/probe/pdfcraft-boot.js': path.join(__dirname, 'fixtures', 'pdfcraft-boot.js'),
    },
    extraHeaders: { 'Content-Security-Policy': CSP },
  });
  const browser = await t.browser();
  const { page } = await t.newPage(browser, { width: 1280, height: 800 });
  const errors = attachErrorCollector(page);
  await page.goto(`${base}/probe/pdfcraft-boot.html`, { waitUntil: 'load' });

  // 부팅 완료(READY) 또는 실패(FALLBACK)까지 최대 75초 대기한다
  // (워치독 45초 + 프리패치 여유).
  const deadline = Date.now() + 75000;
  let outcome = 'TIMEOUT';
  let logText = '';
  while (Date.now() < deadline) {
    const log = await page.evaluate(() => window.__log || []).catch(() => []);
    logText = log.join('\n');
    if (/FALLBACK/.test(logText)) { outcome = 'FALLBACK'; break; }
    if (/READY/.test(logText)) { outcome = 'READY'; break; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  assert(outcome === 'READY', `배포 CSP 하에서 pdfcraft 부팅이 READY까지 가야 한다 (결과: ${outcome})\n${logText.slice(-2000)}`);
  const blobCspErrors = (errors.consoleErrors || []).filter(
    (e) => e.includes('connect-src') || (e.includes('blob:') && e.includes('Content Security Policy')),
  );
  assert(blobCspErrors.length === 0, 'Blob URL fetch CSP 위반이 없어야 한다: ' + blobCspErrors.join(' | '));
});
