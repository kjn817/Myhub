# RSS 우회 실험 + 파서 대조 (2026-10-26)

> 실험 + 문서만. MyHub 코드 변경 없음, 커밋하지 말 것.
> 작업 위치: `~/workspace/myhub`, 브랜치 `fix/unlock-block-remove-ciphertext` (HEAD `7089ef9`).
> 근거 문서: `docs/github-apply-research-20261026.md` 3-4절 (RSSHub / RSS-Bridge / miniflux).
> 라이선스 재확인 (GitHub API, 2026-10-26 실측): RSSHub **AGPL-3.0** · RSS-Bridge **Unlicense** ·
> miniflux **Apache-2.0**. RSSHub은 패턴 참고만, 코드 복사 금지.

## 전제 (라이브 실측 확정 사실)

- Google News RSS는 Worker egress에서 503 (`gnews-rss ok:false error:"Google News RSS 503"`).
  커밋 `7089ef9`의 UA/Accept 헤더 추가 후에도 tail 로그로 여전히 503 확인됨.
  Google이 Worker egress 자체를 차단하는 것으로 보임.
- 같은 피드는 VM curl로는 정상 동작함 (아래 베이스라인 실측).
- MyHub RSS 파서는 손수 짠 정규식 기반 (`src/services/news-sources.ts` `parseGoogleNewsRss`).

## 0. 결론 요약

| 항목 | 판정 | 한 줄 |
|---|---|---|
| RSSHub 공개 인스턴스(`rsshub.app`) 경유 우회 | **FAIL — 사용 불가** | 이 VM에서 인스턴스 전체가 403 (라우트 무관). 브라우저 UA는 Cloudflare JS 챌린지. |
| 미러(`rsshub.rssforever.com`) | **FAIL** | 504 Gateway Time-out (61.5초 대기 후). |
| RSSHub Google News 라우트 자체 | **MyHub 요구와 불일치** | RSS 프록시가 아니라 HTML 스크레이퍼이고, 키워드 검색 라우트가 없어 카테고리(Top stories 등)만 가능. |
| RSS-Bridge 한국 언론사 보강 | **패턴만 유효, 당장 불가** | 한국 언론사 브릿지가 하나도 없음 (신규 작성 필요). 공개 인스턴스·셀프호스팅 모두 이번 범위 밖. |
| miniflux 파서 대조 | **적용 후보 2건** | 다중 날짜 포맷 폴백 + `dc:date` 폴백. 단, 날짜 없음 시 `time.Now()` fail-open은 MyHub 뉴스 필터와 정반대라 차용 금지. |
| RSSHub 날짜·캐시·재시도 패턴 | **적용 후보 3건** | 상대 날짜 파서(스크레이핑 시에만), 2단계 캐시 TTL, 재시도 시 프록시 전환 헤더. |

**최종 판단: 공개 인스턴스 의존은 실험 결과만으로 종결한다. 주 경로로 삼지 않는다.**
뉴스 체인 현행 우선순위(네이버 → GNews RSS → Tavily → Exa)는 유지하고,
GNews RSS 503의 실질적 대안은 네이버 API 키 발급(1차) + Cloudflare Web Search API 날짜 실측(1-3절)
쪽으로 본다. RSSHub 경유는 두 가지 독립적 사유(403 차단 + 검색 라우트 부재)로 탈락했다.

---

## 1. RSSHub 공개 인스턴스 경유 우회 실험

### 1-1. 방법

- 수단: VM `curl`만 사용. Worker 배포·라이브 OTP 호출 없음.
- 일시: 2026-10-26 16:19–16:22 KST (07:19–07:22 UTC).
- 라우트 확인: GitHub 원본(`DIYgod/RSSHub`, `lib/routes/google/news.tsx`)을 먼저 읽어
  정확한 라우트 서명을 확인한 뒤 실험했다.
  - 라우트: `/google/news/:category/:locale`
  - 예시: `/google/news/Top stories/hl=en-US&gl=US&ceid=US:en`
  - 한국판 실험 URL: `https://rsshub.app/google/news/Top%20stories/hl=ko-KR&gl=KR&ceid=KR:ko`
- 베이스라인: 직접 Google News RSS (`https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko`)를
  같은 VM에서 먼저 측정했다.

### 1-2. 베이스라인 — 직접 Google News RSS (VM)

| 측정 | 값 |
|---|---|
| HTTP 상태 | 200 |
| 총 소요 | 1.74초 |
| 크기 | 93,884 B |
| 최신 `pubDate` | `Mon, 26 Oct 2026 04:37:00 GMT` (= 13:37 KST, 측정 시점 기준 약 2.8시간 전) |
| 그 외 `pubDate` 샘플 | 00:19 / 02:56 / 03:31 / 00:17 GMT (전부 오늘자) |

VM에서는 직접 피드가 신선하게 동작함을 재확인했다. 문제는 Worker egress에서만 발생한다.

### 1-3. rsshub.app 실험 결과 — 403 (인스턴스 전체)

| 시도 | UA | 결과 |
|---|---|---|
| 1차 (3회 반복) | curl 기본 UA | 403, 0.36–0.50초, 본문 386 B (3회 전부 동일) |
| 재실행 | curl 기본 UA | 403, 1.08초, 386 B |
| 재실행 | 브라우저 UA (Chrome 141) | 403, 0.55초, 본문 3,320 B |
| 프로브: 루트 `/` | curl 기본 UA | 403, 0.71초 |
| 프로브: 무관 라우트 `/github/trending/daily` | curl 기본 UA | 403, 0.72초, 본문 386 B |

- **라우트와 무관하게 인스턴스 전체가 403이다.** 구글 뉴스 라우트만의 문제가 아니다.
- 기본 UA 403 본문 (386 B, `text/plain`, `Server: cloudflare`, `CF-RAY` 포함):

> Due to cost considerations, we will gradually restrict access to rsshub.app for some feed readers.
> Please note that rsshub.app is intended for testing purposes only and should not be used as a
> production RSS source. For stable and long-term usage, we strongly recommend self-hosting RSSHub.

- 브라우저 UA 403 본문 (3,320 B)은 Cloudflare **"Just a moment..." JS 챌린지 페이지**이다.
  즉 UA를 바꾸면 차단 형태만 바뀔 뿐 (일반 403 → 봇 챌린지), 피드 내용은 어느 경우에도 오지 않는다.
- 403 응답 헤더: `Cache-Control: private, max-age=0, no-store, no-cache, must-revalidate`,
  `Expires: Thu, 01 Jan 1970 00:00:01 GMT` — 엣지(Cloudflare)에서 차단 결정을 내리고 캐시하지 않는다.
- 제한 사항: 이 VM의 egress IP가 Cloudflare 봇 규칙에 걸린 것인지, rsshub.app 전역 정책인지
  이 실험만으로는 구분할 수 없다. 다만 본문 문구 자체가 "일부 피드 리더의 접근을 점진 제한" +
  "테스트 용도, 운영 소스로 쓰지 말 것"을 명시하고 있어, 설령 이 VM에서 뚫린다 해도
  운영 의존 대상으로는 부적격이라는 결론은 같다.

### 1-4. 미러 실험 — 504

- `https://rsshub.rssforever.com/google/news/Top%20stories/hl=ko-KR&gl=KR&ceid=KR:ko`
  (조사 문서에 나온 대체 미러): **504 Gateway Time-out, 61.5초 대기 후** (nginx).
- 미러도 가용하지 않다. 다른 미러를 추가로 추측·시도하지 않았다 (URL 추측 금지 원칙).

### 1-5. 라우트 자체 분석 — RSS 프록시가 아니다

`lib/routes/google/news.tsx`를 읽은 결과, 이 라우트는 **Google News RSS를 중계하지 않는다.**

- 동작: `news.google.com/?{locale}` HTML을 가져와 카테고리 링크를 CSS 셀렉터(`a.brSCsc`, `a.aqvwYd`)로
  추출하고, 선택된 카테고리 페이지를 다시 fetch해 cheerio 셀렉터
  (`.UwIKyb`, `.IBr9hb`, `.IFHyqb` 행 / `.gPFEn` 제목 / `a.WwrzSb` 링크 / `time[datetime]` 날짜)로
  기사를 뽑는다. 카테고리 목록은 `cache.tryGet('google:news:{locale}')`으로 캐시한다.
- 링크: 원문 URL을 클릭 메타데이터의 base64 JSON(`5:` 필드)에서 디코딩해 복원하고,
  실패하면 Google News 링크를 그대로 쓴다 (fail-open).
- 날짜: `<time datetime>` 속성값을 `parseDate`로 파싱한다. 날짜가 없으면 `pubDate` 없음.
- **키워드 검색 라우트가 없다.** 카테고리(`Top stories`, `World` 등)만 받는다.
  MyHub 뉴스 체인은 사용자 질의 키워드로 검색(`GNEWS_RSS_URL = .../rss/search?q=...`)하는데,
  이 라우트로는 질의를 표현할 방법이 없다.

즉 rsshub.app이 403이 아니었더라도, MyHub의 "오늘 한국 주요 뉴스" 같은 키워드 검색 요구를
이 라우트로는 충족할 수 없다. 우회 실험은 **차단(403) + 요구 불일치(검색 불가)** 두 가지
독립적 사유로 탈락이다.

### 1-6. 실험 결론

- RSSHub 공개 인스턴스 경유는 **실험 결과만 기록하고 종결**한다. 주 경로·백업 경로 모두로 삼지 않는다.
- 셀프호스팅은 사용자 지시로 금지되어 있어 대안이 되지 않는다.
- GNews RSS 503 문제의 남은 방향: 네이버 뉴스 API 키 발급(1차 소스 강화),
  Cloudflare Web Search API 날짜 실측(`docs/github-apply-research-20261026.md` 1-3절),
  기사 페이지 직접 날짜 검증 패턴(1-2절, 7089ef9 잔존 간극의 정답).

---

## 2. RSS-Bridge 패턴 대조 — "피드가 없는 사이트에 피드 만들기"

### 2-1. 구조 (패턴만, 코드 복사 없음)

- **브릿지 = 사이트 하나당 클래스 하나.** `bridges/*.php`가 `BridgeAbstract`를 확장한다.
  선언 부분: `NAME` / `URI` / `DESCRIPTION` / `MAINTAINER` / `PARAMETERS`(입력 폼 정의) /
  `CACHE_TIMEOUT`(기본 3600초, 브릿지별 지정) 상수 + `collectData()` 추상 메서드 하나.
  실행기는 브릿지를 몰라도 된다: 파라미터 선언 → `collectData()` → `getItems()`라는
  고정 계약만으로 피드를 만든다.
- **출력 포맷 분리.** `formats/`에 Atom / JSON / MRSS / HTML / Plaintext / Sfeed가 있고,
  브릿지는 아이템 배열만 만들면 포맷 선택은 호출자가 한다.
  (MyHub 관점: 소스별 수집과 출력 직렬화를 분리하라는 구조적 교훈. 지금 MyHub는
  `SearchSource { title, url, publishedDate }`라는 공통 형태로 이미 같은 분리를 하고 있다.)
- **피드 확장(FeedExpander).** 이미 피드가 있는 사이트는 `FeedExpander`가 기존 피드를 받아
  본문·날짜 등을 보강한다 — "있는 피드는 고치지 말고 감싸서 보강한다"는 패턴.
  MyHub의 URL 날짜 가드·마커 날짜 소독이 Exa 결과를 감싸는 방식과 같은 계열이다.
- **날짜 처리.** `lib/FeedParser.php`는 `pubDate` → `dc:date` → `updated` 순서로 보고
  `strtotime()`으로 변환한다. 파싱 실패 시 `strtotime('')` = `false`가 들어가고
  기본값은 빈 문자열 — 즉 **날짜 파싱 실패를 조용히 빈 값으로 흘린다.**
  개별 뉴스 브릿지(예: AP 통신)는 JSON의 `publishDateStamp`(epoch ms)를 직접 써서
  내림차순 정렬한다 — 피드 날짜를 믿지 않고 원천(epoch) 값을 쓰는 쪽이 더 단단하다.
- **캐시.** 브릿지별 `CACHE_TIMEOUT` + `CacheInterface` 추상화(파일/메모리 등 구현 교체 가능).
  캐시 키는 브릿지 + 파라미터 조합이다.

### 2-2. XPathAbstract — 선언형 스크레이핑 패턴

- `lib/XPathAbstract.php`는 "코드 없이 XPath 선언만으로 피드 만들기"용 추상 클래스다.
  서브클래스는 상수로만 정의한다: `FEED_SOURCE_URL`(원본 페이지),
  `XPATH_EXPRESSION_ITEM`(기사 목록 노드), 제목·링크·날짜·본문용 XPath,
  필요 시 값 포맷용 메서드만 오버라이드한다.
- RSSHub의 "사이트별 라우트"와 같은 역할이지만, 라우트가 코드(cheerio 셀렉터)라면
  여기는 **선언(XPath 상수)** 이다. 셀렉터가 깨지면 상수만 고치면 된다.
- MyHub에의 함의: 한국 언론사 개별 페이지를 보강해야 한다면, 새 코드를 짜는 대신
  "언론사별 셀렉터 표"라는 선언형 테이블이 유지보수 관점에서 맞는 형태다.
  단, Workers에서 HTML fetch + XPath 평가는 별도 구현이 필요하고(Workers에 DOM/XPath 없음),
  언론사별 셀렉터는 사이트 개편 때마다 깨지는 유지보수 부담이 있다.

### 2-3. 한국 언론사 보강에의 적용 가능성

- **현실: 한국 언론사 브릿지가 하나도 없다.** `bridges/` 디렉토리를 검색한 결과
  한국 관련은 `HanimeBridge.php`(애니메이션, 오탐)뿐이고,
  연합뉴스·네이버·조선·중앙·한겨레·동아·KBS·MBC·SBS 브릿지는 존재하지 않는다.
- 있는 뉴스 브릿지는 AP·Euronews·ABC·Fox(택소노미) 등 영미·유럽 중심이다.
- 따라서 RSS-Bridge로 한국 뉴스를 보강하려면 **언론사별 신규 브릿지(또는 XPath 선언)를 직접 작성**해야 하고,
  이를 돌리려면 공개 인스턴스 의존 또는 셀프호스팅이 필요한데 둘 다 이번 범위 밖이다.
  (공개 인스턴스 `rss-bridge.org`의 가용성·차단은 이번에 실험하지 않았다 — RSSHub 실험과 같은
  제3자 의존 리스크가 그대로 적용되므로, 별도 실험 없이 "주 경로 불가"로 본다.)
- 결론: RSS-Bridge는 **패턴 참고용으로만** 기록한다. 당장 쓸 수 있는 한국 뉴스 소스가 아니다.
  네이버 뉴스 API(공식, sort=date)가 1차인 현행 체인이 여전히 가장 단단하다.

---

## 3. miniflux 파서 대조 — MyHub 정규식 파서와 무엇이 다른가

### 3-1. 구조 (패턴만, 코드 복사 없음)

- Go 구현. `internal/reader/` 아래에 포맷별 하위 패키지가 분리돼 있다:
  `atom` / `rss` / `json` / `rdf` + 공용 `date` / `sanitizer` / `encoding` /
  `urlcleaner` / `scraper`(본문 추출) / `readability` / `filter` / `processor`.
- 파싱 진입점 `internal/reader/parser/`가 피드 종류를 판별해 해당 파서로 넘긴다
  (MyHub는 Google News RSS 한 종류만 파싱하므로 이 분기는 필요 없다).
- **HTML 정제는 allowlist 기반**(`internal/reader/sanitizer`): 허용 태그·속성만 남기고 나머지를 제거한다.
  MyHub의 `stripHtmlTags`(정규식 `<[^>]*>` 제거 + 6개 엔티티 치환)는 "전부 지우기" 방식이라
  제목·본문 정제에는 충분하지만, 본문을 살려야 하는 용도에는 allowlist가 정답이다.
  (지금 MyHub 뉴스 경로는 제목만 쓰므로 정규식 정제로 충분 — 본문 요약을 붙일 때만 재검토.)

### 3-2. 날짜 파싱 — 284개 포맷 + 현지화 치환

`internal/reader/date/parser.go`의 `Parse`는 다음 순서로 시도한다:

1. 빈 문자열 → 에러.
2. 순수 숫자 → Unix epoch 초로 해석 (`time.Unix`).
3. **현지화 치환(`strings.Replacer`)**: 독일어·프랑스어 요일/월 이름
   (`Mo,`→`Mon,`, `Di,`→`Tue,`, `Mär `→`Mar `, `lun,`→`Mon,` …)과
   타임존 표기(`Europe/Brussels`→`CET`, `GMT+0000 (Coordinated Universal Time)`→`GMT`)를
   영어로 정규화한 뒤 파싱한다. **한국어("10월 26일", "월요일") 치환은 없다.**
4. 타임존 없는 RFC822/850/1123은 **로컬 시간**으로만 해석한다 (별도 목록 3개).
5. **약 284개 레이아웃을 순서대로 시도**한다 (`time.RFC822Z`, `RFC3339`, `UnixDate`, `RubyDate`,
   `RFC1123Z`, `ANSIC` + ~278개 변형). 변형에는 실제 피드에서 발견된 오타·변종까지 포함돼 있다:
   서수 접미사 오기(`2th`/`2rd`/`2nd`/`2st Jan`), 소문자 요일(`fri, 02 jan ...`),
   이중 대시(`15:04:05 --0700`), 쉼표 누락(`Mon,2 Jan 2006`), `a.m.`/`p.m.` 표기,
   `15:4:5` 같은 한 자리 시분초, `02.01.2006`/`01/02/2006` 같은 숫자 날짜의 모든 순서 조합.
6. 전부 실패하면 에러를 반환한다. **상대 날짜("3 hours ago", "어제")는 처리하지 않는다.**

### 3-3. 날짜 없음·파싱 실패 시의 정책 — MyHub와 정반대

`internal/reader/rss/adapter.go`의 `findEntryDate`:

- `dc:date`가 있으면 `pubDate`보다 **우선**한다 (Dublin Core 날짜 우선).
- 값이 비어 있거나 파싱에 실패하면 **`time.Now()`를 반환한다** (debug 로그만 남김).
  즉 miniflux는 **날짜를 모르면 "지금"으로 간주해 아이템을 절대 버리지 않는다.**
- MyHub 뉴스 체인은 정반대다: 날짜 없음·창 밖은 **하드 필터로 제외**한다
  (`filterNewsWindow` + 날짜 없음 제외, 커밋 `0a2301f`·`7089ef9`).
- 어느 쪽이 맞나: **목적이 다르다.** 피드 리더(miniflux)는 아이템 유실이 최악이라
  fail-open이 맞고, 뉴스 신선도 필터(MyHub)는 오래된 기사가 섞이는 게 최악이라
  fail-closed가 맞다. **miniflux의 `time.Now()` 폴백을 MyHub 뉴스 경로에 차용하면 안 된다**
  (Exa 가짜 날짜 문제와 똑같은 구멍이 열린다 — 날짜 모름을 오늘로 간주하는 셈이 된다).
- 단, `dc:date` 우선순위는 MyHub에도 차용할 만하다: Google News RSS `<item>`에
  `dc:date`가 들어오는 경우가 있어, `pubDate`가 없을 때의 폴백으로 쓸 수 있다
  (파싱 실패 시에는 버리는 현행 정책을 유지하면서).

### 3-4. 그 밖의 폴백 체인 패턴

- `findEntryContent`: DublinCoreContent → Description → GooglePlayDescription →
  iTunesSummary → iTunesSubtitle 순서로 **첫 비어 있지 않은 값**을 쓴다.
  (MyHub `parseGoogleNewsRss`는 `title`·`link`·`pubDate` 3개 필드만 보고 폴백이 없다.
  필드별 폴백 체인이라는 패턴 자체는 네이버·Tavily·Exa 결과 정규화에도 그대로 쓸 수 있다.)
- `findEntryAuthor`도 같은 방식의 다단계 폴백이다.
- 날짜 파서의 교훈: **날짜 파싱은 "표준 1개 + 실패 시 버림"이 아니라
  "포맷 목록을 순서대로 시도 + 실패 시 명시적 정책"** 으로 설계하는 것이 실전적이다.
  MyHub의 `toIsoDate`는 `Date.parse` 한 번만 시도한다 — RFC822 변종(요일 불일치,
  `UT`/`Z` 같은 비표준 타임존 약어, 한 자리 시분초 등)에는 약하다.

### 3-5. 대조표 — MyHub 파서 vs miniflux vs RSSHub vs RSS-Bridge

| 관점 | MyHub (`news-sources.ts`) | miniflux | RSSHub `parse-date` | RSS-Bridge `FeedParser` |
|---|---|---|---|---|
| 파싱 방식 | 정규식 (`<item>` 블록 + 필드별 정규식) | 전용 XML 파서 + 포맷별 어댑터 | dayjs + 커스텀 포맷 | PHP XML 파서 + `strtotime` |
| 날짜 포맷 수 | 1회 (`Date.parse`) | ~284개 레이아웃 순차 시도 | 상대 날짜 + dayjs 포맷 목록 | `strtotime` 1회 (PHP 내장 휴리스틱) |
| 상대 날짜 ("3시간 전") | 미지원 | 미지원 | **지원 (영·중)** | 미지원 |
| 현지화 치환 | 없음 | 독·불 요일/월 → 영어 | 중문 숫자·수량사 → 아라비아 숫자 | 없음 |
| `dc:date` 폴백 | 없음 | **있음 (pubDate보다 우선)** | 해당 없음 | 있음 (`pubDate ?? dc:date`) |
| 날짜 없음 시 | 제외 (strict) | `time.Now()` (fail-open) | — | 빈 값으로 흘림 |
| 파싱 실패 시 | `undefined` → 제외 | `time.Now()` + debug 로그 | `Invalid Date` 반환 | `false` → 빈 값 |
| HTML 정제 | 정규식 제거 + 엔티티 6종 | allowlist 새니타이저 | cheerio 추출 | simplehtmldom |
| 본문 추출 | 없음 (제목만) | `scraper` + `readability` | 라우트별 cheerio | 브릿지별 |
| 한국어 상대 날짜 | 미지원 | 미지원 | 미지원 (영·중만) | 미지원 |

**주목할 빈칸: 네 프로젝트 모두 한국어 상대 날짜("3시간 전", "어제", "오늘 오전 10시")를
네이티브로 처리하지 않는다.** RSSHub이 중·영을 처리하는 방식(키워드 테이블 + 단위 패턴 +
숫자 정규화)은 한국어에 그대로 포팅 가능한 설계이나, 단어표 자체는 새로 만들어야 한다.
MyHub가 HTML 스크레이핑으로 넘어갈 때만 필요한 항목이라, 지금 당장의 RSS 파서에는 해당 없다.

---

## 4. RSSHub 날짜 정규화·캐시·재시도 패턴 정리

### 4-1. 날짜 정규화 (`lib/utils/parse-date.ts`, 별도 `parse-date-in-timezone.ts` 존재)

설계가 "피드 날짜 파싱"이 아니라 **"사람이 쓴 상대 날짜 파싱"** 에 맞춰져 있다
(스크레이퍼가 페이지에서 긁어온 날짜 문자열용이다):

- **의미 키워드 테이블**: 오늘/어제/그저께/내일/모레 + 요일(월~일)을
  영·중 병기로 매칭하고, 기준일(오늘 00:00)에서 상대 계산한다.
  요일은 "가장 최근의 해당 요일"로 해석한다 (오늘이 월요일이면 지난주 월요일).
- **상대 단위 패턴**: 년/월/주/일/시간/분/초를 영·중 단위 정규식으로 추출해 합산한다
  (`1 hour 30 mins`, `3天前`, `2小时前` 등). `a/an` → 1, 모호한 `几/数` → 3,
  중문 숫자(一二三…) → 아라비아 숫자로 정규화한 뒤 파싱한다.
- **12시간제 처리**: `3pm` 같은 붙은 표기를 `3 pm`으로 분리하고,
  上午/下午/凌晨/晚上 같은 중문 오전·오후 표기를 AM/PM으로 매핑한다.
  12시 경계(오전 12시 = 0시, 오후 12시 = 12시) 보정 로직이 있다.
- **폴백**: 키워드·상대 단위가 모두 아니면 dayjs 명시 포맷 목록으로 시도한다.
- MyHub 관점: 이 파서는 **Exa `publishedDate` 검증용이 아니라, 기사 페이지 HTML에서
  "3시간 전" 같은 상대 날짜를 읽을 때** 필요한 것이다. 1-2절의 기사 날짜 직접 검증 패턴
  (HTML 메타 날짜 우선)과 짝을 이룬다. RSS 피드 날짜(RFC822)에는 과한 도구다.

### 4-2. 사이트별 스크레이퍼(라우트) 구조

- **라우트 = 파일 하나.** `lib/routes/<사이트>/<라우트>.ts(x)`마다
  `route: Route = { path, categories, example, parameters, features, name, maintainers, handler }`
  형태의 선언 + `handler(ctx)` 하나를 수출한다.
- `features` 선언: `requireConfig`(키 필요 여부), `requirePuppeteer`(브라우저 필요),
  `antiCrawler`(차단 우회 필요), `supportBT`/`supportPodcast`/`supportScihub` 등.
  라우트마다 필요한 우회 수단을 선언해 두는 방식이다.
- `handler` 내부 관용구: `ofetch`(아래 4-4절)로 가져오기 → cheerio로 셀렉터 추출 →
  `cache.tryGet`으로 중간 결과 캐시 → 아이템 배열 반환.
  Google News 라우트가 카테고리 목록을 캐시하고 기사 목록을 스크레이핑하는 것이 대표 예시다.
- MyHub 관점: 지금 뉴스 소스는 4개뿐이라 라우트 레지스트리까지는 과하지만,
  "소스별 선언(필요 키·타임아웃·날짜 신뢰도) + 공통 수집기"라는 분리는
  `news-sources.ts`의 체인 구조와 이미 같은 방향이다. 언론사 보강을 선언형으로 할 때 참고할 형태다.

### 4-3. 캐시 정책 — 2단계 TTL

`lib/config.ts` 기본값 (2026-10-26 실측):

| 설정 | 기본값 | 의미 |
|---|---|---|
| `CACHE_TYPE` | `memory` | 백엔드: memory / redis / http (빈 문자열이면 비활성화) |
| `CACHE_EXPIRE` (`routeExpire`) | 5분 | 라우트 응답(최종 피드) 캐시 |
| `CACHE_CONTENT_EXPIRE` (`contentExpire`) | 1시간 | 수집한 콘텐츠(중간 결과) 캐시 |
| `MEMORY_MAX` | 256개 | 메모리 캐시 LRU 최대 항목 수 |
| `CACHE_REQUEST_TIMEOUT` | 60 (단위: 초로 보임) | 캐시 백엔드 요청 타임아웃 |

- `lib/utils/cache/index.ts`의 `tryGet(key, getValueFunc, maxAge = contentExpire, refresh = true)`:
  캐시가 있으면 반환하고, `refresh=true`면 백그라운드로 갱신하는
  **stale-while-revalidate 형태**다. 키는 `google:news:{locale}`처럼 네임스페이스를 붙인다.
- `lib/middleware/cache.ts`가 라우트 응답 단 캐시를 맡고, `tryGet`이 수집 단 캐시를 맡는
  **2단계 분리**가 핵심이다: 최종 응답은 짧게(5분), 원천 수집은 길게(1시간) 잡아
  원천 서버 부하를 줄이면서도 피드 신선도를 유지한다.
- MyHub 관점: Workers에는 `cache.tryGet`에 해당하는 것이 KV(스테이징에 `myhub-kv-staging` 존재)나
  Cloudflare Cache API다. 뉴스 체인은 현재 매 요청마다 4개 소스를 순차 호출하고
  15초 타임아웃만 있다 — "오늘 뉴스" 같은 질의는 수 분간 같은 결과를 돌려줘도 되므로,
  **라우트 응답 5분 캐시**는 Workers Cache API/KV로 구현 가능한 현실적 최적화다.
  (단, 이 문서는 실험·정리까지만 하고 구현은 하지 않는다.)

### 4-4. 재시도·fetch 정책 — 프록시 전환이 핵심

`lib/utils/ofetch.ts` (ofetch 래퍼):

- 재시도 대상 상태코드: `[400, 408, 409, 425, 429, 500, 502, 503, 504]` —
  **503을 재시도 대상에 포함**한다 (MyHub GNews RSS 503도 이 분류다).
- 기본 재시도 횟수 `requestRetry = 2`, 재시도 간격 `retryDelay = 1000ms`,
  요청 타임아웃 `requestTimeout = 30000ms` (MyHub는 15초).
- **재시도 시 `x-prefer-proxy: 1` 헤더를 붙인다**: 첫 시도는 직접 egress,
  실패하면 프록시 경유로 바꿔서 재시도하는 구조다. 즉 RSSHub은 "한 번 막히면
  같은 경로로 재시도하지 않고 egress를 바꾼다"는 정책을 코드로 갖고 있다.
  MyHub의 Google 503 문제와 정확히 같은 문제의식이다 — 다만 MyHub(Workers)는
  egress를 바꿀 수단이 없어, 가장 가까운 대응은 이미 있는 **Deno 릴레이 경유**
  (Gemini용으로 구축된 `GEMINI_RELAY_URL` 패턴)나 Cloudflare Web Search API 같은
  다른 경로로의 폴백이다. 이 문서에서는 패턴만 기록한다.
- 응답 리다이렉트·요청 실패 원인 체인을 로그로 남긴다
  (`onResponseError`/`onRequestError`/`onResponse` 훅).
- **호스트별 속도 제한** (`lib/utils/host-rate-limit.ts`):
  `REQUEST_RATE_LIMITS`를 `{"hostname": {"points": N, "duration": 초}}` JSON으로 받아
  호스트별 요청을 큐 + 타이머로 간격을 강제한다. "스크레이핑은 예의 바르게"를
  설정으로 강제하는 패턴이다. MyHub의 4개 소스에는 과한 장치이나,
  언론사 직접 fetch를 늘릴 때 필요한 안전장치다.
- **헤더 생성기** (`header-generator`): 라우트별 `antiCrawler` 플래그에 따라
  현실적인 브라우저 헤더를 생성한다. MyHub이 GNews RSS에 고정 UA를 박은 것(7089ef9)과
  같은 문제의식이나, RSSHub은 UA를 라우트·요청마다 바꿔가며 생성한다.

---

## 5. MyHub에 적용 가능한 패턴 후보 (구현 아님 — 다음 작업의 판단 재료)

우선순위 순. 어디에도 코드를 바꾸지 않았다. 각 항목은 별도 작업·승인이 필요하다.

| # | 패턴 (출처) | MyHub 적용 형태 | 비고 |
|---|---|---|---|
| 1 | 다중 날짜 포맷 폴백 (miniflux `date.Parse`, ~284개 레이아웃) | `toIsoDate`를 `Date.parse` 1회에서 "RFC822 변종 목록 순차 시도"로 확장 | 순수 함수라 Workers에 그대로 맞는다. RSS `pubDate` 변종(요일 불일치, `UT`, 한 자리 시분초) 내성 확보. |
| 2 | `dc:date` 폴백 (miniflux·RSS-Bridge 공통) | `parseGoogleNewsRss`에서 `pubDate`가 없으면 `dc:date`를 본다 | 실패 시 버리는 현행 정책은 유지. 날짜 없음 → 오늘 간주(miniflux식)는 **금지**. |
| 3 | 라우트 응답 단기 캐시 (RSSHub 2단계 TTL) | "오늘 뉴스" 질의 결과를 Workers Cache API/KV에 5분 캐시 | 매 요청 4소스 순차 호출 + 15초 타임아웃 부하를 줄인다. `/api/ai/websearch` 502 타임아웃(체인 순차 실행이 30초 edge 제한 초과 추정) 완화에도 기여할 수 있다. |
| 4 | 기사 페이지 직접 날짜 검증 (1-2절, 7089ef9 잔존 간극의 정답) | 상위 N개 URL fetch → `article:published_time`·JSON-LD `datePublished`·`<time>` 확인 | `bbcbreakingnews` 미러 1건(가짜 날짜가 자정이 아닌 시각 + URL 날짜 없음)을 닫는 유일한 방법. 상대 날짜("3시간 전")가 나오면 RSSHub 4-1절 파서 패턴(한국어 단어표 신규 작성 필요)을 함께 쓴다. |
| 5 | 재시도 시 egress 전환 (RSSHub `x-prefer-proxy`) | GNews RSS 503 시 Deno 릴레이 경유 재시도 검토 | Workers egress를 직접 바꿀 수 없으므로 릴레이 경유가 대응. Gemini 릴레이 패턴 재사용 여부·비용·지연은 별도 판단. |
| 6 | 선언형 셀렉터 표 (RSS-Bridge XPathAbstract / RSSHub 라우트) | 한국 언론사 보강 시 "언론사별 셀렉터 표"로 선언 | 언론사별 HTML fetch + 셀렉터 유지보수 부담이 커, 네이버 API 키가 있는 한 후순위. Workers에 XPath/DOM이 없어 별도 파서 구현도 필요하다. |

**차용하지 않을 것 (명시):**

- miniflux의 날짜 없음 → `time.Now()` fail-open (뉴스 신선도 필터와 정면 충돌).
- RSS-Bridge의 `strtotime` 실패 → 빈 값 조용 처리 (MyHub은 statuses에 실패를 기록하는 현행이 맞다).
- RSSHub 공개 인스턴스·미러 의존 (1절 실험 결과).
- 세 프로젝트 중 어느 하나의 통째 설치·셀프호스팅 (사용자 지시).
- RSSHub AGPL 코드 복사 (라이선스). RSS-Bridge(Unlicense)·miniflux(Apache-2.0)도
  이번 문서는 패턴 서술만 했고 코드를 가져오지 않았다.

---

## 6. 제한·미검증 항목

- **rsshub.app 403의 원인 구분 불가**: 이 VM egress IP 기반 차단인지 전역 정책인지 알 수 없다.
  본문 문구가 전역 제한을 시사하나, 다른 네트워크에서의 동작은 실험하지 않았다.
  어느 쪽이든 "운영 의존 불가" 결론은 변하지 않는다.
- **RSS-Bridge 공개 인스턴스 미실험**: RSSHub과 같은 제3자 의존 리스크가 적용되어 별도 실험하지 않았다.
- **Worker egress에서의 RSSHub 경유 미실험**: rsshub.app이 VM에서조차 403이라,
  Worker → rsshub.app 경로를 추가로 실험할 의미가 없었다 (VM보다 나을 이유가 없음).
- **miniflux·RSS-Bridge·RSSHub의 최신 커밋 이후 변경**: 이 문서는 2026-10-26 시점의
  `master`/`main` 스냅샷을 읽은 것이다. 라우트 셀렉터·포맷 목록은 원천 사이트 변경에 따라 깨질 수 있다.
- **라이브 OTP·운영 D1·배포**: 일절 수행하지 않았다 (작업 범위 외).
- **뉴스 체인 코드 변경**: 없음. 이 문서는 `docs/` 신규 파일 1건만 추가했다.
