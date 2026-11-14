/**
 * 노바 아티팩트 도구
 * 홈화면에 표시되는 인터랙티브 위젯 (게임, 도구 등)
 */

import { guardSearchQuery } from './privacy-gateway'
import { escapeHtml } from '../lib/escape'
import { parseJsonMarkers } from '../lib/markers'

// SHA-256 해시
async function sha256hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// 아티팩트 생성 + v1 버전 생성 (원자적)
// 반환: { artifactId, versionId }
async function createArtifactWithV1(
  env: any,
  title: string,
  type: string,
  html: string,
  status: string,
  sourceType: string = 'nova',
): Promise<{ artifactId: number; versionId: number }> {
  const hash = await sha256hex(html)
  const artResult = await env.DB.prepare(
    `INSERT INTO artifacts (title, type, html_content, status) VALUES (?, ?, ?, ?)`
  ).bind(title.trim().slice(0, 100), type, html, status).run()
  const artifactId = artResult.meta.last_row_id as number
  const verResult = await env.DB.prepare(
    `INSERT INTO artifact_versions
     (artifact_id, version_no, html_content, content_sha256, source_type, created_by)
     VALUES (?, 1, ?, ?, ?, 'nova')`
  ).bind(artifactId, html, hash, sourceType).run()
  const versionId = verResult.meta.last_row_id as number
  // 포인터 설정
  if (status === 'draft') {
    await env.DB.prepare(
      'UPDATE artifacts SET draft_version_id = ? WHERE id = ?'
    ).bind(versionId, artifactId).run()
  } else {
    await env.DB.prepare(
      'UPDATE artifacts SET published_version_id = ?, draft_version_id = ? WHERE id = ?'
    ).bind(versionId, versionId, artifactId).run()
  }
  return { artifactId, versionId }
}

// [ARTIFACT_CREATE]{...}[/ARTIFACT_CREATE]
export function parseArtifactMarkers(text: string): Array<{ full: string; action: string; data: any }> {
  const results: Array<{ full: string; action: string; data: any }> = [];

  parseJsonMarkers(text, /\[ARTIFACT_CREATE\]([\s\S]*?)\[\/ARTIFACT_CREATE\]/gi,
    (data, full) =>
      // python 타입은 code 필드를 html로 변환하지 않고 별도 저장
      data.title && (data.html || data.python || data.code)
        ? { full, action: 'create', data }
        : null,
    3, results);

  // [ARTIFACT_FROM_GITHUB]{...}[/ARTIFACT_FROM_GITHUB]
  parseJsonMarkers(text, /\[ARTIFACT_FROM_GITHUB\]([\s\S]*?)\[\/ARTIFACT_FROM_GITHUB\]/gi,
    (data, full) => (data.repo ? { full, action: 'from_github', data } : null),
    3, results);

  parseJsonMarkers(text, /\[ARTIFACT_DELETE\]([\s\S]*?)\[\/ARTIFACT_DELETE\]/gi,
    (data, full) => ((data.id || data.title) ? { full, action: 'delete', data } : null),
    3, results);

  return results;
}

export async function executeArtifactCreate(env: any, data: any): Promise<any> {
  try {
    const { title, html, python, code, type } = data;
    // 타입 결정: python 필드가 있으면 python, code가 있으면 code 타입
    let artifactType = type || 'html';
    let content = html;
    if (python && !html) {
      artifactType = 'python';
      content = python;
    } else if (code && !html) {
      artifactType = 'python';
      content = code;
    }
    if (!title || !content) {
      return { success: false, error: '제목과 내용 필요' };
    }
    const { artifactId } = await createArtifactWithV1(env, title.trim(), artifactType, content, 'published');
    return { success: true, data: { id: artifactId, title, type: artifactType } };
  } catch (e) {
    return { success: false, error: '아티팩트 생성 실패' };
  }
}

export async function executeArtifactDelete(env: any, data: any): Promise<any> {
  try {
    let id = Number(data.id);
    if ((!id || !Number.isInteger(id) || id <= 0) && data.title) {
      const found = await env.DB.prepare(
        'SELECT id FROM artifacts WHERE title LIKE ? ORDER BY created_at DESC LIMIT 5'
      ).bind(`%${String(data.title).trim()}%`).all();
      const rows = found.results || [];
      if (rows.length === 0) {
        return { success: false, error: `"${data.title}" 아티팩트를 찾을 수 없음` };
      }
      if (rows.length > 1) {
        return {
          success: false,
          error: 'multiple_candidates',
          candidates: rows.map((r: any) => ({ id: r.id, title: r.title })),
          message: '여러 아티팩트가 발견됨. 선택해주세요.',
        };
      }
      id = rows[0].id;
    }
    if (!id || !Number.isInteger(id) || id <= 0) {
      return { success: false, error: '유효한 아티팩트 ID나 제목이 필요' };
    }
    const result = await env.DB.prepare('DELETE FROM artifacts WHERE id = ?').bind(id).run();
    if ((result.meta?.changes ?? 0) === 0) {
      return { success: false, error: '아티팩트를 찾을 수 없음' };
    }
    return { success: true, data: { id } };
  } catch (e) {
    return { success: false, error: '아티팩트 삭제 실패' };
  }
}

export async function executeArtifactList(env: any): Promise<any> {
  try {
    const { results } = await env.DB.prepare(
      'SELECT id, title, type, created_at FROM artifacts ORDER BY created_at DESC LIMIT 50'
    ).all();
    return { success: true, data: results || [] };
  } catch (e) {
    return { success: false, error: '아티팩트 조회 실패' };
  }
}

// GPT 검토 반영: 마커 없이 노바 응답에서 완성된 HTML을 감지해 초안으로 저장
// - 마크다운 코드 블록(```html ... ```)에서 추출
// - <html>...</html> 또는 <!DOCTYPE html> 포함 여부로 완전성 판단
export function detectHtmlFromResponse(text: string): string | null {
  // 1. 마크다운 코드 블록에서 html 추출
  const codeBlockRe = /```(?:html?)?\s*\n([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  let best: string | null = null;
  while ((m = codeBlockRe.exec(text)) !== null) {
    const code = m[1].trim();
    if (isCompleteHtml(code)) {
      // 가장 긴 완성된 HTML 선택
      if (!best || code.length > best.length) best = code;
    }
  }
  if (best) return best;
  // 2. 코드 블록 없이 직접 출력된 경우
  const directRe = /(<!DOCTYPE html[\s\S]*?<\/html>|<html[\s\S]*?<\/html>)/i;
  const dm = directRe.exec(text);
  if (dm && isCompleteHtml(dm[1])) return dm[1].trim();
  return null;
}

function isCompleteHtml(code: string): boolean {
  const lower = code.toLowerCase();
  // <html> 태그와 </html> 닫기 태그가 모두 있어야 함
  if (!lower.includes('<html') || !lower.includes('</html>')) return false;
  // 최소 길이 (너무 짧으면 예제 조각일 가능성)
  if (code.length < 200) return false;
  return true;
}

// HTML 초안 저장 (status='draft')
export async function saveArtifactDraft(env: any, title: string, html: string, type: string = 'html'): Promise<any> {
  try {
    // 기본 검증: 크기 제한 (500KB)
    if (html.length > 500 * 1024) {
      return { success: false, error: 'HTML이 너무 큽니다 (500KB 초과)' };
    }
    const { artifactId } = await createArtifactWithV1(env, title, type, html, 'draft');
    return { success: true, data: { id: artifactId, title, status: 'draft' } };
  } catch (e) {
    return { success: false, error: '초안 저장 실패' };
  }
}

// GitHub에서 가져오기: repo의 README나 데모를 아티팩트로 변환
// 실제 구현은 노바가 [GITHUB:] 검색 후 내용을 직접 [ARTIFACT_CREATE]로 만드는 것을 권장
// 이 함수는 메타데이터만 저장 (향후 확장용)
export async function executeArtifactFromGithub(env: any, data: any): Promise<any> {
  try {
    const { repo, title, description } = data;
    if (!repo) {
      return { success: false, error: 'GitHub repo 필요 (예: "user/repo")' };
    }
    if (guardSearchQuery(String(repo)) === null) {
      return { success: false, error: 'repo 값에 개인정보가 포함되어 조회를 중단했습니다' };
    }
    // GitHub API로 repo 정보 조회 (인증 없이 public repo만)
    const apiUrl = `https://api.github.com/repos/${repo}`;
    const res = await fetch(apiUrl, {
      headers: { 'User-Agent': 'MyHub-Nova', 'Accept': 'application/vnd.github.v3+json' },
    });
    if (!res.ok) {
      return { success: false, error: `GitHub repo를 찾을 수 없음: ${repo}` };
    }
    const info: any = await res.json();
    // README를 가져와서 마크다운 아티팩트로 저장
    const readmeUrl = `https://raw.githubusercontent.com/${repo}/main/README.md`;
    let readme = '';
    try {
      const rres = await fetch(readmeUrl, { headers: { 'User-Agent': 'MyHub-Nova' } });
      if (rres.ok) readme = await rres.text();
    } catch {}
    if (!readme) {
      const readmeMain = `https://raw.githubusercontent.com/${repo}/master/README.md`;
      try {
        const rres2 = await fetch(readmeMain, { headers: { 'User-Agent': 'MyHub-Nova' } });
        if (rres2.ok) readme = await rres2.text();
      } catch {}
    }
    const artifactTitle = title || info.name || repo;
    const html = `<html><head><meta charset="utf-8"><style>
      body{font-family:system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.6}
      h1{border-bottom:1px solid #eee;padding-bottom:10px}
      pre{background:#f6f8fa;padding:16px;border-radius:6px;overflow:auto}
      code{background:#f6f8fa;padding:2px 6px;border-radius:3px}
      a{color:#0969da}
    </style></head><body>
    <h1>📦 ${escapeHtml(artifactTitle)}</h1>
    <p><a href="${info.html_url}" target="_blank">${info.html_url}</a></p>
    <p>${escapeHtml(info.description || description || '')}</p>
    <p>⭐ ${info.stargazers_count || 0} | 🍴 ${info.forks_count || 0} | 📝 ${info.language || ''}</p>
    <hr><pre>${escapeHtml(readme.slice(0, 10000))}</pre>
    </body></html>`;
    const { artifactId } = await createArtifactWithV1(env, artifactTitle, 'github', html, 'published', 'github');
    return { success: true, data: { id: artifactId, title: artifactTitle, repo } };
  } catch (e) {
    return { success: false, error: 'GitHub 가져오기 실패' };
  }
}
