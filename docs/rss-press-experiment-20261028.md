# 언론사 직접 RSS 실험 — Worker egress 실측 (2026-10-28)

> 근거: `docs/recent-trends-20261028.md` §1-3. Google News RSS가 Worker egress에서
> 503이었던 전례가 있어, 언론사 직접 RSS도 **VM이 아니라 Worker에서** 직접 fetch해
> 판정했다. 일회용 스크래치 Worker(`rss-probe-scratch-20261028`)로 실험하고 삭제했다.
> 운영 Worker·운영 D1·스테이징 Worker는 일절 건드리지 않았다.

## 결론 (한 줄)

**6개 피드 전부 통과.** YNA 3개·한경 2개·매경 1개 모두 Worker egress에서 200 +
`pubDate` 신선. 단, **한경·매경은 브라우저 UA 필수** (UA 없으면 403).
코드 적용 완료: `src/services/news-sources.ts`에 `press-rss` 소스 추가
(한국어 5개 피드 — 체인 순서 네이버 → press-rss → gnews-rss → Tavily → Exa).

## 실험 방법

- 스크래치 Worker를 Cloudflare API로 생성
  (`PUT /accounts/{id}/workers/scripts/rss-probe-scratch-20261028`,
  multipart `metadata` + `index.js`), workers.dev 서브도메인 활성화 후
  `https://rss-probe-scratch-20261028.myhub-app.workers.dev/` 호출.
- 프로브 Worker는 피드마다 상태 코드·응답 시간(ms)·바이트 수·`<item>` 수·
  앞 5개 `pubDate` 파싱 결과·최신 `pubDate`를 JSON으로 반환.
- 3회 측정: (1) 브라우저 UA, (2) UA 없음 (`?ua=0`), (3) 브라우저 UA 반복.
  추가로 기사 본문 fetch 검증용 프로브 1회 (피드별 최신 기사 1건씩,
  `article:published_time`·JSON-LD `datePublished` 유무 확인).
- 실험 후 스크래치 Worker 삭제 확인
  (`GET` → "This Worker does not exist on your account").

## 피드별 결과

측정 시각: 2026-10-28 12:56~12:59 KST (03:56~03:59 UTC). 판정 기준:
200 + `pubDate` 파싱 가능 + 최신 기사가 당일(어제~오늘 창 안)이면 통과.
503이면 즉시 탈락 (해당 피드 없음).

| 피드 | URL | UA 있음 (1회) | UA 있음 (반복) | UA 없음 | 최신 pubDate (KST) | 판정 |
|---|---|---|---|---|---|---|
| YNA 전체 | `https://www.yna.co.kr/rss/news.xml` | 200 · 1611ms · 120건 | 200 · 179ms · 120건 | 200 · 904ms · 120건 | 2026-10-28 12:38 | ✅ 통과 |
| YNA 경제 | `https://www.yna.co.kr/rss/economy.xml` | 200 · 215ms · 120건 | 200 · 179ms · 120건 | 200 · 180ms · 120건 | 2026-10-28 12:04 | ✅ 통과 |
| YNA 영문 | `https://en.yna.co.kr/RSS/news.xml` | 200 · 1452ms · 94건 | 200 · 896ms · 94건 | 200 · 1287ms · 94건 | 2026-10-28 12:47 | ✅ 통과 (미연동 — 아래 참조) |
| 한경 증권 | `https://www.hankyung.com/feed/finance` | 200 · 417ms · 50건 | 200 · 8ms · 50건 | **403** · 4ms | 2026-10-28 11:37 | ✅ 통과 (UA 필수) |
| 한경 경제 | `https://www.hankyung.com/feed/economy` | 200 · 209ms · 50건 | 200 · 191ms · 50건 | **403** · 1ms | 2026-10-28 11:52 | ✅ 통과 (UA 필수) |
| 매경 경제 | `https://www.mk.co.kr/rss/30100041/` | 200 · 628ms · 50건 | 200 · 723ms · 50건 | **403** · 4ms | 2026-10-28 11:18 | ✅ 통과 (UA 필수, URL 확인됨) |

- `pubDate` 파싱: 6개 피드 전부 앞 5개 모두 파싱 성공. 형식은 RFC 822
  (`Wed, 28 Oct 2026 12:38:06 +0900`)이며 매경만 `+09:00` 콜론 표기 —
  `Date.parse`가 둘 다 읽는다 (테스트로 고정).
- 응답 시간: 첫 호출 0.2~1.6초, 반복 8ms~0.9초 (캐시·웜업 편차). 전부
  레그 타임아웃 8초 안에 여유 있게 들어간다.
- UA 없음 결과: YNA 3개는 UA 없이도 200. 한경·매경은 UA 없이 즉시 403
  (1~4ms — 봇 게이트). Google News RSS 503 전례와 같은 패턴이라,
  코드의 RSS fetch는 전부 브라우저 UA로 통일했다.
- 매경 URL 재확인: `https://www.mk.co.kr/rss/30100041/`이 경제 피드임이
  확인됨 — 채널 제목 `매일경제 : 경제`, 아이템 카테고리 `경제`,
  링크 `https://www.mk.co.kr/news/economy/...` (2차 출처 URL이 맞았다).
- 한경 증권 피드 채널 제목 `한국경제 | 뉴스 | 증권`, 경제 피드도 동일 구조.

## 기사 본문 fetch 검증 (본문 요약·날짜 검증 패턴용)

피드별 최신 기사 1건을 Worker egress에서 브라우저 UA로 직접 fetch:

| 기사 | URL | 상태·시간 | `article:published_time` | JSON-LD `datePublished` |
|---|---|---|---|---|
| YNA 경제 | `https://www.yna.co.kr/view/AKR20261028066300002` | 200 · 911ms · 147,528B | 2026-10-28T12:00:10+09:00 | 동일 |
| 한경 증권 | `https://www.hankyung.com/article/202610280125i` | 200 · 244ms · 94,065B | 2026-10-28T11:33:10+09:00 | 동일 |
| 매경 경제 | `https://www.mk.co.kr/news/economy/12188202` | 200 · 924ms · 230,830B | 2026-10-28T10:52:05+09:00 | 동일 |

3사 모두 기사 페이지가 Worker egress에서 열리고 메타 날짜가 RSS `pubDate`와
일치한다. 그래서 기존 `verifyArticleDates` 패턴(기사 페이지 직접 fetch →
메타 날짜로 재검증, 실패 시 제외)을 press-rss 단계에도 그대로 적용했다.

## 코드 적용 내역

- `src/services/news-sources.ts`
  - `PRESS_RSS_FEEDS` (6개) + `PRESS_RSS_KO_FEEDS` (한국어 5개).
    YNA 영문은 실측 통과했으나 영문 피드라 한국어 체인·브리핑 범위 밖 —
    목록에는 남겨 후속 영문 브리핑에서 쓴다.
  - `fetchPressRssHeadlines(query, fetchFn, timeoutMs, feeds)`:
    5개 피드 병렬 fetch (`Promise.allSettled` — 한 피드 실패가 전체를
    죽이지 않음, 전부 실패 시에만 throw해 체인이 `ok:false`로 기록),
    피드 간 URL 중복 제거.
  - 피드는 검색이 아니라 최신 헤드라인 목록이라 질의 관련성 필터가 있다
    (`pressQueryTokens`): 주제 토큰이 있으면 제목에 토큰이 들어간 항목만
    남기고, 일반 질의("오늘 주요 뉴스" — 토큰이 남지 않음)에는 헤드라인
    전체를 쓴다. 필터가 없으면 주제 질의에 무관한 헤드라인이 목표 수(5)를
    채워 체인을 멈추게 한다.
  - 체인 순서: 네이버 → **press-rss** → gnews-rss → Tavily → Exa.
    `pubDate` 어제~오늘 하드 필터(`filterNewsWindow`)와 기사 날짜 직접
    검증(`verifyArticleDates`, strict)을 Exa와 동일하게 적용한다.
    자정 UTC 미상 취급은 Exa에만 적용 (발행사 직접 날짜라 press-rss에는 미적용).
  - `parseGoogleNewsRss`는 RSS 2.0 공용 파서라 `parseRssItems`로 이름을
    바로잡고 구 이름은 별칭으로 남겼다.
  - `src/services/news-briefing.ts`의 체인 순서 주석만 갱신 (동작 변경 없음 —
    브리핑은 `fetchNewsSources` 경유로 press-rss를 그대로 탄다).
- 테스트: `tests/unit/news-sources.test.ts`에 press RSS describe 9건 +
  체인 통합 2건 추가 (실제 피드 응답 발췌 fixture — YNA 경제·한경 증권·
  매경 경제 앞 3건, 2026-10-28 기록). 카나리아 3건 확인
  (UA 제거·토큰 필터 무력화·전부 실패 throw 제거 → 각 대응 테스트 실패 후 복원).
  `tests/runtime/news-chain.test.ts`는 press 단계 상태 단언 2건 추가.

## 저작권 경계

- 연합뉴스 피드 채널에 명시됨:
  **"저작권자(c) 연합뉴스, 무단 전재-재배포, AI 학습 및 활용 금지"**
  (실제 피드 `<copyright>`에서 확인). 한경·매경도 각사 저작권을 갖는다.
- 코드는 피드에서 **제목·링크·`pubDate`만** 읽어 검색 결과로 쓴다.
  기사 본문(`<description>` 포함)은 저장하지 않고, 외부 AI에 본문을
  통째로 전송하거나 재배포하지 않는다. 요약은 제목+링크+검증된 날짜만으로
  하고, 기사 페이지는 날짜 검증용으로만 fetch해 날짜 추출 후 버린다.
  이 경계는 `PRESS_RSS_FEEDS` 위 주석에도 남겼다.

## 남은 주의·다음 단계

- **피드 구조 변경 모니터링 대상**: RSS는 비공식·무계약 경로라 채널·
  아이템 구조가 바뀌면 파서가 조용히 빈 결과를 낼 수 있다. 체인
  `statuses`의 `press-rss fetched:0` 지속 여부를 tail 로그로 관찰할 것.
- **매경 기사 ID와 URL 날짜 가드**: 매경 링크가 `.../12188202` 같은
  8자리 순차 ID라, ID가 우연히 유효한 날짜 형태가 되면 `filterNewsWindow`의
  URL 날짜 가드가 오판할 수 있다. 현재 ID(`12188xxx` — 월 18로 무효)는
  안전하나, 장기적으로 ID 체계가 바뀌면 가드 재검토 필요.
- **한경·매경 UA 의존성**: UA 정책이 바뀌면 403으로 다시 막힐 수 있다.
  UA 문자열은 `RSS_BROWSER_HEADERS` 한 곳에서 관리한다.
- **YNA 영문 피드**: 통과했으나 미연동. 영문 브리핑·해외 뉴스 질의에서
  쓸 때 `PRESS_RSS_FEEDS`에서 `lang:'en'`으로 꺼내 쓰면 된다.
- **네이버 뉴스 API와 교차 검증**: press-rss는 브리핑 헤드라인 1차 경로이나,
  네이버(sort=date)·Exa와 교차 검증하는 기존 체인 구조는 유지한다.
  네이버 키 발급 경로는 NCP API HUB로 바뀐 별도 트랙(사용자 단계).
- 스크래치 Worker는 실험 종료 후 삭제 완료 (삭제 후 `GET`으로 부재 확인).
