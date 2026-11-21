// pdfcraft 손상 캐시 부팅 회귀 (2026-11-21 사용자 보고: 새 브라우저는
// 되는데 사용자 브라우저에서만 "전용 편집기를 불러오지 못했습니다").
// 원인: 캐시된 WASM 파트의 길이를 검증하지 않아, 잘린 파트가
// CacheStorage에 남으면 매 부팅마다 잘린 WASM을 조립해 로더 init이
// 조용히 죽고 45초 뒤 타임아웃 폴백만 떴다. 다시 시도도 같은 손상
// 캐시를 읽어 영구 실패였다. 이 테스트는 part0을 1MB로 잘라 심은 뒤
// 부팅이 READY까지 가는지 확인한다 (손상 캐시를 지우고 다시 받아야
// 한다). 길이 검증을 빼면 FALLBACK timeout으로 실패한다 (카나리아 확인).
'use strict';

const fs = require('fs');
const path = require('path');
const { runScenario, attachErrorCollector, assert } = require('./harness.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const INDEX_TS = fs.readFileSync(path.join(ROOT, 'src', 'index.ts'), 'utf-8');
const CSP_MATCH = INDEX_TS.match(/const GENERAL_HTML_CSP =\s*"([^"]+)"/);
if (!CSP_MATCH) throw new Error('GENERAL_HTML_CSP를 src/index.ts에서 찾지 못했습니다');
const CSP = CSP_MATCH[1];

runScenario('pdfcraft-corrupt-cache-boot', async (t) => {
  const { base } = await t.server({
    fixtures: {
      '/probe/pdfcraft-boot-corrupt-cache.html': path.join(__dirname, 'fixtures', 'pdfcraft-boot-corrupt-cache.html'),
      '/probe/pdfcraft-boot-corrupt-cache.js': path.join(__dirname, 'fixtures', 'pdfcraft-boot-corrupt-cache.js'),
    },
    extraHeaders: { 'Content-Security-Policy': CSP },
  });
  const browser = await t.browser();
  const { page } = await t.newPage(browser, { width: 1280, height: 800 });
  attachErrorCollector(page);
  await page.goto(`${base}/probe/pdfcraft-boot-corrupt-cache.html`, { waitUntil: 'load' });

  // 부팅 완료(READY) 또는 실패(FALLBACK)까지 최대 120초 대기한다
  // (손상 캐시 제거 + 23MB 파트 재다운 + 워치독 45초 여유).
  const deadline = Date.now() + 120000;
  let outcome = 'TIMEOUT';
  let logText = '';
  while (Date.now() < deadline) {
    const log = await page.evaluate(() => window.__log || []).catch(() => []);
    logText = log.join('\n');
    if (/FALLBACK/.test(logText)) { outcome = 'FALLBACK'; break; }
    if (/READY/.test(logText)) { outcome = 'READY'; break; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  assert(/SEEDED truncated part0/.test(logText), '손상 캐시 시딩이 먼저 돼야 한다\n' + logText.slice(-2000));
  assert(outcome === 'READY', `손상 캐시가 있어도 부팅이 READY까지 가야 한다 (결과: ${outcome})\n${logText.slice(-2000)}`);
  // 손상 캐시가 제거되고 올바른 파트로 교체됐는지 CacheStorage에서 직접 확인한다.
  const cached = await page.evaluate(async () => {
    const man = await (await fetch('/vendor/pdfcraft/manifest.json')).json();
    const url = new URL('/vendor/pdfcraft/' + man.wasmParts[0], location.href).href;
    const cache = await caches.open('myhub-pdfcraft-parts');
    const res = await cache.match(url);
    if (!res) return { len: -1, expected: man.wasmPartBytes[0] };
    return { len: (await res.arrayBuffer()).byteLength, expected: man.wasmPartBytes[0] };
  });
  assert(cached.len === cached.expected, `캐시의 part0이 올바른 길이(${cached.expected})로 교체돼야 한다 (실제: ${cached.len})`);
});
