# Semgrep 36건 재검증 (2026-10-29, 트랙 B)

2026-10-27 스캔(`docs/semgrep-20261027.md`)에서 "36건 전부 오탐"으로 판정했으나
건별 근거가 요약 수준에 그쳤고, 외부 평가(GPT)가 "근거 없이는 인정 불가"라고
지적했다. 본 문서는 **현재 코드(bdc3f1d, 운영 라이브 298bb244와 동일 코드)를
같은 도구·같은 규칙셋으로 재스캔하고, 검출 건 전수를 현재 코드에서 직접 읽어
건별로 재 판정한** 기록이다. 판정의 근거는 2026-10-27 문서의 복사본이 아니라
2026-10-29에 각 위치의 코드를 직접 확인한 내용이다.

## 실행 방법 (재현)

- 도구: semgrep **1.182.1** (`~/.venvs/myhub-semgrep`, 2026-10-27 설치본과 동일 버전)
- 실행: 저장소 공식 경로 그대로 — `bash scripts/run-semgrep.sh --json`
  (`npm run lint:security`와 동일 스크립트)
- 규칙셋: `p/security-audit` + `p/secrets` + `p/javascript` + `p/typescript`
  + 커스텀 `.semgrep/myhub-rules.yaml` (4개 규칙) — 2026-10-27과 동일 구성,
  규칙 파일 무변경 (`git status` 기준 `.semgrep/`·`scripts/run-semgrep.sh` 변경 없음)
- 스캔 범위: 스크립트 기본값인 저장소 전체 (제외: `backups/`·`coverage/`·`dist/`·
  `.wrangler/`·`node_modules/`·`.scratch/`·`*-bundle.cjs/js`·`src/index-inline.ts`).
  과제 지시의 "src/ 대상"과 달리 실제 36건 기준 스캔은 저장소 전체였고
  (python 배포 스크립트 10건이 포함돼야 36이 된다), 재현은 원본 범위를 따랐다.
- 재현성: 동일 명령 2회 실행 → **2회 모두 46건, check_id+path+line 집합 완전 일치**.
  스캔 오류(errors) 0건, 스캔 파일 543개 (2026-10-27: 526개).

## 총 건수와 과거 36건과의 차이: 46건 (+10)

규칙셋·도구 버전은 동일한데 코드베이스가 2026-10-27 이후 성장해 신규 검출이
생겼다. 증가분 10건은 전부 "신규 코드가 기존과 동일한 안전 패턴을 쓴 경우"이며
커밋으로 추적된다.

| 규칙 | 2026-10-27 | 2026-10-29 | 차이 원인 |
|---|---|---|---|
| `myhub-sql-template-interpolation` | 22 | 25 | +3: 메모 검색 trigram 단계 등 쿼리 2건 추가(`src/modules/memo/routes.ts`, perf 개편·bdc3f1d 계열), `src/index.ts` 통계 COUNT의 `DB.batch`+폴백 이중화(fef1db2)로 동일 패턴 1→2건 |
| `python dynamic-urllib-use-detected` | 10 | 15 | +5: `deploy_full.py` ASSETS 업로드 경로 추가(87bde94, +1), 신규 스크립트 `scripts/backup_production.py`(98f0ba2, +1)·`scripts/clairic-ab/probe_deploy.py`·`run_ab.py`(04561d3, +3) |
| `myhub-hardcoded-worker-secret` | 2 | 4 | +2: MCP 토큰 접두사 상수(`src/modules/mcp/tokens.ts`, 099f85d), vitest 더미 `GOOGLE_CLIENT_SECRET`(32a861a) |
| `myhub-locked-memo-query-without-filter` | 1 | 1 | 동일 위치 (fact-graph.ts:328) |
| `myhub-eval-or-new-function` | 1 | 1 | 동일 위치 (studio-workspace.ts:249) |
| `p/secrets` 등 그 외 공식 규칙 | 0 | 0 | 고엔트로피 비밀·기타 공식 규칙 검출 없음 (공식 규칙 검출은 urllib뿐) |
| **합계** | **36** | **46** | |

과거 36건의 위치는 현재 코드에서 줄번호가 이동한 경우(예: memo/routes 157→215)
를 포함해 전부 현재 46건 안에 대응물이 있다. 사라진 과거 finding은 없다.

## 판정 요약

| 판정 | 건수 |
|---|---|
| 오탐 | **46** |
| 진짜 결함 | **0** |
| 부분 해당 | **0** |

고친 코드는 없다. 아래 건별 표가 그 근거이다. 판정 원칙은 2026-10-27과 동일:
보간·URL·리터럴의 **출처**를 코드로 추적해, 사용자 입력이 도달하지 않음을 확인한
경우만 오탐으로 판정했다.

## 건별 판정 — ① myhub-sql-template-interpolation 25건 (전부 오탐)

공통 구조: 보간되는 것은 SQL **값**이 아니라 (a) 고정 문자열 상수, (b) 고정
리터럴만으로 조립되는 조건/SET 프래그먼트, (c) `?` 플레이스홀더 개수,
(d) 숫자 상수, (e) 상수 화이트리스트 중 하나이며, 실제 값은 전부 `?` 바인딩이다.

| # | 위치 | 보간 출처 (2026-10-29 코드 직접 확인) | 판정 근거 |
|---|---|---|---|
| 1 | src/index.ts:104 | `tableNames` — 직전 쿼리 `SELECT name FROM sqlite_master …` 결과 | 테이블명은 DB 스키마(마이그레이션) 유래 내부 식별자, 사용자 입력 경로 없음. 식별자는 `"${name}"`로 따옴표 감쌈. batch 경로 |
| 2 | src/index.ts:112 | 동일 `tableNames` (batch 실패 시 순차 폴백) | #1과 동일 근거. 패턴이 이중화된 것뿐 |
| 3 | src/modules/artifact/routes.ts:515 | `updates` — `'title = ?'`·`'description = ?'`·`'icon_key = ?'` 고정 리터럴 + 고정 접미 2개만 push | 컬럼명은 코드 분기 고정 문자열, 값은 전부 `?`. 길이 검증 후 분기 진입 |
| 4 | src/modules/backup/routes.ts:167 | `BACKUP_TABLES.map(table => …)` | `BACKUP_TABLES`는 파일 상단 export된 32개 고정 문자열 배열(화이트리스트). 사용자 입력으로 구성되지 않음. 암호화 백업 경로 |
| 5 | src/modules/backup/routes.ts:283 | 동일 `BACKUP_TABLES` | #4와 동일. 평문 백업(스테이징 전용) 경로 |
| 6 | src/modules/memo/routes.ts:215 | `${fileCountSelect}` `${join}` `${fileCountJoin}` `${where}` | `fileCountSelect='COALESCE(fc.n, 0) AS file_count'`·`fileCountJoin`은 고정 상수. `join`은 태그 있을 때 고정 리터럴 `' JOIN memo_tags t ON …'`만 누적. `conds`는 `'t.tag = ?'`·날짜 범위 고정 리터럴만 push하고 값(tag·날짜 범위)은 `?` 바인딩. FTS 검색어 자체도 `MATCH ?` 바인딩 |
| 7 | src/modules/memo/routes.ts:236 | #6과 동일 프래그먼트 + `${notIn()}` | `notIn()`은 이미 본 id 집합 크기만큼 `?`만 생성 (`[...seen].map(() => '?')`). trigram 검색어도 `MATCH ?` |
| 8 | src/modules/memo/routes.ts:254 | #6과 동일 프래그먼트 + `${notIn()}` | 파일명 검색 패턴 `%${q}%`는 SQL 문자열이 아니라 `LIKE ?`의 **바인딩 값**으로 전달됨 |
| 9 | src/modules/memo/routes.ts:281 | `${likeConds.join(' AND ')}` | `likeConds` = `conds`(고정+`?`) + 고정 리터럴 `'m.is_locked = 0'`·`'m.sensitivity < 2'`·`'(m.text LIKE ? OR …)'` + `?` 전용 NOT IN. 검색어는 바인딩 값 |
| 10 | src/modules/memo/routes.ts:293 | #6과 동일 프래그먼트 + `${where}` | 비검색 목록 경로. limit/offset도 `?` 바인딩 |
| 11 | src/modules/memory/routes.ts:97 | `${category ? 'AND m.category = ?' : ''}` | 고정 문자열의 조건부 선택일 뿐. category·FTS 검색어(`searchTerm`, `"` 이스케이프 후 구성)는 전부 `?` 바인딩 |
| 12 | src/modules/memory/routes.ts:175 | `updates` — `'updated_at = ?'` 초기값 + `'content = ?'`·`'category = ?'`·`'allow_ai_use = ?'`·`'allow_provider_send = ?'` 고정 리터럴만 push | category는 `VALID_CATEGORIES` allowlist 검증 통과 시에만 분기 진입. 값은 전부 `?` |
| 13 | src/modules/schedule/routes.ts:125 | `${COLS}` `${conds.join(' AND ')}` | `COLS` 고정 상수. `conds` 초기값·push는 전부 고정 리터럴(`'start_at >= ?'` 등). status는 `['active','cancelled','done'].includes(status)` 통과 시에만 `'status = ?'` 추가되고 값은 바인딩. from/to는 날짜 정규식 검증 후에도 문자열 보간이 아닌 바인딩 값으로 사용 |
| 14 | src/modules/schedule/routes.ts:149 | `${COLS}` `${rConds.join(' AND ')}` | #13과 동일 구조 (반복 일정 경로) |
| 15 | src/modules/todo/routes.ts:97 | `${where}` (conds 조립) | `conds`는 status가 `['pending','done']`에 포함될 때만 `'status = ?'` push, 값은 바인딩. 그 외 where는 빈 문자열 |
| 16 | src/services/approval-flow.ts:147 | `WHERE ${whereSql}` — private 메서드 `fetchPendingRow(whereSql, args, now)` | 호출자 2곳 모두 같은 파일 내부이며 고정 리터럴만 전달: `findNewestPending`의 `"conversation_id = ? AND status = 'pending'"`, `findPendingByScope`의 `"conversation_id = ? AND scope_key = ? AND status = 'pending'"`. 외부에서 whereSql을 주입할 공개 경로는 없음 (private + 호출 고정) |
| 17 | src/services/fact-graph.ts:394 | `${likeConds}` — `terms.map(() => "name LIKE ? ESCAPE '\\'")` | 항마다 동일한 고정 리터럴 반복. 검색 토큰은 `%_\\` 이스케이프 후 `?` 바인딩 (`likeParams`) |
| 18 | src/services/fact-graph.ts:403 | `${seedPlaceholders}` — `seedIds.map(() => '?')` | `?` 문자만 생성. seedIds는 DB 결과 id를 `Number()` 변환 + `> 0` 필터한 값이며 그마저 `?` 바인딩됨 |
| 19 | src/services/memory-service.ts:326 | `${conds}` — `terms.map(() => 'content LIKE ?')` | #17과 동일 패턴. 값은 이스케이프 후 바인딩 |
| 20 | src/services/memory-service.ts:436 | `${placeholders}` — `ids.map(() => '?')` | ids는 진입부에서 `Number.isInteger(n) && n > 0` 필터 + 중복 제거 + 최대 20개 절단 후 `?` 바인딩 |
| 21 | src/services/schedule-tools.ts:113 | `${COLS}` | `COLS`는 함수 내 고정 문자열 상수. 기간 값(from/to)은 `?` 바인딩 |
| 22 | src/services/schedule-tools.ts:121 | `${COLS}` | #21과 동일 상수 (반복 일정 경로) |
| 23 | src/services/schedule-tools.ts:205 | `${fields.join(', ')}` — fields는 `allowed` 맵 순회로 `${allowed[key]} = ?` push | `allowed`는 고정 키→고정 컬럼명 맵 (`title→title`, `new_title→title` 등 8개). 사용자 키가 컬럼명으로 직접 들어가지 않고 맵 조회 결과만 사용. 값은 `?` |
| 24 | src/services/todo-tools.ts:180 | `${fields.join(', ')}` | fields push는 분기별 고정 리터럴(`'title = ?'`·`'description = ?'`·`'due_at = ?'`·`'priority = ?'`)만. priority는 0~2 정수 검증 후 바인딩 |
| 25 | src/services/workflow.ts:218 | `${STALE_RUNNING_MS / 60000}` | `STALE_RUNNING_MS = 15 * 60 * 1000` 숫자 상수의 나눗셈 결과(=15). 문자열·사용자 입력 아님 |

## 건별 판정 — ② myhub-hardcoded-worker-secret 4건 (전부 오탐)

| # | 위치 | 대입되는 값 | 판정 근거 |
|---|---|---|---|
| 26 | scripts/test-worker-search.mjs:6 | 로컬 QA용 세션 서명 비밀 (값 자체가 아님을 문서화하지 않음 — 값은 본 문서에 적지 않는다) | localhost Worker(`http://localhost:18787`) 전용 QA 스크립트. 값 문자열 자체에 "prod에서 쓰지 말 것"이 명시돼 있고 운영 시크릿이 아니다. 운영 Worker Secret과 무관한 경로 |
| 27 | src/modules/mcp/tokens.ts:16 | `MCP_TOKEN_PREFIX = 'mcp_'` | **비밀값이 아니라 공개 접두사 상수.** 실제 토큰은 `generateMcpToken()`이 CSPRNG 32바이트로 생성하고, 저장·조회는 SHA-256 해시로만 한다(파일 머리 주석 + 코드 확인). 접두사는 토큰 형식 식별용 공개 상수이며 이를 알아도 토큰을 만들 수 없다. 규칙이 변수명 `TOKEN` + 문자열 리터럴 패턴에 걸린 이름 기반 오탐 |
| 28 | vitest.config.ts:34 | miniflare 로컬 바인딩용 테스트 전용 세션 비밀 | 코드 주석 "테스트 전용 값. 운영 SESSION_SECRET이 아니다" 명시. 바인딩은 로컬 miniflare 격리 DB 전용, 운영 D1/KV ID 미사용 (파일 머리 주석 확인) |
| 29 | vitest.config.ts:42 | miniflare 로컬 바인딩용 테스트 전용 Google 클라이언트 비밀 더미 | 주석 "테스트 전용 더미 값. 운영 GOOGLE_CLIENT_ID/SECRET이 아니다… 실제 Google 호출은 하지 않는다" 명시. #28과 동일 근거 (2026-10-28 Google 쓰기 런타임 테스트 추가 시 신규 검출) |

참고: `p/secrets`(고엔트로피 탐지)는 이번 스캔에서도 0건이다. 위 4건은 실제
비밀값이 아니라 이름 패턴에만 걸린 것이다.

## 건별 판정 — ③ myhub-locked-memo-query-without-filter 1건 (오탐)

| # | 위치 | 판정 근거 |
|---|---|---|
| 30 | src/services/fact-graph.ts:328 | 2단계 분리 검사를 코드로 재확인. 322–327행: 먼저 `SELECT id, is_locked FROM memos WHERE id = ?`로 잠금을 확인하고 `is_locked === 1`이면 본문을 읽지 않고 `{ ok: false, error: 'locked' }`로 조기 반환한다. 328행 본문 조회는 미잠금 메모만 도달한다. 조회 후에도 `sanitizeForAI(text, locked_blocks)`로 잠긴 블록을 제거한 텍스트만 사실 추출에 쓴다. 규칙은 단일 `prepare()` 문자열만 보므로 이 선행 검사를 보지 못하는 한계. **잔여 이론적 경합**: 검사와 조회 사이에 메모가 잠기는 TOCTOU 창이 있으나, 2026-10-29 P0 수정(bdc3f1d)으로 잠긴 메모 본문은 저장 시점에 `ENC:` 암호문이라 경합으로 읽혀도 평문이 아닌 암호문이 읽히고, 단일 사용자 시스템에서 동시 잠금 전환 자체가 공격 경로가 되지 않는다. 결함으로 보지 않되 경합 존재 자체는 여기에 기록한다 |

## 건별 판정 — ④ myhub-eval-or-new-function 1건 (오탐, 설계상 허용)

| # | 위치 | 판정 근거 |
|---|---|---|
| 31 | src/services/studio-workspace.ts:249 | `new Function(content)`의 **반환값을 버린다** — 생성된 함수는 어디에도 저장·호출되지 않는다. 용도는 `.js` 파일의 문법 검증(생성자 파싱 단계의 SyntaxError만 수집)이며, 함수 본문은 실행되지 않는다. content는 소유자 본인의 스튜디오 파일이고 이 경로(validate)는 실행 경로가 아니다. `eval()` 사용처는 코드베이스에 없다 |

## 건별 판정 — ⑤ python dynamic-urllib-use-detected 15건 (전부 오탐)

공통: 전부 운영자(소유자)가 로컬에서 실행하는 배포·백업·실험 스크립트이며,
Worker 런타임 코드가 아니다. URL의 scheme/host는 상수이거나 운영자 본인이
CLI 인자로 지정하는 값으로, 원격 사용자 입력이 도달하는 경로가 없다.
urllib의 `file://` 등 스킴 남용은 URL 문자열을 공격자가 통제할 때만 성립한다.

| # | 위치 | URL 출처 | 판정 근거 |
|---|---|---|---|
| 32 | apply_d1.py:42 | 상수 `ACCOUNT_ID`/`DB_ID`로 구성한 `https://api.cloudflare.com/…` 고정 URL | 요청마다 같은 상수 URL. surrogate에 `allowed_hosts=['api.cloudflare.com']` 지정 |
| 33 | check_deploy_safety.py:36 | 문자열 리터럴 `https://myhub.myhub-app.workers.dev/login.html` | 완전 고정 리터럴. 동적 요소 없음 |
| 34 | deploy_full.py:144 | `_fetch_url(url, …)` 헬퍼 | 호출자 4곳 전부 `verify_deployment` 내부로, `base_url`은 `CONFIG['BASE_URL']`(고정 운영 도메인 상수) + 고정 경로(`/manifest.json`·`/api/system`·`/login.html`)만 결합. 외부 입력 없음 |
| 35 | deploy_full.py:287 | `api_json()`: `url = BASE + path`, `BASE='https://api.cloudflare.com/client/v4'` 상수 | path는 스크립트 내부 호출자들이 고정 문자열로 전달. surrogate `allowed_hosts=ALLOWED_HOSTS(['api.cloudflare.com'])` |
| 36 | deploy_full.py:512 | `url = BASE + '/accounts/{ACCOUNT_ID}/workers/assets/upload?base64=true'` | host/scheme은 상수 BASE 고정. ASSETS 업로드 경로 (surrogate 대신 assets JWT Bearer를 쓰는 경로라 allowed_hosts 지정은 없지만 URL 자체가 상수 구성) |
| 37 | deploy_full.py:718 | `url = BASE + '/accounts/{ACCOUNT_ID}/workers/scripts/{SCRIPT_NAME}'` | 상수 구성 + surrogate `allowed_hosts` 지정. Worker 업로드 경로 |
| 38 | deploy_safe.py:91 | `BASE` 상수 기반 (동일 패턴) | 폐기된 실험 스크립트(AGENTS.md 기록)이나 패턴은 #35와 동일하게 상수 URL |
| 39 | deploy_staging.py:158 | `BASE` 상수 + surrogate allowed_hosts | #35와 동일 패턴 |
| 40 | deploy_staging.py:179 | `base_url='https://myhub-staging.myhub-app.workers.dev'` 리터럴 + 고정 경로 dict 순회 | base_url·path 모두 파일 내 고정값 |
| 41 | deploy_staging_minimal.py:98 | `BASE` 상수 + surrogate allowed_hosts | #35와 동일 패턴 |
| 42 | scripts/backup_production.py:71 | `d1_query()`: 상수 `ACCOUNT_ID`/`DB_ID`로 구성한 `https://api.cloudflare.com/…/query` 고정 URL | 2026-10-29 P0 백업 스크립트. 토큰 있을 때 Bearer, 없을 때 surrogate `allowed_hosts=['api.cloudflare.com']`. SQL·params는 BACKUP_TABLES 파싱 + 페이지네이션으로 스크립트가 구성 (원격 입력 없음) |
| 43 | scripts/clairic-ab/probe_deploy.py:63 | `url = f"https://{NAME}.myhub-app.workers.dev/health"`, `NAME`은 파일 상수 | 일회용 프로브 Worker 헬스체크. host가 상수에서 결정됨 |
| 44 | scripts/clairic-ab/run_ab.py:81 | `BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run"` 상수 + `/{model}` | model은 스크립트 내부 arm 상수. surrogate `allowed_hosts=['api.cloudflare.com']` |
| 45 | scripts/clairic-ab/run_ab.py:121 | `call_probe(probe_url, …)`: `probe_url`은 운영자 CLI 옵션 `--probe-url` (기본값은 고정 프로브 도메인) | 운영자 본인이 실행 시 지정하는 값 — 자기 자신에 대한 지정이라 SSRF 피해자가 없다. 로컬 실험 도구 한정 |
| 46 | scripts/perf_test.py:26 | `BASE = sys.argv[1]` (기본값 고정 운영 도메인) + 고정 path | #45와 동일하게 운영자 지정 로컬 성능 도구. 원격 입력 없음 |

## 스캔 커버리지 한계 (2026-10-27 기록을 현재 기준으로 재확인)

1. `public/*.html` 인라인 스크립트는 Semgrep JS 규칙의 분석 대상이 아니다
   (2026-10-27 한계 그대로 유효). 프론트 XSS는 이 스캔으로 판정할 수 없다.
2. 공식 taint 규칙은 D1 `prepare()` 문자열 조립을 잡지 못해 커스텀 규칙으로
   보완 중이며, 그 커스텀 규칙은 보간 **존재**만 잡는다. 안전성은 본 문서처럼
   보간 출처를 사람이 추적해야 확정된다 — "검출 0건"이 아니라 "검출 전건 추적
   완료"가 본 재검증의 증거다.
3. 이번 스캔의 errors는 0건이었다 (2026-10-27에 기록된 memo-bundle.js 부분
   파싱 오류는, 번들이 스캔 제외 대상이라 이번 실행의 errors에 나타나지 않는다).

## 결론 및 후속

- 46건 전부 오탐, 진짜 결함 0건, 부분 해당 0건. **수정할 코드가 없어 회귀
  테스트·카나리아는 해당 없음** (테스트 원칙상 만들 이유 없는 테스트는 만들지
  않는다).
- 규칙은 끄지 않았다. 신규 코드가 같은 패턴을 쓰면 다시 검출되며, 그때는
  본 문서 형식으로 건별 판정을 추가하는 것이 절차다.
- CI 게이트(`--error`/베이스라인) 적용 여부는 2026-10-27 메모 그대로 미결정
  사항으로 남긴다 (본 트랙 범위 밖, 코디네이터 판단 사항).

## 검증

- 스캔 2회 실행: 46건·동일 집합, exit 0 (본문 "실행 방법" 참조).
- 본 트랙은 문서만 추가했고 프로덕션·테스트 코드를 변경하지 않았다.
  전수 테스트 수치는 본 문서와 함께 보고되는 실행 결과(Jest·tsc)를 참조.
