# AI 스튜디오 생성 앱의 DB 공간 설계안 (2025-10-15)

## 1. 요구사항 (사용자, 2026-10-15 09:09 KST)

> "db를 써야하는 앱들도있자나 이때 별도 db에 공간도 만들어서 실제 사용가능하도록 해야한다는거야"

AI 스튜디오가 생성하는 앱 중 DB가 필요한 앱(예: 투두리스트 — 새로고침 후에도 데이터 유지)에게는
**실제로 사용 가능한 별도의 DB 공간**을 제공해야 한다. localStorage 안내는 요구사항을 충족하지 못한다.

## 2. 현재 이견 (미해결)

같은 세션에서 Muse는 "생성된 앱이 localStorage를 쓰도록 가이드하면 돼. 별도 D1 테이블을 앱마다 만드는 건 보안상 위험해"라고
반박했다. 사용자는 이 반박에 동의하지 않았으므로, 아래 설계안으로 결정을 요청한다.

## 3. 조사로 확인된 제약

### 3.1 생성 앱의 실행 환경
- 미리보기 iframe: `sandbox="allow-scripts"` (`public/agent.html:276`) — opaque origin.
- 생성된 앱의 JS는 서버 자격증명(세션 쿠키 포함)을 직접 보유·사용할 수 없다.
- 따라서 앱별 DB 접근은 반드시 **MyHub 서버 API를 경유**해야 하며, 앱 코드에는 주입된 SDK(`window.MyHubDB`)만 노출한다.

### 3.2 물리적으로 별도 D1을 앱마다 만들 수 없는 이유
- Worker의 D1 바인딩은 `wrangler.toml`에 배포 시 정적으로 선언된다. 런타임에 앱마다 동적으로 바인딩 추가 불가.
- D1 REST API로 DB를 생성해도 Worker가 런타임에 접근할 방법이 없다 (API 토큰은 Worker 시크릿에 없음).
- 결론: "앱마다 물리적으로 독립된 D1"은 Workers 아키텍처상 불가. **논리적 분리(네임스페이스)** 가 현실적인 최대치다.

### 3.3 멀티테넌시 표준 패턴
SaaS 업계의 정석은 3단계다: (1) 테넌트별 DB — 최강 격리·최대 운영비, (2) 테넌트별 스키마 — D1/SQLite는 스키마 개념이 없어 부적합,
(3) 공유 테이블 + 테넌트 식별 컬럼 — 최저 비용, 격리는 쿼리 레벨에서 강제.
1인용 시스템(MyHub는 사용자 본인만 사용)에서는 (3)이 표준 선택이다.

## 4. 옵션 비교

### 옵션 A. `studio_app_kv` 네임스페이스 테이블 (권장)
- 스키마(고정, 마이그레이션 1회):
  ```sql
  CREATE TABLE studio_app_kv (
    app_id TEXT NOT NULL,          -- artifacts.id
    k TEXT NOT NULL,
    v TEXT NOT NULL,               -- JSON 문자열
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (app_id, k)
  );
  ```
- API (기존 `src/modules/artifact/routes.ts` 패턴 그대로, Hono + `c.env.DB.prepare().bind()`):
  - `GET /api/studio-apps/:appId/kv` — 키 목록/전체 조회
  - `PUT /api/studio-apps/:appId/kv/:key` — 값 저장 (JSON body)
  - `DELETE /api/studio-apps/:appId/kv/:key` — 삭제
- 보안 규칙:
  - `appId`는 URL 경로에서만 취득하고, 해당 artifact가 요청자(단일 사용자)의 것인지 먼저 확인. body의 appId는 무시.
  - 테이블명은 코드에 고정 — 클라이언트 입력이 SQL에 들어갈 자리 자체가 없음 (파라미터 바인딩만 사용).
  - 앱 코드는 주입 SDK를 통해서만 호출. SDK는 미리보기/게시 서빙 시점에 MyHub가 HTML에 삽입.
- 장점: DDL 없음, 테이블 수 고정, 보안 표면 최소, D1 무료 한도(5M reads/100k writes/일, 5GB) 안에서 충분.
- 정직한 한계: 물리적으로는 하나의 D1을 공유한다. 앱별 논리 네임스페이스가 "별도 공간"의 실체다.

### 옵션 B. 앱별 prefix 테이블 동적 생성
- `app_<artifactId>_<table>` 형태로 런타임 `CREATE TABLE`. 테이블명은 서버에서 생성하고
  `/^app_[0-9a-f-]{36}_[a-z][a-z0-9_]{0,30}$/` allowlist로 검증.
- 장점: 사용자가 상상한 "별도 테이블"에 가장 가까움.
- 단점: 런타임 DDL, 테이블 수 무한 증가, 스키마 버전 관리 불가, 백업·삭제 시 누락 위험.
  보안상 가능은 하지만 운영 부채가 A보다 크다.

### 옵션 C. localStorage 가이드 유지
- 사용자가 이미 거부한 안. 크로스 기기 불가, 서버에서 조회 불가, "실제 DB" 요구 미충족. 탈락.

## 5. "보안상 위험" 지적에 대한 답변

원래 반박의 근거는 '앱마다 테이블을 만들면' 이었다. 옵션 A는 테이블을 앱마다 만들지 않는다.
고정 스키마 + 파라미터 바인딩 + 서버 바인딩 appId이므로, SQL 인젝션 표면과 무한 DDL 위험이 원천 제거된다.
단일 사용자 시스템에서 앱 간 격리 위반의 blast radius도 본인 데이터에 한정된다.

## 6. 구현 스케치 (옵션 A 기준)

1. 마이그레이션 `0036_studio_app_kv.sql` — 위 스키마 1회 적용 (운영 D1은 Time Travel bookmark 후 적용).
2. `src/modules/artifact/routes.ts`에 `/studio-apps/:appId/kv/*` 3개 라우트 추가 (인증 미들웨어는 기존 artifact 라우트와 동일).
3. 미리보기/게시 서빙(`generate-html.ts` 또는 서빙 레이어)에서 앱 HTML에 SDK 주입:
   ```html
   <script>window.MyHubDB={appId:"<id>",
     get:(k)=>fetch(`/api/studio-apps/${appId}/kv/${k}`).then(r=>r.json()),
     set:(k,v)=>fetch(`/api/studio-apps/${appId}/kv/${k}`,{method:"PUT",body:JSON.stringify({v})}),
     del:(k)=>fetch(`/api/studio-apps/${appId}/kv/${k}`,{method:"DELETE"})}</script>
   ```
   sandbox iframe의 opaque origin에서 같은 오리진 fetch가 동작하는지는 CORS 설정에 달려 있으므로,
   구현 시 (a) 서버 CORS 허용 또는 (b) 부모 페이지 postMessage 브릿지 중 택일하고 브라우저 E2E로 검증 필요.
4. 시스템 프롬프트에 "DB 필요 시 localStorage 대신 `window.MyHubDB` 사용" 규칙 추가.
5. (선택) 스튜디오 UI에 앱별 데이터 조회 뷰 — "별도 공간"의 가시적 증거.

## 7. 결정 요청

1. **옵션 A(네임스페이스 KV, 권장) vs 옵션 B(앱별 prefix 테이블)** — 어느 것으로 구현할까?
2. **기대치 확인**: 물리적 D1 분리는 아키텍처상 불가하므로, "별도 공간 = 앱별 논리 네임스페이스 + 서버 실저장"으로 이해해도 될까?

A안이 확정되면 마이그레이션 → 라우트 → SDK 주입 → 프롬프트 규칙 → 브라우저 E2E 순서로 구현한다.
