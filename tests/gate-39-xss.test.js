/**
 * 관문 테스트 39: 채팅 XSS 방지 — 실제 파일(public/agent.html) 검증
 *
 * 성질: 서버·DB에서 온 채팅 메시지(m.content)는 HTML로 해석되지 않고
 * 텍스트로 렌더링된다. <script>나 <img onerror> 같은 페이로드를
 * 채팅에 넣어도 실행되지 않는다.
 *
 * 검증 방식: 브라우저 없이 실제 배송 파일 public/agent.html을 읽어
 * 렌더링 경로를 검사하고, 파일에 포함된 esc() 함수를 실제로 실행한다.
 * - renderChatMsg(): user/nova 모두 m.content를 textContent로만 넣는다.
 *   innerHTML 템플릿 안에는 m.content가 없다.
 * - addMsg('user', ...) 호출부는 전부 esc()로 감싼다.
 * - 검색 결과 렌더링도 서버에서 온 제목·스니펫을 esc()로 감싼다.
 * - esc()는 & < > " ' 를 모두 이스케이프한다 (함수 본문을 직접 실행해 확인).
 *
 * 실행: npx jest tests/gate-39-xss.test.js
 */
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '../public/agent.html'), 'utf8');

function extractFunction(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error(`함수를 찾을 수 없음: ${startMarker}`);
  const end = endMarker ? src.indexOf(endMarker, start) : src.length;
  if (end === -1) throw new Error(`함수 끝을 찾을 수 없음: ${endMarker}`);
  return src.slice(start, end);
}

describe('관문 39: 채팅 XSS 방지 (실제 agent.html)', () => {
  test('renderChatMsg는 user/nova 모두 m.content를 textContent로만 넣는다', () => {
    const fn = extractFunction(HTML, 'function renderChatMsg(m, inner) {', '/* 결과 카드 렌더링 */');
    expect(fn).toContain("tmp.querySelector('.bubble').textContent = m.content");
    expect(fn).toContain("tmp.querySelector('p').textContent = m.content");
    // 이 함수 안의 innerHTML 템플릿에는 m.content가 없어야 한다
    const innerHtmlTemplates = [...fn.matchAll(/innerHTML\s*=\s*`([\s\S]*?)`;/g)].map((m) => m[1]);
    expect(innerHtmlTemplates.length).toBeGreaterThan(0);
    for (const tpl of innerHtmlTemplates) {
      expect(tpl).not.toContain('content');
    }
  });

  test('esc()는 & < > " \' 를 실제로 이스케이프한다 (파일의 함수를 직접 실행)', () => {
    const m = HTML.match(/function esc\(s\) \{ return (.*?); \}/);
    expect(m).not.toBeNull();
    const esc = new Function('s', 'return ' + m[1] + ';');
    expect(esc('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
    expect(esc('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(esc(`a&b"c'd`)).toBe('a&amp;b&quot;c&#39;d');
    expect(esc('평문')).toBe('평문');
  });

  test("addMsg('user', ...) 호출부는 전부 esc()로 감싼다", () => {
    const calls = [...HTML.matchAll(/addMsg\('user',\s*([^)]+)\)/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const [, arg] of calls) {
      expect(arg.trim().startsWith('esc(')).toBe(true);
    }
  });

  test('검색 결과 렌더링은 서버에서 온 제목·스니펫을 esc()로 감싼다', () => {
    expect(HTML).toContain('${esc(p.title)}');
    expect(HTML).toContain('${esc(h.snippet)}');
    expect(HTML).toContain('${esc(h.artifact_title');
  });

  test('파일 전체에서 innerHTML 템플릿 안에 m.content가 직접 들어가지 않는다', () => {
    const templates = [...HTML.matchAll(/innerHTML\s*=\s*`([\s\S]*?)`;/g)].map((m) => m[1]);
    expect(templates.length).toBeGreaterThan(0);
    for (const tpl of templates) {
      expect(tpl).not.toContain('m.content');
    }
  });
});
