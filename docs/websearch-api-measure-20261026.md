# Cloudflare Web Search API 날짜 정확도 실측 (트랙 B1)

> 측정일: 2026-10-26 (KST). 실험만 수행, 프로덕션 코드 변경 없음, 커밋 없음.
> 결론부터: **날짜 정확도를 측정하지 못했다 — 단 1건의 검색 결과도 반환되지 않았다.**
> 원인은 정확도가 아니라 과금 전제다. AI Gateway 크레딧 잔액이 0이라 전 프로바이더가 402로 거부한다.
> 카드 등록·유료 동의가 필요하므로, 과제 지시대로 해당 절차에서 중단한다.

## 1. 공식 호출 방법 (문서 확인)

출처: `https://developers.cloudflare.com/web-search/how-to-use/` (문서 업데이트 2026-10-12),
출시 공지 2026-10-02/04. 두 가지 호출 경로가 있다.

### 1-1. REST API

```
POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/websearch/
Authorization: Bearer <Cloudflare API 토큰>
Body: { "query": "...", "provider": "ceramic"|"exa"|"linkup", "limit": 5,
        "options": { "gateway": { "id": "default" } } }
```

- 토큰 권한 (둘 다 필요): **Account > Workers AI > Read** + **Account > AI Gateway > Read**
- 전제: 계정에 AI Gateway(`default`는 전 계정 기본 존재) + **AI Gateway 크레딧 충전 또는 게이트웨이에 저장된 제공자 키(BYOK)**

### 1-2. Workers Binding

```ts
// wrangler: [ai] binding = "AI", compatibility_date 최신
const res = await env.AI.websearch({ gatewayId: "default", query, provider: "exa", limit: 5 });
const results = await res.json(); // Response 객체 반환
```

- 토큰 불필요 (Worker 실행 권한으로 동작). 과금은 REST와 동일하게 AI Gateway 크레딧.

### 1-3. 응답 형식 — 날짜 필드가 없다 (구조적 발견)

공식 문서의 응답 예시는 이것뿐이다:

```json
{ "items": [{ "url": "...", "title": "...", "description": "..." }],
  "metadata": { "query": "...", "requestId": "...", "latencyMs": 612 } }
```

> "Optional fields are only included when the provider returns them."

즉 **날짜 필드(`publishedDate` 등)는 문서상 보장되는 필드가 아니다.**
크레딧이 있어 재측정하더라도, 날짜 정확도는 API 응답만으로 잴 수 없을 가능성이 크고
기사 페이지 직접 fetch(`article:published_time`·JSON-LD `datePublished`)로 검증해야 한다
(1-2절 "기사 날짜 직접 검증" 패턴과 동일). Exa가 파트너 중 하나라 Exa 가짜 날짜가
그대로 전파될 가능성도 여전히 열려 있다.

### 1-4. 한도

| 항목 | 값 |
|---|---|
| 질의 길이 | 1,024자 |
| 요청당 결과 수 | 최대 10건 |

## 2. 실측 결과

### 2-1. REST 경로 — 403 (토큰 권한 부족)

| 시도 | 결과 |
|---|---|
| `POST /accounts/{AID}/ai/websearch/` (ceramic, limit 5) | **403, code 10000 "Authentication error"** |
| 대조군: `GET /user/tokens/verify` | 200, 토큰 `active` (인증 첨부 자체는 정상) |
| 대조군: `GET /accounts/{AID}/workers/scripts/myhub/versions` | 200 (기존 Workers 권한은 정상) |
| 대조군: `GET /accounts/{AID}/ai-gateway/gateways` | **403, code 10000** (동일) |

판정: 저장된 Cloudflare API 토큰(surrogate 경유)에 **Workers AI Read / AI Gateway Read 권한이 없다.**
REST 실측은 토큰 권한을 고쳐야 가능하다. 토큰 권한 변경은 대시보드 토큰 편집 또는
재연결이 필요해 본 실험에서 하지 않았다.

### 2-2. Workers Binding 경로 — 402 (크레딧 잔액 0)

일회용 프로브 워커 `websearch-probe`를 만들어 `env.AI.websearch()`로 호출했다
(AI 바인딩만 부여, 시크릿 없음; 측정 후 삭제 완료).
서브도메인 활성화(`POST .../subdomain {"enabled": true}`)가 별도로 필요했다
(미활성화 시 workers.dev 404 / error 1042).

| 호출 | 결과 |
|---|---|
| `provider=ceramic` | **402 `web_search_payment_required`** |
| `provider=exa` | **402 `web_search_payment_required`** (동일) |
| `provider=linkup` | **402 `web_search_payment_required`** (동일) |
| provider 미지정 (기본값 ceramic) | **402 `web_search_payment_required`** (동일) |

원문 (4회 모두 동일 메시지, `gatewayRequestId`만 다름):

> "Your AI Gateway credit balance is zero, so this search could not be billed.
> Load credits on your account, or add your own search provider key to this gateway
> (Provider Keys) and pass its alias as `byokAlias` to bill the provider directly instead."

판정: **계정의 AI Gateway 크레딧 잔액이 0이다.** 과금 실패라 검색이 실행되지 않았고,
결과 0건이므로 날짜 정확도 측정 자체가 불가능했다. 실패 호출은 과금되지 않았다
(402라 청구 대상이 아님).

### 2-3. 날짜 정확도 측정표 — 측정 불가

준비한 뉴스 질의 10건은 아래와 같으나, **어느 질의도 실행되지 않아 표는 비어 있다.**
재측정 시 이 질의 목록을 그대로 쓴다 (기준일 2026-10-26, 창: 당일·전일).

| # | 질의 (재측정용) | 실행 | 반환 | 날짜 판정 |
|---|---|---|---|---|
| 1 | 2026년 10월 26일 오늘 한국 주요 뉴스 | 미실행 (402) | — | — |
| 2 | 2026년 10월 26일 한국 경제 뉴스 | 미실행 (402) | — | — |
| 3 | 2026년 10월 26일 한국 정치 뉴스 | 미실행 (402) | — | — |
| 4 | 2026년 10월 26일 한국 사회 뉴스 | 미실행 (402) | — | — |
| 5 | 2026년 10월 25일 한국 주요 뉴스 | 미실행 (402) | — | — |
| 6 | 2026년 10월 26일 코스피 증시 뉴스 | 미실행 (402) | — | — |
| 7 | 2026년 10월 26일 국제 뉴스 | 미실행 (402) | — | — |
| 8 | 2026년 10월 26일 IT 기술 뉴스 | 미실행 (402) | — | — |
| 9 | 2026년 10월 26일 스포츠 뉴스 | 미실행 (402) | — | — |
| 10 | 2026년 10월 26일 연예 뉴스 | 미실행 (402) | — | — |

**날짜 정확도: 측정 불가 (NOT TESTED). "정확도가 낮다"는 결론이 아니다.
정확도가 높다/낮다를 말할 근거가 아직 없다.**

## 3. 과금 조건

- **무료 티어: 문서상 없다.** Web Search API는 AI Gateway 크레딧으로만 과금되며,
  크레딧이 0이면 402로 거부된다 (이번 실측으로 확인).
- 단가 (제공자 정가 그대로, Cloudflare 마크업 없음):
  | 제공자 | 단가 (/1,000회) | 10회 비용 |
  |---|---|---|
  | Ceramic.ai (기본값) | $0.25 | $0.0025 |
  | Linkup | $5.00 | $0.05 |
  | Exa | $7.00 | $0.07 |
- 재측정 30회(10 질의 × 3 제공자) 예상 비용: **약 $0.12** + 크레딧 구매 수수료 5%.
  운영 환산 (예: 하루 뉴스 10회 × ceramic): 월 약 $0.08 수준으로 저렴하나,
  **전제는 크레딧 충전이다.**
- 크레딧 충전 절차 (공식 문서 `ai-gateway/features/unified-billing/`):
  대시보드 AI Gateway 페이지 → Credits Available → Manage → Top-up credits.
  **결제 수단이 없으면 이 단계에서 결제 수단(카드) 추가를 요구한다.**
  사용자 원칙(카드·초과 과금 동의가 필요한 무료 서비스 기피)에 따라 본 실험은
  여기서 중단했고, 충전·카드 등록을 하지 않았다.
- 자동 충전(auto top-up)도 같은 결제 수단을 전제로 한다. 설정하지 않았다.

### BYOK 대안 (카드 없이 쓸 수 있는 유일한 경로 — 단, 키 필요)

- 게이트웨이 Provider Keys에 제공자 키를 저장하고 요청에 `byokAlias`를 넘기면
  제공자가 직접 과금하고 Cloudflare 크레딧은 쓰지 않는다.
- MyHub는 Exa 키를 Worker secret으로 갖고 있으나 **secret 값은 조회 불가**라
  본 실험에서 게이트웨이에 등록할 수 없었다. 사용자가 대시보드에서 직접 등록해야 한다.
- 주의: BYOK Exa는 Exa 직접 호출과 사실상 같은 경로라, Exa 가짜 날짜 문제가
  그대로 전파될 가능성이 크다. Ceramic 무료 플랜(자체 1,000회 무료라는 2차 보도 있음)이
  BYOK에 적용되는지는 공식 문서에 확인되지 않았다 — 미확인 사항으로 남긴다.

## 4. 체인 1차 승격 여부 결론

**NO-GO — 승격 불가 (판단 보류, 부정적 판단 아님).**

- 날짜 정확도를 잴 수 없어 Exa 대체·1차 승격을 판단할 근거가 없다.
- 구조적으로도 응답에 날짜 필드가 보장되지 않아, 승격하더라도 날짜 검증은
  기사 직접 fetch 패턴이 별도로 필요하다.
- 재측정 전제 조건 (사용자 결정 필요):
  1. **크레딧 충전** (카드 등록 필요) — 또는 BYOK 제공자 키를 게이트웨이에 직접 등록.
  2. REST 경로 실측을 원하면 API 토큰에 **Workers AI Read + AI Gateway Read** 권한 추가.
  3. 위 1·2 중 하나가 충족되면 `.scratch/websearch_probe.py` 골격으로
     10 질의 × 3 제공자 재측정 → 기사 페이지 날짜 대조 → 승격 여부 재판단.

## 5. 실험 산출물 · 정리 상태

- `.scratch/websearch_smoke.py` — REST 스모크 (403 기록)
- `.scratch/websearch_deploy_smoke.py` — 일회용 워커 배포 + binding 스모크 (402 기록)
- `.scratch/websearch_worker.js` — 일회용 프로브 워커 소스 (AI 바인딩만, 시크릿 없음)
- `.scratch/websearch_smoke.json` — REST 403 원본 응답
- `.scratch/websearch_smoke_binding.json` — binding 402 원본 응답
- 일회용 워커 `websearch-probe`: **삭제 완료** (DELETE 200). 운영 Worker(`myhub`)
  배포·설정·시크릿은 건드리지 않았고, 운영 D1 쓰기·OTP 호출·프로덕션 코드 변경·커밋 없음.
- API 토큰 값은 어느 파일·로그에도 남기지 않았다.
