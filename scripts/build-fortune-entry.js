// [2026-11-07 복구 재구성본] 소실 사고(2026-11-07) 후 엔진 재빌드 과정에서 재작성된 빌드 스크립트 보존본.
// 원본 scripts/build-*.mjs는 소실됐고, 이 파일이 그 레시피의 정본이다. 상세 레시피: scripts/ENGINE-BUILD-RECIPES.md
// fortune-entry 재구성: @fortune-sheet/react Workbook을 고전 스크립트 전역으로 노출.
// 복원된 sheet-fortune.html의 계약: window.FortuneSheet.createWorkbook(el, { data, lang })
// - data: FortuneSheet Sheet[] (celldata 형식), lang: 'ko'는 코어 로케일에 없어 en으로 폴백됨
//   (운영본은 자체 한국어 로케일 1,457개 문자열을 주입했으나 그 번역 자산은 소실 — 본 재구성은 기능 동등 범위)
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Workbook } from '@fortune-sheet/react';

const roots = new WeakMap();

function createWorkbook(el, opts = {}) {
  if (!el) throw new Error('FortuneSheet.createWorkbook: container element required');
  let root = roots.get(el);
  if (!root) {
    root = createRoot(el);
    roots.set(el, root);
  }
  const props = {
    data: opts.data && opts.data.length ? opts.data : [{ name: 'Sheet1', celldata: [] }],
    lang: opts.lang || 'en',
  };
  if (typeof opts.onChange === 'function') props.onChange = opts.onChange;
  if (typeof opts.onOp === 'function') props.onOp = opts.onOp;
  root.render(React.createElement(Workbook, props));
  return {
    unmount() {
      root.unmount();
      roots.delete(el);
    },
  };
}

const FortuneSheet = { createWorkbook, Workbook };
window.FortuneSheet = FortuneSheet;
export default FortuneSheet;
