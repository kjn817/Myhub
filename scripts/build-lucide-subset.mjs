// Lucide 서브셋 빌드 (2026-11-13 성능 4라운드).
//
// 문제: public/vendor/lucide/lucide.min.js(477KB, 아이콘 2,292개)가
// 데스크톱 + 앱 iframe 12개 전부에 로드돼 앱 열기마다 60~160ms의 파싱
// 비용을 냈다 (LUCIDE_BLOCK 프로브 실측: memo -97ms·finder -59ms·
// todo -163ms). 실제 사용하는 아이콘은 100개 미만이다.
//
// 해법: public/을 스캔해 실제로 쓰는 아이콘 이름만 모아 lucide 패키지에서
// 해당 아이콘만 번들링한다. 버전은 현행 벤더 파일과 같은 1.67.0으로
// 고정한다 — 최신으로 올리면 아이콘 그림이 미묘하게 바뀔 수 있어, 이
// 리팩터링은 크기만 바꾸고 픽셀은 바꾸지 않는 것이 목표다.
//
// 안전망:
//  - 스캔은 scripts/lucide-scan.cjs가 담당한다 (테스트와 공유).
//    strict 패턴의 이름이 lucide 카탈로그에 없으면 빌드 실패
//    (조용한 누락 금지). lenient 패턴은 카탈로그에 있는 이름만 채택.
//  - 산출물과 함께 scripts/lucide-subset.json 매니페스트를 쓴다 —
//    tests/lucide-subset.test.ts가 스캔 결과와 매니페스트를 대조하고,
//    실브라우저 검증이 전 앱에서 <i data-lucide> 잔존 0건을 확인한다.
//  - login.html의 SRI 해시는 이 스크립트가 다시 계산해 갱신한다.
//
// 사용법: node scripts/build-lucide-subset.mjs
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { icons as LUCIDE_ICONS } from 'lucide';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const OUTFILE = path.join(PUBLIC, 'vendor/lucide/lucide.min.js');
const MANIFEST = path.join(ROOT, 'scripts/lucide-subset.json');
const require = createRequire(import.meta.url);
const { scanPublicIcons, kebabToPascal } = require('./lucide-scan.cjs');

// lucide 카탈로그 판정: kebab 이름을 PascalCase로 바꾼 export가 존재하는지
// 본다 (createIcons가 data-lucide 값을 찾는 방향과 같다). 역방향
// (Pascal→kebab) 변환은 숫자 접미사(FilePlus2 등)에서 틀리기 쉬워 쓰지 않는다.
const CATALOG = new Set(Object.keys(LUCIDE_ICONS));
function inCatalog(kebab) {
  return CATALOG.has(kebabToPascal(kebab));
}

const { strict, lenient } = scanPublicIcons(PUBLIC, ROOT);
const missing = [...strict.keys()].filter((n) => !inCatalog(n));
if (missing.length) {
  console.error('lucide 카탈로그에 없는 아이콘 이름이 스캔됨 (빌드 중단):');
  for (const n of missing) console.error(`  ${n}  (출처: ${strict.get(n)})`);
  process.exit(1);
}
const names = new Set([...strict.keys()]);
for (const n of lenient.keys()) if (inCatalog(n)) names.add(n);
const sorted = [...names].sort();
const pascalNames = sorted.map((n) => kebabToPascal(n));

// 진입 모듈 생성 (임시 파일은 scripts/ 아래에 두고 빌드 후 제거).
const entry = path.join(ROOT, 'scripts/.lucide-subset-entry.mjs');
const imports = pascalNames.join(', ');
const subsetObj = pascalNames.map((p) => `${p}`).join(', ');
fs.writeFileSync(
  entry,
  `import { createIcons as __origCreateIcons, ${imports} } from 'lucide';\n` +
    `const SUBSET = { ${subsetObj} };\n` +
    `const api = {\n` +
    `  icons: SUBSET,\n` +
    `  createIcons: function (opts) {\n` +
    `    var o = opts || {};\n` +
    `    return __origCreateIcons({ ...o, icons: o.icons || SUBSET });\n` +
    `  },\n` +
    `};\n` +
    `if (typeof window !== 'undefined') window.lucide = api;\n` +
    `if (typeof globalThis !== 'undefined') globalThis.lucide = api;\n`,
);

const before = fs.existsSync(OUTFILE) ? fs.statSync(OUTFILE).size : 0;
await build({
  entryPoints: [entry],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  outfile: OUTFILE,
  logLevel: 'warning',
});
fs.unlinkSync(entry);

const after = fs.statSync(OUTFILE).size;
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/lucide/package.json'), 'utf8'));
fs.writeFileSync(MANIFEST, JSON.stringify({ version: pkg.version, icons: sorted }, null, 2) + '\n');

// login.html SRI 해시 갱신 (이 페이지에만 integrity가 있다).
const loginPath = path.join(PUBLIC, 'login.html');
let login = fs.readFileSync(loginPath, 'utf8');
const digest = createHash('sha384').update(fs.readFileSync(OUTFILE)).digest('base64');
const SRI_RE = /(<script src="\/vendor\/lucide\/lucide\.min\.js" integrity=")sha384-[^"]+(")/;
if (!SRI_RE.test(login)) {
  console.error('login.html에서 lucide integrity 속성을 찾지 못함 (수동 확인 필요)');
  process.exit(1);
}
// 산출물이 바이트 동일하면 해시도 같아 교체 결과가 원본과 같다 —
// 그건 정상이므로 매칭 여부로만 판정한다.
const next = login.replace(SRI_RE, `$1sha384-${digest}$2`);
fs.writeFileSync(loginPath, next);

console.log(`lucide subset: ${sorted.length} icons, ${before} -> ${after} bytes (${((1 - after / before) * 100).toFixed(1)}% 감소)`);
console.log(`manifest: scripts/lucide-subset.json (lucide ${pkg.version})`);
