# 네이버 API HUB — 카드(결제수단) 등록 필요 판정 및 발급 보류 (2026-10-28)

> 조사·문서 작업만. 코드 변경 없음. 커밋 브랜치: `apply/rss-naver` (HEAD 51c1127 기준).
> 근거 문서: `docs/recent-trends-20261028.md` §1-4 및 "긴급 정정 1".
> 조사일: 2026-10-28 (KST). 수단: NCP 공식 문서·이용약관 직접 열람 + browser.search.

> **2026-10-28 이관 완료 (브랜치 `apply/naver-hub`, 코드 트랙):** 사용자가 카드 등록 후
> HUB 키 발급을 마쳤고(앱 MyHub, 뉴스 검색 API만 선택), Worker 시크릿
> `NAVER_CLIENT_ID`·`NAVER_CLIENT_SECRET` 존재가 이름 목록으로 확인됐다(값 미조회).
> 코드 이관 완료 — `src/services/news-sources.ts`를 HUB 엔드포인트·헤더로 교체
> (구 엔드포인트 폴백 없음). **남은 것:** ① HUB 응답 형식(필드명·pubDate 날짜 형식)과
> `sort=date` 파라미터 동작은 공식 문서에서 확인 못 함 — 스테이징 실제 호출로 검증 필요
> ② 테스트 갱신은 별도 트랙. 자세한 미확인 항목은 아래 §5 표와 §8 참조.

## 결론 (한 줄)

**NCP NAVER API HUB로 네이버 뉴스 API 키를 발급받으려면 결제수단(신용·체크카드) 등록이 실무상 필요하다.
사용자 원칙(무료·무카드)과 충돌하므로 네이버 뉴스 1차 경로는 발급 보류 — 대안 경로(언론사 RSS·Tavily·Exa)로 간다.
카드 등록을 감수하기로 결정하지 않는 한 NCP 가입·키 발급을 시도하지 않는다.**

## 1. 카드 필요 여부 판정

| 항목 | 판정 | 근거 |
|---|---|---|
| NCP 계정 가입 + API HUB 이용 신청 시 결제수단(카드) 등록 | **필요 (실무 판정)** | 아래 ①~④ |
| 공식 API HUB 문서에 "카드 필수" 명시 문구 | **없음** | 이관 가이드·사용 가이드·이용약관 전수 열람 — 결제수단 언급 0건 |
| 무료 한도 내 과금 | **0원 (한시적 무료)** | 공개 요금표 기준 (아래 §3). 단, 카드 등록 자체가 과금 동의의 전제 조건이라는 점이 문제 |

### 판정 근거

**① NAVER API HUB 키 발급 전용 실무 가이드 (2026-10-17, 가장 직접적인 근거)**

네이버 API 키 발급 23단계 가이드(블로그·검색어 트렌드용, API HUB 경로):

- "콘솔 접속 및 결제수단 등록 안내 ('이용 불가 계정' 안내 해결)"
- "신용/체크카드 등록 및 휴대폰 본인 인증"
- **"결제 수단 등록: 결제 수단을 등록해야 정상적인 API 호출이 가능합니다
  (오류 메시지 발생 시 결제 수단 관리에서 카드 등록)"**

출처: https://www.youtube.com/watch?v=svKg5ZrLzzs (설명란 타임스탬프·요약 기준)

**② NCP API 일반 실무 가이드 — "등록해야만 API를 사용할 수 있다"**

네이버 지도 API(NCP AI·NAVER API) 사용법:

- "1. Naver Cloud Platform에 회원 가입하고 **카드를 등록**한다.
  (카드 등록을 해도 돈이 나가지 않는다. **등록해야만 API를 사용할 수 있다**)"
- 마이페이지 > 결제수단 관리에서 카드 등록 (체크카드 가능)

출처: https://love1905.tistory.com/6

**③ NCP 일반 가입·이용 흐름에 결제수단 등록이 포함됨**

- NCP Financial CDN+ 가입 절차: "가입한 ID/PW를 통해 로그인하고 **결제수단 선택 및 등록을 완료**해 주십시오."
  (출처: https://guide-fin.ncloud-docs.com/docs/networking-cdn-cdnconsole)
- NCP 미납 방지 안내: "서비스 이용 전, 마이페이지에서 **네이버클라우드 결제수단 등록**을 완료해 주십시오.
  (신용카드, 체크카드, 계좌이체 등 선택 가능)"
  (출처: https://3e.at-honeytips.com/entry/%EB%AF%B8%EB%82%A9-%EB%B0%A9%EC%A7%80-%ED%81%B4%EB%9D%BC%EC%9A%B0%EB%93%9C-%EA%B2%B0%EC%A0%9C-%EC%88%98%EB%8B%A8-%EB%93%B1%EB%A1%9D-%EB%B0%8F-%EB%B2%95%EC%9D%B8%EC%B9%B4%EB%93%9C-%EC%9C%A0%EC%9D%98%EC%82%AC%ED%95%AD)
- NAVER WORKS 도움말: 국내 개인 회원의 자동 결제수단은 **신용카드만 가능**.
  (출처: https://help.worksmobile.com/en/getting-started-guides/register-payment/)

**④ 공식 문서가 침묵하는 이유 — 확인의 한계 (정직한 기록)**

- NCP 공식 **NAVER API HUB 이관 가이드**
  (https://guide.ncloud-docs.com/docs/apihub-migration) 전수 열람:
  이용 신청 절차는 "콘솔 접속 → NAVER API HUB 신청하기 → Subscription [서비스 이용 신청] →
  약관 동의 → Application 등록 → API 선택 → 이름 입력"이며 **결제수단 언급 없음**.
- NCP 공식 **NAVER API HUB 사용 가이드**
  (https://guide.ncloud-docs.com/release-20260917/docs/apihub-use)에도 결제수단 언급 없음.
- **NAVER API 서비스 이용약관 (시행 2026-06-25)**
  (https://xv-ncloud.pstatic.net/images/provision/NAVER_API_%EC%84%9C%EB%B9%84%EC%8A%A4%EC%9D%B4%EC%9A%A9%EC%95%BD%EA%B4%80_APIHUB_%EC%B5%9C%EC%A2%85_260624_KR_clean_1782291589723.pdf)
  전수 열람: 결제수단 조항 없음. 단, "이용자의 NCP 플랫폼 이용에 관한 사항은
  네이버클라우드의 서비스 이용약관(https://www.ncloud.com/policy/terms/svc)이 함께 적용"된다고 명시 —
  즉 카드 요구는 API HUB 약관이 아니라 **NCP 플랫폼 가입·이용 조건 쪽에 걸려 있을 수 있다**.
- NCP 개인정보처리방침은 "자동 결제 수단 등록"을 별도 수집 항목으로 둔다
  (신용카드: 생년월일/사업자등록번호, 카드번호, 유효기간) — 가입 필수 항목이 아니라
  결제수단 등록 시 수집 항목으로 분리돼 있다.

**판정 방식:** 공식 API HUB 문서에 "카드 필수"라는 문장은 없으나,
API HUB 발급 실무 가이드(①)와 NCP API 일반 가이드(②), NCP 가입 흐름(③)이
**독립적으로 같은 결론**을 말한다. NCP는 무료 API라도 플랫폼 계정 차원에서
결제수단 등록을 API 정상 호출의 전제로 삼는 구조다.
공식 문구 부재를 "카드 불필요"로 읽는 것은 실무 보고와 모순되므로,
**카드 필요로 판정**한다. 최종 확인은 사용자가 NCP 가입을 직접 시도해 보는 것뿐이나,
그 시도 자체가 카드 등록 단계에 도달하면 중단하면 된다 — 시도 전 결론은 "필요"이다.

## 2. 이관 일정 (확정 사실)

- **2026-07-31부터** developers.naver.com에서 검색·검색어 트렌드·쇼핑인사이트 3종 API **신규 신청 불가**.
- **2027-06-30 지원 종료 — 기존 발급 키도 차단.**
- 이관 공지 이후 기존 검색 API 키가 갑자기 작동하지 않아 새 키를 발급받은 사례 보고됨
  (1년 유예 고지보다 실제 전환 체감이 빠름).
- 이후 이용자는 NCP 계정으로 가입해 새 인증키를 발급받아야 한다.
- 출처: 네이버 개발자센터 2026-06-29 공지 (조선비즈 2026-07-23 보도 경유),
  https://v.daum.net/v/20260723173625636 ·
  https://it.chosun.com/news/articleView.html?idxno=2023092166395

**즉, 옛날 방식(developers.naver.com)으로 키를 받으면 2027-06-30에 차단된다.
지금 키를 받는다면 처음부터 NCP API HUB에서 받아야 한다 — 단, 카드 문제로 보류 중 (§1).**

## 3. 무료 한도 (콘솔 요금표 직접 확인 못 함 — 2차 출처 기준)

> NCP 콘솔 요금표는 로그인 후 콘솔에서만 열람 가능해 이번 조사에서 직접 열람하지 못했다.
> 아래 수치는 공개 요금표를 인용한 보도 기준이며, **발급 시 콘솔에서 직접 재확인 필요**하다.

| API | 무료 제공량 |
|---|---|
| 검색 API | **월 775,000건까지 무료, 하루 최대 25,000건** |
| 검색어 트렌드 API | **월 30,000건 기본 무료** (30,000 초과 ~ 50,000 이하 구간은 요금표상 '유료' 분류이나 요금 0원·'한시적 무료 제공' 표기) |
| 쇼핑인사이트 API | **월 30,000건 기본 무료** (위와 동일) |

- 출처: https://v.daum.net/v/20260723173625636 (공개 요금표 인용)
- "네이버 검색 API(API HUB)는 현재 **한시적 무료**입니다. 유료로 바뀌면 네이버가 미리 공지한다고 안내하고 있습니다. (공식 안내)"
  — 출처: https://oaiwan.kr/g/naver-search
- **2027년 유료 요금제 도입 검토 중** (네이버클라우드 관계자 발언, 조선비즈/다음 보도).
  "유료화 이후에도 기존 무료 제공량은 동일하게 유지할 예정"이라고 하나 정책 리스크 존재 —
  무료 제공량 유지 여부를 주기적으로 확인할 것.

## 4. 대안 경로 (네이버 뉴스 1차 경로 보류에 따른 우선순위)

| 순위 | 경로 | 상태 (2026-10-28 기준) |
|---|---|---|
| 1 | **언론사 직접 RSS** (연합뉴스·한경·매경) | 무료·키 불필요·카드 불필요. **실험 단계** — 스테이징 Worker에서 fetch 실측부터 (Google News RSS처럼 503이면 탈락). YNA 전체 `https://www.yna.co.kr/rss/news.xml`, 경제 `https://www.yna.co.kr/rss/economy.xml`, 한경 증권 `https://www.hankyung.com/feed/finance`, 경제 `https://www.hankyung.com/feed/economy`. 저작권 표기 주의 — 제목+링크+요약 범위, 본문 통째 저장·재배포 금지. |
| 2 | **Tavily** | 한국 뉴스 1차 후보로 이미 결론 난 적 있음 (`docs/exa-news-research-20261026.md`). 키 발급 조건(카드 여부)은 별도 확인 필요 — Tavily는 카드 없이 API 키 발급 가능으로 알려졌으나 이번 조사에서 미확인. |
| 3 | **Exa** | 심층·배경용으로 유지. 단, 실시간 뉴스 인덱스가 아님 (발행일 보유율 46%) — 1차 뉴스 경로 부적합. |
| — | 네이버 뉴스 API (API HUB) | **코드 이관 완료 (2026-10-28, `apply/naver-hub`).** HUB 키 발급·Worker 시크릿 등록 완료. **스테이징 실제 호출 검증 대기** — 응답 형식·`sort=date` 동작 미확인 (§8). |

## 5. 참고: 발급 절차 (공식 이관 가이드 기준 — 현재 보류, 카드 등록을 감수할 경우에만)

> **지금 따라 하지 않는다.** 카드 등록을 감수하기로 사용자가 명시적으로 결정한 경우에만 유효한 절차다.
> 출처: NCP 공식 이관 가이드 https://guide.ncloud-docs.com/docs/apihub-migration

1. NCP(네이버클라우드플랫폼) 계정 가입 — 개인 회원 선택 (가입 후 변경 불가).
2. 콘솔 접속 → **Menu > All Services > Application Services > NAVER API HUB > 신청하기**.
3. **Subscription** 메뉴에서 **[서비스 이용 신청]** 클릭 → 이용 약관·개인정보 제공 안내 동의.
4. **결제수단 등록** — 마이페이지 > 결제관리 > 결제수단 관리에서 신용·체크카드 등록 + 휴대폰 본인 인증.
   (카드 등록이 없으면 '이용 불가 계정' 안내 또는 API 호출 오류 발생 보고 있음.)
5. **Application** 메뉴에서 **[Application 등록]** → 사용할 API 선택 (**검색**) → **[다음]** → Application 이름 입력 → 등록 완료.
6. Application Management에서 등록한 Application 선택 → **[인증 정보]** → **Client ID·Client Secret 확인**.
7. Worker Secret으로 등록: `NAVER_CLIENT_ID` · `NAVER_CLIENT_SECRET`
   (시크릿 이름은 기존 코드 `src/services/news-sources.ts`와 동일 — 값만 HUB 발급 값으로 교체.
   **키 값은 채팅·문서에 붙여넣지 않고 사용자가 직접 등록한다.**)
8. 발급 직후 스테이징에서 호출 테스트 (이관 마찰 — 기존 키 갑작스런 작동 중단 사례 있음).
9. 무료 한도 재확인: 검색 월 775,000건·일 최대 25,000건 (콘솔 요금표 기준, §3 참조).
10. 2027년 유료 요금제 도입 검토 중 — 무료 제공량 유지 여부를 주기적으로 확인.

### 코드 이관 참고 (별도 코드 트랙용 — 이 문서에서는 변경하지 않음)

> **2026-10-28 이관 완료 (`apply/naver-hub`):** 아래 표대로 `src/services/news-sources.ts`의
> 호출 도메인·Path·헤더를 교체했다. 환경변수 이름(`NAVER_CLIENT_ID`·`NAVER_CLIENT_SECRET`)은
> 그대로 둔다 (값만 HUB 키). 구 엔드포인트 폴백 없음. 근거: NCP 공식 이관 가이드
> https://guide.ncloud-docs.com/docs/apihub-migration (§4, 뉴스 검색 curl 예시 기준).
> **미확인:** HUB 응답 형식(필드명·날짜 형식)은 공식 문서에서 응답 샘플을 찾지 못해
> 확인 못 했다 — 이관 가이드도 "응답 Body 구조 — API별 확인 필요"로 명시한다.
> 파서는 구 API 형태(`items[].title/originallink/link/pubDate`)를 그대로 쓰며,
> 스테이징 실제 호출로 검증해야 한다 (§8). `sort=date`도 HUB 예시에 `query`·`display`만
> 나와 명시 확인이 안 됐다.

공식 이관 가이드 기준, HUB 호출은旧 엔드포인트·헤더와 다르다:

| 항목 | 구 Developers Center | NAVER API HUB |
|---|---|---|
| 호출 도메인 | `https://openapi.naver.com` | `https://naverapihub.apigw.ntruss.com` |
| 뉴스 검색 Path | `/v1/search/news.json` | `/search/v1/news` |
| Client ID 헤더 | `X-Naver-Client-Id` | `X-NCP-APIGW-API-KEY-ID` |
| Client Secret 헤더 | `X-Naver-Client-Secret` | `X-NCP-APIGW-API-KEY` |

현재 코드 `src/services/news-sources.ts`는 2026-10-28 이관으로 HUB 엔드포인트
(`naverapihub.apigw.ntruss.com/search/v1/news`)와 HUB 헤더를 쓴다
(브랜치 `apply/naver-hub`).

## 6. 기존 문서 정정 결과 (grep 전수)

- `developers.naver.com` 문자열: 저장소 전수 검색 결과 **0건** — 정정할 문서 없음.
- "개발자센터" + 네이버 언급: `docs/` 전수 검색 결과 **0건**.
- `openapi.naver.com` (구 API 엔드포인트): 2026-10-28 이관으로 코드
  `src/services/news-sources.ts`에서는 제거됨. 잔존: 테스트
  `tests/unit/news-sources.test.ts`·`tests/runtime/news-chain.test.ts` (별도 테스트
  트랙에서 갱신 예정 — 이 코드 트랙에서는 테스트를 건드리지 않음),
  dated 노트 `docs/msw-20261027.md:76`은 HUB 엔드포인트로 정정 완료
  (단, 해당 테스트의 실제 단언은 테스트 트랙 갱신 전까지 구 엔드포인트를 가리킴 —
  `docs/msw-20261027.md`의 2026-10-28 정정 주석 참조).

## 8. 코드 이관 후 미확인 항목 (2026-10-28, `apply/naver-hub` — 스테이징 실제 호출로 검증 필요)

| 항목 | 상태 | 비고 |
|---|---|---|
| HUB 뉴스 검색 Path `/search/v1/news` | **공식 문서 확인됨** | NCP 이관 가이드 §4 뉴스 검색 curl 예시 — https://guide.ncloud-docs.com/docs/apihub-migration |
| HUB 헤더 `X-NCP-APIGW-API-KEY-ID` / `X-NCP-APIGW-API-KEY` | **공식 문서 확인됨** | 같은 가이드 §3·§4 |
| HUB 응답 필드명 (`items`·`title`·`originallink`·`link`·`pubDate` 동일 여부) | **미확인** | 이관 가이드가 "API별 확인 필요"로 명시. 공식 응답 샘플을 찾지 못함. 파서는 구 형태 유지 |
| HUB `pubDate` 날짜 형식 (RFC 822 유지 여부) | **미확인** | 위와 동일. 파서는 `Date.parse` 기반이라 ISO·RFC 822 둘 다 처리 가능하나 실측 필요 |
| `sort=date` 파라미터 HUB 동작 | **미확인** | HUB curl 예시에 `query`·`display`만 있음. 무시되면 최신순 보장이 깨질 수 있음 |
| HUB 실제 호출 (스테이징) | **미실시** | 키 값은 다루지 않으므로 이 트랙에서 호출 검증 안 함. 스테이징에서 `searchNaverNews` 실호출로 위 3건 확인 필요 |
| 테스트 갱신 | **별도 트랙** | `tests/unit/news-sources.test.ts`·`tests/runtime/news-chain.test.ts`의 구 엔드포인트·헤더 단언 교체 필요 |

## 7. 사용자 단계 (다음 단계)

> **2026-10-28 갱신:** 1번 결정은 "카드 등록 감수"로 결론났고(사용자가 카드 등록·키 발급 완료),
> 3번의 발급·등록과 코드 이관도 완료됐다. 남은 사용자 단계는 아래와 같다.

1. **스테이징 실제 호출 검증** (별도 트랙): §8의 미확인 3건(응답 필드·pubDate 형식·`sort=date` 동작)을 스테이징 `searchNaverNews` 실호출로 확인한다.
2. **테스트 갱신** (별도 트랙): 구 엔드포인트·헤더 단언을 HUB 기준으로 교체한다.
3. 2027년 유료 요금제 도입 여부와 무료 제공량 유지 여부는 주기적 확인 대상
   (네이버가 유료화 시 사전 공지 예정).
4. 언론사 RSS는 이미 실험 완료·체인에 반영됨 (`apply/rss-feeds`) — 네이버 1차 경로의
   백업으로 유지한다.
