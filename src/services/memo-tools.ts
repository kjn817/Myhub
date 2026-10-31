/**
 * AI 메모 도구
 * - 읽기: MEMO_SEARCH, MEMO_GET (잠금 정책 준수)
 * - 쓰기: MEMO_CREATE, MEMO_UPDATE, MEMO_DELETE
 * - 잠금/해제는 AI가 할 수 없음 (사용자 전용)
 */

import { searchAccessibleMemos, getAccessibleMemo } from './ai-access';
import { isMemoLocked } from './policy-guard';

export interface MemoToolResult {
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * 마커 id 정규화: 숫자 또는 숫자 문자열만 안전한 정수로 받는다.
 * - 모델이 id를 문자열("7")로 적는 경우가 있어 숫자 문자열은 허용한다
 *   (기존 동작 유지 — svc3-memo-tools 'id를 Number로 변환' 테스트가 고정).
 * - "abc"·1.5·1e21 같은 비정수/비안전값은 거부한다. 거부하지 않으면
 *   NaN·소수 id가 그대로 DB 바인딩으로 흘러갔다 (fast-check 반례).
 */
function normalizeMarkerId(raw: unknown): number | undefined {
  if (typeof raw !== 'number' && typeof raw !== 'string') return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * [MEMO_SEARCH]{"query": "..."}[/MEMO_SEARCH] 파싱
 */
export function parseMemoSearchMarkers(text: string): Array<{ full: string; query: string }> {
  const results: Array<{ full: string; query: string }> = [];
  const re = /\[MEMO_SEARCH\]([\s\S]*?)\[\/MEMO_SEARCH\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (parsed.query && typeof parsed.query === 'string') {
        results.push({ full: m[0], query: parsed.query.slice(0, 200) });
      }
    } catch {
      // JSON 파싱 실패 시 무시
    }
    if (results.length >= 3) break; // 턴당 최대 3회
  }
  return results;
}

/**
 * [MEMO_GET]{"id": 123}[/MEMO_GET] 파싱
 */
export function parseMemoGetMarkers(text: string): Array<{ full: string; id: number }> {
  const results: Array<{ full: string; id: number }> = [];
  const re = /\[MEMO_GET\]([\s\S]*?)\[\/MEMO_GET\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (parsed.id && Number.isSafeInteger(parsed.id)) {
        results.push({ full: m[0], id: parsed.id });
      }
    } catch {
      // 무시
    }
    if (results.length >= 3) break;
  }
  return results;
}

/**
 * 메모 검색 실행 (AI 접근 계층 사용)
 */
export async function executeMemoSearch(
  env: any,
  query: string
): Promise<MemoToolResult> {
  try {
    const results = await searchAccessibleMemos(env, query, 5);
    return { success: true, data: results };
  } catch (e) {
    return { success: false, error: '검색 실패' };
  }
}

/**
 * 메모 조회 실행 (AI 접근 계층 사용)
 */
export async function executeMemoGet(
  env: any,
  id: number
): Promise<MemoToolResult> {
  try {
    const memo = await getAccessibleMemo(env, id);
    if (!memo) {
      return { success: false, error: '메모를 찾을 수 없음' };
    }
    return { success: true, data: memo };
  } catch (e) {
    return { success: false, error: '조회 실패' };
  }
}

/**
 * [MEMO_CREATE]{"text": "..."}[/MEMO_CREATE] 파싱
 * - 본문 필드: text(레거시) 또는 content — 둘 다 있으면 text 우선
 * - title이 있으면 제목을 본문 앞에 붙인다 (memos 테이블은 text 단일 컬럼)
 * - 본문이 없거나 JSON이 깨졌으면 무시 (호출자가 남은 마커를 실패 안내로 대체)
 */
export function parseMemoCreateMarkers(text: string): Array<{ full: string; text: string }> {
  const results: Array<{ full: string; text: string }> = [];
  const re = /\[MEMO_CREATE\]([\s\S]*?)\[\/MEMO_CREATE\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const body = [parsed.text, parsed.content].find(
        (v) => typeof v === 'string' && v.trim().length > 0
      ) as string | undefined;
      if (!body) continue;
      const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
      const combined = title ? `${title}\n\n${body}` : body;
      results.push({ full: m[0], text: combined.slice(0, 10000) });
    } catch {}
    if (results.length >= 2) break;
  }
  return results;
}

/**
 * [MEMO_UPDATE]{"id": 123, "text": "..."}[/MEMO_UPDATE] 파싱
 */
export function parseMemoUpdateMarkers(text: string): Array<{ full: string; id: number; text: string }> {
  const results: Array<{ full: string; id: number; text: string }> = [];
  const re = /\[MEMO_UPDATE\]([\s\S]*?)\[\/MEMO_UPDATE\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const id = normalizeMarkerId(parsed.id);
      if (id !== undefined && parsed.text) {
        results.push({ full: m[0], id, text: String(parsed.text).slice(0, 10000) });
      }
    } catch {}
    if (results.length >= 2) break;
  }
  return results;
}

/**
 * [MEMO_DELETE]{"id": 123}[/MEMO_DELETE] 파싱
 */
export function parseMemoDeleteMarkers(text: string): Array<{ full: string; id: number }> {
  const results: Array<{ full: string; id: number }> = [];
  const re = /\[MEMO_DELETE\]([\s\S]*?)\[\/MEMO_DELETE\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const id = normalizeMarkerId(parsed.id);
      if (id !== undefined) {
        results.push({ full: m[0], id });
      }
    } catch {}
    if (results.length >= 2) break;
  }
  return results;
}

/**
 * 메모 생성 실행 (잠긴 메모는 생성 불가 - 항상 is_locked=0)
 */
export async function executeMemoCreate(env: any, text: string): Promise<MemoToolResult> {
  try {
    const r = await env.DB.prepare(
      'INSERT INTO memos (text, is_locked, sensitivity) VALUES (?, 0, 0)'
    ).bind(text).run();
    return { success: true, data: { id: Number(r.meta.last_row_id) } };
  } catch (e) {
    return { success: false, error: '생성 실패' };
  }
}

/**
 * 메모 수정 실행 (잠긴 메모는 수정 불가)
 */
export async function executeMemoUpdate(env: any, id: number, text: string): Promise<MemoToolResult> {
  try {
    // 잠긴 메모인지 확인 (정책 가드 공용 판정 — 잠긴 메모는 수정 불가)
    const memo = await env.DB.prepare('SELECT is_locked FROM memos WHERE id = ?').bind(id).first() as any;
    if (!memo) return { success: false, error: '메모를 찾을 수 없음' };
    if (isMemoLocked(memo)) return { success: false, error: '잠긴 메모는 수정할 수 없습니다' };
    
    await env.DB.prepare('UPDATE memos SET text = ? WHERE id = ?')
      .bind(text, id).run();
    return { success: true, data: { id } };
  } catch (e) {
    return { success: false, error: '수정 실패' };
  }
}

/**
 * 메모 삭제 실행 (잠긴 메모는 삭제 불가)
 */
export async function executeMemoDelete(env: any, id: number): Promise<MemoToolResult> {
  try {
    const memo = await env.DB.prepare('SELECT is_locked FROM memos WHERE id = ?').bind(id).first() as any;
    if (!memo) return { success: false, error: '메모를 찾을 수 없음' };
    if (isMemoLocked(memo)) return { success: false, error: '잠긴 메모는 삭제할 수 없습니다' };
    
    await env.DB.prepare('DELETE FROM memos WHERE id = ?').bind(id).run();
    return { success: true, data: { id } };
  } catch (e) {
    return { success: false, error: '삭제 실패' };
  }
}
