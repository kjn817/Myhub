// [2026-11-07 복구 재구성본] 소실 사고(2026-11-07) 후 엔진 재빌드 과정에서 재작성된 빌드 스크립트 보존본.
// 원본 scripts/build-*.mjs는 소실됐고, 이 파일이 그 레시피의 정본이다. 상세 레시피: scripts/ENGINE-BUILD-RECIPES.md
// build-kordoc.mjs 재구성 (1단계: dist 패치)
// 원본 계약 (2026-11-03 기록): kordoc 4.24.39 핀, dist 소스 단계 패치,
// readZipEntry의 JSZip .nodeStream → file.async('uint8array') + 상한 가드 교체.
// 패치 앵커가 없으면 실패하는 가드 + 무패치 번들 방지 가드를 함께 재현한다.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const distDir = new URL('./node_modules/kordoc/dist/', import.meta.url).pathname;

const OLD_ANCHOR = 'const stream = file.nodeStream("nodebuffer");';
const FN_START = 'function readZipEntry(file, type, used = 0) {';
const FN_END = 'function clampSpan';

const NEW_FN = `async function readZipEntry(file, type, used = 0) {
  const declared = file._data?.uncompressedSize;
  const limit = typeof declared === "number" && declared >= 0 ? declared : Number.POSITIVE_INFINITY;
  if (Number.isFinite(limit) && used + limit > MAX_DECOMPRESS_SIZE) {
    throw new ZipBombError("ZIP \\uC555\\uCD95 \\uD574\\uC81C \\uD06C\\uAE30 \\uCD08\\uACFC (ZIP bomb \\uC758\\uC2EC)");
  }
  const data = await file.async("uint8array");
  if (used + data.length > MAX_DECOMPRESS_SIZE || data.length > limit) {
    throw new ZipBombError("ZIP \\uC555\\uCD95 \\uD574\\uC81C \\uD06C\\uAE30 \\uCD08\\uACFC (ZIP bomb \\uC758\\uC2EC)");
  }
  if (type === "text") return new TextDecoder("utf-8").decode(data);
  return data;
}
`;

let patched = 0;
for (const name of readdirSync(distDir)) {
  if (!name.endsWith('.js')) continue; // ESM dist만 (번들 진입점이 ESM)
  const path = join(distDir, name);
  const src = readFileSync(path, 'utf8');
  if (!src.includes(OLD_ANCHOR)) continue;
  const start = src.indexOf(FN_START);
  const end = src.indexOf(FN_END, start);
  if (start < 0 || end < 0) {
    throw new Error(`패치 앵커 불완전: ${name} (start=${start}, end=${end}) — 빌드 중단`);
  }
  const next = src.slice(0, start) + NEW_FN + '\n' + src.slice(end);
  writeFileSync(path, next);
  patched++;
  console.log(`patched: ${name}`);
}

if (patched === 0) throw new Error('패치 대상이 없음 — 이미 패치됐거나 dist 구조 변경. 빌드 중단.');

// 무패치 방지 가드: ESM dist 전체에 nodeStream이 남아 있으면 실패
for (const name of readdirSync(distDir)) {
  if (!name.endsWith('.js')) continue;
  const src = readFileSync(join(distDir, name), 'utf8');
  if (src.includes('nodeStream')) throw new Error(`nodeStream 잔존: ${name} — 빌드 중단`);
}
console.log(`patch complete: ${patched} file(s), nodeStream 잔존 0`);
