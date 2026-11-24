// pdfcraft 로더 (build-pdfcraft.mjs 재구성): 분할된 WASM 조각을 fetch로
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
  partFromQuery(0, './pdfcraft-web-a63fea2b9a0762bf_bg.wasm.part0'),
  partFromQuery(1, './pdfcraft-web-a63fea2b9a0762bf_bg.wasm.part1'),
  partFromQuery(2, './pdfcraft-web-a63fea2b9a0762bf_bg.wasm.part2'),
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

const bindings = await import('./pdfcraft-web-a63fea2b9a0762bf.js');
const wasm = await bindings.default({ module_or_path: bytes });
window.wasmBindings = bindings;
dispatchEvent(new CustomEvent('TrunkApplicationStarted', { detail: { wasm } }));
} catch (e) {
  reportFailure(e);
  throw e;
}
