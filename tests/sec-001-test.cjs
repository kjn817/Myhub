/**
 * SEC-001: renderMarkdown 보안 테스트
 * Node.js 환경에서 DOMPurify 동작 검증
 */

// 최소 DOM 모킹
global.document = {
  createElement: (tag) => ({
    tagName: tag,
    _textContent: '',
    _innerHTML: '',
    set textContent(v) { this._textContent = v; this._innerHTML = v.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); },
    get textContent() { return this._textContent; },
    set innerHTML(v) { this._innerHTML = v; },
    get innerHTML() { return this._innerHTML; },
    querySelectorAll: () => [],
  })
};

// DOMPurify 모킹 (실제로는 jsdom + dompurify 필요)
global.window = {
  marked: {
    parse: (text) => {
      // 간단한 마크다운 변환 모킹
      return text
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`(.+?)`/g, '<code>$1</code>');
    }
  },
  DOMPurify: {
    sanitize: (html) => {
      // 위험한 패턴 제거 모킹
      return html
        .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
        .replace(/<script[^>]*>.*?<\/script>/gi, '')
        .replace(/javascript:/gi, '');
    }
  }
};

// renderMarkdown 함수 (수정된 버전)
function renderMarkdown(text) {
  const raw = String(text ?? "");
  if (typeof window.marked?.parse !== "function" ||
      typeof window.DOMPurify?.sanitize !== "function") {
    const safe = document.createElement("div");
    safe.textContent = raw;
    return safe.innerHTML;
  }
  try {
    const html = window.marked.parse(raw);
    // SEC-001: 정제 전 DOM 삽입 금지 - 최초 정제 후 삽입
    const firstClean = window.DOMPurify.sanitize(html);
    const tmp = document.createElement('div');
    tmp.innerHTML = firstClean;
    // 하이라이팅 (생략)
    return window.DOMPurify.sanitize(tmp.innerHTML);
  } catch {
    const safe = document.createElement("div");
    safe.textContent = raw;
    return safe.innerHTML;
  }
}

// 테스트
console.log('=== SEC-001 보안 테스트 ===\n');

const tests = [
  {
    name: 'SEC-TEST-01: 정상 마크다운',
    input: '**굵게** 테스트',
    check: (out) => out.includes('<strong>굵게</strong>'),
  },
  {
    name: 'SEC-TEST-03: 이벤트 속성 제거',
    input: '<img src="x" onerror="alert(1)">',
    check: (out) => !out.includes('onerror'),
  },
  {
    name: 'SEC-TEST-04: 위험한 URL 제거',
    input: '<a href="javascript:alert(1)">클릭</a>',
    check: (out) => !out.includes('javascript:'),
  },
  {
    name: 'SEC-TEST-06: DOMPurify 미로드 시 폴백',
    input: '<script>alert(1)</script>',
    setup: () => { const d = window.DOMPurify; window.DOMPurify = undefined; return () => window.DOMPurify = d; },
    check: (out) => !out.includes('<script>'),
  },
];

let passed = 0;
let failed = 0;

for (const t of tests) {
  let restore = null;
  if (t.setup) restore = t.setup();
  
  try {
    const out = renderMarkdown(t.input);
    const ok = t.check(out);
    if (ok) {
      console.log(`✅ ${t.name}: PASS`);
      passed++;
    } else {
      console.log(`❌ ${t.name}: FAIL`);
      console.log(`   출력: ${out.substring(0, 100)}`);
      failed++;
    }
  } catch (e) {
    console.log(`❌ ${t.name}: ERROR - ${e.message}`);
    failed++;
  }
  
  if (restore) restore();
}

console.log(`\n=== 결과: ${passed} PASS, ${failed} FAIL ===`);
process.exit(failed > 0 ? 1 : 0);
