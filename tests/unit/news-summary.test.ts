/// <reference types="jest" />
/**
 * 뉴스 요약 품질 (2026-10-25 결함 2건 수정) 단위 테스트
 * - buildSearchFollowUpPrompt: 항목별 [출처](URL) 지시 + 카테고리 분류 체계 + MEMO_CREATE 유지
 * - attachMissingSources: 빠진 항목 출처를 순서대로 보강 (오인 연결 방지 가드 포함)
 * Exa 실호출 없음 — 전부 fixture/mock.
 */
import {
  NEWS_CATEGORY_GUIDE,
  buildSearchFollowUpPrompt,
  attachMissingSources,
  validateItemSources,
  normalizeSourceUrl,
  dedupeSources,
  filterFreshSources,
  isNewsQuery,
  exaNewsParams,
  resolveNewsIntent,
  kstTodayStr,
  kstTodayKoStr,
  newsWindow,
  buildDatedNewsQuery,
  sanitizeNewsQueryDate,
  extractUrlDate,
  isExactlyMidnightUtc,
  filterNewsWindow,
  mergeSearchSources,
  extractUrlsFromText,
  noFreshNewsText,
  type SearchSource,
} from '../../src/lib/news-summary'

const SOURCES: SearchSource[] = [
  { title: '태풍 참피 제주 강풍', url: 'https://www.edaily.co.kr/news/1' },
  { title: '흑해 상선 공격', url: 'https://www.hankookilbo.com/news/2' },
  { title: '원주 DB 3연승', url: 'https://sports.news.com/3' },
]

describe('buildSearchFollowUpPrompt', () => {
  const prompt = buildSearchFollowUpPrompt({
    query: '오늘 주요 뉴스',
    searchContext: '1. 태풍 참피\n   URL: https://www.edaily.co.kr/news/1',
  })

  it('검색 결과와 [SEARCH:] 마커를 포함한다', () => {
    expect(prompt).toContain('1. 태풍 참피')
    expect(prompt).toContain('https://www.edaily.co.kr/news/1')
    expect(prompt).toContain('[SEARCH: 오늘 주요 뉴스]')
  })

  it('각 항목마다 [출처](URL) 형식을 강제한다', () => {
    expect(prompt).toContain('[출처](URL)')
    expect(prompt).toContain('해당 번호 검색 결과의 URL')
    expect(prompt).toContain('URL을 지어내지 말고 주어진 검색 결과 목록의 URL만 사용할 것')
    expect(prompt).toContain('출처가 없는 항목을 만들지 말 것')
    // 기존의 모호한 지시는 없어야 한다
    expect(prompt).not.toContain('본문에 자연스럽게 포함해')
  })

  it('카테고리 분류 체계를 포함한다 (전쟁 오분류 방지)', () => {
    expect(prompt).toContain('전쟁·분쟁·군사 충돌·테러는 국제')
    expect(prompt).toContain('절대 날씨 및 재해에 넣지 말 것')
    expect(prompt).toContain('날씨 및 재해에는 실제 기상·자연재해만 넣을 것')
    expect(prompt).toContain('사건·사고 및 법조계')
    expect(prompt).toContain('국제')
    expect(prompt).toContain('스포츠')
  })

  it('각 항목마다 서로 다른 URL을 하나씩만 달 것을 지시한다', () => {
    expect(prompt).toContain('서로 다른 URL을 하나씩만')
    expect(prompt).toContain('같은 URL을 두 항목에 달지 말 것')
    expect(prompt).toContain('30일 이상 지난 결과는 인용하지 말 것')
  })

  it('검색 결과 개수를 초과해 항목을 늘리지 말 것을 지시한다 (2026-10-26 실측: 2개 출처 → 8개 항목 부풀림)', () => {
    expect(prompt).toContain('검색 결과 개수만큼만 항목을 만들 것')
    expect(prompt).toContain('결과를 초과해 항목을 늘리지 말 것')
  })

  it('[MEMO_CREATE] 지시와 서론 금지 규칙을 유지한다', () => {
    expect(prompt).toContain('[MEMO_CREATE]')
    expect(prompt).toContain('오늘 주요 뉴스')
    expect(prompt).toContain('불필요한 서론 없이 바로 목록부터 시작해')
  })

  it('NEWS_CATEGORY_GUIDE가 카테고리 정의와 규칙을 모두 담는다', () => {
    for (const name of ['사건·사고 및 법조계', '국제', '날씨 및 재해', '정치', '경제', '사회', '스포츠', '기술·과학', '문화·연예']) {
      expect(NEWS_CATEGORY_GUIDE).toContain(name)
    }
    expect(NEWS_CATEGORY_GUIDE).toContain('없는 카테고리를 새로 만들지 말 것')
  })
})

describe('isNewsQuery / exaNewsParams (2026-10-26 라이브 실측)', () => {
  it('뉴스 계열 질의를 판정한다', () => {
    expect(isNewsQuery('오늘 한국 주요 뉴스 알려줘')).toBe(true)
    expect(isNewsQuery('속보 있어?')).toBe(true)
    expect(isNewsQuery('최신 헤드라인')).toBe(true)
    expect(isNewsQuery('오늘의 브리핑')).toBe(true)
    expect(isNewsQuery('파이썬 문법 알려줘')).toBe(false)
    expect(isNewsQuery('내 일정 확인해줘')).toBe(false)
    expect(isNewsQuery('')).toBe(false)
  })

  it('뉴스 파라미터는 category news + 1~2일 창(어제~오늘) + userLocation KR이다', () => {
    const now = new Date('2026-10-26T12:00:00Z')
    const params = exaNewsParams(now)
    expect(params.category).toBe('news')
    expect(params.startPublishedDate).toBe('2026-10-25')
    expect(params.endPublishedDate).toBe('2026-10-26')
    expect(params.userLocation).toBe('KR')
  })
})

describe('resolveNewsIntent / kstTodayStr / noFreshNewsText (2026-10-26 재실측)', () => {
  it('마커에 키워드가 없어도 사용자 원문에 있으면 뉴스 의도다', () => {
    expect(resolveNewsIntent('서울서부지방법원 습격', '오늘 한국 주요 뉴스 하나를 검색해서 한 문장으로 알려줘')).toBe(true)
    expect(resolveNewsIntent('서울서부지방법원 습격', '오늘 한국 주요 뉴스 알려줘')).toBe(true)
  })

  it('둘 다 뉴스 키워드가 없으면 뉴스 의도가 아니다', () => {
    expect(resolveNewsIntent('서울서부지방법원 습격', '이 사건 배경을 설명해줘')).toBe(false)
    expect(resolveNewsIntent('', '')).toBe(false)
  })

  it('마커에 키워드가 있으면 사용자 원문과 무관하게 뉴스 의도다', () => {
    expect(resolveNewsIntent('오늘 주요 뉴스', '이거 요약해줘')).toBe(true)
  })

  it('kstTodayStr은 KST 날짜를 반환한다 (UTC 자정 근처도 KST 기준)', () => {
    // 2026-10-25 16:00 UTC = 2026-10-26 01:00 KST
    expect(kstTodayStr(new Date('2026-10-25T16:00:00Z'))).toBe('2026-10-26')
    expect(kstTodayStr(new Date('2026-10-26T12:00:00Z'))).toBe('2026-10-26')
  })

  it('noFreshNewsText는 오늘 날짜와 정직한 안내를 담고 마커를 포함하지 않는다', () => {
    const text = noFreshNewsText(new Date('2026-10-26T12:00:00Z'))
    expect(text).toContain('오늘(2026-10-26)')
    expect(text).toContain('최신 뉴스를 찾지 못했어요')
    expect(text).toContain('오늘·어제 날짜')
    expect(text).not.toContain('[SEARCH:')
  })

  it('buildSearchFollowUpPrompt에 오늘 날짜가 명시된다', () => {
    const prompt = buildSearchFollowUpPrompt({
      query: '오늘 주요 뉴스',
      searchContext: '1. x',
      today: new Date('2026-10-26T12:00:00Z'),
    })
    expect(prompt).toContain('오늘 날짜는 2026-10-26이다')
    expect(prompt).toContain('"오늘 뉴스"는 이 날짜를 기준으로 한 최신 뉴스')
  })
})

describe('attachMissingSources', () => {
  it('URL이 없는 항목 끝에 순서대로 출처를 붙인다', () => {
    const text = [
      '1. 태풍 참피 제주 강풍특보',
      '2. 흑해 상선 공격 격화',
      '3. 원주 DB 3연승',
    ].join('\n')
    const out = attachMissingSources(text, SOURCES)
    expect(out).toContain('1. 태풍 참피 제주 강풍특보 — [출처](https://www.edaily.co.kr/news/1)')
    expect(out).toContain('2. 흑해 상선 공격 격화 — [출처](https://www.hankookilbo.com/news/2)')
    expect(out).toContain('3. 원주 DB 3연승 — [출처](https://sports.news.com/3)')
  })

  it('이미 URL이 있는 항목은 건드리지 않는다 (마크다운 링크·bare URL)', () => {
    const text = [
      '1. 태풍 참피 — [출처](https://www.edaily.co.kr/news/1)',
      '2. 흑해 상선 공격 https://www.hankookilbo.com/news/2',
      '3. 원주 DB 3연승',
    ].join('\n')
    const out = attachMissingSources(text, SOURCES)
    expect(out).toContain('1. 태풍 참피 — [출처](https://www.edaily.co.kr/news/1)')
    expect(out).not.toContain('https://www.edaily.co.kr/news/1) — [출처]')
    expect(out).toContain('3. 원주 DB 3연승 — [출처](https://sports.news.com/3)')
    // 2번 항목에는 중복 출처가 붙지 않는다
    expect(out.match(/hankookilbo/g)?.length).toBe(1)
  })

  it('여러 줄 항목은 블록 마지막 줄에 붙인다', () => {
    const text = [
      '1. 태풍 참피 제주 강풍특보',
      '   26일까지 비가 이어진다.',
      '2. 흑해 상선 공격 격화',
    ].join('\n')
    const out = attachMissingSources(text, SOURCES.slice(0, 2))
    expect(out).toContain('   26일까지 비가 이어진다. — [출처](https://www.edaily.co.kr/news/1)')
    expect(out).toContain('2. 흑해 상선 공격 격화 — [출처](https://www.hankookilbo.com/news/2)')
  })

  it('항목 수와 출처 수가 다르면 오인 연결을 막기 위해 원문을 그대로 둔다', () => {
    const text = '1. 태풍 참피\n2. 흑해 상선 공격\n3. 원주 DB 3연승\n4. 추가 뉴스'
    expect(attachMissingSources(text, SOURCES)).toBe(text)
    expect(attachMissingSources('1. 태풍 참피', SOURCES)).toBe('1. 태풍 참피')
  })

  it('번호 목록이 없거나 출처가 없으면 원문을 그대로 둔다', () => {
    expect(attachMissingSources('오늘 뉴스를 요약해 드릴게요.', SOURCES)).toBe('오늘 뉴스를 요약해 드릴게요.')
    expect(attachMissingSources('1. 태풍 참피', [])).toBe('1. 태풍 참피')
    expect(attachMissingSources('', SOURCES)).toBe('')
  })

  it('"1)" 형식 번호도 인식한다', () => {
    const text = '1) 태풍 참피\n2) 흑해 상선 공격'
    const out = attachMissingSources(text, SOURCES.slice(0, 2))
    expect(out).toContain('1) 태풍 참피 — [출처](https://www.edaily.co.kr/news/1)')
  })
  it('[MEMO_CREATE] 마커는 건드리지 않는다', () => {
    const text = [
      '1. 태풍 참피',
      '2. 흑해 상선 공격',
      '[MEMO_CREATE]{"title": "오늘 주요 뉴스", "text": "1. 태풍 참피\\n2. 흑해 상선 공격"}[/MEMO_CREATE]',
    ].join('\n')
    const out = attachMissingSources(text, SOURCES.slice(0, 2))
    // 본문 항목에는 출처가 붙는다
    expect(out).toContain('1. 태풍 참피 — [출처](https://www.edaily.co.kr/news/1)')
    // 마커 안의 내용은 원문 그대로이다
    expect(out).toContain('[MEMO_CREATE]{"title": "오늘 주요 뉴스", "text": "1. 태풍 참피\\n2. 흑해 상선 공격"}[/MEMO_CREATE]')
  })
})

describe('newsWindow / buildDatedNewsQuery / filterNewsWindow (2026-10-26 Exa 조사 권장안)', () => {
  const NOW = new Date('2026-10-26T12:00:00Z') // KST 21:00 → 오늘 2026-10-26, 어제 2026-10-25

  it('newsWindow는 어제~오늘(KST)이다', () => {
    expect(newsWindow(NOW)).toEqual({ startDate: '2026-10-25', endDate: '2026-10-26' })
    // KST 자정 근처: 2026-10-25 16:00 UTC = 2026-10-26 01:00 KST
    expect(newsWindow(new Date('2026-10-25T16:00:00Z'))).toEqual({ startDate: '2026-10-25', endDate: '2026-10-26' })
  })

  it('kstTodayKoStr은 "2026년 10월 26일" 형태이다', () => {
    expect(kstTodayKoStr(NOW)).toBe('2026년 10월 26일')
    expect(kstTodayKoStr(new Date('2026-10-25T16:00:00Z'))).toBe('2026년 10월 26일')
  })

  it('buildDatedNewsQuery는 오늘 날짜를 문장으로 앞에 붙인다', () => {
    expect(buildDatedNewsQuery('오늘 한국 주요 뉴스', NOW)).toBe('2026년 10월 26일 오늘 한국 주요 뉴스')
    // 날짜가 이미 있어도 오늘 날짜로 교체한다 (2026-10-26 실측: 모델이 마커에
    // "2025년 1월 22일" 같은 잘못된 날짜를 넣으면 질의가 오염됨)
    expect(buildDatedNewsQuery('2026년 10월 25일 뉴스', NOW)).toBe('2026년 10월 26일 뉴스')
    expect(buildDatedNewsQuery('2026-10-25 뉴스', NOW)).toBe('2026년 10월 26일 뉴스')
    expect(buildDatedNewsQuery('2025년 1월 22일 한국 주요 뉴스', NOW)).toBe('2026년 10월 26일 한국 주요 뉴스')
    expect(buildDatedNewsQuery('', NOW)).toBe('')
  })

  it('buildDatedNewsQuery는 질의 앞뒤 공백을 제거한다 (감사 §4 #8 — trim 뮤턴트)', () => {
    expect(buildDatedNewsQuery('  오늘 한국 주요 뉴스  ', NOW)).toBe('2026년 10월 26일 오늘 한국 주요 뉴스')
    expect(buildDatedNewsQuery('\t오늘 뉴스\n', NOW)).toBe('2026년 10월 26일 오늘 뉴스')
    expect(buildDatedNewsQuery('   ', NOW)).toBe('')
  })

  it('filterNewsWindow는 창 안의 발행일만 남기고 날짜 없음을 버린다', () => {
    const srcs: SearchSource[] = [
      { title: '오늘', url: 'https://example.com/today', publishedDate: '2026-10-26T09:00:00+09:00' },
      { title: '어제', url: 'https://example.com/yesterday', publishedDate: '2026-10-25T23:59:59+09:00' },
      { title: '그저께', url: 'https://example.com/daybefore', publishedDate: '2026-10-24T23:59:59+09:00' },
      { title: '미래', url: 'https://example.com/future', publishedDate: '2026-10-27T00:00:00+09:00' },
      { title: '날짜없음', url: 'https://example.com/nodate' },
      { title: '파싱불가', url: 'https://example.com/bad', publishedDate: 'not-a-date' },
    ]
    expect(filterNewsWindow(srcs, '2026-10-25', '2026-10-26').map((s) => s.title)).toEqual(['오늘', '어제'])
  })

  it('filterNewsWindow는 창이 잘못되면 빈 목록을 반환한다', () => {
    const srcs: SearchSource[] = [
      { title: '오늘', url: 'https://example.com/today', publishedDate: '2026-10-26T09:00:00+09:00' },
    ]
    expect(filterNewsWindow(srcs, 'bad', '2026-10-26')).toEqual([])
  })

  it('filterNewsWindow 창 경계: 시작일 00:00:00·종료일 23:59:59.999 KST와 정확히 같은 항목은 포함, 1ms 밖은 제외 (감사 §4 #10)', () => {
    // 창 2026-10-25~2026-10-26 → 시작 2026-10-24T15:00:00.000Z, 종료 2026-10-26T14:59:59.999Z
    const srcs: SearchSource[] = [
      { title: '시작일 정확히', url: 'https://example.com/nodate1', publishedDate: '2026-10-24T15:00:00.000Z' },
      { title: '종료일 정확히', url: 'https://example.com/nodate2', publishedDate: '2026-10-26T14:59:59.999Z' },
      { title: '시작 1ms 전', url: 'https://example.com/nodate3', publishedDate: '2026-10-24T14:59:59.999Z' },
      { title: '종료 1ms 후', url: 'https://example.com/nodate4', publishedDate: '2026-10-26T15:00:00.000Z' },
    ]
    expect(filterNewsWindow(srcs, '2026-10-25', '2026-10-26').map((s) => s.title)).toEqual([
      '시작일 정확히',
      '종료일 정확히',
    ])
  })
})

describe('sanitizeNewsQueryDate (2026-10-26 tail 로그 실측 — 마커 날짜 환각)', () => {
  const NOW = new Date('2026-10-26T12:00:00Z') // KST 21:00 → 오늘 2026-10-26

  it('마커의 잘못된 날짜를 제거하고 오늘 날짜로 교체한다', () => {
    expect(sanitizeNewsQueryDate('2025년 1월 22일 한국 주요 뉴스', NOW)).toBe('2026년 10월 26일 한국 주요 뉴스')
    expect(sanitizeNewsQueryDate('2025-01-22 한국 주요 뉴스', NOW)).toBe('2026년 10월 26일 한국 주요 뉴스')
    expect(sanitizeNewsQueryDate('2025/01/22 한국 주요 뉴스', NOW)).toBe('2026년 10월 26일 한국 주요 뉴스')
    expect(sanitizeNewsQueryDate('1월 22일 한국 주요 뉴스', NOW)).toBe('2026년 10월 26일 한국 주요 뉴스')
    expect(sanitizeNewsQueryDate('2025 한국 주요 뉴스', NOW)).toBe('2026년 10월 26일 한국 주요 뉴스')
  })

  it('이미 올바른 오늘 날짜면 동일하게 나온다 (멱등)', () => {
    expect(sanitizeNewsQueryDate('2026년 10월 26일 한국 주요 뉴스 헤드라인', NOW)).toBe(
      '2026년 10월 26일 한국 주요 뉴스 헤드라인',
    )
  })

  it('상대 날짜("오늘"/"어제")는 건드리지 않고 오늘 날짜만 앞에 붙인다', () => {
    expect(sanitizeNewsQueryDate('오늘 한국 주요 뉴스', NOW)).toBe('2026년 10월 26일 오늘 한국 주요 뉴스')
    expect(sanitizeNewsQueryDate('어제 한국 주요 뉴스', NOW)).toBe('2026년 10월 26일 어제 한국 주요 뉴스')
  })

  it('날짜만 남은 질의는 날짜만 반환하고, 빈 질의는 빈 문자열이 아니다', () => {
    expect(sanitizeNewsQueryDate('2025년 1월 22일', NOW)).toBe('2026년 10월 26일')
    expect(sanitizeNewsQueryDate('   ', NOW)).toBe('2026년 10월 26일')
  })
})

describe('extractUrlDate (2026-10-26 tail 로그 실측 — Exa publishedDate 가짜 대응)', () => {
  it('tail 로그의 오래된 URL 2건에서 창 밖 날짜를 추출한다', () => {
    // BBC Learning English 미러: /2025/250108 → 2025-01-08
    expect(
      extractUrlDate('https://meleleh.pages.dev/learningenglish/thai/features/learning-english-from-the-news_2025/250108'),
    ).toEqual({ date: '2025-01-08', precise: true })
    // 아시아경제 랭킹: 마지막 날짜 20250720 → 2025-07-20
    expect(extractUrlDate('https://www.asiae.co.kr/ranking/nationwide/20260622/20250720')).toEqual({
      date: '2025-07-20',
      precise: true,
    })
  })

  it('신선한 URL의 날짜를 추출한다 (여러 형식)', () => {
    expect(extractUrlDate('https://example.com/news/2026/10/26/article')).toEqual({ date: '2026-10-26', precise: true })
    expect(extractUrlDate('https://example.com/20261026/article')).toEqual({ date: '2026-10-26', precise: true })
    expect(extractUrlDate('https://example.com/news/2026-10-26/article')).toEqual({ date: '2026-10-26', precise: true })
    expect(extractUrlDate('https://example.com/news/2026년10월26일/article')).toEqual({ date: '2026-10-26', precise: true })
    expect(extractUrlDate('https://example.com/news/261026/article')).toEqual({ date: '2026-10-26', precise: true })
  })

  it('날짜가 없는 URL은 null이다 (기사 ID는 날짜가 아님)', () => {
    expect(extractUrlDate('https://www.katakini.com/artikel/118442/paspampres-korsel-bantah-gunakan-peluru-tajam/')).toBeNull()
    expect(extractUrlDate('https://kffnews.com/News/Section/articleView/4157')).toBeNull()
    expect(extractUrlDate('https://bbcbreakingnews.pages.dev/zhongwen/articles/cm2ny3gvmd1o/trad')).toBeNull()
    // 연합뉴스 기사 ID: 17자리 숫자 안의 20261026은 날짜가 아니다 (숫자 경계)
    expect(extractUrlDate('https://www.yna.co.kr/view/AKR20261026011900011')).toBeNull()
    expect(extractUrlDate('not-a-url')).toBeNull()
    expect(extractUrlDate('')).toBeNull()
  })

  it('유효하지 않은 날짜(13월·2월 30일)는 날짜가 아니다', () => {
    expect(extractUrlDate('https://example.com/20261340/article')).toBeNull()
    expect(extractUrlDate('https://example.com/2026/02/30/article')).toBeNull()
    // 윤년 2024-02-29는 유효, 평년 2023-02-29는 무효
    expect(extractUrlDate('https://example.com/2024/02/29/article')).toEqual({ date: '2024-02-29', precise: true })
    expect(extractUrlDate('https://example.com/2023/02/29/article')).toBeNull()
  })

  it('연도만 있으면 imprecise로 반환한다', () => {
    expect(extractUrlDate('https://example.com/news/2025/article')).toEqual({ date: '2025-01-01', precise: false })
    expect(extractUrlDate('https://example.com/news/2026년/article')).toEqual({ date: '2026-01-01', precise: false })
  })

  it('연도 범위 가드: 1900~2100년 밖은 날짜가 아니다 (감사 §4 #1 — 달력 검사가 흡수 못 함)', () => {
    // 1899년·2101년은 달력상 유효한 날짜라 가드가 없으면 날짜로 오인된다
    expect(extractUrlDate('https://example.com/1899/06/15/x')).toBeNull()
    expect(extractUrlDate('https://example.com/2101/01/01/x')).toBeNull()
    expect(extractUrlDate('https://example.com/1899-06-15/x')).toBeNull()
    expect(extractUrlDate('https://example.com/2101-01-01/x')).toBeNull()
    // 연도만 세그먼트도 범위 밖이면 null (기사 ID 오인 방지)
    expect(extractUrlDate('https://example.com/news/1899/article')).toBeNull()
    expect(extractUrlDate('https://example.com/news/2101/article')).toBeNull()
    // 경계 1900-01-01·2100-12-31은 유효하다
    expect(extractUrlDate('https://example.com/1900/01/01/x')).toEqual({ date: '1900-01-01', precise: true })
    expect(extractUrlDate('https://example.com/2100/12/31/x')).toEqual({ date: '2100-12-31', precise: true })
  })

  it('월/일 경계: 12월·31일·1월 1일은 유효하다 (감사 §4 #2)', () => {
    expect(extractUrlDate('https://example.com/2026/12/31/x')).toEqual({ date: '2026-12-31', precise: true })
    expect(extractUrlDate('https://example.com/2026/01/01/x')).toEqual({ date: '2026-01-01', precise: true })
    expect(extractUrlDate('https://example.com/2026-12-31/x')).toEqual({ date: '2026-12-31', precise: true })
    expect(extractUrlDate('https://example.com/20261231/x')).toEqual({ date: '2026-12-31', precise: true })
    expect(extractUrlDate('https://example.com/news/2026년12월31일/x')).toEqual({ date: '2026-12-31', precise: true })
  })
})

describe('isExactlyMidnightUtc (2026-10-26 tail 로그 실측)', () => {
  it('정확히 자정 UTC면 true', () => {
    expect(isExactlyMidnightUtc('2026-10-25T00:00:00.000Z')).toBe(true)
    expect(isExactlyMidnightUtc('2026-10-25T00:00:00Z')).toBe(true)
    expect(isExactlyMidnightUtc('2026-10-25T00:00:00.000+00:00')).toBe(true)
  })

  it('자정이 아니면 false (KST 자정·날짜만·일반 시각)', () => {
    expect(isExactlyMidnightUtc('2026-10-25T21:23:30.000Z')).toBe(false)
    expect(isExactlyMidnightUtc('2026-10-26T02:00:00.000Z')).toBe(false)
    // KST 자정 = UTC 15:00 — 자정 UTC가 아니다
    expect(isExactlyMidnightUtc('2026-10-26T00:00:00+09:00')).toBe(false)
    // 날짜만 있으면 일자 자체는 알려진 정보라 미상이 아니다
    expect(isExactlyMidnightUtc('2026-10-26')).toBe(false)
    expect(isExactlyMidnightUtc(undefined)).toBe(false)
    expect(isExactlyMidnightUtc('not-a-date')).toBe(false)
  })
})

describe('filterNewsWindow URL 날짜 가드 + 자정 규칙 (2026-10-26 tail 로그 실측)', () => {
  const START = '2026-10-25'
  const END = '2026-10-26'

  it('URL 날짜가 창 밖이면 publishedDate와 무관하게 제외한다', () => {
    const srcs: SearchSource[] = [
      { title: '가짜 신선 BBC', url: 'https://meleleh.pages.dev/x/2025/250108', publishedDate: '2026-10-25T00:00:00.000Z' },
      { title: '가짜 신선 랭킹', url: 'https://www.asiae.co.kr/ranking/nationwide/20260622/20250720', publishedDate: '2026-10-25T00:00:00.000Z' },
      { title: '진짜 신선', url: 'https://www.yna.co.kr/view/AKR20261026011900011', publishedDate: '2026-10-26T02:00:00.000Z' },
    ]
    expect(filterNewsWindow(srcs, START, END).map((s) => s.title)).toEqual(['진짜 신선'])
  })

  it('연도만 있는 URL은 창 연도 밖이면 제외, 창 안 연도면 유지한다', () => {
    const srcs: SearchSource[] = [
      { title: '2025년 글', url: 'https://example.com/news/2025/article', publishedDate: '2026-10-26T02:00:00.000Z' },
      { title: '2026년 글', url: 'https://example.com/news/2026/article', publishedDate: '2026-10-26T02:00:00.000Z' },
    ]
    expect(filterNewsWindow(srcs, START, END).map((s) => s.title)).toEqual(['2026년 글'])
  })

  it('자정 UTC + 플래그 ON + URL 확증 없음 → 제외 (Exa 전용)', () => {
    const srcs: SearchSource[] = [
      { title: '자정·날짜없는URL', url: 'https://www.katakini.com/artikel/118442/x', publishedDate: '2026-10-25T00:00:00.000Z' },
      { title: '자정·URL확증', url: 'https://example.com/news/2026/10/26/article', publishedDate: '2026-10-25T00:00:00.000Z' },
      { title: '자정아님', url: 'https://example.com/nodate', publishedDate: '2026-10-25T21:23:30.000Z' },
    ]
    expect(filterNewsWindow(srcs, START, END, { treatMidnightAsUnknown: true }).map((s) => s.title)).toEqual([
      '자정·URL확증',
      '자정아님',
    ])
  })

  it('자정 UTC + 플래그 OFF(기본값) → 유지 (네이버·RSS·Tavily는 실제 09:00 KST 발행이 있음)', () => {
    const srcs: SearchSource[] = [
      { title: '네이버 09시 정각', url: 'https://example.com/n1', publishedDate: '2026-10-26T00:00:00.000Z' },
    ]
    expect(filterNewsWindow(srcs, START, END).map((s) => s.title)).toEqual(['네이버 09시 정각'])
    expect(filterNewsWindow(srcs, START, END, { treatMidnightAsUnknown: false }).map((s) => s.title)).toEqual([
      '네이버 09시 정각',
    ])
  })

  it('tail 로그 5건(체인 1 유지분): 자정 규칙 + URL 가드로 4건 제외, 1건 잔존 — 잔존 사유를 명시한다', () => {
    // /tmp/tail_news.log [news-exa] 체인 1의 publishedDates를 위치 순서대로 매핑
    const logged: SearchSource[] = [
      { title: 'katakini', url: 'https://www.katakini.com/artikel/118442/paspampres-korsel-bantah-gunakan-peluru-tajam/', publishedDate: '2026-10-25T00:00:00.000Z' },
      { title: 'meleleh', url: 'https://meleleh.pages.dev/learningenglish/thai/features/learning-english-from-the-news_2025/250108', publishedDate: '2026-10-25T00:00:00.000Z' },
      { title: 'kffnews', url: 'https://kffnews.com/News/Section/articleView/4157', publishedDate: '2026-10-26T00:00:00.000Z' },
      { title: 'bbcbreakingnews', url: 'https://bbcbreakingnews.pages.dev/zhongwen/articles/cm2ny3gvmd1o/trad', publishedDate: '2026-10-25T21:23:30.000Z' },
      { title: 'asiae', url: 'https://www.asiae.co.kr/ranking/nationwide/20260622/20250720', publishedDate: '2026-10-25T00:00:00.000Z' },
    ]
    const kept = filterNewsWindow(logged, START, END, { treatMidnightAsUnknown: true })
    // katakini/meleleh/kffnews/asiae 제외 — meleleh·asiae는 URL 날짜, katakini·
    // kffnews는 자정 규칙으로 걸러짐.
    // KNOWN RESIDUAL GAP: bbcbreakingnews는 가짜지만 자정이 아닌 시각
    // (21:23:30) + 날짜 없는 URL이라 신호만으로 구분 불가 — 페이지를 직접
    // fetch하거나 미러 도메인 정책을 정하지 않는 한 남는다.
    expect(kept.map((s) => s.title)).toEqual(['bbcbreakingnews'])
  })
})

describe('mergeSearchSources / extractUrlsFromText (2026-10-26 실측 — sources/text 불일치)', () => {
  it('기존 sources 중 최종 텍스트에 남은 링크만 유지하고 치환 항목을 병합한다', () => {
    const existing = [
      { title: '오래된1', url: 'https://old.example.com/1' },
      { title: '신선1', url: 'https://fresh.example.com/1' },
    ]
    const replacements = [
      { title: '신선2', url: 'https://fresh.example.com/2' },
      { title: '신선3', url: 'https://fresh.example.com/3' },
    ]
    const text = [
      '1. 신선한 뉴스 — [출처](https://fresh.example.com/1)',
      '웹검색 (오늘 한국 주요 뉴스):',
      '- [신선2](https://fresh.example.com/2)',
      '- [신선3](https://fresh.example.com/3)',
    ].join('\n')
    expect(mergeSearchSources(existing, replacements, text)).toEqual([
      { title: '신선1', url: 'https://fresh.example.com/1' },
      { title: '신선2', url: 'https://fresh.example.com/2' },
      { title: '신선3', url: 'https://fresh.example.com/3' },
    ])
  })

  it('치환이 없어도 기존 sources는 텍스트에 없는 URL이 빠진다', () => {
    const existing = [{ title: '사라진 링크', url: 'https://gone.example.com/1' }]
    expect(mergeSearchSources(existing, [], '링크 없는 텍스트')).toEqual([])
  })

  it('중복 URL은 한 번만 들어가고 지어낸 URL은 들어가지 않는다', () => {
    const existing = [{ title: 'a', url: 'https://example.com/1/' }]
    const replacements = [{ title: 'a-dup', url: 'https://example.com/1' }]
    const text = 'x [출처](https://example.com/1)'
    expect(mergeSearchSources(existing, replacements, text)).toEqual([
      { title: 'a', url: 'https://example.com/1/' },
    ])
  })

  it('extractUrlsFromText는 마크다운 링크와 bare URL을 모두 뽑는다', () => {
    const text = 'a [출처](https://example.com/1) b https://example.com/2 c'
    expect(extractUrlsFromText(text)).toEqual(['https://example.com/1', 'https://example.com/2'])
    expect(extractUrlsFromText('링크 없음')).toEqual([])
  })
})
