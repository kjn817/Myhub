// Lucide 아이콘 이름 스캐너 — build-lucide-subset.mjs와
// tests/lucide-subset.test.ts가 공유하는 유일한 스캔 로직이다.
// public/의 html·js에서 실제로 쓰는 아이콘 이름을 모은다.
// (vendor·pdf-viewer·rhwp-studio는 자체 문서라 제외.)
//
// strict: 아이콘 문맥이 확실한 패턴 — 이 이름이 서브셋에 없으면
//   빌드·테스트가 실패해야 한다.
//   1) data-lucide="..." 리터럴
//   2) glyph: '...' / icon: '...' 필드
//   4) fileGlyph / fileIcon 함수의 return 리터럴
// lenient: 삼항 분기·|| 폴백의 따옴표 문자열 — 아이콘이 아닌 값도
//   많이 잡히므로, 빌드는 카탈로그에 있는 이름만 채택한다.
'use strict';
const fs = require('fs');
const path = require('path');

const SCAN_SKIP = new Set(['vendor', 'pdf-viewer', 'rhwp-studio', '.scratch']);
const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function kebabToPascal(kebab) {
  return kebab
    .split('-')
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
    .join('');
}

// 함수 선언 시작 위치부터 중괄호 균형을 세어 함수 본문만 잘라낸다.
// (문자열·템플릿·주석 안의 중괄호는 세지 않는다 — fileGlyph/fileIcon은
// 작은 순수 함수라 이 정도면 충분하다.)
function functionBody(src, at) {
  const open = src.indexOf('{', at);
  if (open < 0) return '';
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

function listFiles(dir, out) {
  out = out || [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SCAN_SKIP.has(ent.name)) continue;
      listFiles(p, out);
    } else if (ent.isFile() && (p.endsWith('.js') || p.endsWith('.html'))) {
      out.push(p);
    }
  }
  return out;
}

function scanPublicIcons(publicDir, rootDir) {
  const strict = new Map();
  const lenient = new Map();
  const noteStrict = (name, src) => {
    if (!NAME_RE.test(name)) return;
    if (!strict.has(name)) strict.set(name, src);
  };
  const noteLenient = (name, src) => {
    if (!NAME_RE.test(name)) return;
    if (!lenient.has(name)) lenient.set(name, src);
  };
  for (const file of listFiles(publicDir)) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = rootDir ? path.relative(rootDir, file) : file;
    for (const m of src.matchAll(/data-lucide=["']([A-Za-z0-9-]+)["']/g)) noteStrict(m[1], rel);
    for (const m of src.matchAll(/(?:glyph|icon)\s*:\s*["']([A-Za-z0-9-]+)["']/g)) noteStrict(m[1], rel);
    for (const m of src.matchAll(/\?\s*["']([A-Za-z0-9-]+)["']\s*:\s*["']([A-Za-z0-9-]+)["']/g)) {
      noteLenient(m[1], rel);
      noteLenient(m[2], rel);
    }
    for (const m of src.matchAll(/\|\|\s*["']([A-Za-z0-9-]+)["']/g)) noteLenient(m[1], rel);
    for (const fn of ['fileGlyph', 'fileIcon']) {
      // 'function fileIcon('처럼 괄호까지 매칭해야 fileIconsApi 같은
      // 접두사 일치를 피한다 (2026-11-13: fileIconsApi를 잡아
      // legacyKindFor의 반환값까지 스캔하는 오탐이 있었다).
      const at = src.indexOf(`function ${fn}(`);
      if (at < 0) continue;
      const body = functionBody(src, at);
      for (const m of body.matchAll(/return\s+["']([A-Za-z0-9-]+)["']/g)) noteStrict(m[1], rel);
    }
  }
  return { strict, lenient };
}

module.exports = { scanPublicIcons, kebabToPascal };
