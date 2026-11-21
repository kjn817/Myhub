// pdfcraft 로더 (build-pdfcraft.mjs 재구성): 분할된 WASM 조각을 fetch로
// 이어 붙여 wasm-bindgen 글루의 init에 바이트로 전달한다. fetch arrayBuffer는 전송
// 인코딩과 무관하게 원본 바이트를 돌려주므로 엣지 재인코딩 영향을 받지 않는다.
// 게이트 핸드오프 (2026-11-15): 호스트가 부팅 게이트에서 받은 조각 바이트를
// Blob URL로 넘기면(쿼리 wasmPart0/wasmPart1) 네트워크 대신 그 URL을 받는다.
// 23MB 조각은 HTTP 캐시에 남지 않아(2026-11-15 실측: 동일 문서 재-fetch도
// 전문 재다운로드) 게이트만으로는 엔진이 47MB를 다시 받기 때문이다.
// 쿼리가 없으면 기존 상대경로로 받는다 (직접 열기·구 호스트 하위호환).
import init, * as bindings from './pdfcraft-web-9b55b29e05639517.js';

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
const PARTS = [
  PART_PARAMS.get('wasmPart0') || './pdfcraft-web-9b55b29e05639517_bg.wasm.part0',
  PART_PARAMS.get('wasmPart1') || './pdfcraft-web-9b55b29e05639517_bg.wasm.part1',
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

const wasm = await init({ module_or_path: bytes });
window.wasmBindings = bindings;
dispatchEvent(new CustomEvent('TrunkApplicationStarted', { detail: { wasm } }));
} catch (e) {
  reportFailure(e);
  throw e;
}
