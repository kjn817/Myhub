/// <reference types="jest" />
/**
 * fast-check 속성 기반 테스트 — 뉴스 날짜 필터 (src/lib/news-summary.ts)
 *
 * 성질:
 * - 창 밖·날짜 없음·파싱 불가 발행일은 절대 통과하지 않는다
 * - 필터는 멱등하다 (두 번 걸러도 같은 결과)
 * - 뉴스 창은 항상 [어제, 오늘] KST 2일이다
 * - 질의 날짜 소독은 멱등하고 항상 오늘 날짜로 시작한다
 * - URL 정규화는 멱등하고, dedupe는 정규화 기준 중복을 없앤다
 * - extractUrlDate가 돌려주는 날짜는 항상 유효한 달력 날짜다
 *
 * fast-check가 반례를 찾는 것 자체가 카나리아다. 추가로 결함 1건(URL
 * 정규화의 멱등성 위반 — 말단 슬래시 2개)은 이 파일의 property가 직접
 * 찾아냈고, src/lib/news-summary.ts에서 말단 슬래시 전체 제거로 수정했다.
 * 회귀 고정: 아래 'normalizeSourceUrl은 멱등하다' property + 명시적 예시.
 */

import * as fc from 'fast-check';
import {
  SearchSource,
  filterNewsWindow,
  newsWindow,
  sanitizeNewsQueryDate,
  normalizeSourceUrl,
  dedupeSources,
  extractUrlDate,
  isExactlyMidnightUtc,
  kstTodayStr,
  kstTodayKoStr,
} from '../../src/lib/news-summary';

const NOW = new Date('2026-10-27T10:00:00+09:00');
const WINDOW = newsWindow(NOW); // { startDate: '2026-10-26', endDate: '2026-10-27' }

const windowStartMs = Date.parse(`${WINDOW.startDate}T00:00:00+09:00`);
const windowEndMs = Date.parse(`${WINDOW.endDate}T23:59:59.999+09:00`);

// 창 안/밖/없음/깨짐을 섞은 발행일 생성기
const publishedDateArb = () =>
  fc.oneof(
    // 창 안: 어제 00:00 KST ~ 오늘 23:59 KST 사이의 임의 시각
    fc
      .integer({ min: windowStartMs, max: windowEndMs })
      .map((t) => new Date(t).toISOString()),
    // 창 밖: 과거·미래
    fc
      .integer({ min: windowStartMs - 365 * 86400000, max: windowStartMs - 1 })
      .map((t) => new Date(t).toISOString()),
    fc
      .integer({ min: windowEndMs + 1, max: windowEndMs + 365 * 86400000 })
      .map((t) => new Date(t).toISOString()),
    fc.constant(undefined),
    // 파싱 불가 문자열
    fc.string({ minLength: 1, maxLength: 30 }).filter((s) => Number.isNaN(Date.parse(s))),
  );

const sourceArb = (): fc.Arbitrary<SearchSource> =>
  fc.record({
    title: fc.string({ maxLength: 60 }),
    url: fc.webUrl(),
    publishedDate: publishedDateArb(),
  }) as fc.Arbitrary<SearchSource>;

describe('filterNewsWindow', () => {
  test('property: 통과한 항목의 발행일은 항상 파싱 가능하고 창 안에 있다', () => {
    fc.assert(
      fc.property(fc.array(sourceArb(), { maxLength: 12 }), (items) => {
        const kept = filterNewsWindow(items, WINDOW.startDate, WINDOW.endDate);
        for (const s of kept) {
          expect(s.publishedDate).toBeDefined();
          const t = Date.parse(s.publishedDate as string);
          expect(Number.isNaN(t)).toBe(false);
          expect(t).toBeGreaterThanOrEqual(windowStartMs);
          expect(t).toBeLessThanOrEqual(windowEndMs);
        }
      }),
      { numRuns: 200 },
    );
  });

  test('property: 발행일이 없거나 파싱 불가한 항목은 절대 통과하지 않는다', () => {
    fc.assert(
      fc.property(fc.array(sourceArb(), { maxLength: 12 }), (items) => {
        const kept = filterNewsWindow(items, WINDOW.startDate, WINDOW.endDate);
        const keptSet = new Set(kept);
        for (const s of items) {
          if (!s.publishedDate || Number.isNaN(Date.parse(s.publishedDate))) {
            expect(keptSet.has(s)).toBe(false);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  test('property: 창 밖 발행일 항목은 절대 통과하지 않는다 (URL 날짜와 무관하게)', () => {
    fc.assert(
      fc.property(fc.array(sourceArb(), { maxLength: 12 }), (items) => {
        const kept = filterNewsWindow(items, WINDOW.startDate, WINDOW.endDate);
        const keptSet = new Set(kept);
        for (const s of items) {
          if (s.publishedDate) {
            const t = Date.parse(s.publishedDate);
            if (!Number.isNaN(t) && (t < windowStartMs || t > windowEndMs)) {
              expect(keptSet.has(s)).toBe(false);
            }
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  test('property: 필터는 멱등하다 — 두 번 걸러도 같은 결과', () => {
    fc.assert(
      fc.property(fc.array(sourceArb(), { maxLength: 12 }), (items) => {
        const once = filterNewsWindow(items, WINDOW.startDate, WINDOW.endDate);
        const twice = filterNewsWindow(once, WINDOW.startDate, WINDOW.endDate);
        expect(twice).toEqual(once);
      }),
      { numRuns: 200 },
    );
  });

  test('property: 잘못된 창(start/end 파싱 불가)이면 전부 버린다', () => {
    fc.assert(
      fc.property(fc.array(sourceArb(), { maxLength: 6 }), (items) => {
        expect(filterNewsWindow(items, 'not-a-date', WINDOW.endDate)).toEqual([]);
        expect(filterNewsWindow(items, WINDOW.startDate, 'not-a-date')).toEqual([]);
      }),
      { numRuns: 50 },
    );
  });

  test('property: 자정 UTC 발행일은 Exa 모드에서 URL 확증 없으면 버려진다', () => {
    fc.assert(
      fc.property(fc.array(sourceArb(), { maxLength: 8 }), (items) => {
        const midnight = items.map((s) => ({
          ...s,
          // 창 안 날짜의 자정 UTC로 강제
          publishedDate: `${WINDOW.endDate}T00:00:00.000Z`,
          url: 'https://example.com/no-date-here',
        }));
        const kept = filterNewsWindow(midnight, WINDOW.startDate, WINDOW.endDate, {
          treatMidnightAsUnknown: true,
        });
        expect(kept).toEqual([]);
        // 같은 항목도 일반 모드에서는 통과한다 (자정 규칙은 Exa 전용)
        const keptNormal = filterNewsWindow(midnight, WINDOW.startDate, WINDOW.endDate);
        expect(keptNormal.length).toBe(midnight.length);
      }),
      { numRuns: 100 },
    );
  });
});

describe('newsWindow', () => {
  test('property: 창은 항상 [어제, 오늘] KST이고 start <= end다', () => {
    // fast-check 4.x의 fc.date()는 기본적으로 Invalid Date(new Date(NaN))도
    // 생성한다(설계상 — noInvalidDate 옵션으로 제외 가능). 2026-10-27 실측:
    // 시드 200개 중 85개에서 Invalid Date 반례가 나와 kstTodayStr의
    // Intl.DateTimeFormat.formatToParts가 RangeError를 던졌다 — flaky 원인.
    // 프로덕션 경로에서는 Invalid Date가 kstTodayStr에 도달할 수 없다:
    // 호출자는 전부 new Date()이거나(뉴스 경로), Date.parse/kstWallToIso로
    // 검증된 ISO 문자열만 넘긴다(article-date.ts extractArticlePublishedDate).
    // 그래서 생성기에서 Invalid Date를 제외한다 — 프로덕션 동작 변경 없음.
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('2020-01-01'),
          max: new Date('2030-12-31'),
          noInvalidDate: true,
        }),
        (now) => {
          const w = newsWindow(now);
          expect(w.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(w.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(w.endDate).toBe(kstTodayStr(now));
          const startMs = Date.parse(`${w.startDate}T00:00:00+09:00`);
          const endMs = Date.parse(`${w.endDate}T00:00:00+09:00`);
          expect(endMs - startMs).toBe(86400000);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('sanitizeNewsQueryDate', () => {
  test('property: 결과는 항상 오늘 날짜로 시작하고, 소독은 멱등하다', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (q) => {
        const today = kstTodayKoStr(NOW);
        const once = sanitizeNewsQueryDate(q, NOW);
        expect(once.startsWith(today)).toBe(true);
        expect(sanitizeNewsQueryDate(once, NOW)).toBe(once);
      }),
      { numRuns: 200 },
    );
  });

  test('property: 상대 표현(어제/오늘)은 건드리지 않는다', () => {
    // '어제'/'오늘'에 임의의 한글 접두사·접미사를 붙여도 상대 표현은 그대로 남는다
    // (고정 예시 4건이던 것을 생성기로 교체 — §5.2-1).
    // 접두사·접미사는 숫자를 포함하지 않는 한글 음절만으로 만든다: 숫자가
    // 들어가면 날짜 토큰(예: 2026년)으로 소독되어 '건드리지 않는다' 성질과
    // 무관하게 실패하므로, 생성기에서 날짜 토큰이 생길 여지를 없앤다.
    const hangulAffix = () =>
      fc
        .array(fc.integer({ min: 0xac00, max: 0xd7a3 }), { maxLength: 10 })
        .map((cps) => cps.map((cp) => String.fromCodePoint(cp)).join(''));
    fc.assert(
      fc.property(
        fc.tuple(fc.constantFrom('어제', '오늘'), hangulAffix(), hangulAffix()),
        ([word, pre, suf]) => {
          const q = `${pre}${word}${suf} 뉴스`;
          const out = sanitizeNewsQueryDate(q, NOW);
          expect(out).toContain(q);
          expect(out).toContain(word);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('normalizeSourceUrl / dedupeSources', () => {
  test('property: URL 정규화는 멱등하다', () => {
    fc.assert(
      fc.property(fc.webUrl(), (url) => {
        const once = normalizeSourceUrl(url);
        expect(normalizeSourceUrl(once)).toBe(once);
      }),
      { numRuns: 300 },
    );
    // 말단 슬래시가 여러 개여도 멱등해야 한다 (fast-check 반례 고정)
    fc.assert(
      fc.property(
        fc.webUrl(),
        fc.integer({ min: 1, max: 4 }),
        (url, slashes) => {
          const withSlashes = normalizeSourceUrl(url).replace(/\/*$/, '') + '/'.repeat(slashes);
          const once = normalizeSourceUrl(withSlashes);
          expect(normalizeSourceUrl(once)).toBe(once);
        },
      ),
      { numRuns: 200 },
    );
  });

  test('회귀: 말단 슬래시 2개짜리 URL은 한 번에 전부 제거된다', () => {
    expect(normalizeSourceUrl('https://example.com/a//')).toBe('https://example.com/a');
    expect(normalizeSourceUrl('https://example.com/a///')).toBe('https://example.com/a');
    expect(normalizeSourceUrl('https://EXAMPLE.com/a/')).toBe('https://example.com/a');
  });

  test('property: dedupe는 정규화 기준 중복을 없애고 첫 등장 순서만 남긴다', () => {
    fc.assert(
      fc.property(fc.array(fc.webUrl(), { minLength: 0, maxLength: 12 }), (urls) => {
        const sources: SearchSource[] = urls.map((url, i) => ({
          title: `t${i}`,
          url,
        }));
        const out = dedupeSources(sources);
        const keys = out.map((s) => normalizeSourceUrl(s.url));
        expect(new Set(keys).size).toBe(keys.length);
        // 첫 등장만 남는다: 출력은 입력의 부분 수열이다
        let idx = 0;
        for (const s of out) {
          const found = sources.findIndex(
            (src, j) => j >= idx && normalizeSourceUrl(src.url) === normalizeSourceUrl(s.url),
          );
          expect(found).toBeGreaterThanOrEqual(0);
          idx = found + 1;
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('extractUrlDate', () => {
  test('property: 돌려주는 날짜는 항상 유효한 달력 날짜다', () => {
    const segment = () =>
      fc.oneof(
        fc.integer({ min: 1900, max: 2100 }).map(String),
        fc.integer({ min: 1, max: 12 }).map(String),
        fc.integer({ min: 1, max: 31 }).map(String),
        fc.integer({ min: 0, max: 99999999 }).map((n) => String(n).padStart(8, '0')),
        fc.integer({ min: 0, max: 999999 }).map((n) => String(n).padStart(6, '0')),
        fc.string({ minLength: 1, maxLength: 10 }).filter((s) => !s.includes('/')),
      );
    fc.assert(
      fc.property(
        fc.array(segment(), { minLength: 1, maxLength: 5 }),
        (segments) => {
          const url = `https://example.com/${segments.join('/')}`;
          const found = extractUrlDate(url);
          expect(() => extractUrlDate(url)).not.toThrow();
          if (found) {
            expect(found.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            const [y, m, d] = found.date.split('-').map(Number);
            const dt = new Date(Date.UTC(y, m - 1, d));
            expect(dt.getUTCFullYear()).toBe(y);
            expect(dt.getUTCMonth()).toBe(m - 1);
            expect(dt.getUTCDate()).toBe(d);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  test('property: 임의 문자열 입력에도 예외를 던지지 않는다', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (s) => {
        expect(() => extractUrlDate(s)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  test('property: 경계값(1900-01-01·2100-12-31·12월·31일)은 받아들여진다 — 수용 방향 (감사 §5.3)', () => {
    // 기존 property는 "찾은 날짜가 유효하다"만 검증해 경계 거부 뮤턴트
    // (m>=12·d>=31·y<1900 등)를 못 잡았다. 경계 입력을 명시적으로 생성해
    // found가 non-null이고 정확한 날짜임을 단언한다.
    const BOUNDARY: Array<[string, string]> = [
      ['https://example.com/1900/01/01/x', '1900-01-01'],
      ['https://example.com/2100/12/31/x', '2100-12-31'],
      ['https://example.com/2026/12/15/x', '2026-12-15'],
      ['https://example.com/2026/01/31/x', '2026-01-31'],
      ['https://example.com/2026/12/31/x', '2026-12-31'],
      ['https://example.com/2026/01/01/x', '2026-01-01'],
    ];
    fc.assert(
      fc.property(fc.constantFrom(...BOUNDARY), ([url, date]) => {
        const found = extractUrlDate(url);
        expect(found).not.toBeNull();
        expect(found).toEqual({ date, precise: true });
      }),
      { numRuns: 60 },
    );
  });
});

describe('isExactlyMidnightUtc', () => {
  test('property: true면 파싱된 시각은 UTC 자정이다', () => {
    // 위 newsWindow property와 같은 이유: fc.date() 기본값은 Invalid Date를
    // 생성하고, 아래 d.toISOString()이 RangeError를 던져 flaky가 된다.
    fc.assert(
      fc.property(fc.date({ noInvalidDate: true }), (d) => {
        const iso = d.toISOString();
        if (isExactlyMidnightUtc(iso)) {
          const t = new Date(iso);
          expect(t.getUTCHours()).toBe(0);
          expect(t.getUTCMinutes()).toBe(0);
          expect(t.getUTCSeconds()).toBe(0);
          expect(t.getUTCMilliseconds()).toBe(0);
        }
        // 날짜만 있는 문자열은 자정으로 보지 않는다
        expect(isExactlyMidnightUtc('2026-10-27')).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  test('property: UTC 자정은 항상 true다 (완전성 — 자정을 직접 생성하면 true)', () => {
    // §5.2-2: 위 property는 단방향(검증)만 본다. 실제 자정인데 false를 내는
    // 경우(완전성 결함)는 이 방향이 잡는다.
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('2020-01-01'),
          max: new Date('2030-12-31'),
          noInvalidDate: true,
        }),
        (d) => {
          const midnight = new Date(
            Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
          );
          expect(isExactlyMidnightUtc(midnight.toISOString())).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  test('경계: 자정 직전·직후 1ms와 타임존 표기는 자정이 아니다', () => {
    expect(isExactlyMidnightUtc('2026-10-27T00:00:00.000Z')).toBe(true);
    expect(isExactlyMidnightUtc('2026-10-27T00:00:00.001Z')).toBe(false);
    expect(isExactlyMidnightUtc('2026-10-26T23:59:59.999Z')).toBe(false);
    // KST 자정은 UTC 자정이 아니다 (15:00 UTC)
    expect(isExactlyMidnightUtc('2026-10-27T00:00:00+09:00')).toBe(false);
  });
});
