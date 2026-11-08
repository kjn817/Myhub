# Exa 뉴스 검색 조사 — "오늘 뉴스"를 신뢰성 있게 가져오는 방법

작성일: 2026-10-26. 조사 방식: Exa 공식 문서 실측 + 깃허브 공개 코드 직접 확인 + 커뮤니티·대안 비교 (3개 조사 갈래 종합). Exa 키가 없어 실제 API 호출 테스트는 하지 않았고, 문서·공개 코드·제3자 실측 중심으로 정리했다. 코드 변경 없음.

## 0. 핵심 결론 (한눈에)

1. **지금 MyHub가 보내는 Exa 파라미터 조합 자체는 문서상 올바르다.** `category: 'news'` + `startPublishedDate: 'YYYY-MM-DD'`는 공식 News 가이드가 "publication window is a hard requirement"일 때 쓰라고 명시한 방식이고, Quickstart도 "Filters are hard constraints"라고 못 박았다. 즉 **파라미터 선택이 틀린 게 아니라** (a) 실제 전송된 요청이 의도와 다르거나, (b) Exa가 매긴 `publishedDate` 메타데이터 자체가 틀렸거나, (c) 날짜 없는 페이지의 미문서 동작일 가능성이 크다.
2. **Exa는 의미 랭킹 엔진이지 실시간 뉴스 인덱스가 아니다.** 관련성 순위가 기본값이고 날짜는 2차 신호다. 제3자 실측에서 Exa 결과에 발행일이 있는 비율은 46%에 불과했다 (Tavily 88%). "오늘 뉴스 완벽" 기준을 Exa 단독으로 만족하기는 어렵다.
3. **유일하게 보장되는 방법은 클라이언트 측 하드 필터다.** 응답의 `publishedDate`를 코드에서 직접 검사해 창 밖·날짜 없음 결과를 버리고, 부족하면 재검색·폴백·실패 선언을 하는 것. 조사한 어떤 오픈소스 프로젝트도 이걸 안 하고 있었다 — 그래서 다들 같은 함정에 빠져 있다.
4. **한국 뉴스는 네이버 뉴스 검색 API(`sort=date`)가 1순위 대안이다.** 무료·무카드, 최신순 정렬이 구조적으로 보장된다. 글로벌 뉴스는 Tavily `topic:'news'` + `time_range:'day'` + `search_depth:'advanced'`가 가장 명시적이다.
5. **진단 1순위는 `warnings[]`와 `publishedDate` 로그다.** Exa 3.0부터 응답에 무시된 필드를 알리는 `warnings[]` 배열이 있다. 2025-01 기사가 뜬 호출의 `warnings`와 각 결과의 `publishedDate`를 로그로 확인해야 원인이 확정된다.

---

## 1. Exa 공식 API 실측

기준 문서: https://exa.ai/docs/search/quickstart, https://exa.ai/docs/search/best-practices, https://exa.ai/docs/reference/search, https://exa.ai/docs/changelog, https://exa.ai/docs/search/data/news

### 1.1 `/search` 파라미터 전수

| 파라미터 | 형식 / 기본값 | 동작·주의점 |
|---|---|---|
| `query` | string, **유일한 필수** | 자연어 질의. `"news"` 같은 한 단어보다 `"Latest news on EU battery policy"`처럼 주제+출처 종류+시점을 담은 문장이 권장됨. |
| `type` | string, 기본값 `auto` | **현재 값: `auto`(~1s), `lite`(~450ms), `deep-lite`(~4s), `deep`(4–15s).** 구 `neural`/`keyword`는 현재 Quickstart 타입 표에 **없다**. 레거시 `fast`/`instant`/`deep-reasoning`은 아직 동작하나 신규 사용 금지. |
| `category` | enum, 기본값 없음 | **현재 값 6개: `company`, `publication`, `news`, `personal site`, `financial report`, `people`.** 구 `research paper`→`publication`, `linkedin profile`→`people` 교체, `pdf`/`github`/`tweet`은 폐기 중. **`company`·`people`은 `startPublishedDate`/`endPublishedDate` 미지원 — 보내면 400 에러. `people`은 `excludeDomains`도 미지원.** `news`는 날짜 필터 지원. Snapshot과 병용 불가. |
| `startPublishedDate` / `endPublishedDate` | string, 날짜만 **`YYYY-MM-DD`** (공식 SDK 예제: `"2024-01-01"`) | "해당 날짜 이후/이전에 **발행된** 링크만 포함". 비교 기준은 Exa가 추출한 `publishedDate` 메타데이터이지 기사 본문 날짜가 아님. **날짜 하한이 무시되는 조건에 대한 공식 언급 없음.** |
| `numResults` | integer, 기본값 **10**, 최대 **100** | 관련 결과 적으면 더 적게 반환될 수 있음. `lite`는 10개까지 기본 요금, 초과분 $1/1,000 results. |
| `includeDomains` / `excludeDomains` | string[] | 도메인·경로 접두사(`anthropic.com/news`)·와일드카드(`*.substack.com`) 지원. **각 최대 1,200개**. 쿼리의 `site:`·인용구가 매칭 실패하면 `RESTRICTIONS_RELAXED` notice와 함께 해당 연산자를 빼고 검색함(단, body 필터는 유지됨). |
| `includeText` / `excludeText` | **폐기(deprecated)** | "쿼리 본문에 단어를 넣으라"는 게 현재 지침. 사용 금지. |
| `useAutoprompt` | **제거됨** | Best Practices 명시: "`useAutoprompt` → Nothing. Exa interprets the query directly; remove the field." 한국어 질의 포함 어떤 질의에서도 더 이상 동작하지 않음. 보내면 `IGNORED_FIELD` 경고 대상. |
| `livecrawl` | **폐기됨 → `contents.maxAgeHours`로 대체** | 구 매핑: `always`→`maxAgeHours: 0`, `never`→`-1`, `fallback`→생략, `preferred`→낮은 값(예: `1`). **둘을 함께 보내면 안 됨.** `livecrawlTimeout` 기본값 10,000ms. |
| `contents.maxAgeHours` | number | 생략=캐시 있으면 사용·필요 시 fetch / 양의 정수=그 시간보다 새로우면 캐시 / `0`=항상 새로 fetch / `-1`=캐시만. `lite`에서는 **어떤 값이든 400** (`-1` 포함). **중요: "추출할 페이지 본문의 캐시 신선도"이지 발행일 필터가 아님 — 문서에 "It does not filter results by publication date"로 명시. 날짜 필터 대신 쓰면 안 됨.** |
| `contents.highlights` | `true` 또는 `{query, maxCharacters, dynamic}` | 쿼리 관련 발췌. 기본은 Exa가 결과별 relevance에 맞춰 분량 자동 조절. **Dynamic Highlights**(3.0 GA): `highlights: {dynamic: true}` — 전체 결과 집합에 토큰 예산 배분. |
| `contents.text` | `true` 또는 `{maxCharacters, includeHtmlTags, verbosity, includeSections, excludeSections}` | 클린 마크다운 본문. `verbosity`: `compact`(기본)/`standard`/`full`. |
| `contents.summary` | `true` 또는 `{query, schema}` | 페이지별 LLM 요약(Gemini Flash로 생성). **결과별 추가 과금 $1/1,000건.** `lite` 미지원(400). |
| `contents.snapshotAsOf` | ISO datetime 또는 날짜 | 과거 시점 고정. **최신 뉴스용이 아니라 과거 재현용**이며, `category` 미지원, `livecrawl`/`maxAgeHours`/`subpages` 병용 불가, 조회 범위 5개월 롤링, 무료 플랜 미지원(403). |
| `userLocation` | `"US"` 같은 ISO 3166-1 alpha-2 2자리 코드, 또는 `{country, latitude, longitude}` 객체 | 지역 편향. **한국 뉴스는 `"KR"`을 보내는 것이 문서상 권장 방향.** 좌표만으로는 국가가 설정되지 않으므로 `country`를 함께 보낼 것. |
| `outputSchema` | `{type: 'text' \| 'object', ...}` | 검색 결과 합성. `object`는 최대 10개 프로퍼티·2단계 중첩. `lite` 미지원. |
| `objective` / `systemPrompt` | string | 에이전트 작업 목표 전달 / 합성 출력 지침(출처 선호, 중복 제거 등). |
| `startCrawlDate` / `endCrawlDate` | **폐기·무시됨** | **2026-04-15부터 조용히 무시(200 반환, 필터 미적용), Changelog에만 기록.** `warnings[]`에 `IGNORED_FIELD`로 표시됨. 대체재는 `startPublishedDate`/`endPublishedDate`인데 의미가 다름(크롤일≠발행일). |
| `moderation`, `compliance: 'hipaa'`, `userIdentifier` | — | `userIdentifier`는 텔레메트리 전용으로 결과에 영향 없음. |

응답 형태: `results[]`는 relevance 순 정렬, 각 항목에 `title`, `url`, **`publishedDate`(ISO datetime, 예 `2023-11-07T05:31:56Z`)**, `author`, `id`, `image`, `favicon` + 요청한 `contents`. 그 외 `requestId`, `costDollars`, `searchTime`, **`warnings[]`(IGNORED_FIELD)**, **`notices[]`(RESTRICTIONS_RELAXED)** — 비어 있으면 배열 생략.

요금(공식 Changelog·3.0 블로그): `lite` $4/1,000 req, `auto` $7/1,000 req, `deep` $12/1,000 req, `/answer` $5/1,000 req, Monitors $15/1,000 req. Contents(text/highlights)는 검색 결과 10개까지 무료, 이후 $1/1,000 pages. 무료 티어 월 $10 크레딧.

### 1.2 날짜 하한이 무시되는 조건 — 문서상 결론

- **공식 문서에 "날짜 필터가 약하게 적용되는 조건"은 명시돼 있지 않다.** Quickstart는 필터를 "hard constraints"라 하고, News 가이드는 "Combine a natural-language query with date filters when the publication window is a hard requirement"라고 한다.
- **유일하게 문서화된 '조용한 무시' 사례는 `startCrawlDate`/`endCrawlDate`다** (2026-04-15부터 무시, `IGNORED_FIELD` 경고 발생). `startPublishedDate`는 그 대상이 아니다.
- **미문서 영역 (공식 확인 불가 — 가설로만 제시):**
  - `publishedDate`가 없는 페이지(위키피디아 등)의 취급에 대한 공식 언급을 찾지 못했다. 서드파티 타입 정의는 `published_date: str | None`("if available")으로 표기한다. 즉 날짜 없는 결과가 존재할 수 있고, 필터가 이를 어떻게 처리하는지는 문서에 없다.
  - Exa가 추출한 `publishedDate`가 기사 화면 날짜와 다를 수 있다(사이트맵·섹션 페이지, 재발행·업데이트 기사, 메타데이터 오류). 문서 어디에도 `publishedDate` 정확도를 보장한다는 말은 없다. **2025-01 기사가 최상위에 뜬 현상의 가장 유력한 문서 외 원인**이다.
  - `type: 'neural'`일 때 날짜 필터 강도가 달라진다는 언급 없음. (참고로 `neural`/`keyword` 자체가 현재 타입 표에서 사라졌다.)

### 1.3 한국어 질의 특이사항

- **한국어 전용 언급은 공식 문서·블로그에서 찾지 못했다.**
- 관련 일반 규칙: Changelog "Added Language Filtering" — **"Exa now detects your query language and returns results only in that language. Enabled by default for all users, with no setup required."** 즉 한국어 질의면 한국어 결과만 반환되는 것이 기본 동작이다. 끌 수 있는 옵션은 문서에 없다.
- `useAutoprompt`는 한국어 여부와 무관하게 폐기됐다. 한국어 질의의 재작성·번역 동작에 대한 공식 설명은 없다.
- 실무적 함의: 질의가 한국어면 결과 언어도 한국어로 제한되므로, "오늘 한국 주요 뉴스" 같은 질의에 `userLocation: 'KR'`을 더하는 것이 문서상 유일한 지역 강화 수단이다.

### 1.4 뉴스 전용 엔드포인트 / 최신 뉴스용 별도 기능

- **뉴스 전용 엔드포인트는 없다.** 뉴스는 `/search` + `category: 'news'` + 날짜 필터 조합이 공식 권장 경로다. News 가이드: "New articles become searchable within minutes of publication."
- 관련 별도 기능:
  - **`/answer`** (`POST /answer`): 검색 후 LLM이 인용 포함 답변 생성. 파라미터는 `query`, `text`, `model`(`exa`/`exa-pro`/`exa-research`/`exa-fast`), `systemPrompt`, `userLocation`, `outputSchema`, `userIdentifier`, `stream`. **날짜·카테고리 파라미터가 없어서 "오늘 뉴스만"으로 직접 제한할 수 없다.**
  - **Exa Agent** (`POST /agent/runs`): 다단계 리서치·리스트 작성·보강. `/research` 엔드포인트는 폐지됐고 `/search` `type: 'deep'` 계열 또는 Agent로 이관됐다.
  - **Monitors**: 주제별 검색을 스케줄(최소 1시간 간격, `1h`/`6h`/`1d`/`7d`)로 반복 실행해 웹훅으로 **신규 결과만** 중복 제거 후 전송. $15/1,000 req. **중요: Monitor의 search는 `query`, `numResults`, `includeDomains`/`excludeDomains`, `contents`만 받는다 — 날짜 필터를 직접 못 넣고, Exa가 실행마다 시간 필터링을 내부에서 한다.** "움직이는 날짜 범위를 직접 넣지 말라"고 명시돼 있다. 아침 브리핑 같은 정기 뉴스 수집에는 이쪽이 문서상 정석이다.
  - **Exa Snapshot**: `contents.snapshotAsOf`로 과거 시점 고정. **최신 뉴스용이 아니라 과거 재현용**이며, `category` 미지원, `livecrawl`/`maxAgeHours`/`subpages` 병용 불가, 조회 범위 5개월 롤링, 무료 플랜 미지원(403).

---

## 2. 깃허브 실전 패턴

조사 방법: `browser.search`로 GitHub 프로젝트·공식 문서를 검색하고, `browser.open`으로 실제 코드 파일을 직접 읽음. **코드 직접 확인 4개 프로젝트** + Exa 공식 문서/체인지로그 + 브리핑 특화 프로젝트 3개(Exa 미사용) 확인.

### 2.1 프로젝트별 파라미터 패턴 표

| # | 프로젝트 | 용도 | query 구성 | type | category | startPublishedDate | numResults | contents | livecrawl / freshness | 도메인 제한 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **sailorworks/video-content-agent** `src/agents/research.ts` | 주제별 트렌드 뉴스 수집 | 토픽 문자열 그대로 (수정 금지 지시) | `neural` | `news` | **30일 전** (동적 계산, `YYYY-MM-DD`) | 5 | — (MCP 경유, 별도 지정 없음) | 없음 | 없음 |
| 2 | **nicobailon/pi-web-access** `exa.ts` (★1,688, MIT) | 범용 웹검색 확장 | 사용자 질의 그대로 | `auto` | 옵션 (`news` 등) | **recencyFilter → 동적 변환**: `day=1일, week=7일, month=30일, year=365일` (ISO datetime) | 기본 5, 최대 20 | highlights 우선, 없으면 text 1000자 | 없음 (검색 단계) | `domainFilter` (+`-` 접두사로 제외) |
| 3 | **oritwoen/websxa** `src/providers/exa.ts` | 멀티 프로바이더 검색 래퍼 | 그대로 전달 | `auto` | 그대로 전달 | 그대로 전달 | `maxResults` 매핑 (기본 10) | `text` + `highlights: true` (기본) | `/contents`에만 `maxAgeHours: 0` (noCache 시) + `livecrawlTimeout` 최대 90초 | include/exclude 그대로 전달 |
| 4 | **agno-agi/agno** `ExaTools` + 쿡북 **media_trend_analysis_agent.py** | 미디어 트렌드 분석 에이전트 | 키워드 기반 검색 지시 | **`keyword`** | (툴 기본값으로 전달 가능) | **30일 전** (`calculate_start_date(30)`) | 기본 5 | `text: true`, 1000자 제한 | `livecrawl: "always"` (툴 기본값 — 단, 현재 버전은 실제 호출에 전달 안 함이 문서에 명시됨) | 예시: `include_domains=["cnbc.com", "reuters.com", "bloomberg.com"]`, `category="news"` |

코드 발췌 (핵심 부분):

**① video-content-agent** — `src/agents/research.ts:168-197`
```ts
const dateStr = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  .toISOString().split("T")[0];
// 에이전트 지시문에 파라미터를 고정:
//   - query: "${topic}" (DO NOT change this - use this exact string)
//   - numResults: 5
//   - type: "neural"
//   - category: "news"
//   - startPublishedDate: "${dateStr}"
```

**② pi-web-access** — `exa.ts:194-266`
```ts
function recencyToStartDate(filter: string): string {
  const offsets = { day: 1, week: 7, month: 30, year: 365 };
  return new Date(now.getTime() - days * 86400000).toISOString();
}
function exaSearchArgs(query, options) {
  return { query, type: "auto", numResults: options.numResults ?? 5,
    ...mapDomainFilter(options.domainFilter),
    ...(options.category ? { category } : {}),
    ...(startDate ? { startPublishedDate: startDate } : {}) };
}
```

**③ websxa** — `src/providers/exa.ts:169-197`: `{ query, type: "auto", numResults, category, includeDomains, excludeDomains, startPublishedDate, endPublishedDate, contents: { text, highlights: true, summary? } }`를 `/search`에 그대로 POST.

**④ Agno 쿡북 미디어 트렌드 에이전트** — `cookbook/examples/agents/media_trend_analysis_agent.py` (원본 경로는 404로 직접 열람 실패, 미러 문서에서 코드 확인):
```python
def calculate_start_date(days: int) -> str:
    return (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
ExaTools(start_published_date=calculate_start_date(30), type="keyword")
# 지시: "if got sources less then 2, only then scrape them using firecrawl tool"
```
`ExaTools` 본체 (`libs/agno/agno/tools/exa.py:297-330`)는 `search_and_contents`에 `start_published_date`, `end_published_date`, `category`, `include_domains`, `exclude_domains`를 그대로 전달하고, 결과의 `published_date`를 JSON에 포함시켜 모델에 넘김.

### 2.2 신선도 보장 방법 — 조사 결과

조사한 **어느 프로젝트도 질의 문자열에 날짜를 넣지 않음** ("news today 2026-10-26" 같은 패턴 사용처 없음). 공통 패턴은 전적으로 파라미터 의존:

| 방법 | 사용처 |
|---|---|
| `startPublishedDate`를 **오늘 기준 동적 계산** (1/7/30/365일) | 4개 전부. 고정 날짜 문자열을 쓰는 곳은 없음 |
| `category: "news"` | ①②④ |
| `type: "keyword"` (뉴스용) vs `"neural"` vs `"auto"` | ④는 keyword, ①은 neural, ②③은 auto — 의견이 갈림 |
| `livecrawl` | ④만 기본값 `"always"`를 선언하나 실제 전달 여부는 버전마다 다름. **주의: Exa 공식 체인지로그에 따르면 `livecrawl`은 deprecated — 신규 통합은 `contents.maxAgeHours` 사용** (`0`=항상 새로 크롤, `24`=24시간보다 오래되면 재크롤). 단, 공식 문서 명시: "`maxAgeHours`는 콘텐츠 신선도를 제어할 뿐, **발행일 필터가 아니다**" |
| 도메인 제한 | ④만 (CNBC/Reuters/Bloomberg). 나머지는 미사용 |
| **결과 수신 후 날짜 재필터링** | **조사한 4개 프로젝트 모두 없음.** `publishedDate`를 표시·전달만 할 뿐, 오래된 결과를 버리는 코드는 어디에도 없음 |

### 2.3 실패 시 폴백

- **pi-web-access**: 가장 체계적. 검색 폴백 체인 — SearXNG → OpenAI(구독) → **Exa** → Brave → Parallel → TinyFish → Search1API → Searchinfinity → Querit → **Tavily** → Firecrawl → Jina → SERPdive → Kagi → Bocha → Ollama → Perplexity → Gemini API/Web. Exa 실패 시 다음 프로바이더로 자동 이동.
- **Agno 미디어 트렌드 에이전트**: Exa 결과가 **2개 미만일 때만 Firecrawl로 스크랩** — 소스 부족 시 보강이지, 날짜 오래됨에 대한 폴백은 아님.
- **video-content-agent / websxa**: Exa 실패 시 폴백 없음 (결과 없음 → `"No trends found."` 또는 에러 전파).
- **Exa 미사용 브리핑 프로젝트** (참고): `tballochi`의 아침 이메일 브리핑은 **Tavily**를 쓰고, `duanyytop/agents-radar`와 GitHub Digest 모닝 브리핑은 **RSS/API 직접 수집**(HN·GitHub·ArXiv 등) — 즉 데일리 브리핑 특화 오픈소스들은 Exa보다 **RSS/전용 API를 선호**하는 경향이 있음. Exa 기반 데일리 뉴스 브리핑 전용 프로젝트는 이번 조사에서 찾지 못함.

### 2.4 MyHub 증상에 대한 깃허브 갈래의 핵심 발견

**① `startPublishedDate`는 아직 유효한 파라미터 — `startCrawlDate`는 아님**
Exa 공식 체인지로그(https://exa.ai/docs/changelog) 확인:
- **`startCrawlDate` / `endCrawlDate`: 2026-04-15부터 조용히 무시됨** — 200을 반환하면서 필터 미적용. 문서 스키마에는 여전히 남아 있어 코드 리뷰로는 안 잡힘.
- **`startPublishedDate` / `endPublishedDate`는 여전히 동작**한다고 같은 출처들이 명시 ("published date as Exa understands it"라는 단서 포함).
- **Exa 3.0 (2026-10-19)부터 `/search` 응답에 `warnings` 배열 추가**: 효과 없는 필드(예: `startCrawlDate`)를 플래그하고 대안을 알려줌. `exa-py`/`exa-js` 2.26.0부터 경고 로깅. `type: "lite"`는 미지원 파라미터에 400을 반환해 조용한 실패를 막음.

→ MyHub가 `startPublishedDate`를 보내는데 2025-01 기사가 나온다면, **파라미터 자체의 폐기가 원인은 아님**. 유력한 가설은 다음 중 하나:
  - **(a) [SEARCH:] 경로에서 날짜 파라미터가 실제로 안 넘어감** (기존 가설과 일치 — 마커에 주제만 들어감). 코드상 요청 본문 검증이 최우선.
  - **(b) Exa가 추출한 `publishedDate` 기준**: 날짜를 파싱할 수 없는 페이지(예: **연합뉴스 사이트맵** — MyHub 증상에 그대로 등장)는 필터를 통과할 수 있음. 공식 문서에 미확인 날짜 페이지의 동작은 명시돼 있지 않아 **가설** 단계이나, 증상(사이트맵 + 2025-01 기사)과 정합함. 검증법: 응답의 각 결과 `publishedDate` 값을 로그로 확인 — 2025-01 날짜가 찍혀 있으면 필터 자체가 안 먹힌 것이고, `null`/없으면 미확인 날짜 통과 가설이 유력.
  - **(c) 30일 창이 너무 넓음**: "오늘 뉴스"에는 30일이 과도. 조사 프로젝트들도 30일을 쓰지만 그건 "트렌드" 용도지 "오늘" 용도가 아님.

**② 아무도 안 하는 방어 — 결과 수신 후 날짜 재필터링**
조사한 4개 프로젝트 모두 Exa의 날짜 필터를 신뢰하고 후처리를 안 함. MyHub 증상 재발 방지에는 **클라이언트 측 재필터링이 사실상 유일하게 확실한 방어**:
- `result.publishedDate`가 창(예: 7일) 밖이면 버리고, `publishedDate`가 없으면(`null`) **버리거나 별도 표시** (사이트맵류 차단).
- 필터 후 남는 결과가 부족하면(예: <3건) 창을 넓혀 재검색하거나 Tavily/RSS로 폴백 (pi-web-access식 체인 참고).

---

## 3. 커뮤니티 평가 — "오래된 결과가 나온다"는 불만, 있는가?

### 3.1 직접적인 불만 보고는 적지만, 구조적 원인은 확인됨

HN/Reddit에서 "Exa가 오래된 결과를 반환한다"는 바이럴 불만 스레드는 이번 조사에서 찾지 못했다(`site:reddit.com` / `site:news.ycombinator.com` 검색 무결과). 대신 다음의 **검증 가능한 구조적 사실**들이 나왔다.

**① Exa는 시맨틱(유사도) 인덱스이지, 실시간 Google 인덱스가 아니다.**
- 비교 리뷰의 핵심 결론: "Exa는 semantic-first discovery, neural ranking이 신선도보다 중요할 때" 쓰는 도구이며, "freshness matters less than topical similarity"인 경우에 강하다. 즉 **관련성 순위가 기본값이고, 날짜는 2차 신호**이다.
- 출처: https://www.apipick.com/blog/tavily-exa-serper-vs-apipick

**② Exa 공식 문서의 함정 — `maxAgeHours`는 날짜 필터가 아니다.**
- Exa 공식 문서: "`contents.maxAgeHours` controls how fresh the **content extracted** from each result must be. **It does not filter results by publication date.**"
- 공식 Best Practices 표: "Newer publications → Put the time window in the query or use publication-date filters | **Avoid `maxAgeHours`**" / "Fresh content from pages that change → `contents.maxAgeHours` | Avoid publication-date filters"
- 즉 **콘텐츠 신선도(캐시 재생성)와 결과 날짜 필터는 별개 축**이며, 둘을 혼동하면 "필터를 걸었는데 오래된 기사가 나온다"는 현상이 그대로 발생한다. MyHub가 겪은 현상과 정확히 겹치는 오해 지점이다.
- 출처: https://exa.ai/docs/search/quickstart, https://exa.ai/docs/search/best-practices

**③ Exa가 날짜 필터를 조용히 무시한 전례가 있다 (2026-04-15).**
- dev.to 보고(2026-05-02): Exa가 2026-04-15부터 `startCrawlDate`/`endCrawlDate`를 **200을 반환하면서 조용히 무시**하기 시작했고, 변경 공지는 changelog에만 있었다. SDK 검증도 통과하고 응답도 정상이라 테스트가 못 잡는 "silent degradation" 사례로 소개됨.
- 같은 글: `startPublishedDate`/`endPublishedDate`는 "still work but mean something different — **published date as Exa understands it, not crawl date**". 즉 발행일 필터는 동작하지만, **Exa가 인식한 발행일** 기준이며, 사이트맵·인덱스 페이지·재게시 페이지의 날짜 메타데이터가 틀리면 필터도 틀린다. 연합뉴스 사이트맵(2025-01-18)이 최상위에 뜬 MyHub 사례와 부합하는 메커니즘이다.
- 출처: https://dev.to/flarecanary/exa-just-removed-research-and-started-silently-ignoring-two-date-filters-your-agent-is-probably-1p51

**④ Exa 자기 주장 vs 제3자 실측이 갈린다.**
- Exa 자사 블로그(합성 벤치마크 1,000 쿼리): 리랭커 적용 시 Freshness nDCG@10이 0.156(무랭크) → 0.738(Auto)/0.797(Fast)로 "최고"라고 주장. 단, **자사 합성 쿼리·자사 측정**이다.
- 출처: https://exa.ai/blog/sota-reranking
- 제3자 실측(GoLogin, 2026-10, 10개 쿼리·50개 결과): 결과에 **발행일이 있는 비율이 Tavily 88% vs Exa 46%**에 불과했고, "Exa의 freshest median 0일"은 **발행일이 아니라 크롤 타임스탬프가 찍힌 경우가 많아 주의가 필요**하다고 명시. 같은 리뷰에서 Tavily basic은 최신 결과가 중앙값 10일 전, advanced는 4일 전이었다.
- 출처: https://gologin.com/blog/tavily-review/

**⑤ 속보 실측 — SerpApi의 Grok 4.7 테스트 (벤더 편향 주의).**
- SerpApi 자사 블로그: xAI 발표 45분 후 쿼리에서 SerpApi(Google SERP)는 발표를 1위로, **Exa도 발표와 Vercel 변경로그를 1·2위로 올렸으나 나머지는 발표 전 추측 기사로 채웠고, Tavily는 10개 전부 발표 전 기사**였다고 보고. SerpApi가 쓴 글이므로 편향이 있으나, "발표 직후" 구간에서 **Google SERP 계열이 가장 빠르고, Tavily basic이 가장 느리다**는 방향성은 GoLogin 결과와 일치한다.
- 출처: https://serpapi.com/blog/markdown-search-results-serpapi-vs-exa-tavily-firecrawl/

### 3.2 알려진 우회책 (커뮤니티·공식 문서 종합)

| 우회책 | 근거 |
|---|---|
| 날짜를 **쿼리 문장 안에** 넣기 ("2026년 10월 26일 오늘 한국 뉴스") + `startPublishedDate`를 **어제~오늘 수준으로 좁히기** (30일은 너무 넓음) | Exa Best Practices: "Put the time window in the query" |
| `numResults`를 늘리고 **클라이언트에서 `publishedDate`로 직접 하드 필터** (오래된 것은 버리기) — 유일하게 보장되는 방법 | 어떤 제공자도 날짜 준수를 보장하지 않음 (apipick: "none of them solve the upstream problem of a stale source") |
| `category:'news'` + `includeDomains`로 매체 제한은 보조 수단일 뿐, 날짜 메타데이터 오류는 못 고침 | Exa Best Practices: "A hard domain allowlist"는 지양, 쿼리 표현·`systemPrompt` 권장 |
| `contents.maxAgeHours: 0`(항상 라이브 크롤)은 **본문 신선도**용이지 결과 날짜 필터가 아님 — 혼동 금지 | Exa 공식 문서 (상기) |
| 응답 필드 형태 모니터링 (날짜 필터 파라미터가 무시되는지 탐지용 일일 프로브) | dev.to 글의 권고: "HTTP 200 isn't enough. The shape matters." |

---

## 4. 한국 뉴스 특수성

### 4.1 Exa의 한국어 커버리지에 대한 직접 보고는 찾지 못함

Exa의 한국어 뉴스 커버리지·한국어 질의 동작·연합뉴스 도메인 제한 효과에 대한 **커뮤니티 보고를 이번 조사에서 찾지 못했다.** 이는 "문제가 없다"는 뜻이 아니라 **검증된 정보가 없다**는 뜻이며, 실측이 필요하다. 다만 구조적으로 다음은 확실하다.

- Exa는 자사 크롤러 기반 인덱스라, **네이버 뉴스(검색 포털 내부)나 한국 매체의 JS 렌더링·페이월·robots 정책에 따라 커버리지가 들쭉날쭉**할 수 있다. Google SERP 계열(Serper/SerpApi)은 Google이 이미 색인한 결과를 그대로 가져오므로 한국어 뉴스 커버리지가 Google 수준으로 따라간다.
- `includeDomains`로 `yna.co.kr` 등을 지정하면 **출처는 좁혀지지만 날짜 메타데이터 문제는 해결되지 않는다.** 실제로 MyHub 사례가 그 증거이다 — 연합뉴스 사이트맵이 최상위에 뜬 것은 도메인 문제가 아니라 날짜/페이지 종류 문제이다.

### 4.2 한국 뉴스 전용 대안 — 네이버 뉴스 검색 API (가장 유력)

- **네이버 Developers 검색 API(뉴스)**: 무료, 카드 불필요(공식 무료 API). 키워드 검색에 `sort=date`(최신순 정렬) 파라미터가 있어 **"오늘 뉴스" 요구에 구조적으로 가장 잘 맞는다.** 네이버 뉴스 인덱스라 한국 매체 커버리지가 사실상 최상이다. 단점은 본문이 아니라 **제목·링크·요약(description)만** 반환하므로, 본문 요약이 필요하면 기사 URL을 직접 fetch해야 한다.
- 한도: 2차 출처(korean-news-mcp) 기준 **일 25,000회 무료**. 공식 문서에서 직접 확인하지 못했으므로 **가입 시 공식 한도 재확인 필요**하다.
- 출처: https://socket.dev/pypi/package/korean-news-mcp/overview/0.1.0, https://github.heygears.com/isnow890/naver-search-mcp/blob/main/README.md

### 4.3 무료 RSS 경로 — Google News 한국판 RSS

- **Google News RSS는 비공식이지만 무료·무제한·키 불필요**로 널리 쓰인다. `gnews` 라이브러리(PyPI) 기준 Google News는 **141개국 이상·41개 언어**를 커버하며, 한국판(`hl=ko&gl=KR&ceid=KR:ko`)으로 오늘 헤드라인을 바로 가져올 수 있다. 단, 공식 API가 아니므로 피드 구조 변경 리스크가 있고, 반환 항목 수가 제한적이며 본문은 없다.
- 출처: https://pypi.org/project/gnews/0.2.0/, https://ujeebu.com/blog/how-to-scrape-google-news-results-with-a-serp-api-python-tutorial
- 참고: 연합뉴스 등 개별 매체 RSS도 존재하나, 매체별 파싱 유지보수가 늘어나므로 **네이버 API + Google News RSS 조합이 현실적**이다.

### 4.4 기타 뉴스 전용 API — 무료 티어는 있으나 "오늘 뉴스"에는 부적합

- **GNews**: 무료 100req/일, 카드 불필요. 단 **무료 티어는 12시간 지연**, 전문(全文) 없음, 비상업용. "오늘 아침 뉴스"에는 12시간 지연이 치명적이다. 유료 Essential €49.99/월부터 실시간.
- **NewsAPI.org**: 무료 100req/일, 카드 불필요. 단 **무료 티어는 ~24시간 지연 + 개발용만**. 실시간은 Business $449/월부터.
- **NewsData.io**: 무료 200크레딧/일이나 **12시간 지연**, 전문 없음.
- 출처: https://gnews.io, https://newsapi.ai/blog/best-free-news-api/, https://apicostcalc.com/newsapi.html

---

## 5. 대안 비교표 — "오늘·어제 뉴스" 기준

가격은 2026-10-26 조사 시점의 각 출처 기준이며, **공식 가격 페이지 재확인이 필요하다.** "무료·무카드" 원칙에 비추어 무료 지속 가능성을 별도 표기했다.

| 대안 | 신선도(오늘 뉴스) | 무료 티어 (무카드) | 유료 단가 | Workers 적용 난이도 | 비고 |
|---|---|---|---|---|---|
| **Exa (현행, 최적화)** | △ — 의미 랭킹 우선, 날짜는 2차 신호. `startPublishedDate`는 "Exa가 인식한 발행일" 기준이라 사이트맵·재게시 날짜 오류에 취약 | ○ $10/월 + $10 가입 보너스, 카드 불필요 | Lite $4/1k, Auto $7/1k (10개 결과·콘텐츠 포함) | 쉬움 — REST `fetch` 1회, 하이라이트 내장 | 30일 창 → **1~2일 창으로 축소** + 쿼리에 날짜 명시 + 클라이언트 하드 필터가 필수. `maxAgeHours`는 날짜 필터가 아님 |
| **Tavily** `topic:'news'`, `time_range:'day'`, `days:1~3`, `search_depth:'advanced'` | ○ — 뉴스 전용 토픽 + 명시적 시간 범위. 단 basic은 최신 결과 중앙값 10일 전(GoLogin 실측), **advanced 필수** | ○ 1,000 크레딧/월, 카드 불필요 (basic 1크레딧, advanced 2크레딧) | PAYG $0.008/크레딧 (advanced면 $0.016/검색) | 쉬움 — JS SDK가 ESM 전용·Workers 호환 명시. REST도 가능 | 뉴스용으로 설계된 파라미터가 가장 명확. 단 advanced는 무료 티어 소진 빠름(월 500회) |
| **Serper** (Google 뉴스, `tbs=qdr:d`) | ◎ — Google SERP 그대로라 속보 반영이 가장 빠름(45분 후 발표 1위 실측). 날짜 필터는 Google의 `qdr` 버킷 | △ **일회성 2,500회, 월 갱신 아님** — 무료로는 운영 불가, 테스트용 | $1/1k (50,000크레딧 $50 팩), 대량 시 $0.30/1k | 쉬움 — REST. 단 본문 추출이 없어 **기사 fetch를 직접** 해야 함 | 가장 저렴한 실시간 경로이나 무료 티어가 일회성이라 원칙(무료 지속)과 충돌. 스니펫만 반환 |
| **SerpApi** (Google 뉴스) | ◎ — Serper와 동일 계열, Top Stories 포함 | △ 250회/월, 카드 불필요 | $25/1k부터(Starter $25/월 1,000회) | 쉬움 — REST | Serper보다 비쌈. 무료 티어 작음 |
| **Brave Search API** | ○ — 독립 인덱스, 빠름(669ms). 뉴스 전용 파라미터는 `freshness` | ✗ **무료 티어 폐지됨 (2026-02)** — 월 $5 크레딧으로 대체, **카드 등록 필요** | $5/1k | 쉬움 — REST, 스니펫만 반환 | 카드 필요라 사용자 원칙에 **부적합**. 무료 티어 폐지 사실은 여러 출처에서 확인됨 |
| **Perplexity Sonar / Search API** | ○ — 실시간 검색 + 인용 합성 일체형 | ✗ 표준 무료 티어 없음 (Pro $20/월에 $5 API 크레딧 포함) | Search API $5/1k, Sonar $1~$3/1M 입력 토큰 + 요청료 $5~$14/1k | 쉬움 — OpenAI 호환 REST | ~11초 지연 보고. 비용·지연상 뉴스 요약 1차 수단으로는 부적합 |
| **네이버 뉴스 검색 API** 🇰🇷 | ◎ (한국 뉴스 한정) — `sort=date` 최신순, 네이버 뉴스 인덱스 | ○ 무료, 카드 불필요 (2차 출처 기준 일 25,000회 — **공식 확인 필요**) | 무료 범위 내 $0 | 쉬움 — REST `fetch`, Workers에서 직접 호출 가능 | **한국 뉴스 1순위 후보.** 제목·요약만 반환 → 본문은 기사 URL 직접 fetch 필요 |
| **Google News RSS** 🇰🇷 | ◎ (헤드라인 한정) — 실시간 피드, 키 불필요 | ○ 완전 무료·무제한 | $0 | 쉬움 — RSS XML 파싱, Workers에서 `fetch` + XML 파싱 | **헤드라인 수집용 1순위 후보.** 본문 없음·비공식이라 구조 변경 리스크. 아침 브리핑 헤드라인 수집에 적합 |
| **GNews / NewsAPI.org** | ✗ 무료 티어 12~24시간 지연 | ○ 100req/일, 카드 불필요 | GNews €49.99/월~, NewsAPI $449/월~ | 쉬움 — REST | "오늘 뉴스" 목적에는 **무료 티어 지연 때문에 부적합** |
| **Cloudflare Web Search API** (AI Gateway, 2026-10-02 출시) | 미검증 — 기본 Ceramic.ai, `provider` 파라미터로 Exa·Linkup 선택 가능. Cloudflare가 정가 그대로 청구(마크업 없음) | 미확인 | Ceramic.ai $0.25/1k라는 2차 출처 주장 있음 (미검증) | ◎ — Workers/AI Gateway 네이티브 | 출시된 지 한 달도 안 된 신기능이라 **실측 전 채택 금지**. 다만 Workers 친화성상 검증 가치 있음 |
| **DeepSeek Search API** | 미검증 (2026-10 출시) | 2026-11-01까지 Harness 경유 무료라는 보도 있음 | $0.75/1k | REST | 너무 새로움. 가격만 보면 매력적이나 신선도 실측 없음 |

출처(가격·한도): Exa https://exa.ai/alternatives/exa · https://www.activepieces.com/blog/exa-30-search-api-pricing-and-rate-limits-2026 · Tavily https://apicostcalc.com/web-search-api-cost-calculator.html · Serper https://coldiq.com/blog/serper-pricing · Brave 무료 티어 폐지 https://www.implicator.ai/brave-drops-free-search-api-tier-puts-all-developers-on-metered-billing/ · Perplexity https://screenapp.io/blog/perplexity-pricing · Cloudflare Web Search https://parallel.ai/articles/exa-alternatives · DeepSeek https://www.computeleap.com/blog/deepseek-v4-flash-repriced-everything/

---

## 6. MyHub 적용 권장안

### 6.1 진단부터 (코드 변경 전, 1순위)

2025-01 기사가 뜬 호출의 원인을 확정해야 한다. Exa 3.0부터 응답에 `warnings[]`가 있으므로:

1. **실제 전송 요청 본문 로깅**: `[SEARCH:]` 후속 호출과 `externalWebSearch`가 보내는 JSON 본문을 그대로 로그로 남길 것. `startPublishedDate`가 실제로 포함됐는지, `contents` 안에 잘못 들어간 필드는 없는지 확인.
2. **`warnings[]` / `notices[]` 로깅**: `IGNORED_FIELD`가 있으면 어떤 필드가 무시됐는지, `RESTRICTIONS_RELAXED`가 있으면 어떤 연산자가 빠졌는지 확인.
3. **응답 `publishedDate` 로깅**: 각 결과의 `publishedDate`를 그대로 기록 — 2025-01 날짜가 찍혀 있으면 필터 자체가 안 먹힌 것이고, `null`/없으면 미확인 날짜 통과 가설이 유력하다.
4. **마커 질의 로깅**: 모델이 `[SEARCH:]` 안에 넣은 질의 원문을 기록 — 뉴스 키워드 포함 여부를 확인 (별도 진행 중인 "사용자 원문 기준 뉴스 판정" 수정과 직결).

### 6.2 Exa 최적화 요청 본문 (현행 유지 시)

```json
{
  "query": "2026년 10월 26일 오늘 한국 주요 뉴스",
  "category": "news",
  "numResults": 10,
  "startPublishedDate": "2026-10-25",
  "endPublishedDate": "2026-10-26",
  "userLocation": "KR",
  "contents": { "highlights": true }
}
```

변경점과 근거:
- **쿼리에 오늘 날짜를 문장으로 포함** ("2026년 10월 26일 오늘 한국 주요 뉴스") — 공식 Best Practices: "Put the time window in the query". 깃허브 조사에서는 어느 프로젝트도 안 하는 방식이지만, 공식 문서가 명시하는 방식이다.
- **창을 30일 → 1~2일로 축소** (`startPublishedDate` 어제, `endPublishedDate` 오늘) — "오늘 뉴스"에 30일은 과도. pi-web-access의 `day=1일` 프리셋이 가장 가까운 선례. `endPublishedDate`를 함께 보내면 미래 날짜로 잘못 표기된 페이지도 걸러진다.
- **`numResults` 5 → 10** — 클라이언트 하드 필터 후 남는 결과를 확보하기 위한 여유분 (기본값 10).
- **`userLocation: "KR"` 추가** — 문서상 유일한 지역 강화 수단.
- **제거할 것**: `type: 'neural'`(현재 타입 표에 없음), `useAutoprompt`(제거됨), `livecrawl`(폐기됨), `includeText`(폐기됨). `type`은 미지정(`auto`) 유지.
- **주의 — 종합 시 정정한 점**: 깃허브 갈래에서 Agno 사례를 근거로 `type: 'keyword'`를 권장했으나, **공식 문서 기준 `keyword`는 현재 타입 표에 없어** 그대로 보내면 무시되거나 오류가 날 수 있다. `keyword` 채택은 실측 전 금지하고 `auto`를 유지할 것. 마찬가지로 `livecrawl: "always"`는 deprecated이므로 쓰지 말 것. `contents.maxAgeHours`는 발행일 필터가 아니므로 날짜 문제 해결에 쓰지 말 것 (본문 신선도가 필요할 때만 별도 검토).

### 6.3 클라이언트 측 하드 필터 (필수 — 조사한 어떤 프로젝트도 안 함)

Exa의 날짜 준수를 믿지 말고 코드에서 직접 거를 것:

1. 응답의 각 결과에 대해 `publishedDate`를 검사한다.
2. 창(예: 어제~오늘) 밖이면 버린다. **`publishedDate`가 없으면(`null`) 버린다** (사이트맵류 차단).
3. 필터 후 남는 결과가 부족하면(예: <3건) 창을 넓혀 재검색하거나(7일), 폴백 체인(Tavily/네이버/RSS)으로 넘어간다.
4. **fail-closed**: 신선한 결과가 하나도 없으면 오래된 기사를 "오늘 뉴스"로 내주지 말고 "최신 뉴스를 찾지 못했다"고 답한다. (별도 진행 중인 fail-open 제거 작업과 같은 방향.)

### 6.4 폴백 체인 (권장 구성 — 무료·무카드 원칙 유지)

1. **한국 뉴스 1차: 네이버 뉴스 검색 API(`sort=date`)** — 한국 뉴스에 구조적으로 가장 잘 맞는다. 본문 요약이 필요하면 기사 URL을 직접 fetch. (가입 시 공식 일 한도 재확인 필요.)
2. **한국 헤드라인 백업: Google News RSS(`hl=ko&gl=KR&ceid=KR:ko`)** — 키 불필요, 실시간 피드. 아침 브리핑 헤드라인 수집에 적합.
3. **글로벌/일반 뉴스 1차: Tavily `topic:'news'` + `time_range:'day'` + `search_depth:'advanced'`** — 뉴스 전용 시간 필터가 가장 명시적. 무료 1,000크레딧/월(advanced 500회/월). 무료 티어 소진 시 PAYG 과금에 주의.
4. **Exa는 역할 변경: 심층·배경 검색용.** 뉴스에 쓸 때는 6.2 본문 + 6.3 하드 필터의 3중 장치를 적용한다.
5. **검증용 대조군: Serper 일회성 2,500회** — 무료 평가용으로만 쓰고, Tavily/네이버 결과와 신선도를 A/B 비교하는 데 사용한다 (운영 의존 불가 — 월 갱신이 아님).

### 6.5 아침 브리핑 관련

- **Exa Monitors**가 문서상 정석(최소 1시간 간격, 신규 결과만 중복 제거 후 웹훅)이나, Monitor search는 날짜 필터를 직접 못 넣고 $15/1,000 req 과금이 있다. 당장 채택하지 말고, 6.4 구성이 안정된 뒤 검토할 것.
- 당장은 아침 브리핑도 6.2~6.4와 같은 경로(네이버/RSS 1차 + Exa 최적화)를 쓸 것.

### 6.6 보류/관찰 (당장 채택 금지)

- **Cloudflare Web Search API**(AI Gateway, 2026-10-02 출시): Workers 친화적이나 출시 직후라 실측 전 채택 금지.
- **DeepSeek Search API**(2026-10 출시): 가격만 매력적, 신선도 실측 없음.
- **Brave Search API**: 무료 티어 폐지(2026-02) + 카드 필요라 원칙상 제외.
- **GNews / NewsAPI.org**: 무료 티어 12~24시간 지연 때문에 "오늘 뉴스" 목적에 부적합.
- **Perplexity Sonar/Search API**: 비용·지연(~11초)상 뉴스 요약 1차 수단으로 부적합.

---

## 7. 미확인 사항 (후속 실측 필요)

- 네이버 Developers 검색 API의 공식 일 한도(2차 출처 25,000회/일) — 가입 시 공식 문서 확인 필요.
- Exa 한국어 뉴스 커버리지 실측 — 커뮤니티 보고가 없어 직접 비교 테스트가 필요하다.
- Tavily advanced `time_range:'day'`가 한국어 질의에서 실제로 당일 기사만 반환하는지 실측 필요.
- Cloudflare Web Search API의 실제 신선도·가격 — 출시 초기라 정보가 2차 출처 수준이다.
- `publishedDate`가 없는 페이지가 Exa 날짜 필터에서 포함되는지 제외되는지 — 공식 문서에 언급 없음. 응답 로그로 확인해야 한다.
- `startPublishedDate`에 ISO datetime(`...T00:00:00Z`)을 보내면 어떻게 되는지 — 날짜만(`YYYY-MM-DD`)이 정식 예제이다.
- `type: 'neural'`/`'keyword'`를 지금 보내면 400인지 무시되는지 — 현재 문서의 타입 표에 없어서 알 수 없다.

---

## 8. 출처 목록

- Exa 공식 문서 (검색/콘텐츠 신선도·Best Practices): https://exa.ai/docs/search/quickstart · https://exa.ai/docs/search/best-practices · https://exa.ai/docs/contents/quickstart
- Exa API 레퍼런스: https://exa.ai/docs/reference/search · https://exa.ai/docs/reference/answer
- Exa 체인지로그·3.0 블로그: https://exa.ai/docs/changelog · https://exa.ai/blog/exa-3
- Exa News 가이드·자사 리랭킹 블로그: https://exa.ai/docs/search/data/news · https://exa.ai/blog/sota-reranking
- Exa Monitors·Snapshot: https://exa.ai/docs/monitors/quickstart · https://exa.ai/docs/search/snapshot
- Exa 공식 SDK: https://cdn.jsdelivr.net/npm/exa-js@2.8.0/README.md
- Exa 날짜 필터 조용 무시 보고 (dev.to, 2026-05-02): https://dev.to/flarecanary/exa-just-removed-research-and-started-silently-ignoring-two-date-filters-your-agent-is-probably-1p51
- video-content-agent: https://github.com/sailorworks/video-content-agent/blob/main/src/agents/research.ts
- pi-web-access: https://github.com/nicobailon/pi-web-access/blob/main/exa.ts
- websxa: https://github.com/oritwoen/websxa/blob/main/src/providers/exa.ts
- Agno ExaTools: https://github.com/agno-agi/agno/blob/main/libs/agno/agno/tools/exa.py
- Agno 미디어 트렌드 에이전트 (미러): https://spacesail.mintlify.app/examples/use-cases/agents/media_trend_analysis_agent
- Agno Exa 문서: https://docs.agno.com/tools/toolkits/search/exa
- Exa vs Tavily vs Serper 비교: https://www.apipick.com/blog/tavily-exa-serper-vs-apipick
- Tavily vs Exa 실측 리뷰 (GoLogin): https://gologin.com/blog/tavily-review/
- SerpApi 신선도 테스트 (Grok 4.7 발표 45분 후): https://serpapi.com/blog/markdown-search-results-serpapi-vs-exa-tavily-firecrawl/
- Exa vs Serper (Exa 공식 비교 페이지): https://exa.ai/versus/serper
- Exa 3.0 가격·무료 티어: https://www.activepieces.com/blog/exa-30-search-api-pricing-and-rate-limits-2026 · https://exa.ai/alternatives/exa
- Tavily 파라미터 문서 (context7): https://context7.com/tavily-ai/tavily-python/llms.txt?tokens=10000
- Serper 가격·무료 티어: https://coldiq.com/blog/serper-pricing · https://www.openwebninja.com/blog/best-free-web-search-apis-llm-agents
- Brave 무료 티어 폐지: https://www.implicator.ai/brave-drops-free-search-api-tier-puts-all-developers-on-metered-billing/
- Perplexity Sonar 가격: https://screenapp.io/blog/perplexity-pricing · https://cabina.ai/blog/perplexity-api-pricing/
- 네이버 뉴스 API (korean-news-mcp): https://socket.dev/pypi/package/korean-news-mcp/overview/0.1.0 · https://github.heygears.com/isnow890/naver-search-mcp/blob/main/README.md
- Google News RSS / gnews: https://pypi.org/project/gnews/0.2.0/ · https://ujeebu.com/blog/how-to-scrape-google-news-results-with-a-serp-api-python-tutorial
- GNews / NewsAPI.org 무료 티어 지연: https://gnews.io · https://newsapi.ai/blog/best-free-news-api/ · https://apicostcalc.com/newsapi.html
- Cloudflare Web Search API 언급: https://parallel.ai/articles/exa-alternatives
- DeepSeek Search API 가격: https://www.computeleap.com/blog/deepseek-v4-flash-repriced-everything/
- 종합 비교 (참고용): https://irfansp.dev/agent-artifacts/artifacts/web-search-for-ai-agents-2026/
