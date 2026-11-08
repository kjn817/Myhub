/// <reference types="jest" />
/**
 * fast-check 속성 기반 테스트 — 메모 마커 파서 (src/services/memo-tools.ts)
 *
 * 예시 나열이 아니라 성질(property) 검증:
 * - round-trip: 마커로 직렬화한 페이로드를 파싱하면 원래 페이로드와 동일하다
 *   (길이 상한·제목 병합 규칙을 반영한 동일성)
 * - 상한: 턴당 최대 개수(검색/조회 3, 생성/수정/삭제 2)를 절대 넘지 않는다
 * - 명시적 처리: 깨진 JSON·필수 필드 누락 마커는 조용히 무시되고 예외를 던지지 않는다
 * - id 무결성: 파서가 반환하는 id는 항상 안전한 정수다 (DB 바인딩 전제)
 * - 마커가 없는 텍스트는 항상 빈 배열이다
 *
 * fast-check가 반례를 찾는 것 자체가 카나리아다. 추가로 결함 1건(수정/삭제
 * 마커의 id 미검증)은 이 파일의 property가 직접 찾아냈고,
 * src/services/memo-tools.ts에서 Number.isSafeInteger 가드로 수정했다.
 * 회귀 고정: 아래 'id는 항상 안전한 정수' property + 명시적 예시 케이스.
 */

import * as fc from 'fast-check';
import {
  parseMemoSearchMarkers,
  parseMemoGetMarkers,
  parseMemoCreateMarkers,
  parseMemoUpdateMarkers,
  parseMemoDeleteMarkers,
} from '../../src/services/memo-tools';

jest.mock('../../src/services/ai-access', () => ({
  searchAccessibleMemos: jest.fn(),
  getAccessibleMemo: jest.fn(),
}));

// 마커 구분자([/MEMO_*])를 포함하지 않는 본문 문자열 — 구분자가 본문에
// 들어가면 마커 경계가 먼저 끊기는 것이 스펙(비탐욕 매칭)이라 round-trip
// 대상에서 제외한다. 파서 정규식이 /i라 소문자 구분자도 제외한다.
const noMarkerText = () =>
  fc
    .string({ minLength: 1, maxLength: 200 })
    .filter((s) => !/\[\/memo_/i.test(s) && s.trim().length > 0);

const markerBody = (tag: string, payload: unknown) =>
  `[${tag}]${JSON.stringify(payload)}[/${tag}]`;

describe('parseMemoSearchMarkers', () => {
  test('property: round-trip — 직렬화한 검색 마커는 원래 쿼리(200자 상한)를 돌려준다', () => {
    fc.assert(
      fc.property(noMarkerText(), (query) => {
        const parsed = parseMemoSearchMarkers(markerBody('MEMO_SEARCH', { query }));
        expect(parsed).toHaveLength(1);
        expect(parsed[0].query).toBe(query.slice(0, 200));
        expect(parsed[0].full).toBe(markerBody('MEMO_SEARCH', { query }));
      }),
      { numRuns: 200 },
    );
  });

  test('property: 턴당 최대 3개까지만 반환한다', () => {
    fc.assert(
      fc.property(fc.array(noMarkerText(), { minLength: 0, maxLength: 8 }), (queries) => {
        const text = queries.map((q) => markerBody('MEMO_SEARCH', { query: q })).join('\n');
        const parsed = parseMemoSearchMarkers(text);
        expect(parsed.length).toBeLessThanOrEqual(3);
        expect(parsed.length).toBe(Math.min(3, queries.length));
      }),
      { numRuns: 100 },
    );
  });

  test('property: 깨진 JSON·쿼리 누락 마커는 예외 없이 무시된다', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 120 }),
          // 유효한 query를 가진 JSON도 섞는다 — 순수 무작위 문자열만으로는
          // 1000회 중 0번 유효 query가 나와 else 분기가 실행되지 않는다(실측).
          fc.record({ query: fc.string({ maxLength: 50 }) }).map((o) => JSON.stringify(o)),
        ),
        (junk) => {
        const text = `[MEMO_SEARCH]${junk}[/MEMO_SEARCH]`;
        expect(() => parseMemoSearchMarkers(text)).not.toThrow();
        // 파서가 실제로 본 마커 본문(첫 닫는 태그 앞부분)으로 기대값을 계산한다.
        // junk 전체를 JSON.parse하면 닫는 태그를 포함한 junk와 파서 입력이 달라진다.
        const inner = /\[MEMO_SEARCH\]([\s\S]*?)\[\/MEMO_SEARCH\]/i.exec(text)?.[1] ?? '';
        let parsed: unknown;
        try {
          parsed = JSON.parse(inner.trim());
        } catch {
          parsed = undefined;
        }
        const results = parseMemoSearchMarkers(text);
        if (!parsed || typeof parsed !== 'object' || typeof (parsed as any).query !== 'string') {
          expect(results).toHaveLength(0);
        } else if ((parsed as any).query) {
          // 유효한 query가 있으면 파싱 결과가 그 query와 같아야 한다 (공허한 분기 제거 — §5.2-3)
          expect(results).toHaveLength(1);
          expect(results[0].query).toBe(((parsed as any).query as string).slice(0, 200));
        } else {
          // 빈 문자열 query는 falsy라 무시된다 (parsed.query truthy 가드)
          expect(results).toHaveLength(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  test('property: 마커가 없는 텍스트는 항상 빈 배열이다', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }).filter((s) => !s.includes('MEMO_SEARCH')),
        (text) => {
          expect(parseMemoSearchMarkers(text)).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('parseMemoGetMarkers', () => {
  test('property: round-trip — 직렬화한 조회 마커는 원래 id를 돌려준다', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), (id) => {
        const parsed = parseMemoGetMarkers(markerBody('MEMO_GET', { id }));
        expect(parsed).toHaveLength(1);
        expect(parsed[0].id).toBe(id);
      }),
      { numRuns: 200 },
    );
  });

  test('property: 반환되는 id는 항상 안전한 정수다', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer(),
          fc.double({ noNaN: true }),
          fc.string(),
          fc.boolean(),
          fc.constant(null),
        ),
        (id) => {
          const parsed = parseMemoGetMarkers(markerBody('MEMO_GET', { id }));
          for (const r of parsed) {
            expect(Number.isSafeInteger(r.id)).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  test('회귀: 안전하지 않은 큰 정수 id는 무시된다', () => {
    expect(parseMemoGetMarkers(markerBody('MEMO_GET', { id: 1e21 }))).toEqual([]);
    expect(parseMemoGetMarkers(markerBody('MEMO_GET', { id: 1.5 }))).toEqual([]);
    expect(parseMemoGetMarkers(markerBody('MEMO_GET', { id: '12' }))).toEqual([]);
  });
});

describe('parseMemoCreateMarkers', () => {
  test('property: round-trip — 제목+본문 병합 규칙을 반영해 원래 텍스트를 돌려준다', () => {
    fc.assert(
      fc.property(noMarkerText(), noMarkerText(), (body, title) => {
        const payload = { title, text: body };
        const parsed = parseMemoCreateMarkers(markerBody('MEMO_CREATE', payload));
        expect(parsed).toHaveLength(1);
        expect(parsed[0].text).toBe(`${title.trim()}\n\n${body}`.slice(0, 10000));
      }),
      { numRuns: 200 },
    );
  });

  test('property: content 필드만 있어도 본문으로 파싱된다 (text 우선)', () => {
    fc.assert(
      fc.property(noMarkerText(), (body) => {
        const withContent = parseMemoCreateMarkers(markerBody('MEMO_CREATE', { content: body }));
        expect(withContent).toHaveLength(1);
        expect(withContent[0].text).toBe(body.slice(0, 10000));
        const withBoth = parseMemoCreateMarkers(
          markerBody('MEMO_CREATE', { text: 'text우선', content: body }),
        );
        expect(withBoth).toHaveLength(1);
        expect(withBoth[0].text).toBe('text우선');
      }),
      { numRuns: 100 },
    );
  });

  test('property: 턴당 최대 2개까지만 반환하고, 본문 없는 마커는 건너뛴다', () => {
    fc.assert(
      fc.property(fc.array(noMarkerText(), { minLength: 0, maxLength: 6 }), (bodies) => {
        const text = bodies.map((b) => markerBody('MEMO_CREATE', { text: b })).join('\n');
        const parsed = parseMemoCreateMarkers(text);
        expect(parsed.length).toBeLessThanOrEqual(2);
        expect(parsed.length).toBe(Math.min(2, bodies.length));
        // 빈 본문은 결과에 포함되지 않는다
        expect(parseMemoCreateMarkers(markerBody('MEMO_CREATE', { text: '   ' }))).toEqual([]);
        expect(parseMemoCreateMarkers(markerBody('MEMO_CREATE', {}))).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });
});

describe('parseMemoUpdateMarkers / parseMemoDeleteMarkers', () => {
  test('property: 반환되는 id는 항상 안전한 정수다', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer(),
          fc.double({ noNaN: true }),
          fc.string(),
          fc.boolean(),
          fc.constant(null),
        ),
        (id) => {
          const upd = parseMemoUpdateMarkers(markerBody('MEMO_UPDATE', { id, text: 'x' }));
          for (const r of upd) expect(Number.isSafeInteger(r.id)).toBe(true);
          const del = parseMemoDeleteMarkers(markerBody('MEMO_DELETE', { id }));
          for (const r of del) expect(Number.isSafeInteger(r.id)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  test('property: update round-trip — id와 본문을 그대로 돌려준다', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
        noMarkerText(),
        (id, text) => {
          const parsed = parseMemoUpdateMarkers(markerBody('MEMO_UPDATE', { id, text }));
          expect(parsed).toHaveLength(1);
          expect(parsed[0].id).toBe(id);
          expect(parsed[0].text).toBe(text.slice(0, 10000));
        },
      ),
      { numRuns: 200 },
    );
  });

  test('회귀: 문자열·소수·NaN id는 수정/삭제 대상으로 파싱되지 않는다 (fast-check 반례 고정)', () => {
    // fast-check 반례: {"id": "abc"} → Number("abc") = NaN, {"id": 1.5} → 1.5가
    // 그대로 DB 바인딩으로 흘러갔음. 이제는 안전한 정수가 아니면 무시한다.
    // 단, 숫자 문자열 "7"은 기존 동작(문자열 id를 Number로 변환)을 유지한다
    // — svc3-memo-tools 'id를 Number로 변환' 테스트가 고정.
    expect(parseMemoUpdateMarkers(markerBody('MEMO_UPDATE', { id: 'abc', text: 'x' }))).toEqual([]);
    expect(parseMemoUpdateMarkers(markerBody('MEMO_UPDATE', { id: 1.5, text: 'x' }))).toEqual([]);
    expect(parseMemoUpdateMarkers(markerBody('MEMO_UPDATE', { id: 1e21, text: 'x' }))).toEqual([]);
    expect(parseMemoDeleteMarkers(markerBody('MEMO_DELETE', { id: 'abc' }))).toEqual([]);
    expect(parseMemoDeleteMarkers(markerBody('MEMO_DELETE', { id: 1.5 }))).toEqual([]);
    expect(parseMemoDeleteMarkers(markerBody('MEMO_DELETE', { id: 1e21 }))).toEqual([]);
    // 정상 id는 그대로 동작한다 (숫자 문자열 포함)
    expect(parseMemoUpdateMarkers(markerBody('MEMO_UPDATE', { id: 7, text: 'x' }))).toHaveLength(1);
    expect(parseMemoUpdateMarkers(markerBody('MEMO_UPDATE', { id: '7', text: 'x' }))[0].id).toBe(7);
    expect(parseMemoDeleteMarkers(markerBody('MEMO_DELETE', { id: 7 }))).toHaveLength(1);
    expect(parseMemoDeleteMarkers(markerBody('MEMO_DELETE', { id: '7' }))[0].id).toBe(7);
  });

  test('property: 대소문자 구분 없이 태그를 인식한다 (기존 /i 동작)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000000 }), (id) => {
        expect(parseMemoDeleteMarkers(`[memo_delete]{"id": ${id}}[/memo_delete]`)).toHaveLength(1);
      }),
      { numRuns: 50 },
    );
  });
});
