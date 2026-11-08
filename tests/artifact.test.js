/**
 * 노바 아티팩트 기능 테스트 (CommonJS)
 * - 마커 파싱
 * - HTML 자동 감지
 */

// TypeScript 소스를 직접 require할 수 없으므로 로직을 복제해 테스트
// (실제 src/services/artifact-tools.ts와 동일한 정규식)

function parseArtifactMarkers(text) {
  const results = [];
  const createRe = /\[ARTIFACT_CREATE\]([\s\S]*?)\[\/ARTIFACT_CREATE\]/gi;
  let m;
  while ((m = createRe.exec(text)) !== null) {
    try {
      const data = JSON.parse(m[1].trim());
      if (data.title && (data.html || data.python || data.code)) {
        results.push({ full: m[0], action: 'create', data });
      }
    } catch {}
    if (results.length >= 3) break;
  }
  const githubRe = /\[ARTIFACT_FROM_GITHUB\]([\s\S]*?)\[\/ARTIFACT_FROM_GITHUB\]/gi;
  while ((m = githubRe.exec(text)) !== null) {
    try {
      const data = JSON.parse(m[1].trim());
      if (data.repo) {
        results.push({ full: m[0], action: 'from_github', data });
      }
    } catch {}
    if (results.length >= 3) break;
  }
  const deleteRe = /\[ARTIFACT_DELETE\]([\s\S]*?)\[\/ARTIFACT_DELETE\]/gi;
  while ((m = deleteRe.exec(text)) !== null) {
    try {
      const data = JSON.parse(m[1].trim());
      if (data.id || data.title) {
        results.push({ full: m[0], action: 'delete', data });
      }
    } catch {}
    if (results.length >= 3) break;
  }
  return results;
}

function isCompleteHtml(code) {
  const lower = code.toLowerCase();
  if (!lower.includes('<html') || !lower.includes('</html>')) return false;
  if (code.length < 200) return false;
  return true;
}

function detectHtmlFromResponse(text) {
  const codeBlockRe = /```(?:html?)?\s*\n([\s\S]*?)```/gi;
  let m;
  let best = null;
  while ((m = codeBlockRe.exec(text)) !== null) {
    const code = m[1].trim();
    if (isCompleteHtml(code)) {
      if (!best || code.length > best.length) best = code;
    }
  }
  if (best) return best;
  const directRe = /(<!DOCTYPE html[\s\S]*?<\/html>|<html[\s\S]*?<\/html>)/i;
  const dm = directRe.exec(text);
  if (dm && isCompleteHtml(dm[1])) return dm[1].trim();
  return null;
}

describe('parseArtifactMarkers', () => {
  test('HTML 아티팩트 마커 파싱', () => {
    const text = '[ARTIFACT_CREATE]{"title": "테트리스", "html": "<html></html>"}[/ARTIFACT_CREATE]';
    const results = parseArtifactMarkers(text);
    expect(results.length).toBe(1);
    expect(results[0].action).toBe('create');
    expect(results[0].data.title).toBe('테트리스');
  });

  test('Python 아티팩트 마커 파싱', () => {
    const text = '[ARTIFACT_CREATE]{"title": "계산기", "python": "print(1+1)"}[/ARTIFACT_CREATE]';
    const results = parseArtifactMarkers(text);
    expect(results.length).toBe(1);
    expect(results[0].data.python).toBe('print(1+1)');
  });

  test('GitHub 임포트 마커 파싱', () => {
    const text = '[ARTIFACT_FROM_GITHUB]{"repo": "facebook/react"}[/ARTIFACT_FROM_GITHUB]';
    const results = parseArtifactMarkers(text);
    expect(results.length).toBe(1);
    expect(results[0].action).toBe('from_github');
  });

  test('삭제 마커 파싱', () => {
    const text = '[ARTIFACT_DELETE]{"title": "테트리스"}[/ARTIFACT_DELETE]';
    const results = parseArtifactMarkers(text);
    expect(results.length).toBe(1);
    expect(results[0].action).toBe('delete');
  });

  test('잘못된 JSON은 무시', () => {
    const results = parseArtifactMarkers('[ARTIFACT_CREATE]not json[/ARTIFACT_CREATE]');
    expect(results.length).toBe(0);
  });

  test('필수 필드 없으면 무시', () => {
    const results = parseArtifactMarkers('[ARTIFACT_CREATE]{"title": "x"}[/ARTIFACT_CREATE]');
    expect(results.length).toBe(0);
  });
});

describe('detectHtmlFromResponse', () => {
  test('코드 블록에서 HTML 추출', () => {
    const html = `<html><head><title>t</title></head><body>${'x'.repeat(200)}</body></html>`;
    const text = '만들었어요:\n```html\n' + html + '\n```';
    const result = detectHtmlFromResponse(text);
    expect(result).not.toBeNull();
    expect(result).toContain('</html>');
  });

  test('짧은 HTML은 무시', () => {
    const result = detectHtmlFromResponse('```html\n<html></html>\n```');
    expect(result).toBeNull();
  });

  test('HTML 없으면 null', () => {
    expect(detectHtmlFromResponse('일반 채팅입니다')).toBeNull();
  });

  test('닫기 태그 없으면 무시', () => {
    const text = '```html\n<html><body>' + 'x'.repeat(300) + '\n```';
    expect(detectHtmlFromResponse(text)).toBeNull();
  });
});
