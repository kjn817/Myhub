// [2026-11-07 복구 재구성본] 소실 사고(2026-11-07) 후 엔진 재빌드 과정에서 재작성된 빌드 스크립트 보존본.
// 원본 scripts/build-*.mjs는 소실됐고, 이 파일이 그 레시피의 정본이다. 상세 레시피: scripts/ENGINE-BUILD-RECIPES.md
// build-pdfcraft.mjs 재구성 (패키징 단계)
// 원본 계약 (2026-11-03~05 기록 + AGENTS.md 교훈):
//  - 25MB 단일 파일 한도 때문에 WASM을 raw 조각 2개로 분할하고, 페이지가 fetch로
//    이어 붙여 부팅하는 커스텀 셸(index.html)+로더(loader.js)를 생성한다.
//    (Worker가 Content-Encoding을 직접 찍는 방식은 엣지 재인코딩 사고로 전면 제거됨)
//  - manifest.json에 wasmParts와 sourceCommit을 기록한다.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = new URL('./pdfcraft/dist/web/', import.meta.url).pathname;
const OUT = process.argv[2]; // 배치 대상 디렉터리
if (!OUT) throw new Error('usage: node package-pdfcraft.mjs <outdir>');
const SOURCE_COMMIT = 'ca64a31c6ccc61d326970cc576e00043671d3f57';

const files = readdirSync(DIST);
const glue = files.find((f) => f.endsWith('.js'));
const wasmName = files.find((f) => f.endsWith('_bg.wasm'));
if (!glue || !wasmName) throw new Error('dist/web에서 글루/WASM을 찾지 못함');

const wasm = readFileSync(join(DIST, wasmName));
const HALF = Math.ceil(wasm.length / 2);
const part0 = `${wasmName}.part0`;
const part1 = `${wasmName}.part1`;

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, part0), wasm.subarray(0, HALF));
writeFileSync(join(OUT, part1), wasm.subarray(HALF));
copyFileSync(join(DIST, glue), join(OUT, glue));
// snippets 트리 복사
const copyTree = (src, dst) => {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) copyTree(join(src, e.name), join(dst, e.name));
    else copyFileSync(join(src, e.name), join(dst, e.name));
  }
};
copyTree(join(DIST, 'snippets'), join(OUT, 'snippets'));

const loader = `// pdfcraft 로더 (build-pdfcraft.mjs 재구성): 분할된 WASM 조각을 fetch로
// 이어 붙여 wasm-bindgen 글루의 init에 바이트로 전달한다. fetch arrayBuffer는 전송
// 인코딩과 무관하게 원본 바이트를 돌려주므로 엣지 재인코딩 영향을 받지 않는다.
import init, * as bindings from './${glue}';

const PARTS = ['./${part0}', './${part1}'];
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

const wasm = await init({ module_or_path: bytes });
window.wasmBindings = bindings;
dispatchEvent(new CustomEvent('TrunkApplicationStarted', { detail: { wasm } }));
`;
writeFileSync(join(OUT, 'loader.js'), loader);

const shell = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>PdfCraft</title>
    <style>
      html, body { margin: 0; height: 100%; overflow: hidden; background: #f1f1f3; }
      canvas { width: 100%; height: 100%; display: block; outline: none; }
      @media (prefers-color-scheme: dark) { html, body { background: #19191c; } }
    </style>
    <script type="module" src="./loader.js"></script>
  </head>
  <body>
    <canvas id="pdfcraft"></canvas>
  </body>
</html>
`;
writeFileSync(join(OUT, 'index.html'), shell);

const manifest = {
  sourceCommit: SOURCE_COMMIT,
  glue,
  wasm: wasmName,
  wasmBytes: wasm.length,
  wasmParts: [part0, part1],
  wasmPartBytes: [HALF, wasm.length - HALF],
};
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('packaged:', Object.keys(manifest).length, 'meta');
for (const f of [part0, part1, glue, 'loader.js', 'index.html', 'manifest.json']) {
  console.log(f, statSync(join(OUT, f)).size);
}
