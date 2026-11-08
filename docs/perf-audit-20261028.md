# MyHub 성능 감사 — 2026-10-28

- **범위**: 라이브 지연 · 배포 번들 · D1 쿼리 패턴 · AI/외부 호출 시간 예산 · 테스트 스위트 속도
- **작업 위치**: `~/workspace/myhub`, 브랜치 `fix/unlock-block-remove-ciphertext`, HEAD `8b5b96c`
- **운영 라이브 버전**: `89efaa42` (`https://myhub.myhub-app.workers.dev`)
- **감사만 수행, 코드 수정 없음.** 운영 D1 쓰기·운영 배포·부하 테스트 없음. 라이브 측정은 가벼운 GET 타이밍만 사용.
- **원칙**: 숫자는 전부 실측. 확인 못한 것은 "미확인"으로 표기.

## 1. 라이브 지연 (curl, 2026-10-28 측정)

각 엔드포인트 3회씩, `--max-time 30`. TTFB ≈ 전체 시간으로, 응답 전송 시간보다 서버 측 대기 시간이 지배적이다.

| 엔드포인트 | 1회 | 2회 | 3회 | 평균 | 최대 | 크기 | 상태 |
|---|---|---|---|---|---|---|---|
| `/api/health` | 0.968s | 0.499s | 0.545s | **0.671s** | 0.968s | 25 bytes | 200 |
| `/` | 0.430s | 0.733s | 0.421s | **0.528s** | 0.733s | 0 bytes (302) | 302 |
| `/login.html` | 0.522s | 0.338s | 0.488s | **0.449s** | 0.522s | 4,784 bytes | 200 |
| `/manifest.json` | 0.508s | 0.467s | 0.400s | **0.458s** | 0.508s | 379 bytes | 200 |

- `/api/health` 응답 본문은 `{"ok":true,"app":"MyHub"}` 25 bytes이다.
- **참고 수치 정정**: 과제 지문의 "배포 검증 때 /api/health는 148,292 bytes"는 이번 측정과 맞지 않는다. 148,292는 `public/wallpaper.webp` 파일 크기와 정확히 일치한다. 과거 기록이 다른 엔드포인트(또는 파일)와 혼동된 것으로 보이며, 이번 실측 기준 `/api/health`는 25 bytes이다.
- 첫 번째 `/api/health` 요청(0.968s)이 이후 요청(~0.5s)보다 ~2배 느렸다. Cold start 가능성을 시사하지만, 3회 샘플만으로는 단정할 수 없다. **Cold start 실측은 미확인** (isolate 초기화 시간은 외부 curl로 분리 측정 불가. Worker tail CPU 시간 확인이 필요하다).

## 2. 번들 크기

### 2.1 배포 번들 실측

`/tmp/myhub-inline.js`가 없어 배포 스크립트와 동일 명령으로 로컬 재생성했다
(`npx esbuild src/index-inline.ts --bundle --format=esm --platform=neutral --external:cloudflare:workers --outfile=/tmp/myhub-inline.js --metafile=...`).
결과는 배포 시와 **바이트 단위로 동일**하다.

| 항목 | 실측 |
|---|---|
| 번들 크기 | **4,236,453 bytes (4.0 MB)** |
| gzip 압축 후 | 1,883,106 bytes (1.8 MB) |
| esbuild 입력 총합 | 4,672,368 bytes |
| Cloudflare Workers 스크립트 제한(10 MB, 압축 기준) 대비 | 여유 있음 (약 18%) |

### 2.2 번들 구성 (esbuild metafile 기준)

| 구성 요소 | 크기 | 비중 |
|---|---|---|
| base64 인라인 이미지 7개 (아바타 4 + wallpaper + 아이콘 2) | 1,771,624 chars | 번들의 **41.8%** |
| base64 인라인 정적 파일 27개 (`STATIC_FILES_B64`) | 672,052 chars | 번들의 **15.9%** |
| **base64 인라인 합계** | **2,443,676 chars** | **번들의 57.7%** |
| zod v4 (npm) | 854,467 bytes | 20.2% |
| hono (npm) | 71,501 bytes | 1.7% |
| 자사 src 코드 (인라인 제외) | 약 1.3 MB | 약 30% |

이미지 내역 (base64 → 원본 크기):

| 파일 | base64 | 원본 |
|---|---|---|
| `AV_RUMI_B64` (rumi.webp) | 463,884 | 347,912 bytes |
| `AV_NOVA_B64` (nova.webp) | 393,888 | 295,414 bytes |
| `AV_ECHO_B64` (echo.webp) | 356,584 | 267,436 bytes |
| `AV_CALI_B64` (cali.webp) | 315,812 | 236,858 bytes |
| `WALLPAPER_B64` (wallpaper.webp) | 197,724 | 148,292 bytes |
| `ICON512_B64` / `ICON192_B64` | 33,980 / 9,752 | 25,483 / 7,314 bytes |

정적 파일 내역 상위 (`STATIC_FILES_B64`, 원본 기준): `/js/memo-bundle.js` 117,936 · `/agent.html` 108,987 · `/js/chat.js` 39,519 · `/css/memo.css` 38,349 bytes 등 27개 파일 합계 원본 약 504 KB.

### 2.3 Cold start · 초기 로딩 영향

- **모듈 초기화 시 전수 디코딩**: `src/index-inline.ts:103`에서 import 시점에 27개 정적 파일 전체를 `atob()` + 바이트 단위 `charCodeAt` 루프로 디코딩해 `STATIC_FILES`에 적재한다. 어떤 요청이든(예: `/api/health` 한 줄 응답) 이 비용을 먼저 치른다. 이미지 7개는 요청 시점에 `atob()`으로 그때그때 디코딩한다.
- **ASSETS와 중복**: `wrangler.toml`은 이미 `[assets] directory="./public" binding="ASSETS" run_worker_first=true`로 정적 파일을 ASSETS에 두고 있다. 인라인된 27개 파일 + 7개 이미지는 public/에도 그대로 존재하므로, Worker 스크립트와 ASSETS에 **이중 보관**되고 있다. 인라인 라우트가 먼저 등록돼 Worker가 직접 서빙한다.
- **초기 로딩(브라우저) 관점**: HTML 페이지는 인라인 번들에서 `no-cache`로 서빙되고, JS/CSS는 `max-age=31536000, immutable`이다. 첫 방문 시 `/js/memo-bundle.js` 등 정적 파일은 ASSETS가 아닌 Worker를 경유한다. Worker 응답 자체는 빠르지만, Worker 스크립트 파싱(4.2 MB) 비용이 모든 요청의 cold start에 더해진다.
- **정량 한계**: isolate 초기화·스크립트 파싱에 걸리는 실제 ms는 이번 감사에서 측정하지 못했다. **미확인** — Worker tail 또는 `wrangler dev` 계측이 필요하다. 다만 4.2 MB 스크립트 + 2.4 MB base64 문자열 파싱 + 전수 atob 디코딩이 cold start의 지배적 요인이라는 구조적 판단은 코드로 확정된다.

### 2.4 `public/js/memo-bundle.js`

- 크기 **117,935 bytes** (gzip 32,313 bytes). `public/js/memo/` 하위 10개 모듈을 묶은 번들로 보이며, `public/js` 전체는 336 KB이다.
- 메모 페이지 진입 시 118 KB JS 1개 + `memo.html` 인라인 서빙. gzip 32 KB라 전송 자체는 가볍다. 별도 이슈 없음.

## 3. D1 쿼리 패턴 (src/ 전수 스캔)

마이그레이션 인덱스는 총 **83개**이며, 핵심 인덱스는 모두 정의돼 있다(gate-18 방식 확인):
`idx_memos_created_at`(0005) · `idx_files_memo_id`(0002) · `idx_schedules_start`(0014) ·
`idx_memory_v2_active`(0027) · `idx_memory_pages_active`(0044) · `idx_todos_sort`(0017) ·
`idx_ai_usage_date`/`idx_ai_usage_provider`(0007) · `idx_reminders_remind`(0014).
문제는 **인덱스가 있어도 쿼리가 타지 못하는 패턴**이다.

### 3.1 LIKE `'%...%'` 전수 스캔 (선행 와일드카드)

선행 `%`가 있는 LIKE는 어떤 인덱스도 탈 수 없다. 실측된 사용처:

| 위치 | 패턴 | 비고 |
|---|---|---|
| `src/modules/memo/routes.ts:187-188` | `m.text LIKE '%q%'`, `REPLACE(m.text,' ','') LIKE '%...%'`, 파일명 `EXISTS ... filename LIKE` | FTS 실패/부족 시 폴백. `REPLACE()`까지 걸려 인덱스 사용 원천 불가 |
| `src/services/ai-access.ts:125,138` | `text LIKE '%...%'` (3차·4차) | 키워드당 순차 실행 (§3.3) |
| `src/services/unified-search.ts:95,115,134,154` | 메모/기억/일정/할일 LIKE 폴백 | 전부 LIMIT 있음 |
| `src/services/memory-service.ts:288,325` | `content LIKE '%...%'` | FTS 실패 시 폴백 |
| `src/modules/memory/routes.ts:119` | `content LIKE '%q%'` | LIMIT 100 |
| `src/services/fact-graph.ts:392` | `name LIKE '%...%'` | LIMIT 20, 엔티티 시드 탐색 |
| `src/modules/artifact/routes.ts:665,670` | `title/content LIKE` | LIMIT 10/20 |
| `src/services/schedule-tools.ts:155,219`, `todo-tools.ts:107,136,193`, `artifact-tools.ts:117` | `title LIKE '%...%'` | 전부 LIMIT 5 |

단건 테이블이 작은 오늘은 체감이 없으나, 메모 본문 LIKE는 **메모 수에 선형 비례**하는 전수 스캔이다. FTS가 1차 경로라 평소에는 안 타지만, FTS가 실패하거나 결과가 부족할 때마다 폴백이 돈다.

### 3.2 컬럼에 함수 → 인덱스 무력화 4곳

| 위치 | 쿼리 | 무력화되는 인덱스 | 수정 방향 |
|---|---|---|---|
| `src/modules/memo/routes.ts:144` | `date(m.created_at, '+9 hours') = ?` (날짜 필터) | `idx_memos_created_at` | KST 날짜를 UTC 범위로 변환해 `created_at >= ? AND created_at < ?`로 |
| `src/modules/memo/routes.ts:117` | `datetime(created_at, '+9 hours') >= ? AND < ?` (통계) | `idx_memos_created_at` | 동일하게 범위 조건으로 |
| `src/modules/schedule/routes.ts:93,97,122` | `substr(start_at, 1, 10) >= ? / <= ?` | `idx_schedules_start` | `start_at`은 `YYYY-MM-DDTHH:mm` 문자열이라 `start_at >= 'YYYY-MM-DDT00:00'` 식의 문자열 범위 비교로 대체 가능 |
| `src/scheduled.ts:53-55` | `datetime(start_at, '-9 hours') BETWEEN ...` (cron 5분 틱) | `idx_schedules_start` | KST 윈도우를 UTC 문자열 범위로 미리 계산해 `start_at >= ? AND start_at <= ?`로. schedules가 작아 현재 영향은 작으나 매 5분 전수 스캔이다 |

### 3.3 N+1 · 순차 반복 쿼리

| 위치 | 패턴 | 규모 |
|---|---|---|
| `src/modules/memo/routes.ts:136` (`fileCount`) | 목록의 **행마다** 상관 서브쿼리 `(SELECT COUNT(*) FROM files f WHERE f.memo_id = m.id)` | 페이지당 최대 200회 인덱스 조회 (limit 최대 200). `idx_files_memo_id`가 있어 건당 싸지만 행 수 비례 |
| `src/services/ai-access.ts:103-145` | 키워드(최대 3개)마다 FTS 재검색 순차 실행 → 실패 시 LIKE 1회 → 키워드 LIKE 순차 최대 3회 | AI 메모 검색 1회당 **최대 7회 순차 D1 왕복**, 이 중 LIKE는 전수 스캔 |
| `src/modules/ai/routes.ts:1491-1493` | assistant 행마다 `ai_chats` INSERT 반복 | 대화 저장 시 행 수만큼 순차 INSERT. `DB.batch()` 미사용 |
| `src/modules/schedule/routes.ts:129` | 반복 일정 조회에 **LIMIT 없음** (`recurrence_rule IS NOT NULL ... ORDER BY start_at ASC`) | 반환 후 JS에서 전개·`slice(0, limit)`. 반복 일정이 늘면 무제한 증가 |

### 3.4 LIMIT 없는 전체 조회

| 위치 | 쿼리 | 비고 |
|---|---|---|
| `src/modules/schedule/routes.ts:129` | 반복 일정 전체 조회 (상동) | 유일한 무제한 사용자 데이터 조회 |
| `src/modules/backup/routes.ts:100,216` | `SELECT * FROM ${table}` | 백업 덤프 용도라 설계상 전체 조회. 의도된 동작 |
| `src/services/cron-jobs.ts:93` (`listCronJobs`) | `SELECT * FROM user_cron_jobs ORDER BY ...` LIMIT 없음 | 사용자 cron 작업은 수 개 수준이라 현재 무해 |
| `src/scheduled.ts:64` | `SELECT endpoint, p256dh, auth FROM push_subscriptions` LIMIT 없음 | 구독 수도 적어 현재 무해 |
| `src/index.ts:84-95` (`/api/system`) | 테이블 60개에 `COUNT(*)`를 **순차** 실행 | §3.5 참조 |

### 3.5 `/api/system` — 캐시 미스 시 가장 무거운 엔드포인트

`src/index.ts` (`GET /api/system`, 인증 필요). KV에 10분 캐시(`system:stats`)가 있어 캐시 히트 시는 가볍다. **캐시 미스 시**:

1. 테이블 목록 조회 후 **60개 테이블에 `COUNT(*)`를 순차(await in for) 실행** — D1 왕복 60회 이상.
2. Cloudflare D1 API + Cloudinary API를 `Promise.all`로 병렬 호출하는데, **두 fetch 모두 타임아웃이 없다** (`AbortSignal.timeout` 미지정).
3. D1 API 실패 시 폴백으로 `SELECT COALESCE(SUM(LENGTH(title)+LENGTH(content)),0) FROM memos` 전수 스캔.

수정: `COUNT(*)`를 `DB.batch()`로 병렬화하고, 외부 API fetch에 타임아웃(예: 5초)을 단다. (KV 캐시가 있어 빈도는 낮으나, 캐시 미스 1회가 수십 회 왕복 + 무제한 외부 대기를 유발한다.)

### 3.6 기타

- `ai_usage` 집계(`/api/ai/quota`, `/api/ai/usage`, `src/modules/ai/routes.ts:2052,2075`): `created_at >= date('now','-1 day')`는 상수 측 함수라 `idx_ai_usage_date`를 탈 수 있다. 양호.
- 메모 목록 비검색 경로(`ORDER BY m.id DESC LIMIT ? OFFSET ?`): PK 순서라 양호. 단, `OFFSET`이 커지면 D1이 앞 행을 스캔하므로 깊은 페이지네이션은 느려진다 (키셋 페이지네이션 검토 대상이나, 현재 규모에서는 미미).
- `migrations/0028`의 `ai_memory_fts` 트리거가 FTS5 `'delete'` 특수 명령을 사용한다. 0030에서 `memos_fts`는 동일 패턴을 수정했으나 0028은 미수정 latent 상태이다(기억 삭제 시 `SQLITE_ERROR` 가능). 성능 이슈는 아니나 FTS 신뢰성 이슈로 기록한다.
  > **정정 (2026-10-28, 감사 수정 프로그램 0028 트랙 확인): 위 전제는 stale — 0028의 `'delete'` 문제는 2026-10-25 커밋 11655d0의 마이그레이션 0044가 이미 0030 패턴 그대로 수정했고 운영 D1에도 이미 적용돼 있다 (0044 헤더 명시 + `tests/integration/memory-0044-real.test.js` 12/12 + 카나리아 + 운영 D1 읽기 전용 확인). 중복 0059 작성은 하지 않았다. 이 항목은 조치 완료로 본다.**

## 4. AI 호출 · 외부 호출 시간 예산

### 4.1 타임아웃 · 재시도 · 폴백 체인 (코드 실측)

| 경로 | 시간 예산 | 출처 |
|---|---|---|
| AI 채팅 모델 호출 (Gemini/Groq 등, `src/services/ai.ts:262,302,333`) | 호출당 **25초 / 30초 / 25초** (프로바이더별) | `AbortSignal.timeout` |
| AI 요약 호출 (`src/services/ai.ts:443`) | 호출당 **180초** | `AbortSignal.timeout(180000)` |
| AI 채팅 폴백 체인 (`src/services/ai.ts:746-747`) | **최대 4회 시도**, 시도마다 다른 모델 선택, 시도당 위 타임아웃 | `maxAttempts = 4` (disableRetry 시 1회) |
| 외부 웹검색 전체 (`src/modules/ai/routes.ts:2117-2118`) | **전체 deadline 20초**, 레그당 10초 | `EXTERNAL_SEARCH_TOTAL_TIMEOUT_MS=20000` |
| 뉴스 소스 체인 (`src/services/news-sources.ts:88-89`) | 전체 20초, 레그당 8초, 기사 검증 건당 5초·병렬 3 | `NEWS_CHAIN_TOTAL_TIMEOUT_MS=20000` |
| Exa 직접 호출 (`src/modules/ai/routes.ts:1299`) | 15초 | `AbortSignal.timeout(15000)` |
| GitHub API (`src/modules/ai/routes.ts:415,2279`) | 10초 / 15초 | |
| 스튜디오 에이전트 (`src/services/studio-agent.ts:235,308`) | 호출당 **120초** | |
| 아티팩트 생성 (`src/modules/artifact/generate-html.ts:27`, `job-processor.ts:412`) | 전체 240초, AI 단계 180초, 재시도 간격 2초×시도 횟수 | |
| 뉴스 브리핑 Exa (`src/services/news-briefing.ts:67`) | 15초 | |

**최악 예산 문제**: AI 채팅은 시도당 25~30초 × 최대 4회 = **순차 최악 100~120초**의 wall-clock 예산을 갖는다. 웹검색 경로는 20초 deadline으로 묶여 있지만(2026-10-26 502 대응으로 도입), AI 채팅 본체에는 **전체 deadline이 없다**. Workers 요청 제한(무료 플랜 CPU 10ms~30초 계열 제한과 별개로, fetch 대기 포함 wall-clock은 더 길게 허용되나) 및 사용자 체감 지연 관점에서, 4회 연속 타임아웃 시 사용자는 2분 가까이 기다리다 실패를 본다. 수정: 채팅 경로에도 전체 deadline(예: 60초)을 두고, 남은 예산이 없으면 다음 모델 시도를 건너뛴다 — websearch의 `remaining()` 패턴을 그대로 이식하면 된다.

### 4.2 Cron 핸들러 (5분마다, `src/index.ts:234-241` — 4개 순차 실행)

| 핸들러 | 매 틱 작업량 | 비고 |
|---|---|---|
| `handleScheduled` (일정 알림) | due 조회 1회(LIMIT 50) + 구독 전체 조회 + due당 `INSERT OR IGNORE` 1회 + 구독당 푸시 fetch + `UPDATE reminders` 1회 | 푸시 발송은 due×구독 수만큼 순차 fetch. 구독이 적어 현재 무해 |
| `handleCronJobs` (자연어 cron) | due 조회 LIMIT 50 + 작업당 AI 호출 가능 (아침 브리핑·뉴스 요약은 Exa + LLM) | due 작업이 여러 개면 AI 호출이 순차로 쌓인다. 작업당 수십 초 가능 |
| `handleSleepConsolidation` | 03:00 KST가 아니면 즉시 반환. 03:00에는 최대 500건 배치 + 모순 스캔 200건 + LLM 통합 | 하루 1회, 마커로 중복 방지 |
| `handleGoogleSync` | 30분 간격 KV 마커. 미연동이면 즉시 반환 | 현재 미연동이면 무작업 |

Cron 자체의 D1 쓰기는 적다. 주의점은 `handleCronJobs`의 AI 호출이 5분 틱 안에서 순차 누적될 수 있다는 점과, `handleScheduled`의 `datetime(start_at,'-9 hours')` 전수 스캔(§3.2)이다.

### 4.3 KV · D1 쓰기 빈도

- **AI 채팅 1회당 D1 쓰기 최소 3회**: `ai_usage` INSERT 1회(`src/services/ai.ts:690`) + `ai_chats` INSERT 2회(사용자 메시지·어시스턴트 응답, `src/modules/ai/routes.ts:1467-1493`). 재시도 시도는 각각 `ai_usage`에 기록될 수 있다(시도당 INSERT). 도구 호출이 있으면 `ai_tool_runs`/`ai_tool_operations`·감사 로그가 추가된다.
- **KV 쓰기**: PIN 실패 카운터(로그인 시도 시), OAuth state(연동 시), Google 동기화 마커(30분마다 1회), 음성 사용량(음성 호출 시), `system:stats` 캐시(10분마다 1회). 모두 빈도 낮음. **KV 쓰기 폭증 경로는 없다.**
- **Cron D1 쓰기**: due 일정당 INSERT 1 + UPDATE 1, cron 작업당 선점 UPDATE 1 + next_run_at UPDATE 1. 5분 틱 기준 수 회 수준.

## 5. 테스트 스위트 속도

### 5.1 전체 Jest (2026-10-28 실측)

| 항목 | 실측 |
|---|---|
| Jest 보고 시간 | **94.5초** |
| Wall-clock (셸 측정) | **97초** |
| 스위트 | 242개 전부 통과 |
| 테스트 | **5,044개 전부 통과** (0 실패) |
| 실행 방식 | 기본 병렬 (`npx jest --silent --json`) |

과제 지문의 "최근 실측 169초"보다 빠르다. 차이 원인은 미확인이다(병렬/직렬 실행 방식 차이, 머신 부하, 테스트 수 증가 5,004→5,044 등 가능). 동일 조건 재측정 없이는 169초와 직접 비교할 수 없다.

### 5.2 가장 느린 스위트 10개 (전체 실행의 per-suite span 기준)

| 순위 | 스위트 | span | 단독 실행 wall |
|---|---|---|---|
| 1 | `tests/unit/ai-routes.test.ts` | 14.41s | **13.9s** |
| 2 | `tests/unit/job-processor.test.ts` | 10.22s | **14.8s** |
| 3 | `tests/evals/promptfoo-harness.test.ts` | 7.87s | **14.6s** |
| 4 | `tests/unit/job-processor-branches.test.ts` | 6.09s | **10.1s** |
| 5 | `tests/unit/memory-consolidation-real.test.js` | 1.79s | 미측정 |
| 6 | `tests/unit/news-sources.test.ts` | 1.77s | 미측정 |
| 7 | `tests/unit/fastcheck-news.test.ts` | 1.76s | 미측정 |
| 8 | `tests/unit/auth-pin-gate.test.ts` | 1.74s | 미측정 |
| 9 | `tests/unit/gate-72-storage.test.js` | 1.49s | 미측정 |
| 10 | `tests/unit/memory-citation-lock-real.test.js` | 1.44s | 미측정 |

- 상위 4개가 span 합계(91.3s)의 **42%**를 차지한다. 5위부터는 2초 미만으로 급락한다 — 속도는 상위 4개에 집중돼 있다.
- `ai-routes.test.ts`는 테스트/it 283건으로, 건수가 많아 느리다. `job-processor` 2개는 합쳐 114건 + 타이머·재시도 대기성 테스트 포함으로 보인다. `promptfoo-harness`는 테스트 2건인데 14.6초 — 하네스 기동 비용(프롬프트 평가용 모델 스텁·파일 로딩)이 크다.
- 단독 실행이 병렬 span보다 느리게 나온 스위트(`job-processor` 10.22→14.8s 등)는 Jest 기동 + ts-jest 컴파일 비용이 단독 실행에 온전히 잡히기 때문이다. 순위는 두 기준에서 동일하다.
- 나머지 238개 스위트는 전부 2초 미만이다. 전체 94.5초 중 ts-jest 변환·워커 기동 오버헤드가 상당 부분을 차지할 것으로 추정되나, 분리 측정은 하지 않았다(**미확인**).

### 5.3 Stryker 뮤테이션 기준선

- 보고서: `reports/mutation/mutation.json` (2026-10-27 07:59 생성)
- 대상: 5개 파일(`src/lib/news-summary.ts`, `src/lib/search-marker.ts`, `src/lib/citation-lock.ts`, `src/services/article-date.ts`, `src/services/news-sources.ts`)
- 뮤턴트 **1,658개**: Killed 1,182 · Survived 425 · Timeout 16 · NoCoverage 30 · RuntimeError 5
- 스코어: **71.3%** (Killed/전체). NoCoverage 30개를 제외하면 72.6%로, MEMORY.md의 "72.47%" 기록과 부합한다.
- **기준선 측정 소요 시간: 미확인** — `mutation.json`에 소요 시간이 기록돼 있지 않고, 실행 로그도 남아 있지 않다. 1,658개 뮤턴트 × Jest 실행이라 수 시간 규모일 것으로 추정되나, 이는 추측이라 기록하지 않는다. 다음 실행부터 `time npx stryker run`으로 측정할 것.
- 참고: Stryker 설정(`stryker.config.mjs`)은 TS 체커를 VM 메모리 문제로 꺼둔 상태이다.

## 6. 이슈 순위표

| 순위 | 심각도 | 이슈 | 측정값 | 영향 범위 | 수정 제안 (파일·방법) |
|---|---|---|---|---|---|
| 1 | **상** | 배포 번들 4.2 MB 중 57.7%가 base64 인라인 (이미지 1.77M chars + 정적 0.67M chars) | 번들 4,236,453 bytes; base64 2,443,676 chars; gzip 1,883,106 bytes | 모든 요청의 cold start (모듈 초기화 시 27개 파일 전수 atob 디코딩, `src/index-inline.ts:103`) | `deploy_full.py` + `src/index-inline.ts`: 아바타·wallpaper·아이콘 7개(약 1.33 MB 원본)를 인라인에서 빼고 ASSETS(`wrangler.toml` `[assets]`, 이미 존재)로만 서빙. 정적 파일도 `STATIC_FILES` 전수 디코딩 대신 ASSETS 폴백(`src/index-inline.ts:269`의 `c.env.ASSETS.fetch`)으로 이관하거나, 최소한 HTML만 인라인하고 JS/CSS는 ASSETS로. 기대 효과: 번들 약 4.2 MB → 약 1.8 MB |
| 2 | **상** | 메모 검색 LIKE 폴백이 본문 전수 스캔 + `REPLACE()` + 파일명 EXISTS + 행별 fileCount 서브쿼리 | LIKE 폴백 `src/modules/memo/routes.ts:182-199`; 행별 서브쿼리 1행당 1회, 페이지 최대 200회 | 메모 수가 늘수록 검색 지연 선형 증가. FTS 실패 시마다 발생 | `src/modules/memo/routes.ts`: `REPLACE(m.text,' ','') LIKE`를 FTS5 `MATCH`의 공백 정규화(인덱싱 시점에 공백 제거 컬럼 추가) 또는 trigram 보조 인덱스로 대체. `fileCount` 상관 서브쿼리를 `LEFT JOIN files ... GROUP BY m.id` 1회 쿼리로 변경 |
| 3 | **중** | 컬럼에 함수 사용으로 인덱스 4곳 무력화 | §3.2 참조 (memo 날짜·통계, schedule `substr`, cron `datetime`) | 날짜 필터·통계·반복 일정 조회·매 5분 cron 틱이 전수 스캔 | 각 위치를 범위 조건으로 변경: KST 날짜는 UTC 범위로 미리 계산 (`created_at >= ? AND created_at < ?`, `start_at >= 'YYYY-MM-DDT00:00'`). `src/modules/memo/routes.ts:117,144`, `src/modules/schedule/routes.ts:93,97,122`, `src/scheduled.ts:53` |
| 4 | **중** | AI 메모 검색이 키워드당 순차 쿼리, 최대 7회 D1 왕복 (LIKE 전수 스캔 포함) | `src/services/ai-access.ts:103-145`, 키워드 최대 3개 | AI 채팅마다 메모 검색 지연 누적. 키워드가 많을수록 선형 증가 | 키워드 FTS를 `MATCH 'kw1 OR kw2 OR kw3'` 1회로 합치고, LIKE 폴백은 원본 쿼리 1회로 제한. 또는 `Promise.all` 병렬화 (D1 무료 티어 동시성 한도 내) |
| 5 | **중** | AI 채팅 폴백 체인에 전체 deadline 없음 — 최악 100~120초 순차 대기 | 시도당 25~30초 × 최대 4회 (`src/services/ai.ts:746`) | 모델 장애 시 사용자가 2분 가까이 대기 후 실패 | websearch 패턴 이식: 채팅 진입 시점에 `deadline = Date.now() + 60000`을 두고 `remaining()`이 0이면 다음 모델 시도를 건너뛴다 (`src/services/ai.ts`의 재시도 루프) |
| 6 | **중** | `/api/system` 캐시 미스 시 60개 테이블 순차 `COUNT(*)` + 타임아웃 없는 외부 API 2회 | D1 왕복 60회+ (`src/index.ts:84-95`), fetch 타임아웃 없음 | 캐시 미스 1회가 수초~수십 초 지연 + 외부 API 장애 시 무한 대기 가능 | `DB.batch()`로 COUNT 병렬화, Cloudflare/Cloudinary fetch에 `AbortSignal.timeout(5000)` 추가 |
| 7 | **하** | 반복 일정 조회 LIMIT 없음 | `src/modules/schedule/routes.ts:129` | 반복 일정 증가 시 무제한 반환 후 JS에서 `slice` | `LIMIT` 추가 + 전개 후 자르기 대신 쿼리 단계에서 범위 제한 |
| 8 | **하** | 대화 저장 시 assistant 행마다 순차 INSERT | `src/modules/ai/routes.ts:1491-1493` | 채팅 응답 저장 왕복이 행 수 비례 | `DB.batch()`로 묶기 (todo reorder `src/modules/todo/routes.ts:134`는 이미 batch 사용 중 — 동일 패턴) |
| 9 | **하** | 테스트 상위 4개 스위트가 전체 시간의 42% 차지 | ai-routes 13.9s · job-processor 14.8s · promptfoo-harness 14.6s · job-processor-branches 10.1s (단독 실행) | CI·로컬 피드백 속도 | `promptfoo-harness`는 테스트 2건에 14.6초라 하네스 기동 비용 분리 검토. `ai-routes`(283건)는 파일 분할 검토. 단, 전체 94.5초는 허용 범위라 우선순위는 낮다 |
| 10 | **하** | zod v4가 번들의 20.2% (854 KB) | `node_modules/zod/v4` 합계 854,467 bytes | 번들 크기·cold start에 기여 | 실제 import 범위를 확인하고, 사용처가 스키마 검증 일부라면 `zod/v4-mini` 또는 경량 검증으로 교체 검토. 단, 교체 전 사용처 전수 확인 필요 |

### 참고 (성능 외, 감사 중 확인된 사항)

- `migrations/0028`의 `ai_memory_fts` 삭제 트리거가 FTS5 `'delete'` 특수 명령을 사용한다 (0030에서 `memos_fts`는 수정済, 0028은 latent). 기억 삭제 시 `SQLITE_ERROR` 가능성이 있다. 성능 이슈는 아니나 FTS 신뢰성과 직결되므로 후속 조치 대상으로 기록한다.
  > **정정 (2026-10-28): 위 전제는 stale — 마이그레이션 0044(커밋 11655d0, 2026-10-25)가 이미 수정했고 운영 D1 적용 완료. 조치 불필요 (상세는 §3.6 정정 참조).**
- `/api/health` 25 bytes vs 과거 기록 148,292 bytes 불일치 (§1 참조 — 148,292는 `wallpaper.webp` 크기와 일치).

## 7. 미확인 항목

- **Worker cold start 실측 시간** (isolate 초기화·스크립트 파싱 ms): 외부 curl로는 분리 불가. Worker tail CPU 시간 또는 `wrangler dev` 계측 필요.
- **Stryker 기준선 측정 소요 시간**: 보고서·로그에 기록 없음. 다음 실행 시 `time`으로 측정할 것.
- **Jest 169초(과거 기록) vs 94.5초(이번 실측) 차이 원인**: 실행 조건(병렬/직렬)·머신 부하가 달라 직접 비교 불가.
- **운영 D1 실제 행 수·테이블 크기**: 운영 D1 읽기(행 수 조회)도 이번 트랙에서 수행하지 않았다. LIKE 스캔·LIMIT 없는 조회의 실제 영향은 행 수에 달려 있으므로, 다음 감사에서 `SELECT COUNT(*)` 수준의 읽기 측정으로 보완할 것.
- **zod 실제 사용 범위**: 번들에 포함된 zod 모듈 중 실제 import되는 범위와 `zod/v4-mini` 교체 가능성은 미확인.
- **라이브 AI 채팅·웹검색 종단 지연**: OTP 로그인이 필요한 경로라 이번 트랙에서 측정하지 않았다.
