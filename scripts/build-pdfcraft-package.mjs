// [2026-11-07 복구 재구성본] 소실 사고(2026-11-07) 후 엔진 재빌드 과정에서 재작성된 빌드 스크립트 보존본.
// 원본 scripts/build-*.mjs는 소실됐고, 이 파일이 그 레시피의 정본이다. 상세 레시피: scripts/ENGINE-BUILD-RECIPES.md
// build-pdfcraft.mjs 재구성 (패키징 단계)
// 원본 계약 (2026-11-03~05 기록 + AGENTS.md 교훈):
//  - 25MB 단일 파일 한도 때문에 WASM을 raw 조각으로 분할하고, 페이지가 fetch로
//    이어 붙여 부팅하는 커스텀 셸(index.html)+로더(loader.js)를 생성한다.
//    (Worker가 Content-Encoding을 직접 찍는 방식은 엣지 재인코딩 사고로 전면 제거됨)
//    파트 개수는 가변이다 — 파트당 24MB 상한으로 정한다 (v0.22.0부터 WASM이
//    54MB라 2분할로는 한도를 넘는다). 호스트는 매니페스트 wasmParts 배열
//    순서대로 받으므로 개수와 무관하게 동작한다.
//  - manifest.json에 wasmParts와 sourceCommit을 기록한다.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = new URL('./pdfcraft/dist/web/', import.meta.url).pathname;
const OUT = process.argv[2]; // 배치 대상 디렉터리
if (!OUT) throw new Error('usage: node package-pdfcraft.mjs <outdir>');
const SOURCE_COMMIT = '86e5b4cc1b7dde6adb8fd3f95cf21e13cad01fe9'; // myhub-v0.22.0 HEAD (chrome noabsorb for shell-hosted menus)
const VERSION = '0.22.0';

const files = readdirSync(DIST);
// v0.21.1 adds an OCR worker (pdfcraft-ocr-worker-*.js/_bg.wasm/_loader.js):
// match the main app files by prefix, not by suffix alone.
const glue = files.find((f) => f.startsWith('pdfcraft-web-') && f.endsWith('.js'));
const wasmName = files.find((f) => f.startsWith('pdfcraft-web-') && f.endsWith('_bg.wasm'));
const ocrJs = files.find((f) => f.startsWith('pdfcraft-ocr-worker-') && f.endsWith('.js') && !f.endsWith('_loader.js'));
const ocrWasm = files.find((f) => f.startsWith('pdfcraft-ocr-worker-') && f.endsWith('_bg.wasm'));
const ocrLoader = files.find((f) => f.startsWith('pdfcraft-ocr-worker-') && f.endsWith('_loader.js'));
if (!glue || !wasmName) throw new Error('dist/web에서 글루/WASM을 찾지 못함');
if (!ocrJs || !ocrWasm || !ocrLoader) throw new Error('dist/web에서 OCR 워커 파일을 찾지 못함');

const wasm = readFileSync(join(DIST, wasmName));
// 파트당 24MB 상한 (25MB 한도 아래 여유): 개수는 WASM 크기에서 정한다.
// v0.22.0 54MB → 3개 × 약 18MB. 상한을 넘는 파트가 나오면 패키징이
// 실패해야 한다 — 조용히 한도를 넘는 벤더를 만들면 배포에서 터진다.
const MAX_PART_BYTES = 24_000_000;
const PART_COUNT = Math.max(1, Math.ceil(wasm.length / MAX_PART_BYTES));
const PART_LEN = Math.ceil(wasm.length / PART_COUNT);
const parts = [];
const partBytes = [];
for (let i = 0; i < PART_COUNT; i++) {
  const start = i * PART_LEN;
  const end = Math.min(start + PART_LEN, wasm.length);
  parts.push(`${wasmName}.part${i}`);
  partBytes.push(end - start);
}
if (partBytes.some((n) => n >= 25_000_000)) {
  throw new Error(`WASM 파트가 25MB 한도를 넘는다: ${partBytes.join(', ')}`);
}

mkdirSync(OUT, { recursive: true });
for (let i = 0; i < PART_COUNT; i++) {
  writeFileSync(join(OUT, parts[i]), wasm.subarray(i * PART_LEN, i * PART_LEN + partBytes[i]));
}
copyFileSync(join(DIST, glue), join(OUT, glue));
// OCR 워커 파일군 (v0.21.1 신규): 앱이 <meta name="pdfcraft-ocr-worker">로 찾는다.
copyFileSync(join(DIST, ocrJs), join(OUT, ocrJs));
copyFileSync(join(DIST, ocrWasm), join(OUT, ocrWasm));
copyFileSync(join(DIST, ocrLoader), join(OUT, ocrLoader));
// snippets 트리 복사
const copyTree = (src, dst) => {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) copyTree(join(src, e.name), join(dst, e.name));
    else copyFileSync(join(src, e.name), join(dst, e.name));
  }
};
copyTree(join(DIST, 'snippets'), join(OUT, 'snippets'));

// 로더의 파트 목록은 패키징 시점에 리터럴로 박는다 — 로더는 매니페스트를
// 안 읽으므로 개수를 런타임에 알 수 없다. 줄 수는 parts 배열에서 나온다.
// 쿼리 값은 partFromQuery가 blob:만 받아들이고 나머지는 상대 경로로
// 폴백한다 (2026-11-25) — 임의 URL을 fetch해 공격자 WASM이 같은 출처
// iframe에서 실행되는 경로를 막는다.
const partLines = parts.map((p, i) => `  partFromQuery(${i}, './${p}'),`).join('\n');

const loader = `// pdfcraft 로더 (build-pdfcraft.mjs 재구성): 분할된 WASM 조각을 fetch로
// 이어 붙여 wasm-bindgen 글루의 init에 바이트로 전달한다. fetch arrayBuffer는 전송
// 인코딩과 무관하게 원본 바이트를 돌려주므로 엣지 재인코딩 영향을 받지 않는다.
// 게이트 핸드오프 (2026-11-15): 호스트가 부팅 게이트에서 받은 조각 바이트를
// Blob URL로 넘기면(쿼리 wasmPart0..wasmPartN) 네트워크 대신 그 URL을 받는다.
// 큰 조각은 HTTP 캐시에 남지 않아(2026-11-15 실측: 동일 문서 재-fetch도
// 전문 재다운로드) 게이트만으로는 엔진이 WASM 전문을 다시 받기 때문이다.
// 쿼리가 없으면 기존 상대경로로 받는다 (직접 열기·구 호스트 하위호환).
// 글루는 정적 import가 아니라 try 안에서 동적 import한다 (2026-11-21):
// 정적 import 실패(손상된 캐시 글루·404)는 모듈 로딩 단계에서 죽어
// try/catch에 안 잡히고 보고도 없어 45초 워치독만 터졌다. 동적이면
// 실패가 reportFailure로 부모에 전달돼 배너에 원인이 뜬다.
// (글루 파일명 자체가 콘텐츠 해시라 URL에 ?v=를 붙이지 않는다 —
// asset-url.js의 의도적 미버전 설계와 동일. 해시가 바뀌면 URL이 바뀐다.)

// 실패 보고 (2026-11-21): fetch/init 실패를 부모에 pdfcraft:failed로
// 알린다 — 보고 없이는 호스트가 45초 워치독까지 기다렸다가 원인도
// 모른 채 폴백만 했다 (사용자 실화면: 다운로드 완료 후 45초 뒤 배너).
// 호스트는 보고를 받으면 Blob 핸드오프 없이 네트워크 경로로 1회 재시도한다.
function reportFailure(err) {
  try {
    var msg = err && err.message ? String(err.message) : String(err);
    if (typeof parent !== 'undefined' && parent && parent !== window) {
      parent.postMessage({ type: 'pdfcraft:failed', error: msg }, location.origin);
    }
  } catch (e) {
    // 보고 실패는 무시한다 — 워치독이 폴백을 맡는다.
  }
}

try {
const PART_PARAMS = new URLSearchParams(location.search);
// 쿼리로 받은 파트 URL은 blob:만 허용한다 — 호스트가 부팅 게이트에서
// 넘기는 Blob URL이 유일한 정당한 쿼리 값이다 (blob: URL은 만든
// 출처에서만 fetch된다). 다른 스킴·경로가 들어오면 상대 경로 파트로
// 폴백한다.
function partFromQuery(i, fallback) {
  var v = PART_PARAMS.get('wasmPart' + i);
  if (typeof v === 'string' && v.indexOf('blob:') === 0) return v;
  return fallback;
}
const PARTS = [
${partLines}
];
const chunks = await Promise.all(
  PARTS.map(async (p) => {
    const res = await fetch(p);
    if (!res.ok) throw new Error('pdfcraft wasm part failed: ' + p + ' ' + res.status);
    return new Uint8Array(await res.arrayBuffer());
  })
);
const total = chunks.reduce((n, c) => n + c.length, 0);
const bytes = new Uint8Array(total);
let at = 0;
for (const c of chunks) { bytes.set(c, at); at += c.length; }

const bindings = await import('./${glue}');
const wasm = await bindings.default({ module_or_path: bytes });
window.wasmBindings = bindings;
dispatchEvent(new CustomEvent('TrunkApplicationStarted', { detail: { wasm } }));
} catch (e) {
  reportFailure(e);
  throw e;
}
`;
writeFileSync(join(OUT, 'loader.js'), loader);

// 셸의 로더 script는 절대 경로로 둔다 (2026-11-21): loader.js는 콘텐츠
// 해시가 없는 파일명이라 배포 버전(?v=)이 유일한 캐시 무효화 수단인데,
// 배포 버전 부착기(createVersioner)는 절대 경로 참조에만 ?v=를 붙이고
// ./loader.js 같은 상대 경로는 건드리지 않는다. 상대 경로 시절에는
// 손상·구버전 loader.js가 immutable 캐시에 영원히 고정돼 사용자
// 브라우저에서만 편집기가 조용히 안 뜨는 사고가 났다 (배너 '엔진 시작
// 시간 초과'). 이 index.html은 static-assets.json의 versioned에 들어
// 있어 배포 때 /vendor/pdfcraft/loader.js?v=<AV>로 재작성된다.
const shell = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="pdfcraft-ocr-worker" content="./${ocrLoader}" />
    <title>PdfCraft</title>
    <style>
      html, body { margin: 0; height: 100%; overflow: hidden; background: #f1f1f3; }
      canvas { width: 100%; height: 100%; display: block; outline: none; }
      @media (prefers-color-scheme: dark) { html, body { background: #19191c; } }
    </style>
    <script type="module" src="/vendor/pdfcraft/loader.js"></script>
  </head>
  <body>
    <canvas id="pdfcraft"></canvas>
  </body>
</html>
`;
writeFileSync(join(OUT, 'index.html'), shell);

// 라이선스 파일 (업스트림 저장소 루트)
const REPO = new URL('./pdfcraft/', import.meta.url).pathname;
for (const lic of ['LICENSE-APACHE', 'LICENSE-MIT', 'NOTICE']) {
  copyFileSync(join(REPO, lic), join(OUT, lic));
}

const snippetFiles = readdirSync(join(DIST, 'snippets'), { withFileTypes: true })
  .flatMap((d) => d.isDirectory()
    ? readdirSync(join(DIST, 'snippets', d.name)).map((f) => `snippets/${d.name}/${f}`)
    : [`snippets/${d.name}`]);
const manifest = {
  app: 'pdfcraft',
  version: VERSION,
  sourceCommit: SOURCE_COMMIT,
  entry: 'index.html',
  html: 'index.html',
  js: glue,
  wasm: wasmName,
  wasmBytes: wasm.length,
  wasmParts: parts,
  wasmPartBytes: partBytes,
  ocrWorker: { js: ocrJs, wasm: ocrWasm, loader: ocrLoader },
  files: [
    'LICENSE-APACHE',
    'LICENSE-MIT',
    'NOTICE',
    'index.html',
    'loader.js',
    glue,
    ocrJs,
    ocrWasm,
    ocrLoader,
    ...parts,
    ...snippetFiles,
  ],
};
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('packaged:', Object.keys(manifest).length, 'meta');
for (const f of [...parts, glue, ocrWasm, 'loader.js', 'index.html', 'manifest.json']) {
  console.log(f, statSync(join(OUT, f)).size);
}
