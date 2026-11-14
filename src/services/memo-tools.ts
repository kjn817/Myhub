/**
 * AI 메모 도구
 * - 읽기: MEMO_SEARCH, MEMO_GET (잠금 정책 준수)
 * - 쓰기: MEMO_CREATE, MEMO_UPDATE, MEMO_DELETE
 * - 잠금/해제는 AI가 할 수 없음 (사용자 전용)
 */

import { searchAccessibleMemos, getAccessibleMemo } from './ai-access';
import { isMemoLocked } from './policy-guard';
import { syncTags } from '../modules/memo/helpers';
import { parseJsonMarkers } from '../lib/markers';

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
  return parseJsonMarkers(
    text,
    /\[MEMO_SEARCH\]([\s\S]*?)\[\/MEMO_SEARCH\]/gi,
    (parsed, full) =>
      parsed.query && typeof parsed.query === 'string'
        ? { full, query: parsed.query.slice(0, 200) }
        : null,
    3,
  );
}

/**
 * [MEMO_GET]{"id": 123}[/MEMO_GET] 파싱
 */
export function parseMemoGetMarkers(text: string): Array<{ full: string; id: number }> {
  return parseJsonMarkers(
    text,
    /\[MEMO_GET\]([\s\S]*?)\[\/MEMO_GET\]/gi,
    (parsed, full) =>
      parsed.id && Number.isSafeInteger(parsed.id) ? { full, id: parsed.id } : null,
    3,
  );
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
  return parseJsonMarkers(
    text,
    /\[MEMO_CREATE\]([\s\S]*?)\[\/MEMO_CREATE\]/gi,
    (parsed, full) => {
      const body = [parsed.text, parsed.content].find(
        (v) => typeof v === 'string' && v.trim().length > 0
      ) as string | undefined;
      if (!body) return null;
      const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
      const combined = title ? `${title}\n\n${body}` : body;
      return { full, text: combined.slice(0, 10000) };
    },
    2,
  );
}

/**
 * [MEMO_UPDATE]{"id": 123, "text": "..."}[/MEMO_UPDATE] 파싱
 */
export function parseMemoUpdateMarkers(text: string): Array<{ full: string; id: number; text: string }> {
  return parseJsonMarkers(
    text,
    /\[MEMO_UPDATE\]([\s\S]*?)\[\/MEMO_UPDATE\]/gi,
    (parsed, full) => {
      const id = normalizeMarkerId(parsed.id);
      if (id !== undefined && parsed.text) {
        return { full, id, text: String(parsed.text).slice(0, 10000) };
      }
      return null;
    },
    2,
  );
}

/**
 * [MEMO_DELETE]{"id": 123}[/MEMO_DELETE] 파싱
 */
export function parseMemoDeleteMarkers(text: string): Array<{ full: string; id: number }> {
  return parseJsonMarkers(
    text,
    /\[MEMO_DELETE\]([\s\S]*?)\[\/MEMO_DELETE\]/gi,
    (parsed, full) => {
      const id = normalizeMarkerId(parsed.id);
      if (id !== undefined) {
        return { full, id };
      }
      return null;
    },
    2,
  );
}

/**
 * 메모 생성 실행 (잠긴 메모는 생성 불가 - 항상 is_locked=0)
 */
export async function executeMemoCreate(env: any, text: string): Promise<MemoToolResult> {
  try {
    const r = await env.DB.prepare(
      'INSERT INTO memos (text, is_locked, sensitivity) VALUES (?, 0, 0)'
    ).bind(text).run();
    const id = Number(r.meta.last_row_id);
    await syncTags(env.DB, id, text);
    return { success: true, data: { id } };
  } catch (e) {
    return { success: false, error: '생성 실패' };
  }
}

/**
 * AI 쓰기(수정·삭제) 대상 메모의 접근 차단 판정 — D2 통일 (2026-10-31).
 *
 * 읽기 계층(ai-access)은 잠긴 메모와 민감도 2 이상 메모를 "찾을 수
 * 없음"으로 숨긴다. 그런데 이 실행층이 예전에는 is_locked만 봐서,
 * 읽을 수 없는 민감도2 메모를 승인 하에 지우거나 덮어쓸 수 있었다
 * (docs/gate-policy-equivalence-20261030.md 불일치 D2). 더 엄격한
 * E2 판정으로 통일한다: 민감도 2 이상은 승인으로도 수정·삭제 불가.
 * - 잠긴 메모: 기존 명시 메시지 유지 (잠금 차단은 원래 양 경로 공통).
 * - 민감도 2+: 읽기 계층과 같은 "찾을 수 없음" (존재 숨김) 으로 답한다
 *   — E2의 확인·승인 실행이 받는 결과와 표면까지 같다.
 * 차단 사유가 없으면 null.
 */
function aiWriteBlockReason(
  memo: { is_locked?: unknown; sensitivity?: unknown } | null,
  action: '수정' | '삭제',
): string | null {
  if (!memo) return '메모를 찾을 수 없음';
  if (isMemoLocked(memo as any)) return `잠긴 메모는 ${action}할 수 없습니다`;
  if (typeof memo.sensitivity === 'number' && memo.sensitivity > 1) {
    return '메모를 찾을 수 없음';
  }
  return null;
}

/**
 * 메모 수정 실행 (잠긴 메모·민감도 2 이상 메모는 수정 불가)
 */
export async function executeMemoUpdate(env: any, id: number, text: string): Promise<MemoToolResult> {
  try {
    // 잠금·민감도 확인 (정책 가드 공용 판정 + D2 — aiWriteBlockReason)
    const memo = await env.DB.prepare('SELECT is_locked, sensitivity FROM memos WHERE id = ?').bind(id).first() as any;
    const blocked = aiWriteBlockReason(memo, '수정');
    if (blocked) return { success: false, error: blocked };

    await env.DB.prepare('UPDATE memos SET text = ? WHERE id = ?')
      .bind(text, id).run();
    await syncTags(env.DB, id, text);
    return { success: true, data: { id } };
  } catch (e) {
    return { success: false, error: '수정 실패' };
  }
}

/**
 * 메모 삭제 실행 (잠긴 메모·민감도 2 이상 메모는 삭제 불가)
 */
export async function executeMemoDelete(env: any, id: number): Promise<MemoToolResult> {
  try {
    const memo = await env.DB.prepare('SELECT is_locked, sensitivity FROM memos WHERE id = ?').bind(id).first() as any;
    const blocked = aiWriteBlockReason(memo, '삭제');
    if (blocked) return { success: false, error: blocked };

    await env.DB.prepare('DELETE FROM memo_tags WHERE memo_id = ?').bind(id).run();
    await env.DB.prepare('DELETE FROM memos WHERE id = ?').bind(id).run();
    return { success: true, data: { id } };
  } catch (e) {
    return { success: false, error: '삭제 실패' };
  }
}
