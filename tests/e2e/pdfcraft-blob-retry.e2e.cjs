// pdfcraft Blob-less 재시도 (2026-11-21 사용자 보고: 크롬에서 다운로드
// 완료(45.3MB) 후 45초 뒤 폴백, 엑셀은 정상 — 로더의 Blob URL fetch가
// 막힌 환경에서 조용히 멈춘 것이다).
//
// 검증: 배포 CSP에서 blob:을 빼면 로더의 Blob fetch가 CSP에 막힌다.
// 그래도 부팅이 READY까지 가야 한다 — 로더가 pdfcraft:failed를 보고하고
// 호스트가 Blob 없이 네트워크 경로로 1회 재시도하기 때문이다.
// 30초 안에 READY가 와야 한다: 보고 없이는 첫 시도가 45초 워치독까지
// 멈춰 있으니 30초 bound가 빠른 실패 보고를 증명한다 (보고를 빼면
// 45초+재시도 부팅 ≈ 55초가 걸려 실패한다).
// 카나리아: 재시도를 빼면 FALLBACK timeout으로 실패한다.
'use strict';

const fs = require('fs');
const path = require('path');
const { runScenario, attachErrorCollector, assert } = require('./harness.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const INDEX_TS = fs.readFileSync(path.join(ROOT, 'src', 'index.ts'), 'utf-8');
const CSP_MATCH = INDEX_TS.match(/const GENERAL_HTML_CSP =\s*"([^"]+)"/);
if (!CSP_MATCH) throw new Error('GENERAL_HTML_CSP를 src/index.ts에서 찾지 못했습니다');
const CSP_NO_BLOB = CSP_MATCH[1].replace("connect-src 'self' blob:", "connect-src 'self'");

runScenario('pdfcraft-blob-retry', async (t) => {
  assert(
    /connect-src 'self';/.test(CSP_NO_BLOB),
    '재시도 테스트용 CSP의 connect-src에는 blob:이 없어야 한다 (Blob fetch 차단 조건 — img-src·media-src의 blob:은 fetch와 무관하다)',
  );
  const { base } = await t.server({
    fixtures: {
      '/probe/pdfcraft-boot.html': path.join(__dirname, 'fixtures', 'pdfcraft-boot.html'),
      '/probe/pdfcraft-boot.js': path.join(__dirname, 'fixtures', 'pdfcraft-boot.js'),
    },
    extraHeaders: { 'Content-Security-Policy': CSP_NO_BLOB },
  });
  const browser = await t.browser();
  const { page } = await t.newPage(browser, { width: 1280, height: 800 });
  const errors = attachErrorCollector(page);
  const t0 = Date.now();
  await page.goto(`${base}/probe/pdfcraft-boot.html`, { waitUntil: 'load' });

  // 30초 안에 READY가 와야 한다 (빠른 실패 보고 + 재시도 증명).
  const deadline = Date.now() + 30000;
  let outcome = 'TIMEOUT';
  let logText = '';
  while (Date.now() < deadline) {
    const log = await page.evaluate(() => window.__log || []).catch(() => []);
    logText = log.join('\n');
    if (/FALLBACK/.test(logText)) { outcome = 'FALLBACK'; break; }
    if (/READY/.test(logText)) { outcome = 'READY'; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  assert(
    outcome === 'READY',
    `blob: 없는 CSP에서도 Blob-less 재시도로 READY까지 가야 한다 (결과: ${outcome}, ${elapsed}s)\n${logText.slice(-2000)}`,
  );
  // 첫 시도가 실제로 Blob fetch에서 막혔는지 확인 — CSP 위반이
  // 없으면 재시도가 아니라 첫 시도가 뜬 것이므로 테스트가 무의미하다.
  const blobCspErrors = (errors.consoleErrors || []).filter(
    (e) => e.includes('connect-src') || (e.includes('blob:') && e.includes('Content Security Policy')),
  );
  assert(blobCspErrors.length >= 1, '첫 시도의 Blob fetch CSP 위반이 기록돼야 한다 (재시도 조건 증명)');
});
