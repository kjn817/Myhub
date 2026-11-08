# MCP 서버 본체 — 구현 기록 (2026-10-28)

> 브랜치 `apply/mcp-server` (HEAD 3f61071 기준). 구현 + tsc + 기본 동작 확인까지.
> 병합·배포 안 함. 정식 테스트·Inspector 검증은 후속 테스트 트랙.
> 마이그레이션 0060은 운영 D1에 미적용.

## 1. SDK 버전 검증 (npm 실측, 2026-10-28)

| 항목 | 실측 |
|---|---|
| 설치 패키지 | `@modelcontextprotocol/server` **2.4.0** (latest) + transitive `@modelcontextprotocol/core` 2.4.0 |
| 라이선스 | Apache-2.0 (패키지 `license` 필드 직접 확인) |
| 의존성 | zod `^4.2.0` (저장소 zod 4.6.7과 호환), node `>=20` (런타임은 workerd shim) |
| Workers 호환 | `./_shims` 조건부 export에 **workerd** 분기 존재 (`CfWorkerJsonSchemaValidator`, `process` 스텁). esbuild `--conditions=workerd`로 번들 확인 (§6) |

**조사 문서(`docs/recent-trends-20261028.md` §1-1)의 버전 정보는 부정확했다 — 정정:**
- `@modelcontextprotocol/sdk` v2.0.0은 존재하지 않는다. v2는 분할 패키지
  (`@modelcontextprotocol/server` / `@modelcontextprotocol/client`)이고,
  `@modelcontextprotocol/sdk` **1.32.2**는 레거시 v1.x 라인(버그픽스만)이다.
  "v2.0.0 GA 이후 v1.30.0 계열"이라는 서술은 2차 출처의 오해로 보인다.
- 이 트랙은 v1 SDK가 아니라 **v2 `@modelcontextprotocol/server` 2.4.0**을 설치했다.

## 2. 2026-07-28 스펙 지원 여부 (SDK README·문서·코드 직접 확인)

| 스펙 요소 | SDK 2.4.0 지원 | 확인 방법 |
|---|---|---|
| stateless 코어 (요청마다 fresh 서버, 세션 없음) | ✅ | `createMcpHandler(factory)` — "factory runs once per request", `Mcp-Session-Id` 없음 |
| `initialize` 핸드셰이크 폐지 | ✅ (모던 경로) | 모던 요청은 `_meta` 봉투(`io.modelcontextprotocol/protocolVersion: "2026-07-28"` 등)로 버전·capability 선언, `tools/list` 직접 POST 가능 (실측 §5) |
| Streamable HTTP | ✅ | `createMcpHandler`가 Streamable HTTP 핸들러. HTTP+SSE 미사용 |
| `Mcp-Method`·`Mcp-Name` 헤더 라우팅 | ✅ (필수) | 모던 요청은 헤더·본문 일치 검사: `MCP-Protocol-Version` + `Mcp-Method`(+ `tools/call`이면 `Mcp-Name`) 누락 시 400 `-32020` (실측) |
| list 결과 `ttlMs` 캐시 힌트 | ✅ (SDK에 존재) | `CacheHint { ttlMs }`, `tools/list`가 cacheable 결과에 포함. 단, 본 구현은 아직 `ttlMs`를 내보내지 않는다 (후속 결정 사항 §7) |
| `responseMode: 'json'` (SSE 없이 단일 JSON) | ✅ | `createMcpHandler` 옵션으로 사용 중 |
| sampling·roots | 미구현 (의도적) | 스펙에서 폐지 예고 — 신규 구현 금지 지침 준수 |
| OAuth 2.1 풀 구현 | 미구현 (의도적) | 개인용 단일 사용자 — Bearer MCP 토큰 + PIN 세션으로 대체 (§3) |
| 2025-era 클라이언트 호환 | ✅ (기본값) | `legacy: 'stateless'` — `initialize` 핸드셰이크 요청도 세션 없이 받아 SSE로 답한다 (실측 §5). `legacy: 'reject'`로 모던 전용 전환 가능 |

## 3. 인증·토큰 설계

### 인증 수단 (둘 중 하나 — 미인증은 401)
1. **PIN 세션** — 기존 `myhub_session` 쿠키 + `verifySessionForEnv` 재사용
   (세션 버전 대조 포함). 브라우저·동일 세션에서 MCP를 쓸 때.
2. **MCP 토큰** — `Authorization: Bearer mcp_...`. 외부 MCP 클라이언트용.

### 토큰 (D1 `mcp_tokens`, 마이그레이션 0060)
- 값: `mcp_` + base64url(CSPRNG 32바이트). 평문은 **발급 시 1회만 반환**,
  저장되는 것은 **SHA-256 해시뿐** (재조회 불가, `token_hash UNIQUE`).
- 컬럼: `id, email, token_hash, label, created_at, last_used_at, revoked_at`.
- 폐기는 소프트 삭제 (`revoked_at` 기록 — 감사 추적용).
- 활성 토큰 상한: 사용자당 **10개** (초과 시 발급 400).
- 성공 검증 시 `last_used_at`을 best-effort로 갱신 (갱신 실패가 인증을 막지 않음).
- 토큰 값은 로그·에러 응답·목록 응답에 절대 포함하지 않는다.
- 인증 실패 속도 제한: 발신자별 20회/시간 + 전역 100회/시간
  (`/verify`·`/pin-login`과 같은 상한, D1 `rate_limits` 재사용).
  rate_limits 테이블이 없는 DB에서는 best-effort로 건너뛴다 (401은 유지).

### 토큰 관리 엔드포인트 (PIN 세션 전용)
| 엔드포인트 | 동작 |
|---|---|
| `POST /api/mcp/tokens` `{label?}` | 발급 → 201 `{id, token, label, created_at}` (**token은 이 응답에서만 확인 가능**) |
| `GET /api/mcp/tokens` | 목록 (해시·토큰 값 없음) |
| `DELETE /api/mcp/tokens/:id` | 폐기 → 200 (미존재 404) |

- 전역 인증 미들웨어가 `/api/mcp/tokens*`에 세션을 먼저 강제하고,
  핸들러가 `verifySessionForEnv`로 한 번 더 검증한다 (이중화).
- 발급은 **모든 유효 세션**(OTP·PIN)을 받는다. PIN 재설정 같은 OTP step-up은
  적용하지 않았다 — 세션 탈취 시 이미 UI 전체가 노출되는 것과 같은
  위협 모델이라 별도 step-up의 실익이 작다고 판단 (후속 결정 사항 §7).

### 사용자 단계 (토큰 발급·사용)
1. 로그인 후 `POST /api/mcp/tokens`로 토큰 발급 (label 지정 권장) —
   토큰 값을 안전한 곳에 보관한다. **다시 볼 수 없다.**
2. MCP 클라이언트 설정에 `https://myhub.myhub-app.workers.dev/api/mcp` +
   `Authorization: Bearer <토큰>`을 등록한다.
3. 쓰지 않는 토큰은 `DELETE /api/mcp/tokens/:id`로 폐기한다.
4. (운영 적용 전) 마이그레이션 0060을 운영 D1에 적용해야 한다.
   운영 적용은 배포 절차의 일부로, 이 트랙에서는 하지 않았다.

## 4. 도구 4개 (모두 읽기 전용)

| MCP 이름 | 입력 | 재사용 경로 | 출력 상한 |
|---|---|---|---|
| `memo.search` | query(1–120자), limit(1–10, 기본 5) | `searchAccessibleMemos` (FTS5 → 키워드 FTS → LIKE) + MCP 내 trigram 단계 | excerpt 200자/건 |
| `schedule.list` | from/to(YYYY-MM-DD), status, limit(1–100, 기본 50) | `listSchedules` (GET /api/schedule/list와 동일, 반복 전개 포함) | description 200자/건 |
| `todo.list` | status(pending/done/all), limit(1–100, 기본 50) | `listTodos` (GET /api/todo/list와 동일) | description 500자/건 |
| `memory.search` | query(2–120자), limit(1–5, 기본 5) | `getRelevantMemories` (v2 플래그·동의 게이트·인용 잠금) | content 1000자/건 |

- 정의 형태: Plan & Execute와 같은 모양 — Zod 스키마 + `ToolDefinition`
  (`parameters`는 `registry.ts`의 `toJsonSchema`로 같은 스키마에서 생성) +
  typed executor. `MCP_TOOLS` 배열이 등록 단위이며, P&E 재사용은
  `function-calling-route.ts`의 `search_memo` 래퍼 패턴과 같다
  (`schema.safeParse` → typed executor).
- MCP 등록 시 `annotations: { readOnlyHint: true }`, 결과는
  `content(text JSON) + structuredContent`를 함께 반환한다.
- 도구 이름은 스펙이 허용하는 점 표기(`memo.search` — 스펙은
  `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`)이다. 단, OpenAI API 브릿지처럼
  `^[A-Za-z0-9_-]+$`만 받는 호스트에서는 거부될 수 있다 (§7).

### memo.search의 trigram 단계 — 왜 ai-access를 안 고쳤나
- `searchAccessibleMemos`에 trigram을 넣으면 pinned 테스트
  (`svc2-ai-access.test.ts` — "전체 왕복은 최대 3회")가 깨지고 AI 검색
  동작이 바뀐다. 그래서 ai-access는 그대로 두고, MCP 도구 안에서만
  `searchAccessibleMemos`가 빈 결과를 낸 뒤 trigram 단계
  (`memos_fts_tri`, `trigramQuery` 재사용)를 추가한다.
- trigram 단계에도 잠금·민감도 필터를 SQL(`is_locked = 0 AND sensitivity <= 1`)과
  `isMemoAccessibleForAI` 코드 검사로 이중 적용한다. 0059 미적용 DB에서는
  테이블이 없어 throw → 빈 결과로 폴백한다.

## 5. 보안 경계 확인 사항 (실측)

- **잠긴 메모 원천 제외 (카나리아 PASS)**: miniflare 실런타임에서 잠긴 메모
  (`is_locked=1`, "카드번호" 포함)와 민감도 2 메모를 시드하고
  `memo.search`를 호출 — 응답 전문에 "카드번호"·"기밀 프로젝트" 없음,
  잠긴 메모만 매칭되는 질의("카드번호")는 빈 결과. (스크래치 테스트 10건
  전부 통과 후 파일 삭제 — 정식 테스트는 후속 트랙.)
- **memory.search 인용 잠금**: 활성 기억 `citable=true`, 대체된 기억
  `citable=false` + `superseded=true`로 반환 (사실로 인용 불가 표시).
  동의 게이트(`allow_ai_use`·`allow_provider_send`)와 v2 플래그는
  `getRelevantMemories` 재사용으로 그대로 적용된다.
- **미인증 거부**: 쿠키·토큰 없음 → 401, 잘못된 Bearer → 401, 폐기한 토큰 → 401.
- **토큰 평문 비노출**: 목록 응답에 `token_hash`·토큰 값 없음 (응답 전문 대조).
- **쓰기 도구 없음**: 등록 도구가 4개 읽기 도구뿐이고, executor의
  `approvedWrites: false`로 고정된다.
- **Host/Origin 검증 미적용**: SDK 문서가 권하는 `hostHeaderValidationResponse`
  등을 달지 않았다. 공개 Workers 엔드포인트는 Host 기반 라우팅이라
  DNS rebinding의 전형적 대상(localhost)이 아니고, 인증 게이트 + CORS
  미설정(브라우저 cross-origin 읽기 차단)이 1차 방어선이다. 필요 시
  후속 결정 사항 (§7).
- **요청 본문 상한**: SDK 기본 4 MiB (`maxRequestBodySize` 미변경).

## 6. 배포 관련 변경

- `deploy_full.py` esbuild 호출에 **`--conditions=workerd` 추가 (필수)**:
  조건이 없으면 SDK의 `./_shims`가 node shim(`node:process` import)을 타서
  `--platform=neutral` 번들이 실패함을 실측했다. 조건 추가 후 번들 성공.
  workerd 조건이 없는 패키지는 default 분기로 떨어져 기존 번들에 영향 없음.
- 번들 크기 (동일 조건 실측): `src/index.ts` 기준 1,796,776 → **2,242,208 bytes
  (+445,432, +24.8%)**. 한도 내이나 SDK+AJV가 무거운 편이다.
- `src/index.ts` 전역 미들웨어 allowlist에 **정확한 경로 `/api/mcp`만** 추가.
  `/api/mcp/tokens*`는 allowlist에 없어 세션 검사를 그대로 받는다.
- `wrangler.toml`·바인딩 변경 없음. `src/index-inline.ts`는 배포 시 생성물이라
  건드리지 않았다 (배포 검증은 배포 트랙에서).

## 7. 남은 결정 사항

1. **MCP Inspector 검증 미실시** — 서브에이전트에서 라이브 브라우저 불가.
   후속 테스트 트랙이 Inspector로 로컬 연결·도구 목록·실제 클라이언트
   (Claude Code 등) 연동을 확인할 것. 프로토콜 자체는 모던/레거시
   클라이언트 형태로 miniflare에서 검증 완료 (§5).
2. **도구 이름 점 표기 유지 여부** — 스펙상 허용되나 OpenAI 브릿지 등
   일부 호스트에서 거부될 수 있다. 실제 클라이언트에서 거부되면
   `memo_search` 등으로 rename (정의 1곳 + 문서만 바꾸면 된다).
3. **`ttlMs` 캐시 힌트 미적용** — SDK에 `CacheHint`가 있으나 본 구현은
   `tools/list`에 힌트를 달지 않았다. 적정 TTL(도구 목록은 거의 안 바뀜)
   정해서 다는 것은 후속 작업.
4. **토큰 발급 step-up 여부** — 현재 모든 유효 세션을 받는다. OTP 세션만
   받게 강화할지는 사용자·보안 판단이 필요하다.
5. **Host/Origin 검증 추가 여부** — §5 참조. 공개 엔드포인트라 당장은
   미적용이나, 보안 감사에서 요구되면 SDK 헬퍼를 앞에 두면 된다.
6. **memory.search 재현율 한계 (기존 경로의 한계, MCP가 만든 것 아님)** —
   v2 검색은 FTS 토큰 정확 일치라 조사 없는 질의('테니스')로는
   '테니스를' 토큰을 못 찾는다 (조사 붙은 질의에서만 접두사 검색 생성).
   LIKE 폴백은 FTS 예외 시에만 동작해 빈 결과에는 안 탄다. MCP도 같은
   경로를 재사용하므로 같은 한계를 갖는다. 개선은 메모리 검색 자체의
   후속 작업이다.
7. **쓰기 도구** — 승인 게이트 뒤에 두는 후속 작업. `memo.create` 등은
   이 트랙 범위 밖이다.

## 8. 변경 파일

- `package.json` / `package-lock.json` — `@modelcontextprotocol/server ^2.4.0`
  추가 (+ `@modelcontextprotocol/core` 2.4.0 transitive). lock의
  `@cloudflare/workers-types` 5.20261005.1 → 5.20261028.1 재동기화는
  이미 설치된 버전과 맞춘 부수 변경이다 (HEAD lock이 out-of-sync였다).
- `migrations/0060_mcp_tokens.sql` — 신규 (운영 미적용).
- `src/modules/mcp/routes.ts` — 신설 (POST /api/mcp + 토큰 관리).
- `src/modules/mcp/server.ts` — 신설 (McpServer 팩토리).
- `src/modules/mcp/tools.ts` — 신설 (도구 4개 정의·실행).
- `src/modules/mcp/tokens.ts` — 신설 (토큰 발급·검증·폐기).
- `src/modules/memo/routes.ts` — `trigramQuery` export만 추가.
- `src/modules/schedule/routes.ts` — `listSchedules` 추출·export
  (GET /list 핸들러는 위임만, 동작 동일).
- `src/modules/todo/routes.ts` — `listTodos` 추출·export (동일).
- `src/modules.ts` — mcp 모듈 등록 (`hidden: true`).
- `src/index.ts` — `/api/mcp` 정확한 경로만 allowlist 추가.
- `deploy_full.py` — esbuild `--conditions=workerd` 추가.
- `docs/mcp-server-20261028.md` — 본 문서.

## 9. 검증 증거

- `npx tsc --noEmit` 통과.
- 관련 Jest: schedule/todo/memo/ai-access/search-memo/memory-routes
  6개 스위트 **339건 통과**, auth 3개 스위트 **129건 통과**.
- miniflare 실런타임 전체 **45건 통과** (기존 35건 + MCP 스크래치 10건).
  스크래치 10건: 미인증 401·오토큰 401·토큰 목록 비노출·모던 tools/list
  (initialize 없이 도구 4개 + readOnlyHint)·레거시 initialize 200(SSE)·
  카나리아(잠금·민감 제외 + 잠금 전용 질의 빈 결과)·schedule/todo 시드·
  memory.search 인용 잠금·폐기 후 401. 스크래치 파일은 검증 후 삭제했다.
- esbuild 번들: `--conditions=workerd`로 성공 (조건 없으면 `node:process`
  해소 실패로 빌드 실패 — 실측).
