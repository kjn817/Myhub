// 실브라우저 e2e 공용 하네스 (.scratch의 일회성 프로브에서 추출한 공통 부분).
// - public/ 정적 서빙 + /api 스텁 (로컬 서버라 운영 인증 우회)
// - playwright-core + puppeteer 캐시 Chrome
// - 시나리오 실행 래퍼: 타이밍·PASS/FAIL 출력·실패 시 스크린샷·종료코드
// 스크립트는 반드시 myhub 트리 안에서 실행할 것 (.cjs, require 동작).
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const SHOTS_DIR = path.join(ROOT, '.scratch', 'e2e-shots');

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.wasm': 'application/wasm',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pdf': 'application/pdf', '.hwpx': 'application/octet-stream',
  '.hwp': 'application/octet-stream',
};

function resolveChrome() {
  const cached = path.join(process.env.HOME || '', '.cache', 'puppeteer', 'chrome');
  if (cached && fs.existsSync(cached)) {
    for (const d of fs.readdirSync(cached)) {
      const p = path.join(cached, d, 'chrome-linux64', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  throw new Error(
    'Chrome을 찾을 수 없습니다: ~/.cache/puppeteer/chrome에 설치된 Chrome이 없고 ' +
    'CHROME_PATH 환경변수도 없습니다.'
  );
}

// ---- 단언 (실패 시 메시지와 함께 throw) ----

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg} (기대: ${JSON.stringify(expected)}, 실제: ${JSON.stringify(actual)})`);
  }
}

function assertNear(actual, expected, tol, msg) {
  if (typeof actual !== 'number' || Math.abs(actual - expected) > tol) {
    throw new Error(`${msg} (기대: ${expected}±${tol}, 실제: ${actual})`);
  }
}

// ---- 로컬 서버 ----
// opts:
//   onApi: async ({ method, path, query, body }) => { status?, contentType?, body? } | null
//     null을 반환하면 기본 스텁으로 폴백한다.
//   fixtures: { '/probe/blank.hwpx': '<절대 경로>' } — 정적 파일 별칭
//   driveFiles: /api/drive/list?folder_id=... 에 실을 파일 목록
function createServer(opts = {}) {
  const { onApi, fixtures = {}, driveFiles = [] } = opts;
  const server = http.createServer((req, res) => {
    const [urlPath, query = ''] = req.url.split('?');
    const p = decodeURIComponent(urlPath);

    const sendJson = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (fixtures[p]) {
      const file = fixtures[p];
      if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
      return;
    }

    if (p.startsWith('/api/')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        try {
          if (typeof onApi === 'function') {
            const r = await onApi({ method: req.method, path: p, query, body });
            if (r) {
              if (typeof r.body === 'string' || Buffer.isBuffer(r.body)) {
                res.writeHead(r.status || 200, { 'Content-Type': r.contentType || 'application/json' });
                res.end(r.body);
              } else {
                sendJson(r.status || 200, r.body);
              }
              return;
            }
          }
        } catch (e) {
          sendJson(500, { ok: false, error: String((e && e.message) || e) });
          return;
        }
        // 기본 스텁
        if (p === '/api/artifact') {
          // 실측 지연 재현: 부팅이 artifact를 기다리던 시절의 1.5s.
          setTimeout(() => sendJson(200, { data: [] }), 1500);
          return;
        }
        if (p === '/api/drive/list' && !query) {
          sendJson(200, { ok: true, folders: [{ id: 1, name: '바탕화면' }], files: [] });
          return;
        }
        if (p === '/api/drive/list') {
          sendJson(200, { ok: true, folders: [], files: driveFiles });
          return;
        }
        if (/^\/api\/drive\/files\/\d+(\/content)?$/.test(p)) {
          // 64바이트 제로 스텁: 파싱은 실패하지만 열기 체인 검증에는 충분하다.
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(Buffer.alloc(64));
          return;
        }
        if (p.startsWith('/api/schedule/list')) {
          sendJson(200, { schedules: [] });
          return;
        }
        sendJson(200, { ok: true });
      });
      return;
    }

    const file = path.join(PUBLIC, p === '/' ? 'desktop.html' : p);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function launchBrowser() {
  return chromium.launch({
    executablePath: resolveChrome(),
    args: ['--no-sandbox', '--disable-gpu'],
  });
}

// CDP 네트워크 스로틀링 (엔진 WASM 로딩을 늘려 로딩 UI를 오래 보게 한다).
async function throttleNetwork(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 100,
    downloadThroughput: 400 * 1024, uploadThroughput: 400 * 1024,
  });
}

// 페이지 오류 수집기: pageerror·콘솔 에러·HTTP 4xx/5xx를 모은다.
function attachErrorCollector(page) {
  const errors = { pageErrors: [], consoleErrors: [], httpErrors: [] };
  page.on('pageerror', (e) => errors.pageErrors.push(String((e && e.message) || e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.consoleErrors.push(m.text());
  });
  page.on('response', (r) => {
    if (r.status() >= 400) errors.httpErrors.push(`[http ${r.status()}] ${r.url()}`);
  });
  return errors;
}

// 데스크톱 부팅 대기: 부팅 오버레이가 사라지고 독이 보일 때까지.
async function waitForDesktop(page, timeout = 30000) {
  await page.waitForSelector('#dt-boot', { state: 'detached', timeout }).catch(() => null);
  await page.waitForSelector('#dt-dock', { timeout: 15000 }).catch(() => null);
}

// ---- 시나리오 실행 컨텍스트 ----

class ScenarioContext {
  constructor(name) {
    this.name = name;
    this.servers = [];
    this.browsers = [];
    this.page = null;
  }

  async server(opts) {
    const s = await createServer(opts);
    this.servers.push(s);
    return s;
  }

  async browser() {
    const b = await launchBrowser();
    this.browsers.push(b);
    return b;
  }

  // 새 컨텍스트+페이지. 마지막으로 만든 페이지가 실패 스크린샷 대상이다.
  async newPage(browser, viewport = { width: 1440, height: 900 }, extra = {}) {
    const ctx = await browser.newContext({ viewport, ...extra });
    const page = await ctx.newPage();
    this.page = page;
    return { ctx, page };
  }

  async shotOnFailure() {
    if (!this.page) return null;
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    const file = path.join(SHOTS_DIR, `${this.name}-${Date.now()}.png`);
    await this.page.screenshot({ path: file }).catch(() => null);
    return file;
  }

  async close() {
    for (const b of this.browsers) await b.close().catch(() => {});
    for (const s of this.servers) await s.close().catch(() => {});
  }
}

// 시나리오 래퍼: 타이밍 측정·PASS/FAIL 한 줄 출력·실패 시 스크린샷·종료코드.
// fn이 throw하면 FAIL(종료 1), 정상 반환하면 PASS(종료 0). timeoutMs 기본 120초.
async function runScenario(name, fn, opts = {}) {
  const t0 = Date.now();
  const ctx = new ScenarioContext(name);
  const timeoutMs = opts.timeoutMs || 120000;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`시나리오 타임아웃 (${timeoutMs}ms)`)), timeoutMs);
  });
  try {
    await Promise.race([fn(ctx), timeout]);
    clearTimeout(timer);
    console.log(`PASS ${name} (${Date.now() - t0}ms)`);
    await ctx.close();
    process.exit(0);
  } catch (e) {
    clearTimeout(timer);
    const shot = await ctx.shotOnFailure().catch(() => null);
    await ctx.close();
    console.error(`FAIL ${name} (${Date.now() - t0}ms): ${e.message}`);
    if (shot) console.error(`  screenshot: ${shot}`);
    process.exit(1);
  }
}

module.exports = {
  ROOT,
  PUBLIC,
  SHOTS_DIR,
  resolveChrome,
  createServer,
  launchBrowser,
  throttleNetwork,
  attachErrorCollector,
  waitForDesktop,
  assert,
  assertEq,
  assertNear,
  runScenario,
};
