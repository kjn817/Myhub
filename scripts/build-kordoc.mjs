// [2026-11-07 복구 재구성본] 소실 사고(2026-11-07) 후 엔진 재빌드 과정에서 재작성된 빌드 스크립트 보존본.
// 원본 scripts/build-*.mjs는 소실됐고, 이 파일이 그 레시피의 정본이다. 상세 레시피: scripts/ENGINE-BUILD-RECIPES.md
// build-kordoc.mjs 재구성 (3단계: 브라우저 번들)
// 원본 계약 (2026-11-03 기록):
//  - 브라우저 불가 경계: PDF·OCR(네이티브)·암호화 문서 — optional 의존성은 스텁으로 제외
//  - 산출 가드: markdownToHwpx 존재 검사 (2차), 무패치(nodeStream) 잔존 검사
import { build } from 'esbuild';
import { writeFileSync, statSync } from 'node:fs';

// optional(네이티브·PDF·OCR) 패키지와 node 내장 모듈을 받는 즉시-실패 스텁으로 치환.
// import 자체는 성공시키고 호출 시점에 던지게 해야 kordoc 내부의 try/catch 폴백이 산다.
const stubSource = (name) => `
const fail = () => { throw new Error('unavailable in browser bundle: ${name}'); };
const handler = {
  get(_t, prop) {
    if (prop === '__esModule') return true;
    if (prop === 'default') return proxy;
    if (prop === 'then') return undefined;
    return fail;
  },
  apply() { throw new Error('unavailable in browser bundle: ${name}'); },
  construct() { throw new Error('unavailable in browser bundle: ${name}'); },
};
const proxy = new Proxy(function () {}, handler);
module.exports = proxy;
`;

const STUB_PACKAGES = [
  'onnxruntime-node', 'onnxruntime-common', 'onnxruntime-web',
  'pdfjs-dist', '@hyzyla/pdfium', 'sharp', '@huggingface/tokenizers',
  'puppeteer-core', '@modelcontextprotocol/sdk', 'commander',
];
const STUB_BUILTINS = [
  'fs', 'fs/promises', 'os', 'https', 'http', 'http2', 'net', 'tls', 'dns',
  'child_process', 'worker_threads', 'cluster', 'dgram', 'readline', 'repl',
  'vm', 'v8', 'inspector', 'perf_hooks', 'async_hooks', 'module', 'events',
  'querystring', 'string_decoder', 'assert', 'tty', 'constants',
];

// 이름 있는 export가 필요한 ESM 스텁 (ESM→ESM 정적 검증 대응)
const NAMED_STUBS = {
  url: `
export function fileURLToPath() { throw new Error('unavailable in browser bundle: url.fileURLToPath'); }
export function pathToFileURL(p) { return new URL('file://' + p); }
export default { fileURLToPath, pathToFileURL };
`,
  stream: `
export class Readable { constructor() { throw new Error('unavailable in browser bundle: stream.Readable'); } }
export class Writable { constructor() { throw new Error('unavailable in browser bundle: stream.Writable'); } }
export class PassThrough { constructor() { throw new Error('unavailable in browser bundle: stream.PassThrough'); } }
export default { Readable, Writable, PassThrough };
`,

  util: `
export function format(...args) { return args.map(String).join(' '); }
export function promisify(fn) { return (...a) => new Promise((res, rej) => fn(...a, (e, v) => e ? rej(e) : res(v))); }
export function inspect(v) { try { return JSON.stringify(v); } catch { return String(v); } }
export const TextEncoder = globalThis.TextEncoder;
export const TextDecoder = globalThis.TextDecoder;
export default { format, promisify, inspect, TextEncoder, TextDecoder };
`,
};

const here = (f) => new URL('./' + f, import.meta.url).pathname;
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const PATH_BROWSERIFY = req.resolve('path-browserify');
const BUFFER_PKG = new URL('./node_modules/buffer/index.js', import.meta.url).pathname;

const plugin = {
  name: 'browser-stubs',
  setup(b) {
    const routeBuiltin = (raw) => {
      const name = raw.replace(/^node:/, '');
      if (name === 'buffer') return { path: BUFFER_PKG };
      if (name === 'path') return { path: PATH_BROWSERIFY };
      if (name === 'crypto') return { path: here('build-kordoc-shim-crypto.js') };
      if (name === 'zlib') return { path: here('build-kordoc-shim-zlib.js') };
      if (name === 'module') return { path: here('build-kordoc-shim-module.js') };
      if (NAMED_STUBS[name]) return { path: name, namespace: 'named-stub' };
      if (STUB_BUILTINS.includes(name)) return { path: raw, namespace: 'stub' };
      return null;
    };
    b.onResolve({ filter: /^node:/ }, (args) => routeBuiltin(args.path));
    b.onResolve({ filter: /^(buffer|path|crypto|zlib|url|stream|util|module|stream\/promises)$/ }, (args) => routeBuiltin(args.path) ?? { path: args.path, namespace: 'stub' });
    b.onLoad({ filter: /.*/, namespace: 'named-stub' }, (args) => ({
      contents: NAMED_STUBS[args.path],
      loader: 'js',
    }));
    b.onResolve({ filter: /.*/ }, (args) => {
      const p = args.path;
      const root = p.startsWith('@') ? p.split('/').slice(0, 2).join('/') : p.split('/')[0];
      if (STUB_PACKAGES.includes(p) || STUB_PACKAGES.includes(root)) {
        return { path: p, namespace: 'stub' };
      }
      if (STUB_BUILTINS.includes(p)) return { path: p, namespace: 'stub' };
      return null;
    });
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
      contents: stubSource(args.path),
      loader: 'js',
    }));
  },
};

const outfile = new URL('./kordoc.bundle.js', import.meta.url).pathname;
const result = await build({
  entryPoints: [new URL('./build-kordoc-entry.js', import.meta.url).pathname],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile,
  plugins: [plugin],
  // Buffer 전역 폴리필 (kordoc 이진 경로가 Buffer 전역을 참조)
  inject: [new URL('./build-kordoc-buffer-shim.js', import.meta.url).pathname],
  logLevel: 'warning',
  metafile: true,
});

const code = (await import('node:fs')).readFileSync(outfile, 'utf8');
// 산출 가드 (원본 재현): markdownToHwpx 존재 + nodeStream 잔존 금지
if (!code.includes('markdownToHwpx')) throw new Error('가드 실패: 번들에 markdownToHwpx가 없음');
if (code.includes('nodeStream("nodebuffer")')) throw new Error('가드 실패: 번들에 readZipEntry 무패치 호출 잔존');
const size = statSync(outfile).size;
console.log(`bundle ok: ${size} bytes (운영 기록 3,468,918B)`);
writeFileSync(new URL('./meta.json', import.meta.url).pathname, JSON.stringify(result.metafile));
