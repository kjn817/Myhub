// apply-ko-locale.mjs — @fortune-sheet/core 1.0.4 빌드 시점 한국어 로케일 주입 패치
//
// 배경: 코어 로케일 레지스트리(localeObj)는 {en, zh, es, zh-TW, hi, ru} 하드코딩이고
// 런타임 등록 API가 없어 lang:'ko'가 en으로 폴백한다. 운영 원본은 자체 한국어
// 로케일(약 1,457개 문자열)을 빌드 때 주입했으나 번역 자산이 소실됐다.
// 이 패치는 en 로케일 객체를 깊은 복사하며 ko-locale-map.json(en→ko)의 문자열로
// 치환한 ko 객체를 만들어 레지스트리에 등록한다. UI 동등 재번역이 목표이며
// 원문 복원이 아니다.
//
// 방식:
//  1) dist/index.esm.js 와 dist/index.js 에서 `var localeObj = {` 앵커를 찾는다.
//  2) 앵커 직전에 ko 생성 스니펫(번역 맵 + 경로 인식 walk + defaultFmt 래퍼)을 삽입한다.
//  3) localeObj 리터럴에 `ko: ko,` 항목을 추가한다.
//  walk는 functionlist(함수 설명 — 번역 범위 밖)를 en 참조 그대로 유지하고,
//  데이터성 경로는 치환에서 제외한다:
//   - currencyDetail[i].pos/.value (위치 코드·통화 기호)
//   - numberFmtList[i].pos/.value (단위 기호)
//   - dateFmtList 전체 (예시 문자열·형식 패턴)
//   - fontarray/fontFamily/fontjson (글꼴 식별자)
//   - linkTypeList[i].value, splitText.splitSymbols[i].value (동작 키 값)
//  멱등: 마커(myhub-ko-locale)가 있으면 건너뛴다.
//
// 사용: node apply-ko-locale.mjs [core-dist-dir]
//  기본값: ./node_modules/@fortune-sheet/core/dist (이 파일 기준 상대 경로)
// 재현: pristine node_modules에 이 스크립트를 실행한 뒤 기존 레시피대로
//  esbuild 번들하면 한국어 빌드가 된다. 패치를 되돌리려면 node_modules를
//  재설치(npm ci)하면 된다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(here, 'node_modules', '@fortune-sheet', 'core', 'dist');
const mapPath = path.join(here, 'ko-locale-map.json');
const MARKER = 'myhub-ko-locale';

const koMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));

const snippet = `
/* ${MARKER}: build-time ko locale injected by apply-ko-locale.mjs — do not edit by hand */
var __koMap = ${JSON.stringify(koMap)};
var __koSkip = /^(currencyDetail\\[\\d+\\]\\.(pos|value)|numberFmtList\\[\\d+\\]\\.(pos|value)|dateFmtList|fontarray|fontFamily|fontjson|linkTypeList\\[\\d+\\]\\.value|splitText\\.splitSymbols\\[\\d+\\]\\.value)/;
function __koWalk(v, p) {
  if (typeof v === "string") {
    return __koSkip.test(p) ? v : (__koMap[v] !== undefined ? __koMap[v] : v);
  }
  if (Array.isArray(v)) {
    return v.map(function (x, i) { return __koWalk(x, p + "[" + i + "]"); });
  }
  if (v && typeof v === "object") {
    var o = {};
    for (var k in v) {
      o[k] = k === "functionlist" ? v[k] : __koWalk(v[k], p ? p + "." + k : k);
    }
    return o;
  }
  return v;
}
var ko = __koWalk(en, "");
ko.defaultFmt = function (currency) {
  var m = {
    "Automatic": "자동",
    "Plain text": "일반 텍스트",
    "Number": "숫자",
    "Percent": "백분율",
    "Scientific": "지수",
    "Accounting": "회계",
    "Currency": "통화",
    "Date": "날짜",
    "Time": "시간",
    "Time 24H": "시간(24시간)",
    "Date time": "날짜 및 시간",
    "Date time 24 H": "날짜 및 시간(24시간)",
    "Custom formats": "사용자 지정 형식"
  };
  return en.defaultFmt(currency).map(function (it) {
    var c = {};
    for (var k in it) c[k] = it[k];
    if (m[c.text]) c.text = m[c.text];
    return c;
  });
};
`;

let patched = 0;
for (const file of ['index.esm.js', 'index.js']) {
  const fp = path.join(distDir, file);
  if (!fs.existsSync(fp)) {
    console.log(`${file}: 없음 — 건너뜀`);
    continue;
  }
  let src = fs.readFileSync(fp, 'utf8');
  if (src.includes(MARKER)) {
    console.log(`${file}: 이미 패치됨 — 건너뜀`);
    continue;
  }
  const anchor = 'var localeObj = {';
  const at = src.indexOf(anchor);
  if (at < 0 || src.indexOf(anchor, at + 1) >= 0) {
    console.error(`${file}: 앵커 '${anchor}'를 정확히 한 번 찾지 못함 — 중단`);
    process.exit(1);
  }
  src =
    src.slice(0, at) +
    snippet.trim() +
    '\n\n' +
    anchor +
    '\n  ko: ko,' +
    src.slice(at + anchor.length);
  fs.writeFileSync(fp, src);
  patched += 1;
  console.log(`${file}: ko 로케일 주입 완료`);
}
console.log(`patched files: ${patched}`);
