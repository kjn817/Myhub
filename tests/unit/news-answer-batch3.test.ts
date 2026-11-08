/// <reference types="jest" />
/**
 * src/lib/news-answer.ts 성질 테스트 (3차 배치 — 잔여 분기).
 * 기존 news 스위트와 겹치지 않는 경계: 발행처 판정의 실패 형태, 개수 파싱의
 * 0/상한/한국어 수사, 제목 토큰 꼬리 제거가 동일 사안 판정을 바꾸는 사례,
 * 본문 컨텍스트의 선택적 줄, 시의성 고지의 중복 방지·기본 시각 인자.
 * 카나리아: newsChainTargetCount의 과수집분(NEWS_CHAIN_OVERFETCH=3)을
 * 0으로 바꾸면 목표 개수 단언이 실패한다 (실증 완료).
 */
import {
  publisherFromUrl,
  resolvePublisher,
  parseExplicitNewsCount,
  parseRequestedSentenceLimit,
  parseRequestedNewsCount,
  newsChainTargetCount,
  isSameStory,
  clusterNewsItems,
  formatPublishedKst,
  formatEnrichedNewsContext,
  buildNewsAnswerPrompt,
  limitNewsAnswerItems,
  findStaleNewsItems,
  withNewsTimelinessNotice,
  newsShortfallNotice,
  noReadableNewsText,
  NEWS_MAX_REQUEST,
  type EnrichedNewsItem,
} from '../../src/lib/news-answer'

describe('publisherFromUrl — 실패 형태와 서브도메인', () => {
  test('파싱 불가·빈 입력·호스트 없는 URL은 출처 미상', () => {
    expect(publisherFromUrl('not a url')).toBe('출처 미상')
    expect(publisherFromUrl('')).toBe('출처 미상')
    expect(publisherFromUrl(undefined as any)).toBe('출처 미상')
    expect(publisherFromUrl('about:blank')).toBe('출처 미상')
  })

  test('서브도메인은 접미 일치로 매체명을 찾고, 미등록 호스트는 www만 벗긴다', () => {
    expect(publisherFromUrl('https://news.yna.co.kr/article/1')).toBe('연합뉴스')
    expect(publisherFromUrl('https://www.mk.co.kr/news/1')).toBe('매일경제')
    expect(publisherFromUrl('https://www.example.com/x')).toBe('example.com')
    expect(publisherFromUrl('https://blog.example.org/x')).toBe('blog.example.org')
  })
})

describe('resolvePublisher — 명시 발행처 우선, 공백/비문자열은 URL 판정', () => {
  test('명시값은 trim해서 쓰고, 비어 있으면 URL에서 도출한다', () => {
    expect(resolvePublisher({ publisher: '  한겨레 ', url: 'https://www.yna.co.kr/1' })).toBe('한겨레')
    expect(resolvePublisher({ publisher: '   ', url: 'https://www.yna.co.kr/1' })).toBe('연합뉴스')
    expect(resolvePublisher({ publisher: 42, url: 'https://www.hani.co.kr/1' })).toBe('한겨레')
    expect(resolvePublisher({ url: 'https://www.kbs.co.kr/1' })).toBe('KBS')
  })
})

describe('개수 파싱 — 0은 무효, 상한 캡, 한국어 수사', () => {
  test('parseExplicitNewsCount 경계', () => {
    expect(parseExplicitNewsCount('0개 보여줘')).toBeNull()
    expect(parseExplicitNewsCount('99개 보여줘')).toBe(NEWS_MAX_REQUEST)
    expect(parseExplicitNewsCount('3개 보여줘')).toBe(3)
    expect(parseExplicitNewsCount('두 건 알려줘')).toBe(2)
    expect(parseExplicitNewsCount('열 개 정리해줘')).toBe(10)
    expect(parseExplicitNewsCount('하나를 보여줘')).toBe(1)
    expect(parseExplicitNewsCount('하나만 보여줘')).toBe(1)
    expect(parseExplicitNewsCount('뉴스 보여줘')).toBeNull()
    expect(parseExplicitNewsCount('')).toBeNull()
  })

  test('parseRequestedSentenceLimit 경계', () => {
    expect(parseRequestedSentenceLimit('0문장으로 답해줘')).toBeNull()
    expect(parseRequestedSentenceLimit('2문장으로 답해줘')).toBe(2)
    expect(parseRequestedSentenceLimit('세 문장으로 답해줘')).toBe(3)
    expect(parseRequestedSentenceLimit('99문장으로 답해줘')).toBe(NEWS_MAX_REQUEST)
    expect(parseRequestedSentenceLimit('그냥 답해줘')).toBeNull()
  })

  test('parseRequestedNewsCount 우선순위: 명시 개수 > 1문장 요청 > fallback', () => {
    expect(parseRequestedNewsCount('4개, 한 문장으로')).toBe(4)
    expect(parseRequestedNewsCount('한 문장으로 요약해줘')).toBe(1)
    expect(parseRequestedNewsCount('두 문장으로 요약해줘')).toBe(5)
    expect(parseRequestedNewsCount('요약해줘', 7)).toBe(7)
  })

  test('newsChainTargetCount는 과수집분을 더하되 상한을 지킨다', () => {
    expect(newsChainTargetCount(1)).toBe(4)
    expect(newsChainTargetCount(5)).toBe(8)
    expect(newsChainTargetCount(10)).toBe(NEWS_MAX_REQUEST)
    expect(newsChainTargetCount(0)).toBe(4)
  })
})

describe('isSameStory — 토큰 꼬리 제거와 포함률 경로', () => {
  test("금액 꼬리 '원'을 벗겨야 같아지는 제목 쌍은 같은 사안이다", () => {
    expect(isSameStory('삼성전자 100만원', '삼성전자 100만')).toBe(true)
  })

  test("서술 꼬리 '였다'와 조사 '에서'를 벗긴 제목 쌍도 같은 사안이다", () => {
    expect(isSameStory('한국팀 승리였다', '한국팀 승리')).toBe(true)
    expect(isSameStory('서울에서 회의', '서울 회의')).toBe(true)
  })

  test('짧은 제목이 긴 제목에 포함되면 포함률 경로로 같은 사안이다', () => {
    expect(
      isSameStory('김철수 발표했다', '김철수 발표했다 오늘 서울 날씨 회의 결과 보고 자료 공개'),
    ).toBe(true)
  })

  test('빈 제목·불용어만 있는 제목은 같은 사안이 아니다', () => {
    expect(isSameStory('', '')).toBe(false)
    expect(isSameStory('속보', '단독')).toBe(false)
    expect(isSameStory('날씨 예보', '주식 시장')).toBe(false)
  })

  test('clusterNewsItems는 같은 사안을 한 묶음으로, 다른 사안은 따로 묶는다', () => {
    const items = [
      { title: '삼성전자 100만원' },
      { title: '삼성전자 100만' },
      { title: '날씨 예보' },
    ]
    const clusters = clusterNewsItems(items)
    expect(clusters).toHaveLength(2)
    expect(clusters[0].members).toHaveLength(2)
    expect(clusters[1].members[0].title).toBe('날씨 예보')
  })
})

describe('formatPublishedKst', () => {
  test('유효한 ISO는 KST 표기로, 없거나 깨진 값은 undefined', () => {
    expect(formatPublishedKst('2026-11-08T01:05:00Z')).toBe('11월 8일 오전 10시 05분')
    expect(formatPublishedKst('2026-11-08T15:30:00Z')).toBe('11월 9일 오전 12시 30분')
    expect(formatPublishedKst(undefined)).toBeUndefined()
    expect(formatPublishedKst('날짜아님')).toBeUndefined()
  })
})

describe('formatEnrichedNewsContext — 선택적 줄 조립', () => {
  const base: EnrichedNewsItem = {
    title: '제목A', url: 'https://a.test/1', publisher: '연합뉴스', crossRefs: [],
  }
  test('제목 없음·발행 시각·하이라이트 폴백·교차 보도 유무가 줄에 반영된다', () => {
    const out = formatEnrichedNewsContext([
      { ...base, title: '', publishedKst: '11월 8일 오전 10시 05분', bodyText: '본문 내용' },
      { ...base, title: '제목B', url: 'https://b.test/2', highlights: ['발췌1', '발췌2'], crossRefs: [{ publisher: 'KBS' }, { publisher: 'MBC' }] },
      { ...base, title: '제목C', url: 'https://c.test/3', highlights: [] },
    ])
    expect(out).toContain('1. 제목: 제목 없음')
    expect(out).toContain('언론사: 연합뉴스 / 발행: 11월 8일 오전 10시 05분')
    expect(out).toContain('본문 발췌: 본문 내용')
    expect(out).toContain('같은 사안 보도: 없음')
    expect(out).toContain('기사 발췌(본문 직접 확인 실패 — 검색 스니펫): 발췌1 발췌2')
    expect(out).toContain('같은 사안 보도: KBS, MBC — 이 사안은 대표 기사 포함 3개 언론사가 보도했다')
    // 본문도 하이라이트도 없는 항목은 발췌 줄 자체가 없다
    const third = out.split('\n').filter((l) => l.includes('발췌'))
    expect(third).toHaveLength(2)
  })
})

describe('buildNewsAnswerPrompt — 문장 제한 지시와 오늘 날짜', () => {
  test('sentenceLimit가 있으면 지시문이 들어가고, 없으면 들어가지 않는다', () => {
    const withLimit = buildNewsAnswerPrompt({
      query: '오늘 뉴스', searchContext: '자료X', sentenceLimit: 2, today: new Date('2026-11-08T00:00:00Z'),
    })
    expect(withLimit).toContain('사용자가 2문장으로 답하라고 했다')
    expect(withLimit).toContain('자료X')
    expect(withLimit).toContain('[SEARCH: 오늘 뉴스]')
    const without = buildNewsAnswerPrompt({ query: '오늘 뉴스', searchContext: '자료X' })
    expect(without).not.toContain('문장으로 답하라고 했다')
  })
})

describe('limitNewsAnswerItems — 마커 보존과 절단 경계', () => {
  const body = '1. 첫째\n내용\n2. 둘째\n내용\n3. 셋째\n내용'
  test('항목이 상한 이하면 원문 그대로', () => {
    expect(limitNewsAnswerItems(body, 3)).toBe(body)
    expect(limitNewsAnswerItems(body, 5)).toBe(body)
  })
  test('상한을 넘으면 잘라내고, 빈 텍스트·maxItems<1은 원문 그대로', () => {
    expect(limitNewsAnswerItems(body, 2)).toBe('1. 첫째\n내용\n2. 둘째\n내용')
    expect(limitNewsAnswerItems('', 2)).toBe('')
    expect(limitNewsAnswerItems(body, 0)).toBe(body)
  })
  test('[MEMO_CREATE] 마커는 절단 뒤에도 꼬리로 보존된다', () => {
    const withMarker = body + '\n[MEMO_CREATE]메모 본문[/MEMO_CREATE]'
    const out = limitNewsAnswerItems(withMarker, 1)
    expect(out).toBe('1. 첫째\n내용\n[MEMO_CREATE]메모 본문[/MEMO_CREATE]')
  })
})

describe('시의성 판정 — findStaleNewsItems / withNewsTimelinessNotice', () => {
  const now = new Date('2026-11-08T03:00:00Z') // KST 11-08 12:00, 윈도우 11-07~11-08
  test('날짜 없음·파싱 불가·윈도우 밖은 stale, 윈도우 안은 fresh', () => {
    const items = [
      { publishedDate: '2026-11-08T01:00:00Z' },
      { publishedDate: '2026-11-05T01:00:00Z' },
      { publishedDate: '언제인지 모름' },
      {},
    ]
    const stale = findStaleNewsItems(items, now)
    expect(stale).toHaveLength(3)
    expect(stale).not.toContain(items[0])
  })
  test('now 기본 인자로도 동작한다', () => {
    expect(findStaleNewsItems([{}])).toHaveLength(1)
  })
  test('고지 부착: stale 없으면 원문, 이미 고지가 있으면 중복 부착 안 함', () => {
    const fresh = [{ publishedDate: new Date().toISOString() }]
    expect(withNewsTimelinessNotice('답변', fresh)).toBe('답변')
    expect(withNewsTimelinessNotice('', [{ }], now)).toBe('')
    expect(withNewsTimelinessNotice('답변', [], now)).toBe('답변')
    const once = withNewsTimelinessNotice('답변', [{}], now)
    expect(once).toContain('시의성 주의')
    expect(withNewsTimelinessNotice(once, [{}], now)).toBe(once)
  })
  test('부족·무자료 안내 문구는 요청/발견 건수를 반영한다', () => {
    expect(newsShortfallNotice(5, 2)).toContain('5개를 요청하셨는데')
    expect(newsShortfallNotice(5, 2)).toContain('2개였어요')
    expect(noReadableNewsText()).toContain('제목만으로 요약하지 않았어요')
  })
})
