/// <reference types="jest" />
/**
 * fast-check 속성 기반 테스트 — FTS 쿼리 빌더·검색 유틸
 * (src/services/memory-service.ts)
 *
 * 성질:
 * - extractSearchTerms: 최대 5개·2글자 이상·입력 토큰의 순서 유지 부분집합
 * - stripKoreanParticle: 결과는 원본 토큰의 접두사(조사 제거)이고 2글자 미만으로 줄지 않는다
 * - buildFtsQuery: 출력은 항상 `"..."` 구(句)들의 OR 결합(선택적 접두사 `*`)이며,
 *   추출된 모든 검색어가 이스케이프되어 포함된다
 * - buildFtsQuery: 임의의 검색어라도 실제 SQLite FTS5 MATCH에서 문법 오류를
 *   내지 않는다 (better-sqlite3 인메모리 FTS5로 실검증 — 빈 쿼리는 호출자가
 *   가드하는 스펙이라 MATCH 대상에서 제외)
 * - fusionScore: 임의의 수치 입력에도 항상 [0, 1] 안의 유한한 점수를 낸다
 * - parseEntities: 임의 입력에도 예외 없이 문자열 배열을 돌려준다
 *
 * fast-check가 반례를 찾는 것 자체가 카나리아다. 추가로 결함 1건
 * (fusionScore의 NaN 전파 — Date.parse 실패로 ageDays가 NaN이면 점수 전체가
 * NaN이 되어 정렬이 깨짐)은 이 파일의 property가 직접 찾아냈고,
 * src/services/memory-service.ts에서 유한수 소독으로 수정했다.
 * 회귀 고정: 아래 'fusionScore는 항상 [0, 1] 안의 유한한 수' property +
 * 명시적 예시 케이스.
 */

import * as fc from 'fast-check';
import Database from 'better-sqlite3';
import {
  buildFtsQuery,
  extractSearchTerms,
  stripKoreanParticle,
  fusionScore,
  parseEntities,
} from '../../src/services/memory-service';

// FTS5 문법 특수문자를 적극적으로 섞은 검색어 생성기
const ftsHostileToken = () =>
  fc
    .string({ minLength: 1, maxLength: 12 })
    .map((s) => s.replace(/\s/g, ''))
    .filter((s) => s.length >= 1);

const ftsQueryArb = () =>
  fc.oneof(
    fc.string({ minLength: 0, maxLength: 60 }),
    // FTS5 연산자·구문 문자를 노골적으로 포함한 질의
    fc.array(
      fc.constantFrom(
        'AND', 'OR', 'NOT', 'NEAR', '"', '(', ')', '*', '^', ':', '{', '}',
        '이름', '이름은', '반려견', 'memo', 'a', 'ab', '한', '한글', 'test123',
        '2026-10-27', 'C++', 'a"b', "a'b", 'a/b', 'a\\b', 'a-b', 'a_b',
      ),
      { minLength: 1, maxLength: 8 },
    ).map((parts) => parts.join(' ')),
  );

describe('extractSearchTerms', () => {
  test('property: 최대 5개·2글자 이상·입력 토큰 순서 유지', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (query) => {
        const terms = extractSearchTerms(query);
        expect(terms.length).toBeLessThanOrEqual(5);
        for (const t of terms) expect(t.length).toBeGreaterThanOrEqual(2);
        const tokens = (query || '').trim().split(/\s+/).filter((t) => t.length >= 2);
        // terms는 tokens의 순서 유지 부분집합이다
        let idx = 0;
        for (const t of terms) {
          const found = tokens.indexOf(t, idx);
          expect(found).toBeGreaterThanOrEqual(0);
          idx = found + 1;
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('stripKoreanParticle', () => {
  test('property: 결과는 원본의 접두사이거나 원본 그대로이고, 2글자 미만으로 줄지 않는다', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), (token) => {
        const stripped = stripKoreanParticle(token);
        expect(token.startsWith(stripped)).toBe(true);
        expect(stripped.length).toBeLessThanOrEqual(token.length);
        if (stripped !== token) expect(stripped.length).toBeGreaterThanOrEqual(2);
      }),
      { numRuns: 500 },
    );
  });
});

describe('buildFtsQuery', () => {
  test('property: 출력은 "…" 구들의 OR 결합 형태다', () => {
    const phraseRe = /^"((?:[^"]|"")*)"(\*)?$/;
    fc.assert(
      fc.property(ftsQueryArb(), (query) => {
        const out = buildFtsQuery(query);
        if (!out) {
          expect(extractSearchTerms(query)).toHaveLength(0);
          return;
        }
        const groups = out.split(' OR ');
        expect(groups.length).toBeGreaterThanOrEqual(1);
        for (const g of groups) {
          expect(g).toMatch(phraseRe);
        }
      }),
      { numRuns: 500 },
    );
  });

  test('property: 추출된 모든 검색어가 이스케이프되어 출력에 포함된다', () => {
    fc.assert(
      fc.property(ftsQueryArb(), (query) => {
        const out = buildFtsQuery(query);
        for (const t of extractSearchTerms(query)) {
          const escaped = `"${t.replace(/"/g, '""')}"`;
          expect(out).toContain(escaped);
        }
      }),
      { numRuns: 300 },
    );
  });

  test('property: 임의 검색어도 실제 FTS5 MATCH에서 문법 오류를 내지 않는다', () => {
    const db = new Database(':memory:');
    try {
      db.exec(
        `CREATE VIRTUAL TABLE fts USING fts5(content);
         INSERT INTO fts(content) VALUES
           ('내 반려견 이름은 보라돌이야'),
           ('회의 준비 메모와 일정 정리'),
           ('hello world test document'),
           ('2026년 10월 27일 뉴스 브리핑');`,
      );
      const stmt = db.prepare('SELECT count(*) AS n FROM fts WHERE fts MATCH ?');
      fc.assert(
        fc.property(ftsQueryArb(), (query) => {
          const built = buildFtsQuery(query);
          if (!built) return; // 빈 쿼리는 호출자(fetchRankedMemories)가 가드하는 스펙
          expect(() => stmt.get(built)).not.toThrow();
        }),
        { numRuns: 500 },
      );
    } finally {
      db.close();
    }
  });
});

describe('fusionScore', () => {
  test('property: 임의의 수치 입력에도 항상 [0, 1] 안의 유한한 점수다', () => {
    fc.assert(
      fc.property(
        fc.record({
          ftsRank: fc.double(),
          entityMatches: fc.double(),
          entityTotal: fc.double(),
          ageDays: fc.double(),
          accessCount: fc.double(),
        }),
        (input) => {
          const score = fusionScore(input);
          expect(Number.isFinite(score)).toBe(true);
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 500 },
    );
  });

  test('회귀: NaN·Infinity 입력이 점수를 NaN으로 만들지 않는다 (fast-check 반례 고정)', () => {
    // fast-check 반례: ageDays=NaN → recency NaN → 점수 전체 NaN.
    // Date.parse 실패로 ageDays가 NaN이 될 수 있는 경로가 실제로 있다
    // (rankMemoryRows: lastActivity 파싱 실패 시).
    expect(fusionScore({ ftsRank: -1, entityMatches: 1, entityTotal: 2, ageDays: NaN, accessCount: 3 })).toBeGreaterThanOrEqual(0);
    expect(
      fusionScore({ ftsRank: NaN, entityMatches: NaN, entityTotal: NaN, ageDays: NaN, accessCount: NaN }),
    ).toBe(0.15); // fts 0 + entity 0 + recency 1*0.15 + access 0
    expect(
      fusionScore({ ftsRank: -Infinity, entityMatches: Infinity, entityTotal: 1, ageDays: Infinity, accessCount: Infinity }),
    ).toBeLessThanOrEqual(1);
  });
});

describe('parseEntities', () => {
  test('property: 임의 입력에도 예외 없이 문자열 배열을 돌려준다', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        let out: unknown;
        expect(() => {
          out = parseEntities(raw);
        }).not.toThrow();
        expect(Array.isArray(out)).toBe(true);
        for (const e of out as unknown[]) expect(typeof e).toBe('string');
      }),
      { numRuns: 300 },
    );
  });

  test('property: 문자열 배열의 JSON 직렬화는 round-trip된다', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 40 }), { maxLength: 10 }), (arr) => {
        expect(parseEntities(JSON.stringify(arr))).toEqual(arr);
      }),
      { numRuns: 200 },
    );
  });
});
