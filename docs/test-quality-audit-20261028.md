# MyHub 테스트 품질 감사 — 2026-10-28

- **감사 대상**: `~/workspace/myhub`, 브랜치 `fix/unlock-block-remove-ciphertext`, HEAD `8b5b96c`
- **감사 범위**: 감사만 수행, 코드·설정·테스트 파일 일절 미수정, 커밋 없음
- **기준 자료**: `reports/mutation/mutation.json` (Stryker 기준선 실행 결과), 전체 Jest 3회 전수 실행, `docs/test-theater-20261027.md` (이전 감사)
- **재사용한 확정 사실** (배경 지시대로 재조사하지 않음): 전체 Jest 242 스위트/5044 테스트, test:runtime 22/22, tsc 클린, 커버리지 Statements 99.41% / Branches 95.89% / Functions 99.49% / Lines 99.77% (2026-10-27 실측)

## 1. 품질 점수표

| 영역 | 등급 | 근거 (실측) |
|---|---|---|
| 연극 테스트 제거 | **A** | `expect(true).toBe(true)` 0건. 잔존 연극은 gate-34 1건 + 무단언 1건뿐 |
| 단언 강도 | **B−** | bare `toHaveBeenCalled()`-only 17건, `toHaveBeenCalledWith`-only 42건. `not.toHaveBeenCalled()`-only 20건은 스킵 경로 단언이라 정당 |
| 뮤테이션 | **C+** | 명목 72.25% (JSON 재계산; 배경 수치 72.47%와 0.22pp 차이 — §3.1 참조). 등가 뮤턴트 제외 시 실질 79.5~82.6% 추정치. 단, **5개 파일만 측정** — 전체 코드베이스의 뮤테이션 점수는 미확인 |
| 속성 테스트 (fast-check) | **A−** | 38건 중 34건이 진짜 property. 약점 2곳 (§5) |
| Flaky | **원인 특정됨** | 3차 전수 실행에서 재현·특정 (§6). 테스트 단언의 1ms 경계 조건이 원인 — 소스 결함이 아님 |
| 커버리지 | **A** | 99%대. 단, 커버리지가 못 잡는 구멍이 뮤테이션으로 드러남 (§7) |
| **종합** | **B** | 커버리지는 최상이나, 뮤테이션이 보여주는 "틀려도 못 잡는" 구멍이 약점. 연극은 사실상 정리 완료 |

## 2. 연극 잔존 전수 (이전 감사 대비)

측정 방법: `tests/` 전체를 대상으로 테스트 블록 단위 스캔(중괄호 매칭) + 전수 수동 검증.
스캐너는 템플릿 리터럴·중첩 중괄호에서 오탐을 내므로, 아래 수치는 **전수 수동 검증 후 확정**한 것이다.

| 항목 | 이전 감사 (2026-10-27) | 이번 실측 | 변화 |
|---|---|---|---|
| `expect(true).toBe(true)` | ~65개 파일이 연극 (정리 전) | **0건** (tests/·src/ 전수 grep) | 정리 완료 |
| 하드코딩 배열끼리 비교 | gate-34 잔존 | **gate-34 1건만 잔존** (§2.1) | — |
| 단언 없는 테스트 | — (미집계) | **1건** (§2.2) | — |
| bare `toHaveBeenCalled()`만으로 끝나는 테스트 | toHaveBeenCalled 431줄 (구분 없음) | **17건** (양의 bare-only, §2.3) | 줄었으나 잔존 |
| `toHaveBeenCalled` 총 줄 수 | 431줄 | **409줄** | −22줄 |
| mock 사용 (`jest.fn`+`jest.mock` 발생 수) | 1815건 | **920건** (`jest.fn` 801 + `jest.mock` 119) | −895건. 단, 집계 기준이 이전 감사와 다를 수 있음 (§2.4) |
| `expect(` 총 발생 수 | 미집계 | 11,436건 | — |
| 테스트 파일 수 | 242 스위트 | 161개 `.test.ts` + 85개 `.test.js` = 246개 파일, 242 스위트 | — |

### 2.1 gate-34 — 하드코딩 배열 비교 (유일한 잔존 연극)

`tests/gate-34-event-cleanup.test.js` (27줄) — 테스트 본문이 하드코딩된 배열 두 개를 비교할 뿐 실제 코드를 실행하지 않는다:

```js
const deletedTables = ['artifact_files', 'artifact_versions', 'artifact_chats', 'artifact_jobs', 'artifacts']
const missing = ['artifact_job_events'] // 누락!
expect(deletedTables).not.toContain('artifact_job_events')
expect(missing).toContain('artifact_job_events')
```

- **판정**: 다시 쓸 것. gate-45가 2026-10-27에 같은 패턴(`expect(true)` 연극)을 실제 DB + 실제 라우트 검증으로 재작성한 선례가 있다. gate-34도 같은 방식으로 재작성할 것: 실제 artifact 삭제 경로를 실행해 `artifact_job_events` 행이 함께 삭제되는지 실제 DB로 검증한다. (참고: 2026-10-27 정리 프로그램에서 아티팩트 삭제·버전 정리 FK 오류가 "P0급"으로 발견·수정된 바 있다 — 이 테스트가 그 회귀를 잡아야 한다.)

### 2.2 단언 없는 테스트 — 1건 (진짜)

- `tests/unit/job-processor-branches.test.ts` — `'agentResult.files가 없으면 빈 객체 사용'`: 본문에 단언이 없고 주석만 있다 ("에러 없이 실행되면 files || {} 분기 커버"). **판정: 다시 쓸 것** — `processArtifactJob` 실행 후 DB에 기록된 파일 목록이 `{}`(빈 객체) 기반인지, 또는 반환값을 단언한다.

### 2.3 bare `toHaveBeenCalled()`-only — 17건 (약한 단언)

"호출됐다"는 사실만 확인하고 인자·반환값·부수효과를 검증하지 않는다. **판정: 다시 쓸 것** (`toHaveBeenCalledWith` + 반환값/상태 단언으로 강화).

| 파일 | 테스트 (건수) |
|---|---|
| `tests/unit/ai-memo-tool-dispatcher.test.ts` (6건) | '상대 참조(이 메모) 패턴', '상대 참조(그 메모/최근) 패턴', 'resolve 실패(not ok) → 일반 검색 폴백', 'resolve throw → 일반 검색 폴백', 'resolve ok지만 memoId 없음 → 일반 검색 폴백', 'traceId 전달 → console.log 호출 (에러 아님)' |
| `tests/unit/ai-routes.test.ts` (10건) | '모델 오버라이드 조회 실패 → 무시', 'legacy 기억 flag 조회 throw → 무시', '메모 문맥: throw → 무시', 'v2 관련 기억 조회 실패 → 무시', '회상 질문 + 관련 기억 0건 + v2 OFF → 모델 호출', '회상 질문 + 관련 기억 있음 → 모델 호출', '일반 질문 + 관련 기억 0건 → 모델 호출', 'v2 플래그 조회 실패 → 게이트를 열지 않고 모델 호출', '기억 조회 자체가 실패하면', '메모 작성 의도 → 검색 아님' |
| `tests/sw-cache-strategy.test.js` (1건) | '프리캐시 실패해도 install은 실패하지 않음' |

특히 ai-routes 10건은 "무시 → 모델 호출"이라는 **폴백 성질**을 검증하는 테스트인데, 모델이 *무엇을 받아서* 호출됐는지(인자)를 확인하지 않는다. 예: '회상 질문 + 관련 기억 있음 → 모델 호출'은 `mockAiChat`이 관련 기억을 포함한 프롬프트로 호출됐는지까지 단언해야 폴백의 의미가 있다. 지금 상태로는 모델 호출 여부만 보고 기억이 실제로 전달됐는지는 모른다.

### 2.4 정당하다고 판정한 것 (삭제·수정 대상 아님)

- **`not.toHaveBeenCalled()`-only 20건**: 스킵 경로 단언(예: '잠금: 이미 암호화된 텍스트는 재암호화 안 함', 'skipRunLogging이면 logger 미호출', 'keeper가 아니면 사전 검색 스킵'). "호출되지 않음" 자체가 검증하려는 성질이므로 정당. 유지.
- **`toHaveBeenCalledWith`-only 42건**: 인자를 검증하므로 bare보다 강하다. 유지하되, 반환값/최종 상태를 함께 단언하면 더 강해진다 (권장, 필수 아님).
- **`toHaveBeenCalledTimes`-only 7건**: 호출 횟수 단언(예: 'Exa !ok → 2차 호출 없음' — `toHaveBeenCalledTimes(1)`). 정당. 유지.
- **`tests/unit/studio-workspace.test.ts` 66건**: 스캐너가 "단언 없음"으로 오탐했으나, 실제로는 파일 상단의 custom `assert(cond, msg)` 헬퍼로 실검증한다 (`assert(r.ok, ...)`, `assert(ws.getFiles()['a.txt'] === 'hello', ...)`). **연극이 아니다.** 단, Jest `expect`가 아니라 throw 기반이라 실패 메시지가 Jest 리포터에 덜 친화적이라는 점만 참고.
- **스캐너 오탐 4건** (수동 확인 완료 — 단언 존재): `tests/unit/studio-agent.test.ts` 'groq function.arguments 없음', `tests/unit/svc-agent-run-cov.test.ts` 'plan_json 빈 문자열', `tests/unit/search-marker.test.ts` 'JSON처럼 보이지만 깨진 평문 블록', `tests/studio-v2-async.test.js` 'modify 분기에서도 saveWorkspaceToD1 호출'. 모두 `expect` 단언이 있다.
- **gate-45** (`tests/gate-45-polling.test.js`, 187줄): 2026-10-27 재작성 완료. `pollJob` 본체는 브라우저 전용이라 직접 실행하지 않고, 폴링이 의존하는 서버 계약(GET `/jobs/:id/events?since=`, GET `/jobs/:id` — id 오름차순, since 필터, 상태 전이, 타인 소유 403)을 실제 SQLite + 실제 라우트로 검증한다. **정당한 범위 한정**으로 판정. 잔존 한계: 브라우저 타이머·재시도·lastEventId 갱신 로직 자체는 여전히 미검증 (서버 계약만으로 커버) — Playwright E2E가 아니면 잡을 수 없는 영역이라 미확인으로 둔다.

### 2.5 mock 사용량 비교 주의

이전 감사 기준 "mock 1815건"의 집계 방법이 문서에 남아 있지 않다. 이번 실측은 `jest.fn` 801건 + `jest.mock` 119건 = **920건**이다. 참고로 'mock' 단어(대소문자 무관) 발생 수는 4,634건으로, 이전 1815건과는 어느 쪽도 일치하지 않는다. **920건 vs 1815건을 직접 비교해 "절반으로 줄었다"고 단정할 수 없다** — 집계 기준 불일치 가능성을 명시한다. 다만 방향성은 일치한다: 2026-10-27 정리에서 MSW 5건 교체, mock 단언 정리 등이 있었고, `toHaveBeenCalled` 줄 수는 동일 기준(grep 줄 수)으로 431 → 409줄로 줄었다.

## 3. Stryker survived 뮤턴트 분석 (425건)

### 3.1 기준선 수치 — JSON 재계산 결과

`reports/mutation/mutation.json`을 직접 읽어 재계산했다. 배경 수치와 소수점 단위 차이가 있어 두 값을 병기한다.

| 파일 | 전체 | Killed | Survived | Timeout | NoCoverage | RuntimeError | 점수 (JSON 재계산*) | 배경 수치 |
|---|---|---|---|---|---|---|---|---|
| `src/lib/news-summary.ts` | 786 | 560 | 197 | 4 | 20 | 5 | 71.76% | 72.60% |
| `src/services/article-date.ts` | 393 | 241 | 139 | 12 | 1 | 0 | 64.38% | 64.89% |
| `src/services/news-sources.ts` | 299 | 235 | 58 | 0 | 6 | 0 | 78.59% | 79.26% |
| `src/lib/citation-lock.ts` | 132 | 108 | 21 | 0 | 3 | 0 | 81.82% | 82.58% |
| `src/lib/search-marker.ts` | 48 | 38 | 10 | 0 | 0 | 0 | 79.17% | 79.17% |
| **합계** | **1,658** | **1,182** | **425** | **16** | **30** | **5** | **72.25%** | **72.47%** |

\* 점수 = (killed + timeout) / 전체. Stryker 기본 공식이다. 배경 수치와 0.5~0.9pp 차이가 나는데, 배경 수치가 어떤 분모로 계산됐는지(또는 JSON이 배경 수치 측정 이후 재생성됐는지) 확인할 수 없어 **미확인 차이**로 기록한다. search-marker만 정확히 일치한다. 어느 쪽을 써도 결론은 같다: 명목 72%대.

**측정 범위 주의**: Stryker는 5개 파일만 대상으로 했다. 나머지 `src/` 전체의 뮤테이션 점수는 미확인이다. 72.25%는 "뉴스·인용·마커 5개 파일"의 점수이지 프로젝트 전체의 점수가 아니다.

### 3.2 survived 425건 분류

뮤턴트별 `replacement`와 소스 라인을 대조해 분류했다. 가족별 집계는 규칙 기반으로 산출하고, 등가 판정은 아래 §3.3의 증명을 따른다. "불확실"은 구분 입력 존재 여부를 확신할 수 없는 경우다.

| 가족 | 건수 | 실제 구멍 | 등가 (잡을 필요 없음) | 불확실/사소 |
|---|---|---|---|---|
| 날짜 가드 (`isValidYmd` 범위·정수 검사) | 49 | ~21 | ~28 | 0 |
| 달력 왕복 검사 (단일 조건 →true) | 13 | 0 | 13 | 0 |
| 시간 가드 (hh/mm) | 6 | 6 | 0 | 0 |
| 정규식 (Regex) | 128 | ~110 | ~2 | ~16 |
| 메서드 호출 제거 (`.trim()`·`.filter()`·`.slice()` 등) | 27 | 27 | 0 | 0 |
| 문자열 리터럴 (`"Stryker was here!"`) | 39 | ~25 | ~14 | 0 |
| 기타 조건문·연산자 | 163 | ~90 | ~40 | ~33 |
| **합계** | **425** | **~279** | **~97** | **~49** |

**실질 점수 추정치**: 등가 97건을 "잡을 필요가 없는 것"으로 제외하면 (1182 + 16 + 97) / (1658 − 30) = **79.5%**. 불확실 49건까지 제외하면 **82.6%**. 즉 등가를 걷어낸 실질 뮤테이션 점수는 **79.5~82.6%**로 추정되며, 명목 72.25%보다 7~10pp 높다. 단, 이는 분류 추정치에 의존하므로 참고 범위로 쓸 것.

### 3.3 등가 판정 — 증명된 사례 (섣불리 "구멍"이라 하지 않은 것)

**(a) 달력 왕복 검사의 단일 조건 →true (13건, news-summary L113 / article-date L70) — 등가.**
`return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d`에서
하나의 `===`만 `true`로 바꿔도 결과는 변하지 않는다. `Date.UTC` 롤오버 특성상 무효 날짜는
**항상 2개 이상의 성분이 어긋나기 때문**이다 (예: 2026-02-30 → 3월 2일: 월·일 모두 불일치.
2026-04-31 → 5월 1일: 월·일 모두 불일치. 2023-02-29 → 3월 1일: 월·일 모두 불일치).
단일 성분만 어긋나는 경우는 연도 0~99(`Date.UTC`가 1900+년으로 해석)뿐인데, 그 입력은
앞단의 `y < 1900` 가드가 먼저 차단한다. `||` 우선순위 변형(`A && B || C` 등)도 같은 이유로 등가이다.
참고로 전체 표현 →true 뮤턴트(id 263)는 2월 30일 테스트에 의해 killed됐다 — 가드 자체는 살아 있다.

**(b) 월/일 범위 가드의 전체·부분 →false (약 20건, article-date L68 / news-summary L111) — 등가.**
`if (m < 1 || m > 12 || d < 1 || d > 31) return false`를 통째로 `false`로 바꿔도,
13월·40일 같은 입력은 달력 왕복 검사에서 걸러진다 (2026년 13월 40일 → `Date.UTC(2026, 12, 40)` →
2027-02-09, 연도 불일치). 이미 존재하는 `'2026년 13월 40일' → undefined` 테스트가 이 가드를
직접 찌르지 못하는데도 통과하는 이유가 이것이다. **방어 중복**이지 테스트 구멍이 아니다.
단, 연도 범위(`y < 1900 || y > 2100`)는 달력 검사가 흡수하지 못하므로 (a)와 다르다 — 아래 §3.4 참조.

**(c) `isInteger` 가드 (8건, L67/L107) — 사실상 등가.**
`isValidYmd`의 모든 호출자는 정규식 숫자(`Number(...)`)나 URL 세그먼트 숫자만 넘기므로
비정수 입력이 도달할 수 없다. 직접 호출로만 의미를 갖는 방어 코드이다. 테스트를 추가한다면
`isValidYmd(2026.5, 10, 26)` 직접 호출 형태가 되어야 한다 (우선순위 낮음).

**(d) search-marker L21 `!text || !includes('[')` → `&&` (2건) — 등가.**
`'안녕'` 같은 입력은 원본이 조기 반환하고, 뮤턴트도 정규식 교체가 매칭되지 않아 동일하게
원문을 반환한다. 관찰 가능한 차이가 없다.

**(e) `isNewsQuery`의 `query || ''` sentinel (news-summary L34) — 등가.**
`''`을 `"Stryker was here!"`로 바꿔도 `/뉴스|속보|.../i.test()` 결과는 둘 다 `false`이다.

### 3.4 실제 구멍 — 가족별 상세

**날짜 가드 (실제 ~21건).** 연도 범위와 경계값이 핵심이다.
- 연도 범위: `y < 1900` / `y > 2100` 관련 뮤턴트(L110 6건, L68 연도 관련 ~8건). 달력 검사는 1899년·2101년을
  유효한 날짜로 받아들이므로, 이 가드가 사라지면 `extractUrlDate('https://example.com/1899/06/15/x')`가
  날짜로 오인된다. 테스트에 1899/1900/2100/2101년이 **단 한 건도 없다** (grep 확인).
  주석에 "1900~2100년 밖은 날짜가 아니라 기사 ID 등이다 (예: `/articleView/4157/`)"라고 명시된 가드의 존재 이유가
  테스트로 고정돼 있지 않다.
- 경계값: `m >= 12` (12월 거부), `d >= 31` (31일 거부), `m <= 1`, `d <= 1` (1월 1일 거부) 뮤턴트.
  테스트에 12월·31일·1월 1일 입력이 **없다** (grep 확인). fast-check `extractUrlDate` property는
  1900~2100년·1~12월·1~31일을 생성하지만, "찾은 날짜가 유효한 달력 날짜다"만 단언하고
  "경계값이 받아들여진다"는 단언하지 않으므로 이 뮤턴트를 못 잡는다.

**시간 가드 (6건, article-date L75).** `parseKoreanDate`의 `hh < 0 || hh > 23 || mm < 0 || mm > 59`
가드. `24시`·`60분` 입력 테스트가 없고, 경계 `23시`·`59분` 유효 입력 테스트도 없다.

**정규식 (실제 ~110건).** 대부분 구분 입력이 존재하는데 테스트에 없는 경우다. 대표 클러스터:
- article-date L88 (22건)·L92 (18건): 한국어 날짜 정규식의 `\s*`→`\s`/`\S*`, `\d`→`\D` 변형.
  `'2026년10월27일'`(공백 제로), `'2026년  10월  27일'`(공백 2개), 탭 포함 입력을 단언하는 테스트가 없다.
  특히 `\d{4}`→`\D{4}`가 살아 있다는 것은 **연도 4자리 형태 자체를 찌르는 테스트가
  `parseKoreanDate` 경로에 사실상 없다**는 뜻은 아니고(유효 날짜 테스트는 있다), 해당 정규식 분기가
  다른 경로로 우회되고 있음을 시사한다 — 판정은 "구분 입력 부재"로 둔다.
- search-marker L25 (6건): JSON 블록 정규식 `\s*` 변형. 유효한 JSON 블록을 공백 제로
  (`[SEARCH]{"query":"오늘 뉴스"}[/SEARCH]`)로 넣는 테스트가 없다. 깨진 JSON 테스트(L76)는
  정규식이 매칭되지 않는 입력이라 뮤턴트와 결과가 동일해 못 잡는다.
- citation-lock L95 (1건)·L182 (1건)·L183 (5건): `[기억#1]` 무공백 형태, 동사 없는 `'기억'` 회상 문구
  (`'내 반려견 이름 기억?'`류의 `(하|해|하고|나|에|을|이)?` 선택 그룹 제거 변형) 테스트 부재.
- news-summary L86/L87/L89 (9건): `NEWS_QUERY_DATE_PATTERNS`의 `\d{4}년`·`\d{1,2}월` 패턴 변형.
  `'2026년10월'`(공백 제로) 같은 구분 입력 부재.
- news-summary L166~169·L181·L197·L205·L213 (13건): URL 날짜 추출의 `^`/`$` 앵커 제거 변형.
  세그먼트 `'x2026'`·`'20261'`(앵커가 없으면 매칭됨) 같은 구분 입력 부재.
- news-summary L449 MEMO_MARKER_RE (4건, `[\s\S]*?` → `[\s\S]` 등): **불확실**로 분류.
  마커 인식 여부 자체를 단언하는 테스트가 없어, 정규식 변경이 관찰 가능한 차이를 만들지 않는다.
  마커가 포함된 텍스트가 "그대로 유지된다"는 것만 단언할 뿐, 마커로 인식됐는지는 검증하지 않는다.

**메서드 호출 제거 (27건, 전건 실제 구멍).** Stryker MethodExpression은 체인의 마지막 호출을 제거한다:
- `.trim()` 제거 10건 안팎 (citation-lock L144·L186, news-summary L78/L99/L338, article-date L86/L109/L110,
  news-sources L100, search-marker L26): 앞뒤 공백이 있는 입력의 출력 trim을 단언하는 테스트가 없다.
- `.filter((r) => isHttpUrl(r.url))` 제거 2건 (news-sources L141/L231): 네이버·Exa 매핑의 최종 비http URL
  제외 필터. 기존 '비http 제외' 테스트는 `originallink` 비http → `link` 폴백까지만 검증하고,
  **둘 다 비http인 항목의 최종 제외**는 검증하지 않는다.
- `.slice(0, 10)` 제거 2건 (news-sources L266): Exa 결과 12건 → 10건 상한 테스트 부재.
- `.slice(0, markerMatch.index)` 제거 3건 (news-summary L540/L613/L614): 출처 첨부 시 마커 뒤 꼬리(tail)
  분리. 마커 뒤에 꼬리 텍스트가 있는 입력의 본문 분리 단언 부재.
- 기타: `Math.min`→`Math.max` (article-date L241, fetch 타임아웃 계산), `verified.slice(0, limit)` 제거
  (L283), `checks.filter(...)` 제거 (news-sources L403, `dropped` 계산), `seen.add(key)` 제거
  (news-sources L414, dedupe 키 등록 — 중복 URL 제거 자체가 이 뮤턴트로는 검증 안 됨).

**문자열 리터럴 (실제 ~25건).** `stripHtmlTags`의 엔티티 교체값 `''`→sentinel 5건
(news-sources L102~106: `&amp;`·`&quot;`·`&#39;`·`&lt;`·`&gt;` 각각을 단언하는 테스트 없음),
`.join('\n')`→`''` (news-summary L556/L626: 여러 줄 출력의 줄바꿈 단언 부재),
`out.replace(..., '')`·`' '` 교체값 (L100/L458/L507) 등. 등가 ~14건은 출력에 영향 없는
초기값(`let path = ''`, `let tail = ''` 등)이다.

**기타 조건문 (실제 ~90건).** 주요 클러스터:
- news-sources 오케스트레이션: L392 Exa 검증 단계 조건 (`fresh.length > 0 && items.length < target` —
  fresh 0건일 때 검증 스킵 분기 미검증), L160 RSS 10건 상한 (`out.length < 10` → `<= 10`:
  정확히 10건인 피드 테스트 부재), L401 `target - items.length` → `+` (limit 계산 미검증),
  L404 `dropped > 0` → `>= 0` (verifyDropped 기록 분기), L327 `timedOut` 초기값,
  L336 `NAVER_CLIENT_ID && NAVER_CLIENT_SECRET` → `||` (둘 중 하나만 설정한 경우 테스트 부재),
  L218/L257/L260 요청 본문·헤더 ObjectLiteral `{}` (Exa/Tavily 요청 페이로드 단언 부재 — MSW 테스트가
  호출 형태를 검증한다고 하나, 본문 전체가 `{}`로 바뀌어도 통과한다는 뜻이다. MSW 단언의 강도를 재점검할 것),
  L441/L446/L449/L450 결과 객체의 선택 필드 (`timedOut`·`skipped`·`verifyDropped`·`error` 포함 여부 단언 부재).
- news-summary 출처 첨부/검증: L539/L612 `markerMatch.index !== undefined` 블록 통째로 비우기
  (해당 분기의 효과를 단언하는 테스트 없음), L566 `if (keptKey)` 블록 비우기, L535/L607
  `!text || pool.length === 0` → `&&` (빈 텍스트 + 빈 풀 조합 미검증), L279/L289/L292 창 경계
  (`date <= startDate`·`t <= start` — 창 시작일과 **정확히 같은** 날짜·시각의 포함 여부 단언 부재),
  L588 말미 빈 줄 제거 while 루프 (조건 반전·경계 미검증), L342~349 URL 정규화 인덱스 경계
  (`schemeIdx`·`slashIdx`·`hashIdx`가 0인 경우 — `'https://'` 직후 슬래시 등).
- article-date fetch/검증 파이프라인: L250 `if (!res.ok)` 블록 비우기 (비정상 응답 시 throw 단언 부재),
  L261 창 경계 (`kstDate <= window.startDate` — 창 시작일과 같은 날짜 단언 부재),
  L275 deadline `>=` → `>` (정확히 deadline에 도달한 경우), L277 `batchSize` 산술
  (`limit - verified.length`·`items.length - idx` → `+` 변형), L241 `Math.min` → `Math.max`,
  L123/L158 `|| []` → `["Stryker was here"]` (매칭 실패 시 빈 배열 폴백 단언 부재).
- citation-lock: L84 `if (!key) continue`, L99 `if (!text) return []`, L187 `if (!t) return false`
  (빈 입력 가드 단언 부재), L137 `removed.length > 0` → `>= 0` (**등가 쪽에 가까움** — removed가 비면
  교체가 no-op이라 관찰 차이가 거의 없다. 불확실로 둔다).

## 4. 잡아야 할 상위 10개 (구체적 킬 테스트)

우선순위는 (a) 성질의 중요도 (날짜 가드·뉴스 신선도가 비서의 존립 조건) × (b) 한 번에 잡히는 뮤턴트 수로 정했다.
아래 테스트를 추가하면 명목 점수는 약 72.25% → **약 78%**로 오를 것으로 추정한다 (상위 10개만으로 약 90~100건 킬).
등가 뮤턴트는 제외하고 계산한 것이 아니라, 아래 목록은 전부 실제 구멍만 모은 것이다.

| # | 파일·성질 | 추가할 테스트 (입력 예시 포함) | 잡히는 뮤턴트 |
|---|---|---|---|
| 1 | `src/lib/news-summary.ts` L110 + `src/services/article-date.ts` L68 — 연도 범위 가드 | `extractUrlDate('https://example.com/1899/06/15/x')` → `null`; `parseKoreanDate('1899년 6월 15일')` → `undefined`; `parseKoreanDate('2101년 1월 1일')` → `undefined`; 경계 `extractUrlDate('https://example.com/1900/01/01/x')` → `{date:'1900-01-01', precise:true}`, `2100-12-31` 유효 단언 | ~14건 (L110 6건 + L68 연도 관련 ~8건) |
| 2 | `src/lib/news-summary.ts` L111 + `src/services/article-date.ts` L68 — 월/일 경계 | `extractUrlDate('https://example.com/2026/12/31/x')` → `{date:'2026-12-31', precise:true}`; `parseKoreanDate('2026년 12월 31일')` 유효; `parseKoreanDate('2026년 1월 1일')` 유효 | ~7건 (`m>=12`, `d>=31`, `m<=1`, `d<=1` 등) |
| 3 | `src/services/article-date.ts` L75 — 시간 가드 | `parseKoreanDate('2026년 10월 26일 24시 00분')` → `undefined`; `parseKoreanDate('2026년 10월 26일 21시 60분')` → `undefined`; 경계 `23시 59분` 유효 단언 | 6건 |
| 4 | `src/lib/search-marker.ts` L25 — JSON 블록 공백 제로 | `normalizeSearchMarkers('[SEARCH]{"query":"오늘 뉴스"}[/SEARCH]')` → `'[SEARCH: 오늘 뉴스]'`; 콜론 뒤 공백 제로 + 중괄호 앞 공백 제로 조합 2~3종 | 6건 (Regex) |
| 5 | `src/services/news-sources.ts` L141/L231 — 최종 비http 필터 | Naver MSW 응답에 `{title:'x', originallink:'ftp://a', link:'notaurl'}` 항목 추가 → 결과에서 제외 단언; Exa 결과 `{title:'x', url:'ftp://a'}` → 제외 단언 | 2건 (MethodExpression) + 관련 StringLiteral |
| 6 | `src/services/news-sources.ts` L266 + L160 — 10건 상한 | Exa 결과 12건 → 반환 10건 단언; RSS `<item>` 12개 피드 → 10건 단언; 정확히 10건인 피드도 단언 (`<=` 변형 킬) | 4건 |
| 7 | `src/services/news-sources.ts` L102~106 — HTML 엔티티 디코딩 | 제목 `'A &amp; B &quot;C&quot; &#39;D&#39; &lt;E&gt; &gt;'` → `'A & B "C" 'D' <E> >'` 단언 (네이버·RSS 경로 각각) | 5건 (StringLiteral) + L100 MethodExpression |
| 8 | `src/lib/search-marker.ts` L26 + `src/lib/news-summary.ts` L78/L99 — `.trim()` | `normalizeSearchMarkers('[SEARCH]{"query": "  오늘 뉴스  "}[/SEARCH]')` → `'[SEARCH: 오늘 뉴스]'`; `buildDatedNewsQuery('  오늘 뉴스  ')` → 앞뒤 공백 없는 오늘 날짜 질의; `parseKoreanDate('  2026년 10월 26일  ')` 유효 단언 | ~6건 |
| 9 | `src/lib/citation-lock.ts` L144 + L95/L182/L183 — 인용 정리·회상 패턴 | 인용 제거 후 `'A  B'`(이중 공백) → `'A B'`, 문장 끝 공백 trim 단언; `'[기억#1]'`(무공백) 인식 단언; `'내 반려견 이름 기억?'`(동사 없는 회상) 인식 단언 | ~9건 |
| 10 | `src/lib/news-summary.ts` L279/L289/L292 — 창 경계 | `filterNewsWindow`에 `publishedDate`가 창 시작일 00:00:00 KST와 **정확히 같은** 항목 → 포함 단언; 창 종료일 23:59:59.999와 같은 항목 → 포함; 1ms 밖 항목 → 제외 | ~6건 |

**다음 순위 (상위 10개 이후)**: news-sources 오케스트레이션(L392 fresh 0건 시 검증 스킵, L401 limit 계산, L336 키 하나만 설정, L441/L446/L449 선택 필드 단언), news-summary 출처 첨부 꼬리 분리(L540/L613/L614 — 마커 뒤 꼬리 텍스트가 본문에 남지 않음 단언), article-date fetch 파이프라인(L250 `!res.ok` throw, L241 타임아웃 `Math.min`, L275 deadline 경계), `dedupeSources` 중복 제거(L414 `seen.add` — 동일 URL 2건 → 1건 단언), `NEWS_QUERY_DATE_PATTERNS` 공백 제로 입력(L86/L87/L89).

## 5. fast-check 38건 품질 검토

실측: 3개 파일 합계 **38개 테스트 = property 34건 + 회귀 예시 4건**.
(파일별: markers 14건 = property 12 + 회귀 2 / news 15건 = property 14 + 회귀 1 / FTS 9건 = property 8 + 회귀 1.
배경의 "마커 13 / FTS 10"과는 파일별 집계가 1건씩 어긋나므로, 위 실측을 기준으로 쓸 것. 합계 38건은 일치한다.)

3개 파일을 전수 정독한 결과, **예시 나열에 불과한 파일은 없다.** 34개 property는 모두 무작위 입력에 대한
불변식(round-trip·상한·멱등·형태·무예외)을 단언한다. 다만 약점 2곳과 주의점 1건이 있다.

### 5.1 진짜 property인 것 (대표)

- **markers** — round-trip(직렬화→파싱 동일성, 200자 상한 반영), 턴당 상한(검색/조회 3·생성/수정/삭제 2),
  깨진 JSON 무예외 무시, id 안전 정수, 마커 없음 → 빈 배열. 반례로 실제 결함 1건(수정/삭제 마커 id 미검증)을
  찾아낸 이력이 있다.
- **news** — 창 밖·날짜 없음·파싱 불가 항목 절대 미통과, 필터 멱등, 창은 항상 [어제, 오늘] KST 2일,
  질의 날짜 소독 멱등 + 오늘 날짜 시작, URL 정규화 멱등, dedupe 정규화 기준 중복 제거 + 첫 등장 순서 유지,
  `extractUrlDate` 반환값은 항상 유효한 달력 날짜(500 runs, 역방향 검증 포함).
  반례로 실제 결함 1건(URL 정규화 말단 슬래시 멱등성 위반)을 찾아낸 이력이 있다.
- **FTS** — `extractSearchTerms` 최대 5개·2글자 이상·입력 토큰 순서 유지 부분집합,
  `stripKoreanParticle` 결과는 원본 접두사·2글자 미만으로 안 줄어듦,
  `buildFtsQuery` 출력은 `"…"` 구들의 OR 결합 + 추출된 모든 검색어 이스케이프 포함,
  **실제 SQLite FTS5 MATCH에서 문법 오류 없음 (better-sqlite3 인메모리 실검증, 500 runs)**,
  `fusionScore` 임의 수치 입력에도 [0, 1] 안의 유한수 (500 runs),
  `parseEntities` 임의 입력 무예외 + 문자열 배열 반환.
  반례로 실제 결함 1건(`fusionScore` NaN 전파)을 찾아낸 이력이 있다.

### 5.2 약점

1. **news `'상대 표현(어제/오늘)은 건드리지 않는다'` — property 라벨이지만 사실상 고정 예시 4건.**
   `fc.constantFrom('어제 뉴스', '오늘 속보', '어제자 헤드라인', '오늘의 주요 뉴스')`로 4개 고정 문자열만
   돌린다. 무작위성이 없어 property라기보다 예시 테스트에 가깝다.
   **조치**: `'어제'/'오늘'`을 임의 접두사·접미사와 결합하는 생성기로 바꿀 것
   (예: `fc.tuple(fc.constantFrom('어제','오늘'), fc.string({maxLength:20}))`).
2. **`isExactlyMidnightUtc` property — 단방향만 검증.**
   `if (isExactlyMidnightUtc(iso)) { ...자정 단언... }` — true인 경우만 검증하고,
   실제 자정인데 false를 내는 경우(완전성)는 검증하지 않는다. `fc.date()`에서 자정을 직접 생성해
   `isExactlyMidnightUtc(자정 ISO) === true`를 단언하는 방향을 추가할 것.
3. **markers `'깨진 JSON·쿼리 누락 마커는 예외 없이 무시된다'` — 조건부 단언으로 일부 입력이 공허(vacuous).**
   무작위 junk가 우연히 유효한 JSON + 문자열 query이면 아무것도 단언하지 않는다
   (그 분기에는 `toHaveLength(0)` 단언이 없다). **조치**: 유효한 query가 있는 경우
   `parsed[0].query`가 junk의 query와 같음을 단언하는 분기를 추가할 것.
4. **`newsWindow`·`isExactlyMidnightUtc`의 `noInvalidDate: true` — 문서화된 의도적 제외.**
   `fc.date()` 기본값이 Invalid Date를 생성해 `Intl.DateTimeFormat.formatToParts`가 RangeError를 던지던
   flaky의 원인이었고 (2026-10-27 수정, 커밋 ae570c9), "프로덕션 호출자는 Invalid Date를 넘길 수 없다"는
   이유로 생성기에서 제외했다. 제외 근거가 주석에 명시돼 있어 **정당한 범위 한정**으로 판정한다.
   단, 호출자 전제가 깨지면 RangeError가 재발하므로, `kstTodayStr`에 Invalid Date 가드를 넣는 것은
   별도 판단 사항으로 남긴다 (이번 감사에서는 판정하지 않음).

### 5.3 fast-check의 한계 (참고)

- `fusionScore` property는 [0, 1] 유한수만 검증한다. `ageDays` 비유한값이 기본값 0(최신 취급)으로
  소독되는 의미론적 선택(배경: 결정 대기 중)은 property로 잡을 수 없는 종류의 문제다.
- `extractUrlDate` property는 "찾은 날짜가 유효하다"만 검증하고 "경계값이 받아들여진다"는 검증하지 않는다.
  그래서 §4의 #2 경계 뮤턴트(m=12, d=31)를 못 잡았다. **property에 "수용" 방향 단언을 추가할 것**
  (예: 1900-01-01·2100-12-31·12월·31일 입력을 명시적으로 생성해 `found`가 non-null임을 단언).

## 6. flaky 정체 추적 — **재현·특정 완료**

- **배경**: 2026-10-27 전체 Jest 1차 재실행에서 1건 실패(5003/5004) 후, 2회 전수 재실행은 모두 5004/5004 통과.
  실패 테스트 미식별(`tail`로 요약만 남김). 2026-10-26에도 동일 패턴(첫 실행 실패 후 재실행 전수 통과, 원인 미특정) 기록 있음.
- **이번 재현 시도**: 전체 스위트 3회 전수 실행 — 1차 5044/5044 통과(164.9초), 2차 5044/5044 통과(89.6초),
  **3차 5043/5044 (1건 실패, 84.0초) — 재현 성공.** 실패 로그 전체를 `/tmp/jest-run3.log`에 확보했다.
- **특정된 테스트**: `tests/unit/article-date.test.ts` — `'verifyArticleDates › deadline 이후에는 새 fetch를 시작하지 않는다 (시작 시각이 deadline 이전)'` (308행).

  ```
  expect(received).toBeLessThan(expected)
  Expected: < 1793144368433
  Received:   1793144368433
  ```

  즉 fetch 시작 시각이 deadline과 **정확히 같은 밀리초**였다 (`<`가 아니라 `==`).

### 6.1 근본 원인 (확정)

**테스트 단언의 1ms 경계 조건 문제 — 소스 결함이 아니다.**

- 소스(`src/services/article-date.ts` L275)는 배치 시작 전에 `if (deadline !== undefined && Date.now() >= deadline) break`로
  검사한다. 검사를 통과했다는 것은 그 순간의 `Date.now()`가 deadline보다 작았다는 뜻이다.
- 테스트의 mock `fetchFn`은 호출될 때 **별도의** `Date.now()`를 읽어 `starts`에 기록한다
  (`tests/unit/article-date.test.ts` L287: `starts.push(Date.now())`).
- 검사와 기록이 서로 다른 `Date.now()` 읽기이므로, 검사 읽기가 deadline 1ms 전(예: `...432`)이고
  기록 읽기가 deadline과 같은 ms(예: `...433`)가 될 수 있다. `Date.now()`는 1ms 단위라 이 경계가 실제로 발생한다.
- 테스트는 `for (const t of starts) expect(t).toBeLessThan(deadline)`로 엄격한 `<`를 단언한다.
  주석은 "타이머 1ms 오차와 무관한 불변식"이라고 주장하지만, **정반대**다 — 이 단언은 정확히 1ms 경계에 민감하다.
- 타이밍 구조: deadline = `Date.now() + 120`, fetch 1건당 80ms, concurrency 1.
  정상 흐름은 fetch 2건 시작(~0ms, ~80ms) 후 160ms 지점에서 검사 탈출이다.
  첫 번째 80ms 타이머가 이벤트 루프 지연 등으로 정확히 120ms 지점에 발화하면 두 번째 fetch 시작 시각이
  deadline과 같은 ms가 되어 실패한다. 전수 실행 시의 부하가 이 지연을 만들기 때문에 단독 실행에서는 잘 안 터진다.

### 6.2 재현율 측정

- 전수 실행: 3회 중 1회 실패 (1차·2차 통과, 3차 실패). 2026-10-26·27 기록까지 합하면 전수 실행 5회 중 3회 실패 꼴이나,
  모수가 작아 확률로 단정하지 않는다.
- 단독 반복 실행: 해당 테스트만 `-t` 필터로 30회 반복 → **30/30 통과**. 단독 실행에서는 타이머 지연이 작아
  경계에 걸리지 않는다. 단독 재현이 안 된다고 원인이 흔들리는 것은 아니다 — 실패 로그의 `Received == Expected`
  동일값이 메커니즘을 직접 증명한다.

### 6.3 권장 수정 (감사 의견 — 이번 트랙에서는 수정하지 않음)

- **권장안**: 단언을 `expect(t).toBeLessThanOrEqual(deadline)`으로 완화하고, 주석을
  "`Date.now()` 1ms 단위라 검사 통과 후 같은 ms에 시작할 수 있음 — 시작 시각이 deadline을 초과하지 않음이 불변식"으로 고친다.
  소스의 `>=` 검사가 "deadline 이후 시작 금지"를 보장하므로, `<=`가 성질을 약화시키지 않는다
  (초과 시작은 여전히 실패로 잡힌다).
- **대안**: mock이 `starts`에 기록하는 시각을 소스 검사와 같은 `Date.now()` 호출로 묶을 수 없으므로,
  deadline을 120ms가 아니라 여유 있게(예: 200ms) 잡고 fetch 시간을 80ms로 두는 방법도 있으나,
  경계 조건 자체를 없애지 못하므로 권장하지 않는다.
- **재발 방지**: 이 테스트는 전수 실행에서만 간헐적으로 터지므로, CI가 있다면 전수 실행 로그 전체를 파일로 남길 것.
  `--silent`로 실행하면 실패 상세는 남지만, 실패 테스트명 확보를 위해 요약(`tail`)만 남기지 말 것.

## 7. 커버리지 vs 뮤테이션 간극 — 왜 99% 커버리지인데 뮤테이션은 72%인가

커버리지는 "라인이 실행됐는가"를 재고, 뮤테이션은 "코드를 틀리게 바꿔도 테스트가 알아채는가"를 잰다.
99% 커버리지와 72% 뮤테이션 사이의 간극은 다음 네 종류의 구멍에서 온다. 전부 이번 감사에서 실증된 사례다.

1. **실행됐지만 단언이 값을 보지 않음 (가장 큰 간극).**
   라인은 밟혔으나 단언이 출력 "값"을 검증하지 않으면 뮤턴트가 살아남는다.
   예: `stripHtmlTags`의 `&amp;`→`''` 교체는 실행되지만, 엔티티가 포함된 제목의 **변환 결과**를 단언하는
   테스트가 없어 sentinel로 바꿔도 통과한다. `toHaveBeenCalled`류 단언(호출 여부만 봄)도 같은 부류이다.
   커버리지는 "호출됐다"를 세지 "무엇이 반환됐는지"는 세지 않는다.
2. **방어 중복 — 가드가 틀려도 다른 가드가 같은 결론을 냄.**
   §3.3(b): 월/일 범위 가드를 통째로 꺼도 달력 왕복 검사가 같은 결론을 낸다. 라인은 100% 실행되고
   분기도 양쪽 다 밟히지만, 가드 자체의 존재를 증명하는 테스트는 없다. 커버리지는 "방어가 몇 겹인지"를 모른다.
   역설적으로 **방어가 잘 돼 있을수록 뮤테이션 점수가 낮게 나오는** 경우다. 이 부류(약 20건)는
   테스트 구멍이 아니라 등가 뮤턴트이므로, 점수만 보고 "테스트가 부실하다"고 단정하면 안 된다.
3. **경계값 부재 — 분기는 밟혔지만 경계 입력이 없음.**
   `y < 1900` 분기는 실행됐을 수 있으나(1900~2100년 입력이 false 분기를 밟는다),
   `y = 1900`·`y = 2100`·`m = 12`·`d = 31` 같은 경계 입력이 없으면 `<=`/`>=` 변형을 못 잡는다.
   브랜치 커버리지(95.89%)도 "양쪽 분기를 밟았는가"까지만 보고 "경계에서 동작이 바뀌는가"는 보지 않는다.
4. **정규식·문자열 리터럴의 의미 차이.**
   정규식 `\s*` vs `\s`, 문자열 `'\n'` vs `''` 같은 차이는 라인을 실행하는 것만으로는 드러나지 않는다.
   구분 입력(공백 제로 JSON, 여러 줄 출력)이 있어야만 잡힌다. Regex 뮤턴트 128건 중 ~110건이 이 부류이다.

**결론**: 커버리지 99%는 "테스트가 코드를 실행한다"는 증거이지 "테스트가 코드를 검증한다"는 증거가 아니다.
뮤테이션 72.25%는 후자의 척도이며, 등가를 제외한 실질 점수 79.5~82.6%가 현재 테스트의 실질 검증력에 가깝다.
남은 간극(~17~20pp)은 위 1·3·4번 부류의 실제 구멍이며, §4의 상위 10개 테스트로 약 6pp를 메울 수 있다.

## 8. 고쳐야 할 목록

### 8.1 다시 쓸 것 (파일별)

| 파일 | 항목 | 사유·근거 |
|---|---|---|
| `tests/gate-34-event-cleanup.test.js` | 테스트 1건 전체 재작성 | 하드코딩 배열끼리 비교 — 실제 코드 미실행 (§2.1). gate-45 선례대로 실제 DB + 실제 삭제 경로로 검증 |
| `tests/unit/job-processor-branches.test.ts` | 'agentResult.files가 없으면 빈 객체 사용' 1건 | 단언 없음, 주석만 있음 (§2.2) |
| `tests/unit/ai-memo-tool-dispatcher.test.ts` | bare-only 6건 | 호출 여부만 확인, 인자·반환값 미검증 (§2.3) |
| `tests/unit/ai-routes.test.ts` | bare-only 10건 | 폴백 성질("무시 → 모델 호출")을 인자 없이 검증 (§2.3). 특히 기억 전달 여부 단언 필요 |
| `tests/sw-cache-strategy.test.js` | '프리캐시 실패해도 install은 실패하지 않음' 1건 | bare-only (§2.3) |
| `tests/unit/article-date.test.ts` | 'deadline 이후에는 새 fetch를 시작하지 않는다' (308행) | **flaky 원인 특정됨** (§6). `toBeLessThan(deadline)` → `toBeLessThanOrEqual(deadline)`로 완화 + 주석 정정. 소스 결함이 아니라 테스트 단언의 1ms 경계 문제 |
| `tests/unit/fastcheck-news.test.ts` | '상대 표현(어제/오늘)은 건드리지 않는다' | 고정 예시 4건에 property 라벨 (§5.2-1) |
| `tests/unit/fastcheck-news.test.ts` | `isExactlyMidnightUtc` property | 단방향(검증)만 있고 완전성(자정 → true) 없음 (§5.2-2) |
| `tests/unit/fastcheck-markers.test.ts` | '깨진 JSON·쿼리 누락 마커는 예외 없이 무시된다' | 유효 query 입력 시 단언이 공허 (§5.2-3) |

### 8.2 삭제할 것

- **없음.** `expect(true).toBe(true)` 0건, 삭제 대상 연극 파일 없음.
- 주의: `tests/unit/studio-workspace.test.ts` 66건은 custom `assert()` 실검증이라 삭제 대상이 아니다 (§2.4).

### 8.3 새로 추가할 테스트

| 대상 파일 | 추가할 테스트 | 근거 |
|---|---|---|
| `tests/unit/news-summary.test.ts` | 연도 범위(1899/1900/2100/2101), 월/일 경계(12월·31일·1월 1일), 창 경계(시작일·종료일 정확히 일치) | §4 #1·#2·#10 — 뮤턴트 ~27건 킬 |
| `tests/unit/article-date.test.ts` | 연도 범위, 시간 가드(24시·60분·23시59분 경계) | §4 #1·#2·#3 — 뮤턴트 ~20건 킬 |
| `tests/unit/search-marker.test.ts` | JSON 블록 공백 제로, query 값 trim | §4 #4·#8 — 뮤턴트 ~7건 킬 |
| `tests/unit/news-sources.test.ts` | 최종 비http 필터, 10건 상한(Exa·RSS), HTML 엔티티 디코딩, fresh 0건 시 검증 스킵, limit 계산, 키 하나만 설정, 선택 필드 단언, dedupe 중복 제거 | §4 #5·#6·#7 + 다음 순위 — 뮤턴트 ~30건 킬 |
| `tests/unit/citation-lock.test.ts` | 이중 공백 정리·trim, `[기억#1]` 무공백, 동사 없는 회상 문구 | §4 #9 — 뮤턴트 ~9건 킬 |
| `tests/unit/fastcheck-news.test.ts` | `extractUrlDate` property에 경계값 수용 단언 추가 | §5.3 — 경계 뮤턴트 킬 |
| `tests/unit/news-summary.test.ts` (또는 신규) | 출처 첨부 꼬리 분리, `markerMatch.index` 분기 효과 단언 | §3.4 기타 조건문 — 뮤턴트 ~10건 킬 |

### 8.4 유지할 것 (정당한 현재 상태)

- `not.toHaveBeenCalled()`-only 20건, `toHaveBeenCalledWith`-only 42건, `toHaveBeenCalledTimes`-only 7건 (§2.4).
- gate-45의 서버 계약 검증 범위 (§2.4). 브라우저 폴링 본체는 Playwright E2E 영역으로 남긴다.
- fast-check `noInvalidDate: true` 제외 (§5.2-4). 단, `kstTodayStr` Invalid Date 가드는 별도 판단 사항.

## 9. 미확인 항목

1. **Flaky 정체 — 해결됨 (이번 감사에서 특정)** (§6): `tests/unit/article-date.test.ts`의
   deadline 테스트 — `toBeLessThan(deadline)` 단언이 fetch 시작 시각과 deadline이 같은 ms인 경우에 실패.
   원인: 검사와 기록이 서로 다른 `Date.now()` 읽기. 권장 수정: `toBeLessThanOrEqual`로 완화.
   단독 30회 반복은 30/30 통과(전수 부하에서만 터짐).
2. **Stryker 배경 수치와 JSON 재계산 수치 간 0.22~0.9pp 차이** (§3.1): 분모·계산식 또는 JSON 재생성 여부를 확인할 수 없음.
3. **mock 1815건 vs 920건 비교** (§2.5): 이전 감사 집계 기준이 문서에 없어 직접 비교 불가.
4. **전체 코드베이스 뮤테이션 점수**: Stryker는 5개 파일만 측정. 나머지 `src/`의 뮤테이션 점수는 미확인.
5. **fast-check 파일별 집계 차이**: 배경 "마커 13 / FTS 10" vs 실측 "마커 14 / FTS 9" (합계 38건은 일치).
   배경이 property만 센 것인지, 회귀 예시를 다르게 분류한 것인지 미확인.
6. **`isValidYmd` 정수 가드의 실질 의미** (§3.3-c): 호출자가 항상 정수를 넘긴다는 전제를 코드로 확인했으나,
   외부에서 직접 호출되는 경로가 있는지는 전수 확인하지 않음.
7. **MEMO_MARKER_RE 뮤턴트 4건의 판정** (§3.4): 마커 인식 여부 자체를 단언하는 테스트가 없어
   등가인지 실제 구멍인지 확정하지 못함. 불확실로 둔다.
8. **MSW 단언 강도** (§3.4): Exa/Tavily 요청 본문·헤더 ObjectLiteral `{}` 뮤턴트가 살아 있다는 것은
   MSW 테스트가 호출 형태를 충분히 단언하지 않을 수 있음을 시사한다. MSW 핸들러 단언 범위를 직접 대조하지는 않았으므로 미확인으로 둔다.
9. **커버리지 수치 재실행 여부**: 배경 수치(2026-10-27 실측)를 그대로 인용했으며, 이번 감사에서 커버리지를
   재실행하지 않았다. HEAD가 같으므로(8b5b96c) 수치는 유효한 것으로 본다.
10. **Stryker Timeout 16건·RuntimeError 5건**: 어떤 뮤턴트인지 개별 확인하지 않음.
    Timeout은 "무한 루프 유발 뮤턴트"일 가능성이 높아 테스트 구멍이라기보다 뮤턴트 특성일 수 있으나 미확인이다.

## 부록: 실측 명령·산출 근거

- 전체 Jest 1차: `npx jest --silent` → 242 스위트 / 5044 테스트 통과 (164.9초), `/tmp/jest-run1.log`
- 전체 Jest 2차: 동일 명령 → 242 스위트 / 5044 테스트 통과 (89.6초), `/tmp/jest-run2.log`
- 전체 Jest 3차: 동일 명령 → **5043/5044 (1건 실패 — flaky 재현, §6)**, 84.0초, `/tmp/jest-run3.log`
  (실패: `tests/unit/article-date.test.ts` — deadline 테스트)
- 연극 스캔: `grep -rn 'expect(true).toBe(true)'` 0건, `grep -rno 'jest.fn'` 801건, `jest.mock` 119건,
  `toHaveBeenCalled` 409줄, `expect(` 11,436건 + 테스트 블록 단위 파이썬 스캔 + 전수 수동 검증
- 뮤테이션: `reports/mutation/mutation.json` 직접 파싱 (총 1,658건: killed 1182 / survived 425 / timeout 16 /
  noCoverage 30 / runtimeError 5), 184개 라인 클러스터로 집계 (`/tmp/survived-clusters.txt`, 감사 스크래치 — 저장소 밖)
- fast-check: 3개 파일 전수 정독 + `grep -c` 집계 (markers 14 / news 15 / FTS 9 = 38건)
- 경계값 부재 확인: `grep -rn '12월|/12/|31일|1899|1900|2100|2101'` (article-date·news-summary·fastcheck-news) — 해당 입력 없음
