// [2026-11-07 복구 재구성본] 소실 사고(2026-11-07) 후 엔진 재빌드 과정에서 재작성된 빌드 스크립트 보존본.
// 원본 scripts/build-*.mjs는 소실됐고, 이 파일이 그 레시피의 정본이다. 상세 레시피: scripts/ENGINE-BUILD-RECIPES.md
// module 브라우저 시임: createRequire가 실제로 요구하는 패키지는 cfb 하나뿐 (전수 확인)
// — 번들에 포함된 cfb를 그대로 돌려주고, 그 외는 브라우저 불가로 실패시킨다.
import cfbModule from 'cfb';

export function createRequire() {
  const req = (name) => {
    if (name === 'cfb') return cfbModule;
    throw new Error('unavailable in browser bundle: require(' + name + ')');
  };
  req.resolve = () => { throw new Error('unavailable in browser bundle: require.resolve'); };
  return req;
}
export default { createRequire };
