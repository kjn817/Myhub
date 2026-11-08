# Workers OAuth Provider v1 + step-up POC

설계: `../../docs/oauth-provider-v1-design-20261028.md`

## 구성

```
poc/oauth-provider-v1/
├── common.ts                  # 식별자(운영 형태) + 스코프 헬퍼
├── auth-server/               # 인증 서버 Worker (OAuthAuthorizationServer)
│   ├── index.ts               # /authorize — POC 자동 승인 (아래 경고 참조)
│   └── wrangler.jsonc         # name myhub-oauth-poc-auth, KV OAUTH_KV
├── resource-server/           # 리소스 서버 Worker (OAuthResourceServer + MCP)
│   ├── index.ts               # 스코프 게이트 + 실제 MCP 도구 + mcp_ 폴백
│   ├── memo-create-tool.ts    # POC 쓰기 도구 memo.create (최소 스텁)
│   └── wrangler.jsonc         # name myhub-oauth-poc-mcp, D1 + AUTH_SERVER 바인딩
├── e2e.test.ts                # 하네스 e2e (401 → 읽기 → 403 → step-up → 쓰기)
└── vitest.config.ts
```

## 실행

```sh
cd poc/oauth-provider-v1
../../node_modules/.bin/vitest run --config vitest.config.ts
```

`wrangler createTestHarness`가 두 Worker를 로컬 workerd로 띄우고,
리소스 서버는 Service Binding으로 인증 서버를 부른다.
D1은 하네스 로컬 SQLite이며, `mcp.applyD1Migrations('DB')`로
저장소 `migrations/` 전수를 적용한 뒤 테스트용 메모 1건을 심는다.
운영·스테이징 Worker·D1·OTP에는 닿지 않는다. 비용 $0.

## 검증하는 것

- 401 discovery → resource metadata → AS metadata (스코프 카탈로그)
- `mcp:read` 토큰 → `memo.search` 200 (실제 읽기 도구)
- `mcp:read` 토큰 → `memo.create` 403 `insufficient_scope` + 메모 미생성
- step-up 토큰(`mcp:read mcp:write`) → `memo.create` 200 + D1 행 생성
- `mcp:write` 단독 토큰 → 403 (baseline 필요)
- 기존 `mcp_` 토큰 → 읽기 유지, 쓰기 403
- 미등록 리소스 authorize → 코드 미발급
- 무토큰 호출 → 401

## ⚠️ 안전 경고

- `auth-server/index.ts`의 `/authorize`는 **고정 테스트 사용자로 자동 승인**한다
  (로그인·동의 없음). 이 코드는 로컬 하네스 전용이며,
  도달 가능한 Worker에 그대로 배포하면 누구나 토큰을 발급받을 수 있다.
  운영 wiring은 PIN 로그인 + 동의 페이지로 교체해야 한다 (설계 문서 §3).
- POC 메모는 잠기지 않은 테스트용 메모만 쓴다. 잠긴 메모·민감정보를 다루지 않는다.
- `wrangler.jsonc`의 KV/D1 ID는 로컬 하네스용 임의 UUID이다. 실제 ID가 아니다.

## 일회용 스크래치 Worker로 라이브 확인하려면 (선택, 미수행)

하네스 검증이 로컬 workerd라, 실망 검증을 원하면 스크래치 Worker 2개를 만들어
검증 후 삭제한다. 이때는 `common.ts`의 식별자를 스크래치 Worker의 실제 URL로
바꿔야 한다 (issuer·resource는 배포된 URL과 일치해야 한다).
이 POC는 로컬 검증까지만 수행했고, 스크래치 라이브 검증은 미수행이다.
