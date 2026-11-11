// fortune.js 빌드 후 패치 — 이미지 편집 플로팅 도구의 하드코딩 제목 4종 한국어화.
// 로케일 레지스트리 주입(apply-ko-locale.mjs)으로는 닿지 않는
// @fortune-sheet/react 이미지 컴포넌트의 title/aria-label 문자열만,
// 오프셋 구간(이미지 도구 클러스터 > 5,500,000)으로 한정해 교체한다.
// zh/zh-TW 로케일 데이터 영역의 동일 문자열은 건드리지 않는다.
// 사용: node patch-image-titles.mjs <input.js> <output.js>
// 기대 개수가 다르면 실패한다 (번들 구조가 바뀐 경우의 안전장치).
import fs from 'node:fs';

const [inp, outp] = process.argv.slice(2);
if (!inp || !outp) { console.error('usage: patch-image-titles.mjs <in> <out>'); process.exit(2); }
let s = fs.readFileSync(inp, 'utf-8');
const CLUSTER_FROM = 5_500_000;

function count(hay, needle) { return hay.split(needle).length - 1; }
function expectEq(actual, expected, label) {
  if (actual !== expected) { console.error(`FAIL ${label}: expected ${expected}, got ${actual}`); process.exit(1); }
}

const CROP = '"\\u88C1\\u526A"';
const RESTORE = '"\\u6062\\u590D\\u539F\\u56FE"';
const DEL = '"\\u5220\\u9664"';
expectEq(count(s, CROP), 4, 'crop titles');
expectEq(count(s, RESTORE), 4, 'restore titles');
expectEq(count(s, 'title: "Zoom settings"'), 1, 'zoom title');

s = s.split(CROP).join('"자르기"');
s = s.split(RESTORE).join('"원본 복원"');
s = s.replace('title: "Zoom settings"', 'title: "확대/축소 설정"');

// 삭제 제목은 클러스터 구간 안의 4개만 (로케일 영역 6개는 보존)
let delTotal = 0; let delPatched = 0;
let idx = 0; let out = '';
while (true) {
  const i = s.indexOf(DEL, idx);
  if (i < 0) { out += s.slice(idx); break; }
  delTotal += 1;
  out += s.slice(idx, i);
  if (i > CLUSTER_FROM) { out += '"삭제"'; delPatched += 1; } else { out += DEL; }
  idx = i + DEL.length;
}
s = out;
expectEq(delTotal, 10, 'standalone delete strings');
expectEq(delPatched, 4, 'patched delete titles');
expectEq(count(s, CROP), 0, 'crop titles after');
expectEq(count(s, RESTORE), 0, 'restore titles after');
expectEq(count(s, DEL), 6, 'locale delete strings preserved');

fs.writeFileSync(outp, s);
console.log('patched OK:', outp);
