/// <reference types="jest" />
/**
 * 코드로 강제하는 정책 테스트 (OpenClaw 패턴 이식 — 트랙 5)
 *
 * 증명 목표: 프롬프트를 우회해도 코드가 막는다.
 * - 모델이 잠금 마커/도구를 출력해도 디스패처·마커 후처리에서 차단
 * - SQL 필터가 우회되어 잠긴 메모 행이 반환돼도 접근 계층에서 차단
 * - 잠긴 메모 수정/삭제는 기존 메시 그대로 거부
 */

import {
  PolicyViolationError,
  assertToolCallAllowed,
  enforceNoLockMarkers,
  assertMemoAccessibleForAI,
  isMemoAccessibleForAI,
  isMemoLocked,
} from '../../src/services/policy-guard';
import { getAccessibleMemo, searchAccessibleMemos } from '../../src/services/ai-access';
// memo-tools는 디스패처용으로 jest.mock되므로, 실제 함수는 requireActual로 가져온다
const { executeMemoUpdate, executeMemoDelete } = jest.requireActual('../../src/services/memo-tools');

// ---------------- 디스패처 mock (ai-memo-tool-dispatcher.test.ts와 동일 패턴) ----------------
const mockValidateFCArgs = jest.fn();
jest.mock('../../src/ai/memo-fc-tools', () => ({
  validateFCArgs: (...a: any[]) => mockValidateFCArgs(...a),
}));

const mockExecuteMemoCreate = jest.fn();
const mockExecuteMemoUpdate = jest.fn();
const mockExecuteMemoDelete = jest.fn();
const mockExecuteMemoSearch = jest.fn();
const mockExecuteMemoGet = jest.fn();
jest.mock('../../src/services/memo-tools', () => ({
  executeMemoCreate: (...a: any[]) => mockExecuteMemoCreate(...a),
  executeMemoUpdate: (...a: any[]) => mockExecuteMemoUpdate(...a),
  executeMemoDelete: (...a: any[]) => mockExecuteMemoDelete(...a),
  executeMemoSearch: (...a: any[]) => mockExecuteMemoSearch(...a),
  executeMemoGet: (...a: any[]) => mockExecuteMemoGet(...a),
}));

const mockSearchAnchor = jest.fn();
const mockGetLastUserMessage = jest.fn();
jest.mock('../../src/ai/source-preservation', () => ({
  searchAnchor: (...a: any[]) => mockSearchAnchor(...a),
  getLastUserMessage: (...a: any[]) => mockGetLastUserMessage(...a),
}));

jest.mock('../../src/services/memo-context', () => ({
  updateMemoContext: jest.fn(),
}));

jest.mock('../../src/services/memo-target-resolver', () => ({
  resolveMemoTarget: jest.fn(),
}));

import { dispatchToolCall, dispatchToolCalls } from '../../src/ai/memo-tool-dispatcher';

describe('assertToolCallAllowed (잠금/해제 금지)', () => {
  test('잠금 도구 이름은 전부 거부', () => {
    for (const name of [
      'memo_lock', 'memo_unlock', 'MEMO_LOCK', 'MEMO_UNLOCK',
      'lock_memo', 'unlock_memo', 'lock', 'unlock',
      'memo_lock_block', 'MEMO_UNLOCK_BLOCK',
    ]) {
      expect(() => assertToolCallAllowed(name, {})).toThrow(PolicyViolationError);
      expect(() => assertToolCallAllowed(name, {})).toThrow(/잠그거나 해제/);
    }
  });

  test('lock/unlock 포함 미지 도구 이름도 거부', () => {
    expect(() => assertToolCallAllowed('memo_lock_v2', {})).toThrow(PolicyViolationError);
    expect(() => assertToolCallAllowed('UNLOCK_MEMO', {})).toThrow(PolicyViolationError);
  });

  test('정상 도구는 허용', () => {
    for (const name of ['memo_create', 'memo_search', 'memo_get', 'memo_delete', 'memo_ui_action', 'memo_create_from_source']) {
      expect(() => assertToolCallAllowed(name, { id: 1 })).not.toThrow();
    }
  });

  test('인자에 잠금 필드가 있으면 거부 (도구 이름이 정상이어도)', () => {
    expect(() => assertToolCallAllowed('memo_get', { id: 1, is_locked: true }))
      .toThrow(/잠금 필드/);
    expect(() => assertToolCallAllowed('memo_get', { id: 1, locked: 1 }))
      .toThrow(/잠금 필드/);
    expect(() => assertToolCallAllowed('memo_create', { text: 'x', locked_blocks: '[]' }))
      .toThrow(/잠금 필드/);
    // 대소문자 변형도 거부
    expect(() => assertToolCallAllowed('memo_get', { id: 1, IS_LOCKED: 1 }))
      .toThrow(/잠금 필드/);
  });

  test('정상 인자는 허용', () => {
    expect(() => assertToolCallAllowed('memo_get', { id: 1 })).not.toThrow();
    expect(() => assertToolCallAllowed('memo_create', { text: 'hello' })).not.toThrow();
  });
});

describe('enforceNoLockMarkers (모델 출력 잠금 마커 제거)', () => {
  test('paired 잠금 마커가 정책 메시지로 치환되고 마커가 남지 않음', () => {
    const out = enforceNoLockMarkers('이 메모를 잠가줘 [MEMO_LOCK]{"id":1}[/MEMO_LOCK] 끝');
    expect(out).not.toContain('MEMO_LOCK');
    expect(out).toContain('정책 위반으로 차단됨');
  });

  test('single 잠금 마커도 치환', () => {
    const out = enforceNoLockMarkers('열어줘 [MEMO_UNLOCK: 1] 끝');
    expect(out).not.toContain('MEMO_UNLOCK');
    expect(out).toContain('정책 위반으로 차단됨');
  });

  test('소문자·BLOCK 변형도 치환', () => {
    const out = enforceNoLockMarkers('[memo_lock_block]{"id":1}[/memo_lock_block]');
    expect(out).not.toContain('memo_lock_block');
    expect(out).toContain('정책 위반으로 차단됨');
  });

  test('정상 마커는 그대로 유지', () => {
    const text = '[MEMO_GET]{"id":1}[/MEMO_GET] [SEARCH: 뉴스]';
    expect(enforceNoLockMarkers(text)).toBe(text);
  });

  test('빈/비문자열 입력은 그대로 반환', () => {
    expect(enforceNoLockMarkers('')).toBe('');
    expect(enforceNoLockMarkers(null as any)).toBe(null);
  });
});

describe('assertMemoAccessibleForAI / isMemoAccessibleForAI', () => {
  test('잠긴 메모 → MEMO_LOCKED', () => {
    expect(() => assertMemoAccessibleForAI({ is_locked: 1, sensitivity: 0 }))
      .toThrow(PolicyViolationError);
    expect(isMemoAccessibleForAI({ is_locked: 1, sensitivity: 0 })).toBe(false);
    expect(isMemoLocked({ is_locked: 1 })).toBe(true);
    expect(isMemoLocked({ is_locked: 0 })).toBe(false);
  });

  test('민감도 2,3 메모 → MEMO_RESTRICTED', () => {
    expect(() => assertMemoAccessibleForAI({ is_locked: 0, sensitivity: 2 }))
      .toThrow(/민감 메모/);
    expect(() => assertMemoAccessibleForAI({ is_locked: 0, sensitivity: 3 }))
      .toThrow(PolicyViolationError);
    expect(isMemoAccessibleForAI({ is_locked: 0, sensitivity: 2 })).toBe(false);
  });

  test('잠기지 않은 일반 메모 → 허용', () => {
    expect(() => assertMemoAccessibleForAI({ is_locked: 0, sensitivity: 0 })).not.toThrow();
    expect(() => assertMemoAccessibleForAI({ is_locked: 0, sensitivity: 1 })).not.toThrow();
    expect(isMemoAccessibleForAI({ is_locked: 0, sensitivity: 1 })).toBe(true);
    expect(isMemoAccessibleForAI(null)).toBe(true); // 없음은 호출부 처리 대상
  });
});

describe('ai-access 이중화: SQL 우회 시뮬레이션에서도 코드가 차단', () => {
  // Mock DB가 SQL 내용과 무관하게 잠긴 행을 반환한다
  // (= SQL 필터가 우회된 상황을 시뮬레이션 — 프롬프트 우회와 동등한 공격 모델)
  function dbReturningRow(row: any): any {
    return {
      prepare: jest.fn().mockReturnValue({
        bind: jest.fn().mockReturnValue({
          first: jest.fn().mockResolvedValue(row),
          all: jest.fn().mockResolvedValue({ results: row ? [row] : [] }),
          run: jest.fn().mockResolvedValue({}),
        }),
      }),
    };
  }

  test('getAccessibleMemo: 잠긴 행 반환돼도 null (존재 숨김)', async () => {
    const db = dbReturningRow({ id: 1, text: '카드번호 비밀', sensitivity: 0, is_locked: 1, locked_blocks: '[]' });
    expect(await getAccessibleMemo({ DB: db } as any, 1)).toBeNull();
  });

  test('getAccessibleMemo: 민감도 2 행 반환돼도 null', async () => {
    const db = dbReturningRow({ id: 2, text: '민감', sensitivity: 2, is_locked: 0, locked_blocks: '[]' });
    expect(await getAccessibleMemo({ DB: db } as any, 2)).toBeNull();
  });

  test('getAccessibleMemo: 잠기지 않은 일반 메모는 반환', async () => {
    const db = dbReturningRow({ id: 3, text: '공개 메모', sensitivity: 0, is_locked: 0, locked_blocks: '[]' });
    const memo = await getAccessibleMemo({ DB: db } as any, 3);
    expect(memo).not.toBeNull();
    expect(memo!.id).toBe(3);
    expect(memo!.content).toContain('공개 메모');
  });

  test('searchAccessibleMemos: 결과에 섞인 잠긴 행은 제외', async () => {
    const db: any = {
      prepare: jest.fn().mockReturnValue({
        bind: jest.fn().mockReturnValue({
          first: jest.fn().mockResolvedValue(null),
          all: jest.fn().mockResolvedValue({
            results: [
              { id: 1, snippet: '잠긴 비밀', sensitivity: 0, is_locked: 1 },
              { id: 2, snippet: '공개 내용', sensitivity: 0, is_locked: 0 },
              { id: 3, snippet: '민감 내용', sensitivity: 2, is_locked: 0 },
            ],
          }),
          run: jest.fn().mockResolvedValue({}),
        }),
      }),
    };
    const results = await searchAccessibleMemos({ DB: db } as any, '내용', 5);
    expect(results.map((r) => r.id)).toEqual([2]);
  });
});

describe('디스패처: 프롬프트 우회 도구 호출 차단', () => {
  const env = { DB: {} } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateFCArgs.mockReturnValue({ valid: true });
    mockExecuteMemoGet.mockResolvedValue({ success: true, data: { id: 1, text: 't' } });
    mockExecuteMemoCreate.mockResolvedValue({ success: true, data: { id: 1 } });
  });

  test('memo_lock 호출 → 실패 + 실행기 미호출 + 검증 미호출 (가드 최우선)', async () => {
    const r = await dispatchToolCall(env, { name: 'memo_lock', arguments: { id: 1 } });
    expect(r.success).toBe(false);
    expect(r.error).toContain('잠그거나 해제');
    expect(mockValidateFCArgs).not.toHaveBeenCalled();
    expect(mockExecuteMemoGet).not.toHaveBeenCalled();
    expect(mockExecuteMemoCreate).not.toHaveBeenCalled();
  });

  test('MEMO_UNLOCK(대문자 변형) → 실패', async () => {
    const r = await dispatchToolCall(env, { name: 'MEMO_UNLOCK', arguments: { id: 1 } });
    expect(r.success).toBe(false);
    expect(r.error).toContain('잠그거나 해제');
  });

  test('정상 도구에 잠금 필드를 섞어도 실패', async () => {
    const r = await dispatchToolCall(env, { name: 'memo_get', arguments: { id: 1, is_locked: 1 } });
    expect(r.success).toBe(false);
    expect(r.error).toContain('잠금 필드');
    expect(mockExecuteMemoGet).not.toHaveBeenCalled();
  });

  test('정상 memo_get는 그대로 성공 (가드가 정상 경로를 막지 않음)', async () => {
    const r = await dispatchToolCall(env, { name: 'memo_get', arguments: { id: 1 } });
    expect(r.success).toBe(true);
    expect(mockExecuteMemoGet).toHaveBeenCalledTimes(1);
  });

  test('dispatchToolCalls: 잠금 호출에서 중단, 후속 도구 미실행', async () => {
    const results = await dispatchToolCalls(env, [
      { name: 'memo_lock', arguments: { id: 1 } },
      { name: 'memo_get', arguments: { id: 2 } },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(mockExecuteMemoGet).not.toHaveBeenCalled();
  });
});

describe('memo-tools: 잠긴 메모 쓰기 거부 (메시지 불변)', () => {
  function dbWithMemo(row: any): any {
    return {
      prepare: jest.fn().mockReturnValue({
        bind: jest.fn().mockReturnValue({
          first: jest.fn().mockResolvedValue(row),
          all: jest.fn().mockResolvedValue({ results: [] }),
          run: jest.fn().mockResolvedValue({}),
        }),
      }),
    };
  }

  test('잠긴 메모 수정 → 기존 메시지로 거부, UPDATE 미실행', async () => {
    const db = dbWithMemo({ is_locked: 1 });
    const r = await executeMemoUpdate({ DB: db } as any, 1, '새 내용');
    expect(r).toEqual({ success: false, error: '잠긴 메모는 수정할 수 없습니다' });
    const runCalls = (db.prepare as jest.Mock).mock.calls;
    expect(runCalls.filter((c) => String(c[0]).includes('UPDATE memos'))).toHaveLength(0);
  });

  test('잠긴 메모 삭제 → 기존 메시지로 거부, DELETE 미실행', async () => {
    const db = dbWithMemo({ is_locked: 1 });
    const r = await executeMemoDelete({ DB: db } as any, 1);
    expect(r).toEqual({ success: false, error: '잠긴 메모는 삭제할 수 없습니다' });
    const runCalls = (db.prepare as jest.Mock).mock.calls;
    expect(runCalls.filter((c) => String(c[0]).includes('DELETE FROM memos'))).toHaveLength(0);
  });

  test('잠기지 않은 메모 수정 → 성공', async () => {
    const db = dbWithMemo({ is_locked: 0 });
    const r = await executeMemoUpdate({ DB: db } as any, 1, '새 내용');
    expect(r).toEqual({ success: true, data: { id: 1 } });
  });
});
