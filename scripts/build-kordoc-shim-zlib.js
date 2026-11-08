// [2026-11-07 복구 재구성본] 소실 사고(2026-11-07) 후 엔진 재빌드 과정에서 재작성된 빌드 스크립트 보존본.
// 원본 scripts/build-*.mjs는 소실됐고, 이 파일이 그 레시피의 정본이다. 상세 레시피: scripts/ENGINE-BUILD-RECIPES.md
// zlib 브라우저 시임: pako로 실제 제공 (HWP/HWPX 압축 해제가 파싱 본선 경로)
import * as pako from 'pako';

const buf = (u8) => Buffer.from(u8);
export function inflateSync(data) { return buf(pako.inflate(data)); }
export function inflateRawSync(data) { return buf(pako.inflateRaw(data)); }
export function deflateSync(data) { return buf(pako.deflate(data)); }
export function deflateRawSync(data) { return buf(pako.deflateRaw(data)); }
export const constants = {};
export default { inflateSync, inflateRawSync, deflateSync, deflateRawSync, constants };
