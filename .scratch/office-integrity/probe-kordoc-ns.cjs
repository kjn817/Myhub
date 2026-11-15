// kordoc ESM 네임스페이스 확인: import 반환값에 parse가 있는가?
'use strict';
const fs = require('fs');
const path = require('path');
const { createServer, launchBrowser } = require('../../tests/e2e/harness.cjs');
const DIR = __dirname;
const AX = '/home/hatch/workspace/analysis2-20261105/axis-e';
async function main() {
  const tableBytes = fs.readFileSync(path.join(AX, 'fixtures', 'table.hwpx'));
  const { base, close } = await createServer({});
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.goto(base + '/login.html', { waitUntil: 'load' });
  const out = await page.evaluate(async (tB64) => {
    const res = {};
    const mod = await import('/vendor/kordoc/kordoc.js');
    res.nsKeys = Object.keys(mod);
    res.hasParse = typeof mod.parse === 'function';
    res.hasDefault = !!mod.default;
    res.defaultKeys = mod.default ? Object.keys(mod.default) : null;
    res.windowKordoc = typeof window.__kordoc;
    if (res.hasParse) {
      try {
        const dec = Uint8Array.from(atob(tB64), (c) => c.charCodeAt(0));
        const r = await mod.parse(dec);
        res.parseSuccess = r && r.success;
        const md = (r && r.markdown) || '';
        res.mdLen = md.length;
        res.markers = new Set([...md.matchAll(/합성셀(\d{3})/g)].map((m) => m[1])).size;
        res.parseError = r && r.error ? String(r.error).slice(0, 200) : null;
      } catch (e) {
        res.parseThrow = String((e && e.message) || e).slice(0, 400);
      }
    }
    return res;
  }, tableBytes.toString('base64'));
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
  await close();
}
main().catch((e) => { console.error(e); process.exit(1); });
