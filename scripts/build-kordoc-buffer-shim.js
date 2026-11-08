// [2026-11-07 복구 재구성본] 소실 사고(2026-11-07) 후 엔진 재빌드 과정에서 재작성된 빌드 스크립트 보존본.
// 원본 scripts/build-*.mjs는 소실됐고, 이 파일이 그 레시피의 정본이다. 상세 레시피: scripts/ENGINE-BUILD-RECIPES.md
import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;
if (typeof globalThis.process === 'undefined') {
  globalThis.process = {
    env: {},
    platform: 'browser',
    version: '',
    cwd: () => '/',
    nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
    on: () => {},
    exit: (code) => { throw new Error('process.exit(' + code + ') in browser bundle'); },
  };
}
export {};
