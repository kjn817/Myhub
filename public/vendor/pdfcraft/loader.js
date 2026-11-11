// PdfCraft 로더 (MyHub 커스텀 셸) — WASM을 두 조각으로 받아 이어 붙인 뒤
// wasm-bindgen 글루를 부팅한다. 왜 이렇게 하나: raw WASM이 36MB로 정적
// 에셋 파일당 상한(25MB)을 넘어, 반으로 나눠 올린다. fetch의 arrayBuffer는
// 전송 인코딩과 무관하게 항상 원본 바이트를 돌려주므로, Worker가
// Content-Encoding을 직접 찍어 응답하던 구 방식(엣지에서 이중 인코딩돼
// 브라우저가 복원 실패)이 필요 없다. (scripts/build-pdfcraft.mjs가 생성)
import init, * as bindings from './pdfcraft-web-15b9731c4d83bf88.js';

const PARTS = ['./pdfcraft-web-51eed0055b268fe2_bg.wasm.part0', './pdfcraft-web-51eed0055b268fe2_bg.wasm.part1'];
const loadingEl = document.getElementById('pdfcraft-loading');
try {
  const bufs = await Promise.all(PARTS.map(async (p) => {
    const r = await fetch(p);
    if (!r.ok) throw new Error('WASM 조각 로드 실패: ' + p + ' (HTTP ' + r.status + ')');
    return new Uint8Array(await r.arrayBuffer());
  }));
  const total = bufs.reduce((n, b) => n + b.length, 0);
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const b of bufs) { bytes.set(b, off); off += b.length; }
  const res = new Response(bytes, { headers: { 'Content-Type': 'application/wasm' } });
  const wasm = await init({ module_or_path: res });
  window.wasmBindings = bindings;
  dispatchEvent(new CustomEvent('TrunkApplicationStarted', { detail: { wasm } }));
  if (loadingEl) loadingEl.remove();
} catch (err) {
  console.error('PdfCraft 부팅 실패:', err);
  if (loadingEl) loadingEl.textContent = '편집기를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.';
}
