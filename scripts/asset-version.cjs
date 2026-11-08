"use strict";
// 정적 에셋 캐시 무효화 버전 부착기 (2026-11-01 신설, 재구축으로 복원)
//
// 배경: deploy_full.py NODE_GEN의 ?v= 재작성이 고정 파일 목록이라, 목록에
// 없는 데스크톱 에셋(css/desktop.css·js/desktop/*)이 배포 후에도 브라우저의
// 구버전 캐시로 계속 실행되는 사고가 있었다 ("배포했는데 화면 그대로").
// 그래서 부착 기준을 scripts/static-assets.json의 업로드 집합(files) 전체로
// 바꿨다 — 새 에셋은 매니페스트에 등록만 하면 자동으로 ?v= 대상이 된다.
// 이 모듈을 가리키는 회귀 테스트는 tests/asset-version.test.ts다.
//
// 왜 .cjs인가: 프로젝트 package.json이 "type": "module"이라, plain node의
// require가 .js를 ESM으로 해석해 `createVersioner is not a function`으로
// 배포가 중단된 사고(2026-11-01)가 있었다. NODE_GEN(plain node -e)이
// require하는 파일은 반드시 .cjs여야 한다.
//
// 계약:
// - createVersioner(assetList, assetVer) → (content: string) => string
// - assetList는 static-assets.json의 파싱 결과({files: string[], ...}).
// - versioned 대상 파일의 본문에서, files 집합에 있는 경로의 참조
//   (따옴표·괄호·url() 앞, 선행 "/")에 "?v=<assetVer>"를 붙인다.
// - 이미 ?v=가 붙은 참조는 건드리지 않는다 (이중 부착 방지 —
//   public 원본의 하드코딩 ?v= 금지 규칙과 짝을 이룬다).
// - files 집합에 없는 경로는 붙이지 않는다.

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createVersioner(assetList, assetVer) {
  const files = [...(assetList.files || [])]
    .filter((p) => typeof p === "string" && p.startsWith("/"))
    // 긴 경로를 먼저 매칭한다 (접두사가 겹치는 경로 쌍에서 긴 쪽 우선).
    .sort((a, b) => b.length - a.length);
  if (!files.length || !assetVer) {
    return (s) => s;
  }
  const alternation = files.map((p) => escapeRegExp(p.slice(1))).join("|");
  const re = new RegExp(
    "([\"'(]|url\\()(['\"]?)\\/(" + alternation + ")(?!\\?v=)",
    "g",
  );
  return (s) => s.replace(re, "$1$2/$3?v=" + assetVer);
}

module.exports = { createVersioner };
