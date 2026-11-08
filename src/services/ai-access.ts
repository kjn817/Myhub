/**
 * AI 접근 계층
 * 모든 AI 메모 접근은 이 계층을 통해서만 이루어져야 함
 * 잠금 정책을 우회할 수 없음
 */

import { maskWithPrivacyEngine } from './privacy-mask';
import { assertMemoAccessibleForAI, isMemoAccessibleForAI } from './policy-guard';

interface Env {
  DB: D1Database;
}

/**
 * FTS5 MATCH 쿼리 이스케이프
 *
 * FTS5는 특수 문법(AND, OR, NOT, 따옴표, 괄호 등)을 사용하므로,
 * 사용자 입력에 이런 문자가 포함되면 구문 오류나 예상치 못한 동작이 발생합니다.
 * 안전한 텍스트 검색을 위해 각 토큰을 큰따옴표로 감싸고 내부 따옴표를 이스케이프합니다.
 */
function escapeFts5Query(query: string): string {
  // 공백으로 분리하고 빈 토큰 제거
  const tokens = query.trim().split(/\s+/).filter(t => t.length > 0)
  if (tokens.length === 0) return ''

  // 각 토큰을 큰따옴표로 감싸기 (FTS5 구문 무력화)
  // 큰따옴표 내부의 큰따옴표는 두 개로 이스케이프
  const escaped = tokens.map(token => {
    const safe = token.replace(/"/g, '""')
    return `"${safe}"`
  })

  return escaped.join(' ')
}

/**
 * 자연어 검색어에서 핵심 키워드 추출
 * "방금 만든 회의 준비 메모 찾아줘" → "회의 준비"
 */
function extractKeywords(query: string): string[] {
  // 불필요한 지시어 제거
  const stopWords = [
    '방금', '만든', '찾아줘', '찾아', '검색해줘', '검색', '보여줘', '보여',
    '알려줘', '알려', '그', '저', '이', '메모', '내용', '것', '거',
    '좀', '해줘', '해', '주세요', '줘',
  ];
  const words = query
    .replace(/[?!.,]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2)
    .filter(w => !stopWords.includes(w));

  // 2글자 이상 키워드만 반환 (최대 3개)
  return words.slice(0, 3);
}

/**
 * AI가 접근 가능한 메모 검색
 * - is_locked=1 제외
 * - sensitivity 2,3 제외 (외부 AI 전송 불가)
 * - 시크릿 마스킹 적용
 */
export async function searchAccessibleMemos(
  env: Env,
  query: string,
  limit: number = 5
): Promise<Array<{ id: number; title: string; snippet: string }>> {
  const fq = query.trim();
  if (!fq) return [];

  // 정책 가드 (트랙 5): SQL 필터(is_locked=0, sensitivity<=1)와 별도로
  // 코드로 재검사한다. SQL이 우회되어 잠긴 행이 반환돼도 여기서 차단된다.
  const formatResults = (results: any[]) => {
    return results.filter((r: any) => isMemoAccessibleForAI(r)).map((r: any) => {
      const { masked } = maskWithPrivacyEngine(r.snippet || '');
      const firstLine = (masked.split('\n').find((l: string) => l.trim()) || '').slice(0, 50);
      return {
        id: r.id,
        title: firstLine || '제목 없음',
        snippet: masked,
      };
    });
  };

  try {
    // 1차: FTS5 검색 (원본 쿼리, 이스케이프 적용)
    const safeQuery = escapeFts5Query(fq)
    if (safeQuery) {
      const { results } = await env.DB.prepare(
        `SELECT m.id, substr(m.text, 1, 500) as snippet, m.sensitivity, m.is_locked
         FROM memos m
         JOIN memos_fts fts ON m.id = fts.rowid
         WHERE m.is_locked = 0 AND m.sensitivity <= 1 AND memos_fts MATCH ?
         LIMIT ?`
      ).bind(safeQuery, limit).all();

      if (results.length > 0) {
        return formatResults(results);
      }
    }

    // 2차: 키워드 추출 후 FTS 재검색 1회 (P-4: 키워드마다 순차 재검색하던
    // 최대 3회를 `MATCH 'kw1 OR kw2 OR kw3'` 1회로 합침 — 최대 7회 왕복 해소)
    const keywords = extractKeywords(fq);
    const safeKeywords = keywords
      .map((kw) => escapeFts5Query(kw))
      .filter((s) => s.length > 0);
    if (safeKeywords.length > 0) {
      try {
        const { results: kwResults } = await env.DB.prepare(
          `SELECT m.id, substr(m.text, 1, 500) as snippet, m.sensitivity, m.is_locked
           FROM memos m
           JOIN memos_fts fts ON m.id = fts.rowid
           WHERE m.is_locked = 0 AND m.sensitivity <= 1 AND memos_fts MATCH ?
           LIMIT ?`
        ).bind(safeKeywords.join(' OR '), limit).all();
        if (kwResults.length > 0) {
          return formatResults(kwResults);
        }
      } catch {}
    }

    const { results: likeResults } = await env.DB.prepare(
      `SELECT id, substr(text, 1, 500) as snippet, sensitivity, is_locked
       FROM memos
       WHERE is_locked = 0 AND sensitivity <= 1 AND text LIKE ?
       LIMIT ?`
    ).bind(`%${fq}%`, limit).all();

    if (likeResults.length > 0) {
      return formatResults(likeResults);
    }

    return [];
  } catch {
    return [];
  }
}

/**
 * AI가 접근 가능한 메모 단건 조회
 * - is_locked=1이면 null 반환 (존재 여부도 숨김)
 * - sensitivity 2,3이면 null 반환
 */
export async function getAccessibleMemo(
  env: Env,
  id: number
): Promise<{ id: number; title: string; content: string } | null> {
  try {
    const memo = await env.DB.prepare(
      `SELECT id, text, sensitivity, is_locked, locked_blocks
       FROM memos
       WHERE id = ? AND is_locked = 0 AND sensitivity <= 1`
    ).bind(id).first() as any;

    if (!memo) return null;

    // 정책 가드 (트랙 5): SQL 필터와 별도로 코드로 재검사 (이중화)
    // SQL이 우회되어 잠긴 행이 반환돼도 여기서 null로 차단한다.
    assertMemoAccessibleForAI(memo);

    // 잠긴 블록 제거 + 시크릿 마스킹
    const sanitized = sanitizeForAI(memo.text || '', memo.locked_blocks);
    const firstLine = (sanitized.split('\n').find((l: string) => l.trim()) || '').slice(0, 50);

    return {
      id: memo.id,
      title: firstLine || '제목 없음',
      content: sanitized,
    };
  } catch {
    return null;
  }
}

/**
 * AI 컨텍스트용 메모 정제
 * - 잠긴 블록 제거 (class="locked" 또는 data-locked="true")
 * - 시크릿 마스킹
 * - fail-closed: 파싱 실패 시 빈 문자열 반환
 */
export function sanitizeForAI(content: string, lockedBlocksJson?: string): string {
  let sanitized = content;

  try {
    // 잠긴 블록 제거 (정규식 대신 DOM 파서 사용 권장, 여기서는 간단한 패턴)
    // <span class="locked">...</span> 또는 <div data-locked="true">...</div> 제거
    sanitized = sanitized.replace(
      /<(span|div)[^>]*class="[^"]*locked[^"]*"[^>]*>[\s\S]*?<\/\1>/gi,
      '[LOCKED_BLOCK]'
    );
    sanitized = sanitized.replace(
      /<(span|div)[^>]*data-locked="true"[^>]*>[\s\S]*?<\/\1>/gi,
      '[LOCKED_BLOCK]'
    );
  } catch {
    // 파싱 실패 시 fail-closed: 빈 문자열
    return '';
  }

  const { masked } = maskWithPrivacyEngine(sanitized);
  return masked;
}
