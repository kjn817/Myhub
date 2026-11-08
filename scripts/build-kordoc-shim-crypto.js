// [2026-11-07 복구 재구성본] 소실 사고(2026-11-07) 후 엔진 재빌드 과정에서 재작성된 빌드 스크립트 보존본.
// 원본 scripts/build-*.mjs는 소실됐고, 이 파일이 그 레시피의 정본이다. 상세 레시피: scripts/ENGINE-BUILD-RECIPES.md
// crypto 브라우저 시임: 해시는 sha.js(순수 JS)로 실제 제공,
// 암호화 문서 경로는 기록상 브라우저 불가 경계라 호출 시 실패시킨다.
import createHashImpl from 'sha.js';

export function createHash(algorithm) {
  return createHashImpl(algorithm);
}
export function randomUUID() {
  return globalThis.crypto.randomUUID();
}
const fail = (name) => () => { throw new Error(`unavailable in browser bundle: crypto.${name}`); };
export const createCipheriv = fail('createCipheriv');
export const createDecipheriv = fail('createDecipheriv');
export const pbkdf2Sync = fail('pbkdf2Sync');
export const timingSafeEqual = fail('timingSafeEqual');
export default { createHash, randomUUID, createCipheriv, createDecipheriv, pbkdf2Sync, timingSafeEqual };
