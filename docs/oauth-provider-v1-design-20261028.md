# Workers OAuth Provider v1 + step-up — 스코프 설계 및 도입 설계 (2026-10-28)

> 설계 + POC 기록. 운영 코드 변경 없음, 병합·배포하지 말 것.
> 기준 HEAD 1da3477 (브랜치 `apply-trends-1-oauth`).
> 근거: `docs/provider-research-20261028-track2.md` §1-1 (브랜치 `apply/provider-research-20261028` @2086f21),
> Cloudflare 공식 문서·체인지로그 직접 확인 (아래 "공식 근거" 절).
> POC: `poc/oauth-provider-v1/` (로컬 workerd 하네스에서 검증, 운영·스테이징 Worker 미사용).

## 0. 전제 정정 — 스테이징은 없다 (2026-10-28 19:45 사용자 지시)

본 작업의 원 지시는 "스테이징 도메인으로 결정"이었으나, 사용자가 2026-10-28 19:45에
"스테이징없어 우린 그냥 바로 운영배포야"로 정정했다. 실무 흐름은 개발 → 테스트 완료 →
바로 배포(`deploy_full.py production`) → 배포 후 QA이다.

따라서 본 문서의 결정은 다음과 같이 바뀐다.

- **POC 검증 환경**: 격리 환경에서 한다 — 로컬 workerd 하네스(miniflare 계열,
  `wrangler createTestHarness`) 또는 일회용 스크래치 Worker(검증 후 삭제).
  스테이징 Worker는 만들지 않는다. 운영 Worker·운영 D1에는 POC 단계에서 손대지 않는다.
- **식별자(RP ID·도메인에 해당)**: 인증 서버 분리는 격리 스크래치 Worker 도메인으로
  POC하고, **운영 도메인은 배포 결정 때 정한다** (2026-10-28 20:01 정정).
  POC 하네스에 쓰는 issuer URL은 자리 표시자일 뿐 결정이 아니다.
  리소스 URL만 예외로, 이미 배포된 운영 엔드포인트라 고정돼 있다 (§1).
- **운영 도입**: 별도 승인 후 `deploy_full.py production` 한 줄로 직접 배포한다
  (본 작업 범위 밖 — 배포 자체는 이번 작업에서 하지 않는다).

## 1. 식별자 결정

| 항목 | 값 | 상태 |
|---|---|---|
| 리소스 (MCP 서버, canonical) | `https://myhub.myhub-app.workers.dev/api/mcp` | **결정** — 이미 배포된 운영 MCP 엔드포인트. 바꾸면 기존 클라이언트·토큰 audience가 깨지므로 고정. |
| 인증 서버 issuer | `https://myhub-auth.myhub-app.workers.dev` | **미결정 (POC용 자리 표시자)** — 값은 제안일 뿐 결정이 아니다. 운영 도메인은 배포 결정 때 정한다. issuer는 grant·토큰·클라이언트 등록에 박히므로 한 번 정하면 바꾸기 어렵다. |
| 인증 서버 Worker명 | `myhub-auth` | 제안 (issuer와 동일, 미결정). |

POC(`poc/oauth-provider-v1/`)는 위 두 URL을 식별자 상수로 쓴다.
리소스 URL은 실제 운영 엔드포인트(고정)이고, issuer URL은 로컬 하네스용 자리 표시자이다.
하네스는 DNS를 타지 않으므로 로컬 workerd에서도 이 값으로 검증된다.
스크래치 Worker로 라이브 검증을 하면 그때 스크래치 Worker의 실제 URL로 바꿔 쓴다
(`poc/oauth-provider-v1/README.md` 참조).

## 2. 스코프 설계

### 2-1. 스코프 3단

| 스코프 | 의미 | 허용하는 도구 | 허용하는 엔드포인트 |
|---|---|---|---|
| `mcp:read` | 읽기 전용. 모든 접근의 baseline. | `memo.search`, `schedule.list`, `todo.list`, `memory.search` (현행 4개) | `POST /api/mcp` (읽기 호출·`initialize`·`tools/list`), `GET /api/mcp/tokens` (목록 조회) |
| `mcp:write` | 상태 변경. `mcp:read`와 함께 있어야 유효하다 (쓰기만으로는 부족 — 아래 §2-2). | POC: `memo.create`. 후속: `memo.update`·`memo.delete`, `schedule.create`·`schedule.update`·`schedule.delete`, `todo.create`·`todo.update`·`todo.delete`, 메모리 쓰기 도구 | `POST /api/mcp` (쓰기 도구 호출) |
| `mcp:admin` | 토큰·grant 관리. 데이터 접근 권한이 아니다 (읽기·쓰기를 함의하지 않는다). | (도구 없음 — 관리 API 전용) | `POST /api/mcp/tokens` (발급), `DELETE /api/mcp/tokens/:id` (폐기), OAuth grant 목록·폐기 |

인증 서버가 광고하는 전체 카탈로그(`scopesSupported`): `mcp:read`, `mcp:write`,
`mcp:admin`, `offline_access` (리프레시 토큰용 — 리소스 baseline이 아님).

리소스가 광고하는 baseline(`requiredScopes`): `mcp:read`만.
카탈로그를 리소스에 그대로 복사하지 않는다 — 그러면 모든 클라이언트가 첫 로그인 때
전부 요구하게 된다 (라이브러리 문서 "Scopes and step-up authorization" 절).

### 2-2. 함의 규칙 — 없음

- `mcp:write`는 `mcp:read`를 **함의하지 않는다**. 쓰기만 받은 토큰으로 쓰기 도구를
  호출하면 403이다. 모든 쓰기 연산은 `['mcp:read', 'mcp:write']`를 함께 요구한다
  (공식 split-workers 예제·e2e와 동일).
- `mcp:admin`은 읽기·쓰기를 **함의하지 않는다**. 관리 토큰으로 메모를 읽을 수 없다.
- `requiredScopes`는 광고일 뿐 강제하지 않는다 — 핸들러가 직접 검사한다
  (라이브러리 명시: "requiredScopes is advertised, not enforced").
  검사 지점: 리소스 서버 핸들러가 `tools/call` 요청의 도구명을 보고
  `insufficientScope(ctx.auth, [...])`를 반환한다.

### 2-3. step-up 흐름 (프로토콜)

1. 미인증 호출 → `401`, `WWW-Authenticate: Bearer ..., scope="mcp:read"`,
   `resource_metadata` URL (RFC 9728).
2. 클라이언트는 `mcp:read`로만 승인받아 읽기 토큰을 얻는다.
3. 쓰기 도구 호출 → `403`, `WWW-Authenticate: Bearer error="insufficient_scope",
   scope="mcp:read mcp:write"`, 같은 `resource_metadata` URL.
4. 클라이언트가 사용자에게 추가 승인을 묻고 `mcp:read mcp:write`로 재승인 →
   새 토큰으로 재호출 → 200. 기존에 받은 스코프는 유지된다.
5. 거절·실패 시 쓰기는 일어나지 않는다 (403이 executor 전에 반환된다 — POC 카나리아로 검증).

이 흐름은 MyHub의 "위험 기반 승인 게이트"를 프로토콜 표준 형태로 옮긴 것이다.
쓰기 도구의 실제 실행은 기존 승인 게이트(P&E)와 별개로, 스코프는 그 앞단의
"클라이언트가 이 연산을 부를 자격이 있는가"를 가린다. 스코프가 있다고 승인 게이트가
면제되는 것이 아니다 — 쓰기 도구 도입 시점에 두 층을 함께 설계한다.

### 2-4. 기존 MCP 토큰(Bearer `mcp_`)과의 관계

| 질문 | 답 |
|---|---|
| v1으로 옮기면 기존 토큰이 무효화되는가? | **아니오 — DB 행은 그대로이고, 코드가 계속 받아주면 계속 동작한다.** OAuth 토큰은 인증 서버 KV에, `mcp_` 토큰은 D1 `mcp_tokens`에 저장되는 별개 체계라, v1 도입 자체가 기존 행을 지우거나 무효화하지 않는다. |
| 어떻게 공존하는가? | 리소스 서버의 `validateToken`이 토큰 형태(`mcp_` 접두사)로 먼저 구분해 D1에서 직접 검증한다 (라이브러리 문서 "Alongside your own tokens" 절의 공식 지원 패턴). 형태가 맞지 않으면 인증 서버에 위임한다. 만료된 자사 토큰이 외부로 새지 않도록 형태 검사가 먼저이다. |
| 기존 토큰의 스코프는? | **`mcp:read`로만 매핑한다.** 발급 당시에 스코프 개념이 없었고, 쓰기를 허락한 적이 없으므로, 읽기 전용이 안전한 매핑이다. 기존 토큰으로 쓰기 도구를 부르면 `403 insufficient_scope`이다 (POC 카나리아로 검증). |
| 기존 토큰을 무효화하려면? | 폴백 코드를 제거하면 된다 (행은 남고, 폐기는 기존 `DELETE /api/mcp/tokens/:id`로 계속 가능). 제거 시점은 모든 클라이언트가 OAuth로 이주한 뒤 별도 결정한다. 제거 전까지는 두 경로 유지 비용(분기 10줄 내외)을 감수한다. |

## 3. 분리 구성 (split API)

```
┌─────────────────────────────┐   Service Binding (공개 인터넷 미경유)
│ 인증 서버 Worker  myhub-auth │   ┌──────────────────────────────────┐
│ - OAuthAuthorizationServer  │◄──│ 리소스 서버 Worker  myhub        │
│ - /authorize (PIN 로그인 +  │   │ - OAuthResourceServer            │
│   동의 페이지) — 운영 wiring│   │ - POST /api/mcp (+ 기존 라우트)  │
│ - /oauth/token · /oauth/    │   │ - validateToken: AUTH_SERVER 위임 │
│   register (DCR)            │   │   + mcp_ 폴백 (D1 직접 검증)     │
│ - KV: OAUTH_KV (토큰·grant· │   │ - 스코프 검사 → insufficientScope│
│   클라이언트, 해시 저장)    │   │ - D1: 기존 바인딩 유지            │
└─────────────────────────────┘   └──────────────────────────────────┘
```

- 토큰 검증은 요청마다 Service Binding RPC 1회 (Cloudflare 내부망).
- 인증 서버 1개가 여러 MCP 서버에 토큰을 발급할 수 있다 (지금은 1개 리소스만 등록).
- `/authorize`는 애플리케이션 코드이다: 운영 wiring은 기존 PIN 로그인
  (`verifySessionForEnv` 재사용) + 동의 페이지(요청 스코프 표시, `mcp:write`·
  `mcp:admin`은 별도 경고) + `completeAuthorization()`이다.
  POC의 `/authorize`는 테스트용 자동 승인(고정 테스트 사용자)이며,
  **도달 가능한 Worker에 그대로 배포해서는 안 된다** (POC README 참조).
- 클라이언트 등록: POC는 DCR(`/oauth/register`)을 쓴다 (공식 e2e와 동일).
  운영에서는 CIMD(Client ID Metadata Documents)도 켜는 것을 검토한다
  (Claude·Cursor·ChatGPT 등 신형 클라이언트 우선 방식. `global_fetch_strictly_public`
  플래그 필요). DCR은 구형 클라이언트 호환용으로 유지한다.
- 토큰 수명: 기본값 사용 (액세스 토큰 단기, 리프레시 30일·회전).
  `refreshTokenIdleTTL`(슬라이딩 만료)은 운영 결정 사항으로 남긴다.

## 4. POC 검증 결과

POC: `poc/oauth-provider-v1/` — 인증 서버 + 리소스 서버 + e2e 테스트
(`wrangler createTestHarness`, workerd 로컬 실행, 운영·스테이징 미사용).
실행: `cd poc/oauth-provider-v1 && ../../node_modules/.bin/vitest run --config vitest.config.ts`
실행 환경: wrangler 4.147.0, `@cloudflare/workers-oauth-provider` 1.2.4,
`@modelcontextprotocol/server` 2.4.0, vitest 5.0.5. 실행일 2026-10-28.

| 검증 항목 | 결과 | 비고 |
|---|---|---|
| 401 discovery → resource metadata → AS metadata (`scopes_supported` 카탈로그) | **PASS** | `scope="mcp:read"` 챌린지, `authorization_servers=[issuer]`, 카탈로그 4개 일치 |
| `mcp:read` 토큰 → `memo.search` 200 (실제 잠금 해제 메모 반환) | **PASS** | 시드 메모 정확 일치 반환 (실제 `MCP_TOOLS` executor 경유) |
| `mcp:read` 토큰 → `memo.create` 403 `insufficient_scope` + 메모 미생성 (카나리아) | **PASS** | `scope="mcp:read mcp:write"` 챌린지, D1 행 수 불변. **카나리아 확인**: 게이트를 `[mcp:read]`로 망가뜨리면 이 테스트 포함 2건이 실패하고, 복원하면 8/8 그린으로 돌아온다 |
| step-up 토큰 (`mcp:read mcp:write`) → `memo.create` 200 + D1 행 생성 확인 | **PASS** | 반환 id로 D1 조회해 text 일치 확인 |
| `mcp:write` 단독 토큰 → `memo.create` 403 (baseline 필요 — 카나리아) | **PASS** | 쓰기만으로는 부족함을 실증 |
| 기존 `mcp_` 토큰 → `memo.search` 200 (읽기 유지) | **PASS** | v1 도입이 기존 토큰을 무효화하지 않음을 실증 (§2-4) |
| 기존 `mcp_` 토큰 → `memo.create` 403 `insufficient_scope` (카나리아) | **PASS** | 기존 토큰은 `mcp:read`로만 매핑됨을 실증 |
| 미등록 리소스(`https://evil.example/mcp`)로 authorize → 거부 | **PASS** | 코드 미발급 (302 error 또는 400, `code=` 없음) |
| Inspector / Claude Code에서의 step-up UX | 미검증 | 클라이언트별 지원 편차 — 후속 확인 필요 |
| 일회용 스크래치 Worker 라이브 검증 (실망 Service Binding) | 미수행 | 로컬 workerd까지만 검증. 필요 시 스크래치 Worker 2개로 확인 후 삭제 (POC README 참조) |

회귀: 저장소 tsc 클린, Jest MCP 25/25 (`tests/mcp-tokens.test.ts`·`tests/mcp-tools.test.ts`),
런타임 MCP 29/29 (`tests/runtime/mcp-server.test.ts`) — `src/`는 건드리지 않았고
`package.json`에 의존성 1개(`@cloudflare/workers-oauth-provider` 1.2.4, exact pin)만 추가했다.

POC 쓰기 도구 `memo.create`는 D1 `memos`에 직접 INSERT하는 최소 구현이다
(태그 동기화·파일·이벤트 제외). 운영 쓰기 도구는 실제 메모 생성 경로 +
승인 게이트를 재사용해야 하며, 이 스텁을 그대로 운영에 올리지 않는다.
POC 메모는 잠기지 않은 테스트용 메모만 쓴다.

## 5. 운영 도입 전제 조건 (전부 미충족 — 도입 결정 시 체크리스트)

1. **issuer 확정 (배포 결정 때)**: `myhub-auth.myhub-app.workers.dev`는 제안일 뿐이다.
   배포 결정 때 최종 확정한다 (바꾸면 grant 무효화).
2. **인증 서버 Worker 신설**: `myhub-auth` Worker + KV `OAUTH_KV` 생성.
   `deploy_full.py`는 단일 Worker 전제라, 두 번째 Worker 배포 단계가 추가돼야 한다
   (인증 서버 먼저 배포 → myhub에 `AUTH_SERVER` 서비스 바인딩).
   **주의 (2026-10-28 발견)**: `keep_bindings`는 `secret_text`만 보존하고
   `plain_text` 바인딩은 보존하지 않는다. 서비스 바인딩·평문 변수는
   `deploy_full.py`의 `build_worker_metadata()`에 명시 바인딩으로 넣어야
   다음 배포 때 사라지지 않는다. 대시보드에서만 켠 값은 배포 때 조용히 사라진다.
3. **`/authorize` 운영 wiring**: PIN 로그인 재사용 + 동의 페이지
   (라이브러리 consent helper의 confused deputy 보호 포함) + 스코프별 경고 문구.
4. **리소스 서버 통합**: 기존 `src/index.ts`의 `/api/mcp`를
   `OAuthResourceServer`로 감싸되, PIN 세션 쿠키 경로와 `mcp_` 폴백을 유지한다.
   리소스 URL은 현행 `/api/mcp` 그대로 (고정).
5. **쓰기 도구 도입과 함께**: 스코프 게이트 + 기존 승인 게이트 2층 설계,
   `mcp:write` 동의 UX, 클라이언트 미지원 시 폴백(쓰기 도구 호출 실패를
   사용자에게 설명하는 메시지).
6. **KV 정리 Cron**: `purgeExpiredData()`를 Cron Trigger로 주기 실행
   (라이브러리 권장. 기존 `*/5` Cron과는 별도 스케줄 검토).
7. **비용 확인**: Workers Free 범위 내 (요청 10만/일, KV 읽기 10만/일·쓰기 1천/일).
   단일 사용자 규모에서는 무료 범위 내이나, 토큰 검증이 요청마다 KV 읽기를
   하므로 사용량 모니터링을 둔다. 별도 과금 항목 없음.

## 6. 남은 결정 사항

- 운영 issuer 이름 최종 확정 (§1).
- `mcp:admin`의 실제 집행 지점: 토큰 발급·폐기·grant 폐기 API에 스코프 검사를
  붙이는 작업 (설계만 있고 POC 미구현 — 관리 API는 현재 PIN 세션 전용).
- `refreshTokenIdleTTL` 적용 여부 (슬라이딩 만료).
- CIMD 활성화 여부 (신형 클라이언트 대응) vs DCR만 유지.
- `mcp_` 폴백 제거 시점 (모든 클라이언트 OAuth 이주 후).
- Inspector·Claude Code·Cursor에서의 step-up UX 실측 (클라이언트별 지원 매트릭스).
- 두 Worker 배포 절차를 `deploy_full.py`에 넣을지, 별도 스크립트로 둘지.

## 7. 공식 근거 (직접 확인, 2026-10-28)

- v1 발표 (2026-10-01): https://developers.cloudflare.com/changelog/post/2026-10-01-workers-oauth-provider-1x/
  — split API, MCP 2026-07-28 지원 (Client ID Metadata Documents, RFC 9207 issuer 식별),
  `insufficientScope()` 한 줄 step-up, Service Binding 토큰 검증.
- step-up 발표 (2026-10-19): https://developers.cloudflare.com/changelog/post/2026-10-19-cloudflare-mcp-step-up/
  — Cloudflare API MCP 서버 step-up 지원, `insufficient_scope` 챌린지, 기존 스코프 유지.
- 인증 가이드: https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/
  — `OAuthResourceServer` + `requiredScopes`는 광고일 뿐 강제 아님, 핸들러에서
  `insufficientScope()`로 검사, `ctx.auth.scope` 확인, 도구별 조건부 등록 패턴.
- 보안 가이드: https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/
  — audience 검사 (다른 리소스용 토큰 거부), 스코프 검사 위치.
- 라이브러리: `@cloudflare/workers-oauth-provider` **1.2.4** (MIT, 의존성 0개),
  동봉 문서 `docs/authorization-server.md`·`docs/resource-servers.md`
  (스코프 3곳 구분, "Alongside your own tokens" 폴백 패턴, KV 저장 방식),
  공식 예제 `examples/split-workers/` (auth-server + mcp-server + e2e.test.ts —
  POC의 직접 원형. e2e는 401 → 읽기 → 쓰기 403 → step-up → 쓰기 200 → 쓰기 단독 403 흐름).

## 8. 변경 이력

- 2026-10-28: 초안 작성 + POC (`poc/oauth-provider-v1/`) — 브랜치 `apply-trends-1-oauth`.
- 2026-10-28 20:01 정정 반영: "스테이징에서만 검증" → 격리 환경(로컬 workerd 하네스 또는
  일회용 스크래치 Worker, 검증 후 삭제)으로 POC. 인증 서버 분리는 격리 스크래치 Worker
  도메인으로 POC하고 운영 도메인은 배포 결정 때 정한다. POC issuer URL은 자리 표시자이며
  결정이 아니다 (§0·§1·`poc/oauth-provider-v1/common.ts` 주석 정정).
  책임 원칙(2026-10-28 19:46): 복잡하게 만들지 말 것 — 본 작업은 설계 문서 1개 + POC
  2개 Worker + e2e 1개로 단순하게 유지했고, `src/`를 건드리지 않아 깨뜨린 것이 없다
  (tsc 클린, Jest MCP 25/25, 런타임 MCP 29/29, POC e2e 8/8로 확인).
