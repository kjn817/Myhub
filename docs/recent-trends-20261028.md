# 최근 트렌드 조사 — MyHub에 적용하면 좋을 것 (2026-10-28)

> 조사만 수행한 문서. 코드 변경 없음, 커밋하지 말 것.
> 조사일: 2026-10-28 (KST). 5개 트랙 병렬 조사 후 코디네이터가 검증·종합.
> 수단: GitHub REST API(미인증) + 공식 문서·체인지로그 직접 열람 + browser.search.
> 모든 ★ 수·라이선스·최근 push일·가격은 2026-10-28 실측. 확인 못한 것은 "미확인"으로 표기.
> 코디네이터 교차 검증: MCP 2026-07-28 스펙(복수 출처 확인), Workers 64MiB 한도(공식 체인지로그·Limits 문서 확인),
> 네이버 API HUB 이관 방향(확인) + NCP 결제수단 등록 필요 보고(신규 단서, 아래 참조).

## 기준 상태 (2026-10-28 종합 시점)

- HEAD **a014850** — 2026-10-28 감사 수정 목록 전체 적용 완료, **배포 안 함** (운영 라이브는 여전히 89efaa42).
  번들 4,234,069 → 1,789,630 bytes(−57.7%, ASSETS 이관 완료), 메모 검색은 FTS5 trigram(마이그레이션 0059, 운영 D1 미적용),
  Stryker 72.25% → 76.65%, Jest 244/5105·runtime 35/35·tsc 클린.
- 이 문서의 우선순위는 이 상태를 반영한다: 번들 긴급도는 이미 낮아졌고(한도 상향 + ASSETS 이관 완료),
  메모 검색은 "LIKE 폴백 제거"가 아니라 "trigram 위의 시맨틱 계층"이 다음 단계다.
- 0028 latent 결함은 이미 수정돼 있었음 (2026-10-25 커밋 11655d0의 마이그레이션 0044가 0030 패턴으로 수정 + 운영 적용 완료).
  감사 전제가 stale이라 별도 작업 불필요.

## 이전 조사와 중복 제외 목록

- 2026-10-26 (`docs/github-apply-research-20261026.md`, 14개 트랙 적용 완료): promptfoo, Cloudflare Web Search API,
  AI Gateway, agents POC, OTEL, Graphiti, miniflare, workbox, E2B 등.
- 2026-10-27 (`docs/github-test-ai-research-20261027.md`, 1순위 5개 적용 완료): StrykerJS, fast-check, garak, Semgrep, MSW.
- 2026-10-28 감사 (`docs/perf-audit-20261028.md`, `docs/test-quality-audit-20261028.md`) + 그 수정 적용(HEAD a014850).
- 이번 조사는 위와 겹치지 않는 것만 다룬다. 트랙별 원본: `/tmp/trends/track1-cloudflare.md`,
  `/tmp/trends/track2-agents.md`, `/tmp/trends/track3-frontend.md`, `/tmp/trends/track4-security.md`,
  `/tmp/trends/track5-korea.md` (휘발성 — 이 문서가 정본).

## 라이선스·적용 규칙 (전 후보 공통)

- AGPL 코드 복사 금지, 라이선스 미표기 코드 참고 금지, 프리뷰 상태는 패턴 참고로만,
  통째 설치(셀프호스팅 부담) 금지, 카드 등록 필요한 유료 서비스 금지, 2년 이상 방치된 도구 금지.
- 비용은 무료 티어·카드 불필요 기준. 한국 사용자 관점(한국어·한국 뉴스·한국 서비스·iOS PWA) 반영.

---

## ⚠️ 긴급 정정 2건 — 이전 조사·메모리 전제와 달라진 것

### 정정 1. 네이버 무료 API, 네이버클라우드(NCP)로 이관 중 — 뉴스 키 발급 경로가 바뀐다

- 네이버 개발자센터(developers.naver.com)의 무료 API 3종(검색·검색어 트렌드·쇼핑인사이트)이 **NAVER API HUB(NCP)로 이관**된다.
  2026-06-29 공지 기준: **2026-07-31부터 3종 API 신규 신청 불가**, **2027-06-30 지원 종료·기존 발급 키도 차단**.
  이후 이용자는 NCP 계정으로 가입해 새 인증키를 발급받아야 한다.
- 무료 한도 (이관 후 공식 요금표 기준): 검색 API **월 775,000건까지 무료, 하루 최대 25,000건** /
  검색어 트렌드·쇼핑인사이트 각 **월 30,000건 기본 무료 제공**.
  단, 2차 출처에서는 트렌드·쇼핑인사이트 "월 최대 50,000건, 한시적 무료"라는 다른 수치도 있어 **가입 시 콘솔에서 직접 확인 필요**.
- 2027년 유료 요금제 도입 검토 중 (네이버클라우드 관계자 발언). "유료화 이후에도 기존 무료 제공량은 동일하게 유지할 예정"이라고 하나 정책 리스크가 생겼다.
- 이관 마찰 실측: "이관 공지 이후 기존 검색 API 키가 갑자기 작동하지 않아 새 인증키를 발급받은 사례도 확인됐다.
  1년의 유예 기간을 고지했지만 실제 체감하는 전환 시점은 이보다 빠른 것으로 보인다" (조선비즈, 2026-07-23).
- **코디네이터 교차 검증 추가 단서**: NCP 가입 가이드에서 **결제수단(카드) 등록이 필요할 수 있다**는 보고가 있다
  ("결제 수단을 등록해야 정상적인 API 호출이 가능합니다"). 트랙 5는 "미확인"으로 뒀으나,
  사용자 원칙(카드 불필요)과 충돌할 수 있으니 **가입 시 카드 필요 여부를 먼저 확인할 것**.
  카드가 필수면 네이버 뉴스 1차 경로는 원칙상 재검토 대상이 된다.
- **영향**: 메모리에 "네이버 뉴스 키는 사용자 단계로 남아 있음"으로 돼 있는데, 발급처가 developers.naver.com이 아니라
  **NCP NAVER API HUB**로 바뀌었다. 사용자가 옛날 방식으로 키를 발급받으면 2027-06-30에 차단된다.
  **사용자 단계 항목을 "NCP API HUB에서 발급"으로 업데이트해야 한다.**
- 이전 조사 수치 검증: `docs/exa-news-research-20261026.md`의 "네이버 뉴스 API 일 25,000회 무료"는
  이관 후 공식 요금표(일 최대 25,000건)와 일치함을 확인했다.
- 출처: https://it.chosun.com/news/articleView.html?idxno=2023092166395 ·
  https://www.digitalmarketer.co.kr/insights/naver-datalab-api-data-for-non-developers ·
  https://v.daum.net/v/20260723173625636

### 정정 2. Papago NMT API 무료 종료 — 무료 후보에서 제외

- 네이버 개발자센터의 Papago NMT 번역 API 무료 서비스는 **2024-02-29에 종료**되고 NCP 유료로 이관됐다 (NamuWiki).
  과거 "일 10,000자 무료" 블로그 글은 구 정보다. **Papago API는 이제 유료(NCP 종량제)라 무료·무카드 원칙에 부적합.**
- 출처: https://en.namu.wiki/w/%EB%84%A4%EC%9D%B4%EB%B2%84%20%ED%8C%8C%ED%8C%8C%EA%B3%A0

---

## 우선순위 요약표 (전 트랙 통합)

### 1순위 — 지금 검토할 것

| # | 후보 | 한 줄 | 트랙 | 적용 형태 |
|---|---|---|---|---|
| 1 | MCP TS SDK + 2026-07-28 스펙 | MyHub 도구를 표준 MCP 서버로 노출 | 2 | Worker에 Streamable HTTP MCP 서버 (읽기부터) |
| 2 | 한국어 시맨틱 검색 — bge-m3 vs KURE API A/B | trigram 위의 의미 검색 계층 | 1+5 | Vectorize + 임베딩, FTS5와 하이브리드, A/B 후 1개만 운영 |
| 3 | 언론사 직접 RSS 실험 (YNA·한경·매경) | Google News RSS 503 우회 실험 1순위 | 5 | 스테이징 Worker fetch 실측부터 |
| 4 | 네이버 API HUB 이관 대응 | 뉴스 키 발급 경로 변경 (사용자 단계) | 5 | NCP API HUB에서 발급, 카드 필요 여부 먼저 확인 |
| 5 | 패스키 @passwordless-id/webauthn | PIN 6자리의 피싱·유출 약점 근본 해결 | 4 | PIN 옆 선택 인증 수단으로 추가 (RP ID 결정 선행) |
| 6 | Cloudflare Turnstile | PIN 온라인 대입 방어, 무료·무제한·카드 불필요 | 4 | 로그인 폼에 위젯 추가 (폴백 설계 필수) |
| 7 | sharp 빌드타임 리사이즈 | 아바타 1600px→96px, 1.16MB→약 40KB | 3 | devDependency 빌드 스크립트 |
| 8 | zod → zod/mini 교체 | 번들 zod 854KB→수 KB, 사용처 3파일뿐 | 3 | 3개 파일 스키마 재작성 (새 의존성 없음) |
| 9 | Cloudflare Workflows POC | Plan & Execute·자연어 cron의 내구성 실행 엔진 | 1 | 아침 브리핑 1건을 Workflow로 구현해 스테이징 측정 |
| 10 | BFCL식 FC 채점 promptfoo 이식 | 비서 4명의 도구 선택 정확도를 숫자로 | 2 | 방해 도구 섞어 AST 채점, promptfoo 시나리오에 추가 |

### 2순위 — POC·패턴 차용 후 판단

| 후보 | 한 줄 | 트랙 |
|---|---|---|
| Hindsight 4중 검색 + RRF + rerank 패턴 | 메모리 v2 검색의 대조군 (서버 설치 금지, 패턴만) | 2 |
| CaMeL 출처 라벨링 패턴 | 인젝션 방어를 탐지가 아니라 구조로 (garak 결과 나온 뒤 설계) | 4 |
| gitleaks CI + SOPS/age 백업 암호화 | 시크릿 사고 재발 방지 두 겹 잠금 | 4 |
| Workers AI 프론티어 모델 + 네이티브 도구 호출 POC | Kimi K2.6/K2.7-Code·GLM-5.2, 마커 FC 대체 후보 (K2.5 폐기 주의) | 1 |
| Workers 온디맨드 프로파일링 | cold start·atob 비용 실측 (감사 미확인 항목 닫기) | 1 |
| 카카오 Daum 검색 API (sort=recency) | 뉴스 백업 소스, 일 30,000건 무료 | 5 |
| es-hangul (Toss) | 초성·자모 검색 + 조사 자동 선택, 순수 JS | 5 |
| 카카오톡 나에게 보내기 | 아침 브리핑 전달 채널 (알림은 안 옴) | 5 |
| 네이버 DataLab 검색어 트렌드 API | "지금 뜨는 검색어" 감지, 브리핑 트렌드 섹션 | 5 |
| idb 오프라인 outbox | 오프라인 메모·할일 쓰기 큐 (iOS는 Background Sync 미지원이라 online/visibilitychange 드레인) | 3 |
| Cross-document View Transitions | MPA 전환 애니메이션, 공용 CSS 3줄 | 3 |
| web-vitals RUM | LCP/INP/CLS 실측 — 최적화 전후 효과 측정 | 3 |
| Queues 무료 플랜 편입 | 아티팩트 잡·cron 팬아웃 디스패치 (10,000 ops/일) | 1 |
| R2 (Cloudinary 대체) | 첨부파일 저장소, egress 0원, 무료 10GB | 1 |
| Cloudflare OS Gatekeepers 패턴 | 지연 승인·관찰 장부 설계 참고 (통째 설치 금지) | 1 |
| FastMCP 설계 패턴 | MCP 서버 체크리스트 (도구 스키마·OAuth·mount) | 2 |
| Google ADK-TS / VoltAgent / A2A / Cognee / HippoRAG / smolagents 패턴 | Plan & Execute·메모리·핸드오프 설계 대조군 (프레임워크 갈아타기 금지) | 2 |
| OpenAI Realtime API (gpt-realtime-2.1) POC | 실시간 음성 기준선 (카드 조건 확인 후, 1.x는 2027-01-20 종료) | 2 |
| Giskard / Presidio / osv-scanner | PII 유출·환각 스캔, 마스킹 규칙 대조, 의존성 취약점 스캔 | 4 |
| LlamaFirewall·PromptGuard 2 / FIDES / AgentDojo / Spotlighting 패턴 | 에이전트 가드레일 3지점 검사·라벨 설계·평가 기준 (코드 복사 금지) | 4 |
| Cloudflare Image Transformations POC | 동적 이미지 on-demand 리사이즈·AVIF (무료 5,000회/월) | 3 |
| esbuild 코드 스플리팅 (public JS만) | CodeMirror·memo-bundle 지연 로딩 | 3 |
| axe-core CI 접근성 게이트 | Playwright E2E에 a11y 검사 | 3 |
| TanStack Query core POC | API 응답 캐싱·재시도·dedupe (1곳부터) | 3 |
| PWA manifest 고도화 | shortcuts·id·maskable 아이콘 | 3 |
| data.go.kr 특일정보 공휴일 API | 캘리 공휴일 인식 (연 1회 동기화) | 5 |
| Vito STT A/B | 한국어 STT 대안 (무료 10시간으로 평가용만) | 5 |
| KURE-Sparse / KURE-Reranker | 하이브리드 검색·재정렬 2단계 | 5 |
| Kiwi / khaiii / KSS 패턴 | 형태소 분석 아이디어만 (Workers 실행 불가) | 5 |
| Workers Builds GA (검토만) | preview 용도만, 자동 배포 금지 | 1 |
| Cron Triggers Local Explorer | cron 핸들러 로컬 단발 테스트 DX | 1 |

### 3순위 — 지켜보기 / 패턴만

Weave (Opik 이후 검토), Vapi/Retell (무료 크레딧 POC까지만), elizaOS (플러그인 설계만),
Memobase (9개월 stale), inngest/agent-kit (6개월 stale), Dia (11개월 stale + GPU),
Kokoro (한국어 미지원 + 1년 stale — 부적합에 가까움), Zep (Graphiti와 중복),
OPAQUE (PIN 6자리에는 효과 제한 — 패스키가 먼저), Infisical/Doppler (Cloudflare Secrets 유지가 나음),
detect-secrets (gitleaks와 중복·활동 둔화), TaskTracker/InjecAgent (연구 코드·방치),
libsodium/@noble/ciphers (WebCrypto AES-GCM 유지 — 교체 이유 없음),
Yjs/Automerge (단일 사용자라 협업 CRDT 과함), rolldown/Vite (번들러 교체 실익 낮음),
Speculation Rules (Chromium 전용·iOS 무용), D1 읽기 복제 (단일 사용자 효과 작음),
Durable Objects 2026 변경분 (agents POC 전제 조건으로만 기록),
Kanana/HyperCLOVA X (호스팅 무료 API 없음 — 지켜보기만), 카카오 로컬 API (필요해지면 검토),
Declarative Web Push + Badging API (패턴 정리만), vite-plugin-pwa (Vite 전제라 보류), Dexie (idb로 부족할 때만).

---

## 1순위 상세

### 1-1. MCP TypeScript SDK + MCP 2026-07-28 스펙 — MyHub 도구의 표준 노출 경로

- **무엇**: Model Context Protocol 공식 TS SDK (`modelcontextprotocol/typescript-sdk`). 도구·리소스·프롬프트를
  표준 프로토콜로 노출하는 서버/클라이언트 구현체. 2026-07-28 스펙 개정(일명 MCP 2.0)이 핵심 변화다:
  **stateless 코어**(`initialize` 핸드셰이크·`Mcp-Session-Id` 폐지, 요청마다 `_meta`에 버전·capability 선언),
  **MRTR(Multi Round-Trip Requests)**로 서버 주도 elicitation·sampling을 대체
  (`resultType: "input_required"` + continuation 토큰, 상태는 페이로드에),
  sampling·roots는 폐지 예고(2026-07-28로부터 12개월 유예, 2027-07경 중단 예상),
  OAuth 강화(issuer 검증 RFC 9207, Client ID Metadata Documents, Dynamic Client Registration 폐지),
  HTTP+SSE 1년 유예 후 중단 → Streamable HTTP로 이동, `Mcp-Method`·`Mcp-Name` 헤더로 게이트웨이 라우팅 가능,
  list 결과 `ttlMs` 캐시 힌트.
- **실측**: ★13,664 · 라이선스 **전이 중** (LICENSE 직접 확인: "MIT에서 Apache-2.0으로 전환 중.
  신규 코드·스펙 기여는 Apache-2.0, 문서 기여는 CC-BY-4.0, 재라이선스 미동의 기존 기여는 MIT 유지") ·
  push 2026-10-27 · 이슈 617. TS SDK는 2026-07-28 스펙 대응 v2.0.0 GA(2026-07-28) 이후 코어 패키지 v1.30.0 계열로 이어짐
  (2차 출처 기준 — 정확한 현 버전은 미확인). 참조 서버 모음 `modelcontextprotocol/servers`는 ★91,618이나
  API상 라이선스 NOASSERTION (서버별 라이선스 혼재) — 코드 복사 전 개별 확인 필수.
- **코디네이터 교차 검증**: 2026-07-28 스펙의 stateless 전환을 복수 출처(dev.to 2건, Google Developers Blog)에서 확인.
  `initialize`/`Mcp-Session-Id` 제거, MRTR, 헤더 라우팅, 12개월 유예 후 폐지 — 트랙 2 주장과 일치.
- **왜 MyHub에 맞는지**: MyHub의 FC 도구(메모·일정·할 일·파일·아티팩트·검색)는 지금 손수 짠 마커·JSON 파서로만 노출된다.
  MCP 서버로 노출하면 (a) Claude Code·Cursor·ChatGPT 등 외부 클라이언트가 MyHub 도구를 그대로 쓸 수 있고,
  (b) Plan & Execute의 도구 정의가 표준 스키마(Zod → JSON Schema)가 되며, (c) MRTR elicitation이
  MyHub의 **위험 기반 승인 게이트와 같은 모양**이다 — 서버가 도구 실행 중 "이 정보가 더 필요하다"고 중간 응답을 내고,
  클라이언트가 사용자 확인을 받아 재제출한다. stateless 코어는 Workers와 궁합이 좋다 (DO 세션 없이 요청 단위로 동작).
- **어디에·어떻게 적용**: `src/modules/mcp/routes.ts`를 신설해 Streamable HTTP MCP 서버를 Worker 안에 둔다.
  노출 도구는 읽기부터: `memo.search`(잠긴 메모 제외 — 기존 ai-access 경계 재사용),
  `schedule.list`, `todo.list`, `memory.search`(v2 인용 잠금 포함). 쓰기 도구(`memo.create` 등)는 승인 게이트 뒤에 두고,
  처음에는 MCP Inspector (`modelcontextprotocol/inspector`, ★11,172 · push 2026-10-25 · 라이선스 API상 NOASSERTION —
  LICENSE 직접 확인 전에는 도구로만 쓰고 코드 복사 금지)로 로컬 검증한다.
  인증은 기존 PIN 세션 + 별도 MCP 토큰(Worker Secret) 중 하나로, OAuth 2.1 풀 구현은 하지 않는다
  (개인용 단일 사용자라 과함 — 스펙의 OAuth 강화는 "공개 서버" 전제라 MyHub에는 해당 없음).
  sampling·roots는 신규 구현 금지 (폐지 예고).
- **비용·리스크**: 무료 (오픈소스, 추가 과금 없음). 리스크는 (a) 스펙 변동 속도,
  (b) MCP 서버를 공개하면 **도구 노출이 곧 공격 표면**이 된다는 점 — 인증·스코프·잠긴 메모 제외를 서버 단에서 다시 강제해야 한다
  (클라이언트 선의에 의존 금지).
- **출처**: https://github.com/modelcontextprotocol/typescript-sdk ·
  https://modelcontextprotocol.io (스펙) · https://github.com/modelcontextprotocol/servers

### 1-2. 한국어 시맨틱 검색 — bge-m3 vs KURE API A/B (Vectorize + reranker)

트랙 1의 Vectorize + bge-reranker와 트랙 5의 bge-m3·KURE를 하나의 결정으로 합친다.
P-2 trigram(마이그레이션 0059)이 키워드·부분 검색을 맡았으니, 다음 계층은 의미 검색이다.

- **무엇**: Vectorize는 Workers용 관리형 벡터 DB(메타데이터 필터 포함).
  `@cf/baai/bge-m3`(100+ 언어, 1024차원, dense+sparse+multi-vector 동시 지원)과
  `@cf/baai/bge-reranker-base`(쿼리-문서 쌍 유사도 점수 재랭커), 또는 외부 호스팅 한국어 임베딩 **KURE API** 중
  하나를 임베딩 엔진으로 쓰고, Vectorize에 인덱싱해 FTS5와 하이브리드로 검색한다.
- **실측**:
  - bge-m3·bge-reranker-base 추가일: **2025-03-17** (공식 체인지로그) — 2026년 신규는 아니나 이전 조사 2건에서
    한 번도 다루지 않아 이번에 포함. Vectorize 한도 상향 (2026-10, 공식 블로그): 인덱스당 2,000만 벡터(기존 500만),
    `topK` 최대 50개(기존 20). 가격 (공식 가격표 직접 열람, 2026-04-21 업데이트):
    **Workers Free — 월 3,000만 queried dims + 500만 stored dims 포함**, Paid — 5,000만 queried dims 포함 + $0.01/백만.
    (참고: 구버전 스니펫의 "Paid 전용" 문구와 현행 가격표가 모순 — 가격표를 정본으로 판단하나,
    실제 인덱스 생성 시 무료 계정 허용 여부는 사용 전 확인 필요 — 미확인.)
    한국어 검색 품질: MTEB(kor, v2) Retrieval nDCG@10 **0.7483** (TelePIX 비교표 기준).
  - **KURE API** (`kure.kullm.ai`, 고려대 NLP&AI Lab): KURE-v3(dense 1.1B, nDCG@10 **0.8027**, 2048차원 MRL 256–2048,
    최대 8,192 토큰), KURE-v2(late-interaction 154M, **0.8160**), KURE-Sparse(0.7984), KURE-Reranker(1.7B/149M).
    모델 가중치 Apache 2.0 (HF `nlpai-lab/KURE-v3` 모델 카드 직접 확인).
    GitHub `nlpai-lab/KURE`: ★252 · MIT · 업데이트 2026-10-27.
    무료 한도 (공식 문서 https://kure.kullm.ai/docs/limits 직접 확인): 분당 60 RPM·200,000 TPM·**일 4,000,000 토큰**
    (KST 자정 초기화, 한 요청에 텍스트 최대 8개 묶음, 계정 단위 한도). 원문 저장 동의 시 ×2~×10이나 **동의 금지**
    (기본 한도로 충분).
- **왜 MyHub에 맞는지**: 한국어 조사·어미 때문에 "회의"로 "회의록"을 못 찾는 식의 한계가 구조적이다.
  bge-m3는 **Worker 안에서** `env.AI.run()` 한 줄로 임베딩을 뽑고 Vectorize에 넣을 수 있어 외부 키·외부 전송·추가 과금이 없다.
  KURE는 한국어 품질이 bge-m3보다 명확히 높다 (v3 0.8027, v2 0.8160 vs bge-m3 0.7483).
  일 400만 토큰이면 메모 수천 건 임베딩·매일 재임베딩에도 충분하다 (메모 1건 ~500토큰 가정 시 8,000건/일).
  잠긴 메모는 **인덱싱 시점에 제외**하면 검색 경로에서 원천 차단된다 (기존 잠금 경계와 같은 원칙).
- **어디에·어떻게 적용**: D1 FTS5(trigram 포함)를 버리지 않는다. POC: 메모 저장 시(잠기지 않은 메모만)
  임베딩을 생성해 Vectorize에 upsert하고, 검색을 "FTS 1회 + Vectorize 1회 병렬 → reranker 상위 10개 재정렬"로 바꾼 뒤,
  기존 LIKE 폴백 케이스들로 회귀를 측정한다. bge-m3와 KURE를 **같은 한국어 평가셋(메모 50~100건 + 질의 20건)으로 A/B 측정 후
  승자 1개만 운영**한다 (둘 다 유지하지 않음). KURE 질의는 `input_type: "query"`, 문서는 `"document"`로 구분할 것
  (다르게 인코딩하도록 학습됨 — 안 나누면 품질 저하). 동기화는 메모 저장·삭제 훅에 두고,
  Vectorize와 D1이 어긋났을 때의 재색인 스크립트도 함께 만든다.
- **비용·리스크**: 단일 사용자 규모(메모 수천 건·일 수십 쿼리)는 무료 포함량 안에 충분히 들어간다.
  리스크: (1) D1↔Vectorize 이중 쓰기의 정합성 — 삭제·잠금 전환 시 Vectorize 쪽이 남으면 잠긴 메모가 검색에 노출될 수 있어,
  삭제·잠금 경로 테스트가 필수. (2) KURE는 메모 텍스트가 외부(고려대 랩 운영 서버)로 나간다 — **잠긴 메모 절대 전송 금지**,
  원문 저장 동의 금지. 대학 연구실 운영 소규모 서비스라 SLA 없음 — 장애 시 bge-m3(Worker 내)으로 즉시 폴백하는 구조로 만들 것.
  모델 수명 주기 정책이 있어 410 `model_retired` 발생 가능. (3) 쿼리당 비용 공식이 `(쿼리+저장 벡터 수)×차원`이라
  인덱스가 커질수록 쿼리 단가가 오른다 — 메모가 수만 건을 넘으면 재계산 필요.
- **출처**: https://developers.cloudflare.com/vectorize/platform/pricing/ ·
  https://developers.cloudflare.com/changelog/post/2025-03-17-new-workers-ai-models/ ·
  https://kure.kullm.ai · https://kure.kullm.ai/docs/limits · https://huggingface.co/nlpai-lab/KURE-v3 ·
  https://github.com/nlpai-lab/KURE

### 1-3. 언론사 직접 RSS (연합뉴스·한경·매경) — Google News RSS 503 우회 실험 1순위

- **무엇**: 한국 언론사가 직접 제공하는 RSS 피드. Google News RSS는 Worker egress에서 사실상 사용 불가 확정이나,
  언론사 직접 RSS는 별개 경로라 **실측이 필요하다**.
- **실측 (URL은 검색 결과에서 verbatim 확인)**:
  - 연합뉴스 전체: `https://www.yna.co.kr/rss/news.xml`
  - 연합뉴스 경제: `https://www.yna.co.kr/rss/economy.xml`
  - 연합뉴스 영문 전체: `https://en.yna.co.kr/RSS/news.xml`
  - 한국경제 증권: `https://www.hankyung.com/feed/finance` / 경제: `https://www.hankyung.com/feed/economy`
  - 매일경제: `https://www.mk.co.kr/rss/30100041/` (경제 — 2차 출처, 가입 시 재확인)
  - JTBC 구 주소(`https://fs.jtbc.joins.com/RSS/newsflash.xml`)는 2024년 글에서 이미 "변경됨"으로 취소선 처리 — **사용 금지, 재확인 필요**.
  - 연합뉴스 RSS 안내 페이지는 아랍어·프랑스어·영문판까지 운영 중 (서비스 유지 확인됨).
- **왜 MyHub에 맞는지**: RSS는 `pubDate`를 직접 갖고 있어 Exa `publishedDate` 위조 문제를 원천 우회한다.
  이미 구축된 RSS 파서 + 기사 날짜 하드 필터 + 본문 fetch 검증 패턴과 그대로 맞물린다.
  연합뉴스는 한국 뉴스의 사실상 원천(통신사)이라 커버리지가 넓고, 네이버 뉴스 API와 겹치지 않는 독립 경로다.
  뉴스 신선도는 사용자에게 비서의 존립 조건이다.
- **어디에·어떻게 적용**:
  1. **먼저 Worker에서 직접 fetch 실험**: 스테이징 Worker에서 YNA RSS 3개 + 한경 2개를 fetch해
     상태 코드·응답 시간·`pubDate` 파싱을 측정한다. Google News RSS처럼 503이 나오면 즉시 탈락.
  2. 통과하면 `news-sources.ts`에 RSS 소스 추가: YNA 전체·경제 + 한경 증권·경제 (분야별 4개).
     `pubDate`로 어제~오늘 하드 필터 → 제목·링크만 받아 본문 요약은 기사 URL 직접 fetch.
  3. 아침 브리핑 헤드라인 수집용으로 우선 사용하고, Exa·네이버와 교차 검증.
- **비용·리스크**: 완전 무료·키 불필요. 단, **저작권 표기 주의**: 연합뉴스 기사는
  "저작권자(c) 연합뉴스, 무단 전재-재배포, AI 학습 및 활용 금지"를 명시한다.
  개인 비서가 사용자에게 요약해 주는 것은 재배포가 아니나, **본문 통째 저장·외부 전송·재배포는 피하고
  제목+링크+요약 범위**로 쓸 것. 피드 구조 변경 시 파서 수정 필요 (모니터링 대상).
  Worker egress 실측 전에는 채택이 아니라 **실험** 단계.
- **출처**: https://ar.yna.co.kr/channel/index · https://m-en.yna.co.kr/channel/index ·
  https://www.inflearn.com/en/users/575 (한경·매경·YNA RSS 목록) · https://rss.feedspot.com/seoul_rss_feeds/

### 1-4. 네이버 API HUB 이관 대응 — 사용자 단계 항목 업데이트 (긴급)

- 상기 "정정 1" 참조. 네이버 뉴스 API(`sort=date`)는 한국 뉴스 1순위 후보로 이미 결론이 나 있다.
  그런데 발급 경로가 바뀌었으니, 사용자가 옛날 방식으로 키를 받으면 2027-06-30에 차단된다.
  **지금 키를 발급받는다면 처음부터 NCP API HUB에서 받아야 한다.**
- 사용자에게 전달할 단계 체크리스트:
  1. NCP(네이버클라우드플랫폼) 계정 가입 → 콘솔에서 NAVER API HUB 신청
     (5단계: 이용 신청 → Application 등록 → API 선택(검색) → 키 확인 → 환경변수 저장).
  2. 검색 API 선택, Client ID/Secret을 Worker Secret(`NAVER_CLIENT_ID`·`NAVER_CLIENT_SECRET`)으로 등록.
  3. 무료 한도 확인: 검색 월 775,000건·일 최대 25,000건 (콘솔 요금표에서 재확인).
  4. 2027년 유료 요금제 도입 검토 중이므로, 무료 제공량 유지 여부를 주기적으로 확인할 것.
  5. **가입 시 카드(결제수단) 등록 필요 여부를 먼저 확인할 것** — 코디네이터 교차 검증에서 카드 등록 필요 보고가 있음.
     카드가 필수면 네이버 뉴스 1차 경로는 원칙상 재검토 대상이다.
- 비용·리스크: 무료 범위 내 $0. 이관 마찰(이미 발급된 키가 갑자기 작동 중단한 사례)이 보고돼 있어,
  발급 직후 스테이징에서 호출 테스트를 할 것.

### 1-5. 패스키 @passwordless-id/webauthn — PIN 다음 인증 수단

- **무엇**: WebAuthn 패스키를 감싼 미니멀 TS 라이브러리. `client`(브라우저) + `server`(검증) +
  `parsers` + `utils`로 나뉘고, **의존성 0개, 전체 10KB 미만**이다.
- **실측**: ★616 · MIT · pushed 2026-10-21 · 이슈 0건 · archived 아님.
  공식 문서(webauthn.passwordless.id)에 "Runs in... Cloudflare Workers"를 명시하고 있다.
  WebCrypto 기반이라 Node 19+·브라우저·Workers에서 같은 빌드로 동작한다. npm 최신 2.4.1.
- **왜 MyHub에 맞는지**: MyHub 인증은 PIN 6자리 + 이메일 OTP다. PIN은 6자리 숫자라
  추측 공간이 100만 개에 불과하고, 서버가 PBKDF2 해시를 들고 있어 유출 시 오프라인 대입이 가능하다
  (속도만 늦출 뿐). 패스키는 **피싱 내성**(origin 바인딩) + **서버에 비밀 없음**(공개키만 저장)이라
  두 약점을 동시에 없앤다. 사용자는 iPhone 사용자라 Face ID 패스키가 자연스럽고,
  한국에서도 iOS·Android·Chrome 모두 플랫폼 패스키를 지원한다.
  라이브러리가 Workers를 명시 지원하고 의존성이 없어 번들·배포 리스크가 거의 없다.
- **어디에·어떻게 적용**: PIN을 당장 대체하지 않는다. **PIN 옆의 선택 인증 수단**으로 추가한다:
  1. D1에 `auth_passkeys` 테이블 추가(credential_id·공개키·카운터·transports·등록일).
  2. `/api/auth/passkey/register-options`·`/register-verify`·`/login-options`·`/login-verify` 4개 엔드포인트.
     챌린지는 KV에 단기 저장(기존 OTP 패턴과 동일).
  3. 로그인 페이지에 "패스키로 로그인" 버튼 추가 — `client.startAuthentication()` 호출.
  4. attestation은 `"none"`으로 둔다(소비자용 단순화, 개인정보 최소화).
  5. 기존 PIN·OTP는 폴백으로 유지한다(패스키 분실·기기 교체 시 복구 경로).
  6. PRF 확장(패스키로 암호화 키 유도)은 2단계로 미룬다 — 먼저 인증부터.
- **테스트·결함 체크**: 이슈 0건이나, ★616의 소규모 프로젝트라 테스트 규모는 미확인으로 표기한다.
  WebAuthn 표준 자체가 검증된 프로토콜이고, 라이브러리는 얇은 래퍼라 결함 전파 면적이 작다.
  단, RP ID는 origin의 등록 가능한 접미사여야 하고 **한 번 정하면 바꿀 수 없다**
  (바꾸면 기존 패스키 재등록 필요) — `myhub.myhub-app.workers.dev`를 RP ID로 할지
  커스텀 도메인으로 갈지 먼저 정해야 한다.
- **비용·리스크**: 무료, 카드 불필요. 리스크는 (a) RP ID 고정, (b) 소규모 라이브러리 유지보수,
  (c) 사용자가 기기를 잃으면 복구 경로가 PIN/OTP에 의존한다는 점.
- **대안**: SimpleWebAuthn(★2,377·MIT·pushed 2026-10-27)은 생태계가 크나 Node 중심이라 Workers 호환 미확인 — 2순위.
- **출처**: https://github.com/passwordless-id/webauthn ·
  https://webauthn.passwordless.id

### 1-6. Cloudflare Turnstile — PIN/OTP 로그인 봇 방어

- **무엇**: Cloudflare의 CAPTCHA 대체 봇 방어 위젯. 브라우저 신호·IP 평판으로 백그라운드에서 판정하고,
  대부분 사용자는 퍼즐 없이 통과한다. 개인정보 최소화를 표방한다.
- **실측**: 공식 가격 정책 기준(2026-05 확인 보도 종합) — **무료, 챌린지 무제한, 카드 불필요,
  계정당 위젯 20개까지**. 유료 플랜은 위젯 수·관리 호스트명만 늘린다.
  (가격은 Cloudflare 공식 문서 기준이나, 이번 조사에서 공식 가격 페이지를 직접 열지는 않았으므로
  "보도 종합"으로 표기한다. 도입 전 공식 문서 재확인 필요.)
- **왜 MyHub에 맞는지**: PIN은 6자리라 온라인 대입이 현실적 위협이다. 지금은 KV 카운터 5회 실패 시
  15분 잠금만 있다 — 분산 IP에서 오면 잠금이 안 먹힌다. Turnstile은 로그인 폼에 한 줄로 붙고,
  MyHub가 이미 Cloudflare 위에 있어 추가 인프라가 없다. reCAPTCHA는 무료 1만 건/월 초과 시
  과금 + Google Cloud 결제 계정(카드) 필요라 사용자 원칙에 어긋난다.
- **어디에·어떻게 적용**: 로그인·PIN 로그인·OTP 요청 폼에 Turnstile 위젯을 추가한다.
  서버에서 `https://challenges.cloudflare.com/turnstile/v0/siteverify`로 토큰을 검증하고
  (secret은 Worker Secret), 실패 시 요청을 거부한다. 실패한 검증도 KV 카운터와 합산한다.
  iOS PWA에서도 위젯이 동작하는지 실기기 확인이 필요하다.
- **비용·리스크**: $0. 리스크는 위젯 가용성(Cloudflare 장애 시 로그인 막힘) — 폴백 경로 필수.
  위젯이 뜨지 않는 환경(광고 차단기 등)에서는 폴백(기존 잠금 로직 유지)이 필요하다 —
  Turnstile 실패를 "봇"으로 단정하지 말고 "추가 검증 요구"로 처리한다.
- **출처**: https://www.cloudflare.com/products/turnstile/ ·
  https://developers.cloudflare.com/turnstile/

### 1-7. sharp 빌드타임 리사이즈 — 아바타·wallpaper 전송 바이트 축소

- **무엇**: Node.js 고성능 이미지 처리 라이브러리 (`lovell/sharp`). 리사이즈·WebP/AVIF 변환·압축.
- **실측**: ★32,802 · Apache-2.0 · 최근 커밋 2026-10-23 · archived 아님.
  MyHub 로컬 실측: 아바타 7개 전부 **1600×1600px인데 32px로 표시** — 4개 주 아바타 합계 약 1.16MB
  (rumi 348KB·nova 295KB·echo 267KB·cali 237KB). wallpaper `public/wallpaper.webp` 2240×1120px, 148,292B.
  `loading="lazy"`·`srcset`·`<picture>`·`fetchpriority` 전부 **0건**.
- **왜 MyHub에 맞는지**: 4개 주 아바타 합계 약 1.16MB가 채팅 메시지마다 반복 다운로드되는 구조다
  (SW CacheFirst라 2회차부터는 캐시되나, 첫 방문·캐시 무효화 시 전량을 받는다).
  96px(레티나 3x 여유 포함) WebP로 줄이면 파일당 5~15KB 수준이 예상되며, 4개 합계 **1.16MB → 약 40KB (약 97% 감소)**가 기대된다.
  wallpaper도 2240×1120 단일본에서 모바일용 800w + 데스크톱용 1600w + AVIF 변형을 만들 수 있다.
  perf-audit의 번들 57.7% base64 문제는 ASSETS 이관(P-1, HEAD a014850)으로 해소됐으나,
  **전송 바이트 자체는 파일 크기가 그대로 남으므로** 이 항목은 ASSETS 이관과 별개로 유효하다.
- **어디에·어떻게 적용**: 런타임이 아니라 **빌드타임(devDependency) 전용**으로 쓴다.
  `scripts/optimize-images.mjs`를 만들어 배포 전 단계에서 실행한다:
  - `public/avatars/*.webp` → 96px + 192px(@2x) WebP 재생성 (원본은 `assets-src/`로 이동해 보관)
  - `public/wallpaper.webp` → 800w / 1600w / 원본 2240w + AVIF 변형 생성, `index.html`에서
    `image-set()` 또는 `<picture>`로 분기
  - 기존 파일명은 유지해 SW 캐시 키(`?v=`) 체계를 건드리지 않는다. 배포 스크립트(`deploy_full.py`)
    실행 전에 이미지 최적화 스크립트를 먼저 돌리는 순서로 묶는다.
  - sharp는 네이티브 바이너리(libvips)를 쓰므로 VM에 설치해 빌드만 하고, Worker 번들에는 포함하지 않는다.
- **비용·리스크**: 무료(Apache-2.0, 로컬 빌드 도구). 리스크는 빌드 단계 1개 추가뿐.
  단, 아바타 원본(1600px)을 덮어쓰지 말고 원본을 별도 보관할 것 — 재생성 시 품질 열화를 막기 위해.
  AVIF는 iOS 16+·Chrome·Safari에서 지원되나, 구형 브라우저 폴백으로 WebP 원본을 반드시 남긴다.
- **출처**: https://github.com/lovell/sharp

### 1-8. zod → zod/mini 교체 — 번들 zod 854KB 해소 (새 의존성 없음)

- **무엇**: Zod v4에 내장된 트리쉐이킹 전용 경량 변형. `zod` 패키지의 `zod/mini` 서브패스 —
  **새 패키지가 아니라 이미 설치된 zod 4.6.5 안에 있다.**
- **실측**: zod 공식 릴리스 노트(`zod.dev/v4`) 기준, 동일 스키마 Rollup 빌드 gzip 비교:
  Zod 3 `12.47kb` → Zod 4 일반 `5.36kb` → Zod 4 mini **`1.88kb`** (85% 감소).
  단, 이 수치는 공식 샘플 스키마 기준이며 MyHub 사용처의 실제 감소폭은 **교체 후 metafile로 재측정 필요**.
  perf-audit 실측 기준 MyHub 번들 내 zod v4는 854,467B(20.2%).
  MyHub 사용처는 **3개 파일**뿐 (`src/ai/tools/registry.ts`, `search-memo.ts`, `test-todo-add.ts`).
  mini가 `z.toJSONSchema`를 지원하는지 확인했다 — standardschema.dev의 사용 예시에
  `import * as z from 'zod/mini'; z.toJSONSchema(z.string())`이 ✅로 명시돼 있다. 즉 **기능 차단 요소가 없다.**
- **어디에·어떻게 적용**: 3개 파일의 스키마만 mini 함수형 API로 재작성한다.
  mini는 클래식 메서드 체이닝(`.min()/.max()/.regex()/.int()/.default()`)이 없고
  `.check()` + 함수 조합을 쓴다. `z.ZodType` 타입 참조(`registry.ts:46,62`)는 mini의 타입과 호환되는지 tsc로 확인한다.
  교체 후 `npx tsc` + Jest 전체 + esbuild metafile로 zod 포함량을 재측정한다.
  대안으로 **Valibot**(`open-circle/valibot`, ★9,052 · MIT · 2026-10-24)도 있다 —
  모듈러 import로 1.37KB 수준이나, zod/mini는 의존성 추가 없이 같은 패키지 안에서 해결되므로 mini가 1순위,
  Valibot은 mini가 맞지 않을 때의 대안이다. Valibot으로 가면 JSON Schema 변환은 별도 패키지
  `@valibot/to-json-schema`가 필요하다.
- **비용·리스크**: 무료. 리스크는 스키마 3파일 재작성 범위 — 작다.
  mini는 `.transform()`·`.pipe()`·`.refine()`·`.brand()` 미지원이나 MyHub 사용처 3파일에는 해당 API가 없다 (grep 확인).
  `z.toJSONSchema` 출력이 classic과 동일한지는 `registry.ts`의 JSON Schema 변환 테스트로 검증한다.
- **출처**: https://zod.dev/v4 · https://standardschema.dev

### 1-9. Cloudflare Workflows — Plan & Execute·자연어 cron의 내구성 실행 엔진

- **무엇**: Workers 위에 지어진 내구성(durable) 실행 엔진. `step.do()` 단위로 상태를
  저장하고, 실패하면 해당 단계만 재시도하며, `step.sleep()`·`step.waitForEvent()`로
  수 시간~수 일 대기해도 비용이 들지 않는다(대기 중 CPU 과금 없음).
  GA는 2025-04-07(블로그)이나, **2026년에 실질적 전환점이 왔다**: Agents Week 2026(4월)
  10배 스케일업, 2026-05-01 Dynamic Workflows, 2026-06-02 바인딩에 cron 스케줄 직결.
- **실측** (공식 문서·체인지로그):
  - 한도 상향 (2026-10 블로그 "enterprise-for-all" 기준): 동시 인스턴스 50,000개(기존 4,500),
    생성 300개/초(기존 10), 인스턴스당 단계 25,000개(기존 1,024), 큐 200만 개,
    스트리밍 출력은 인스턴스 스토리지 한도까지.
    **코디네이터 교차 검증**: 공식 블로그에서 50,000 동시·25,000 스텝 수치를 확인했다.
  - 2026-06-02: `wrangler.jsonc`의 Workflow 바인딩에 `schedules: ["0 * * * *", ...]`를
    달면 별도 `scheduled` 핸들러 없이 cron마다 인스턴스 자동 생성.
    (주의: 이것은 **Workflow**의 스케줄이지, MyHub가 `deploy_full.py`에서 PUT API로 등록하는
    **Worker Cron Trigger**와는 다른 기능이다. 혼동 금지.)
  - 2026-05-01: `@cloudflare/dynamic-workflows` — Dynamic Worker 안에서 Workflow 실행 가능.
  - 스텝 옵션에 `sensitive: 'output'`(스텝 출력을 로그에서 redact) 및 `rollback`/`rollbackConfig`(실패 시 보상 실행) 존재.
  - 가격 (공식 가격표): Free — 요청 100,000/일(Workers와 공유), CPU 10ms/호출, 스토리지 1 GB-month,
    **스텝 3,000/일**. Paid — 요청 1,000만/월 포함 + $0.30/백만, **스텝 50만/월 포함 + $0.80/10만 스텝**.
    단, 가격표에 "Cloudflare will not bill step and storage usage before the start date
    announced in the Workflows billing changelog" 문구가 있어 **스텝·스토리지 과금 시작일은 미확인**
    (2026-08 글은 실제 청구 사례를 논하고 있어 과금은 시작된 것으로 보이나, 공식 시작일은 확인 못 함).
- **왜 MyHub에 맞는지**: 감사 §4.2·§3.3이 지적한 구조적 약점과 정확히 맞물린다.
  (a) `job-processor`의 재시도·타임아웃·상태 추적을 손으로 구현하고 있는데 Workflows는
  단계별 재시도·타임아웃을 런타임이 보장한다.
  (b) 자연어 cron(`handleCronJobs`)은 5분 틱 안에서 AI 호출이 순차 누적되는데,
  Workflow 인스턴스마다 격리 실행 + 단계별 deadline을 둘 수 있다.
  (c) 승인 게이트(위험 기반 승인)는 `step.waitForEvent()`의 **human-in-the-loop** 패턴과 같은 모양이다 —
  승인 대기 중에는 비용이 들지 않는다.
  (d) `sensitive: 'output'`은 잠긴 메모·비밀정보가 워크플로 로그에 남는 것을 막는 데 직접 쓸 수 있다.
- **어디에·어떻게 적용**: 당장 갈아엎지 않는다. POC 범위: 아침 브리핑(Exa + LLM 요약) 하나를
  Workflow로 구현해 스테이징에서 돌리고, (1) 단계별 재시도가 실패 주입 시 동작하는지,
  (2) 5분 cron 틱 대비 지연·비용이 어떤지, (3) 스텝 출력 redact가 잠금 경계와 맞물리는지를 측정한다.
  통과 후에만 `handleCronJobs` → Workflow 이관을 검토한다.
  `scheduled.ts`의 5분 틱 자체는 유지하고, 틱이 Workflow 인스턴스를 생성하는 형태로 둔다.
- **비용·리스크**: 단일 사용자 규모면 Free 3,000 스텝/일은 충분해 보인다 (브리핑 1회 = 수~수십 스텝).
  리스크: (1) 과금 시작일·실제 청구 조건 미확인 — 무료 범위 초과 시 Paid 전제($5/월 Workers Paid + 사용량)이므로 초과 방지 가드 필요.
  (2) Workflow 인스턴스 상태는 Cloudflare가 보관 — 잠긴 메모 내용을 스텝 입출력에 넣지 않는 규칙을 코드로 강제해야 한다.
  (3) agents SDK(이전 조사)와 역할이 겹친다 — 에이전트 상태는 agents/DO, 다단계 실행 내구성은 Workflows로 나누는 설계 정리가 먼저 필요하다.
- **출처**: https://developers.cloudflare.com/workflows/ ·
  https://developers.cloudflare.com/workflows/reference/pricing/ ·
  https://blog.cloudflare.com/workflows-ga-production-ready-durable-execution/

### 1-10. BFCL식 FC 채점 promptfoo 이식 — 도구 호출 정확도를 숫자로

- **무엇**: LLM의 함수 호출 능력을 평가하는 벤치마크·리더보드 (`ShishirPatil/gorilla`).
  BFCL은 다중 턴·병렬 호출·관련 없는 도구 섞기·AST 기반 정확도 채점을 포함한다.
- **실측**: ★13,062 · Apache-2.0 · push 2026-10-17 · 이슈 296.
- **왜 MyHub에 맞는지**: MyHub Plan & Execute의 약점은 "도구가 제대로 불리는지"를 라이브에서만 알 수 있다는 점이다.
  BFCL의 평가 설계(관련 도구 + 방해 도구(distractor)를 섞어 놓고, AST로 호출 인자를 채점)는 promptfoo 시나리오에 그대로 이식할 수 있다:
  메모 작성 시나리오에 `schedule.create`·`todo.create` 같은 방해 도구를 함께 주고,
  모델이 올바른 도구·올바른 인자를 골랐는지 AST 수준으로 채점한다.
  tau-bench(이전 조사)가 대화 종단 평가라면, BFCL은 **도구 호출 자체의 정확도**에 특화돼 Plan & Execute와 직접 맞는다.
- **어디에·어떻게 적용**: 벤치마크를 그대로 돌리지 않는다 (MyHub 도구와 무관한 태스크가 대부분).
  `tests/evals/`의 promptfoo 시나리오에 BFCL식 채점을 추가한다:
  (1) 시나리오마다 기대 도구 호출을 AST(JSON)로 고정,
  (2) 방해 도구 2~3개를 프롬프트에 함께 노출,
  (3) 채점은 "도구명 일치 + 필수 인자 일치 + 금지 도구 미호출" 3단계.
  비서 4명(루미·에코·노바·캘리)별로 같은 시나리오를 돌려 모델별 FC 정확도를 비교한다 —
  지금은 모델별 FC 품질 차이가 감(感)으로만 알려져 있다.
- **비용·리스크**: 무료 (설계만). 단, 채점용 AST 비교는 JSON 정규화(키 순서·공백)를 먼저 해야 오탐이 안 난다.
  벤치마크 자체의 오염(모델이 BFCL을 외웠을 가능성)은 MyHub 전용 시나리오를 쓰면 회피된다.
- **출처**: https://github.com/ShishirPatil/gorilla

---

## 2순위 상세 (POC·패턴 차용 후 판단 — 요약본, 전량은 트랙 원본 참조)

### 2-1. Hindsight — 메모리 v2의 대조군 (4중 검색 + reflect)

- **무엇**: Vectorize의 에이전트 메모리 엔진 (`vectorize-io/hindsight`). 연산 3개: `retain`·`recall`·`reflect`.
  검색은 **4가지 전략을 병렬 실행** — 시맨틱 검색·BM25 키워드·지식 그래프 순회·시간 필터 — 뒤 RRF + cross-encoder reranker로 융합.
  TS·Python·Go SDK, MCP-first, 임베디드 PostgreSQL 하나로 동작.
- **실측**: ★**54,467** · MIT · push 2026-10-28 · 이슈 175. 2026-09-28 하루에만 4,520개 스타가 붙은 급성장.
  **LongMemEval 94.6%**로 공식 재현 결과 중 1위 주장 (2차 출처 — Vectorize 자사 비교 페이지 기준이라 독립 검증은 미확인).
- **왜 맞는가**: MyHub 메모리 v2는 FTS5 + 임베딩(bge) + 사실 추출·supersede·인용 잠금까지 있으나, 검색이 **단일 경로(FTS → 임베딩 순차)**에
  가깝고 reranker가 없다. Hindsight의 "4중 병렬 + RRF + cross-encoder rerank"는 `fusionScore`가 풀어야 하는 바로 그 문제에 대한 실증된 답안지다.
  `reflect`는 수면 통합(03:00 KST consolidation)과 같은 역할이라 대조군이 된다.
- **어떻게**: **서버를 설치하지 않는다** (Docker + PostgreSQL 상주는 셀프호스팅 부담 + Workers와 맞지 않음). **패턴만 차용**:
  (1) `recall`을 4중으로 — 기존 FTS + bge 임베딩에 BM25(FTS5 `bm25()` 랭킹 활용)·시간 필터(최근성 가중)를 병렬로 돌려 RRF로 융합하는 실험을
  `src/services/memory-service.ts`에 별도 함수로 만들고, 기존 단일 경로와 A/B로 비교한다 (한국어 평가셋 100~200건으로 측정 후 판단).
  (2) `reflect`의 "관찰 + 지식 페이지" 개념을 수면 통합의 출력 형태와 대조한다.
  (3) cross-encoder reranker는 Workers AI에 해당 모델이 있는지 확인 후, 없으면 LLM-as-judge rerank(소규모 후보군만)로 대체 검토.
- **주의**: LongMemEval 94.6%는 **자사 주장**이라 MyHub 데이터로 재현하기 전에는 믿지 않는다.
- **출처**: https://github.com/vectorize-io/hindsight · https://vectorize.io/articles/hindsight-vs-mem0

### 2-2. CaMeL 패턴 — 런타임 인젝션 방어를 "탐지"에서 "구조"로 (출처 라벨링)

- **무엇**: Google DeepMind·ETH Zurich의 프롬프트 인젝션 방어 아키텍처
  (Debenedetti et al., "Defeating Prompt Injections by Design", arXiv:2503.18813, 2025-03-24, 2025-06-24 개정).
  특권 LLM(사용자 지시만 보고 계획 수립) + 격리 LLM(신뢰할 수 없는 외부 콘텐츠만 처리, 도구 접근 없음) +
  데이터 출처(capability) 라벨을 결정적 정책 인터프리터가 검사한다. 신뢰할 수 없는 데이터가 도구 인자로 흘러가면 정책이 차단한다.
- **실측**: 논문 기준 AgentDojo에서 **77% 태스크를 증명 가능한 보안과 함께 해결** (무방비 84%). 7%p의 유틸리티 비용.
  참조 구현: `google-research/camel-prompt-injection` — ★411 · Apache-2.0 · pushed 2025-06-20 · 이슈 4건 (연구 코드).
- **왜 맞는가**: MyHub의 핵심 보안 경계가 메모발 인젝션이다. garak(전 조사)은 **공격 테스트**, llm-guard·NeMo는 **탐지·가드레일**,
  CaMeL은 그 너머의 층 — 탐지가 뚫려도 **구조가 막는다**. MyHub에는 이미 같은 방향의 재료가 있다:
  비서별 도구 권한 경계, 위험 기반 승인 게이트, 잠긴 메모 원천 차단, 비밀정보 마스킹.
  특히 **뉴스·웹검색 결과(외부·신뢰 불가)가 메모 생성·이메일 발송 같은 도구 인자로 흘러가는 경로**가 바로 CaMeL이 겨냥하는 공격면이다.
- **어떻게**: 참조 구현을 통째로 가져오지 않는다. **패턴만 TS로 구현**:
  (1) 모든 도구 인자에 `source` 라벨 — `user`(사용자 직접 입력), `memo`(내 메모), `external`(웹검색·뉴스·RSS), `model`(모델 생성).
  (2) FC 게이트(`src/services/ai.ts`)에 결정적 규칙 추가: `external` 출처 문자열이 `send_email.to`·`calendar.create`·`memo.create`의
  **지시어 위치**에 들어가면 차단하거나 승인 게이트로 보낸다. (값으로 들어가는 것은 허용하되, 명령으로 해석되는 것은 차단.)
  (3) 이미 있는 승인 게이트·위험 기반 분류와 합친다: `external` 출처 + 쓰기 도구는 기본적으로 승인 필요로 격상.
  (4) 평가는 AgentDojo 패턴으로 — garak 프로브에 "출처 라벨 우회" 케이스를 추가한다.
- **순서**: garak 실제 모델 프로브 결과가 나온 뒤에 설계하는 것이 순서다 — 뚫리는 경로를 먼저 보고 라벨을 어디에 붙일지 정한다.
  유틸리티 7%p 하락은 "정상 요청이 더 자주 승인을 묻게 된다"는 뜻이라, 승인 UX와 함께 설계해야 한다.
- **출처**: https://arxiv.org/abs/2503.18813 · https://github.com/google-research/camel-prompt-injection

### 2-3. gitleaks CI + SOPS/age — 시크릿 사고 재발 방지 두 겹 잠금

- **gitleaks** (★30,415 · MIT · pushed 2026-10-23): Git 저장소·코드 스캔해 하드코딩된 비밀키·토큰·API 키를 찾는 스캐너.
  Semgrep의 secrets 규칙은 범용 규칙이고 gitleaks는 100개 이상 서비스의 키 형식을 전용 탐지기로 갖고 있어 탐지율이 다르다.
  CI 게이트로 `gitleaks detect`를 추가한다. 처음에는 warning만 내고, 오탐은 allowlist 파일에 사유를 적어 관리한다.
  기존 커밋 이력 스캔(`gitleaks detect --log-opts`)은 한 번 돌려 과거 유출 여부를 확인한다 (유출이 나오면 키 로테이션).
  2026-10-21 시크릿 소실 사고 이후의 두 번째 잠금이다.
- **SOPS + age** (SOPS ★23,536 · MPL-2.0 · pushed 2026-10-27 / age ★24,085 · BSD-3-Clause · pushed 2026-08-29):
  시크릿은 Cloudflare Secrets에 있고 그게 맞다. 그러나 **로컬에 남는 비밀**(배포 스크립트 테스트용 값, D1 백업 덤프,
  사용자가 직접 등록하는 스테이징 키 메모)이 있다. SOPS+age면 "암호화된 채로 repo에 두고, 키는 로컬에만 두는" 패턴이 된다.
  특히 **D1 백업·내보내기 파일을 age로 암호화**하는 용도가 직접적이다. 설치는 로컬·CI에만 한다(Worker 코드에 안 들어간다).
  리스크는 age 비밀키 분실 시 복호 불가 — 키 백업 절차가 필수.
- **출처**: https://github.com/gitleaks/gitleaks · https://github.com/getsops/sops · https://github.com/FiloSottile/age

### 2-4. Workers AI 2026 프론티어 모델 + 네이티브 도구 호출 — 마커 FC 대체 후보

- **무엇**: 2026년에 Workers AI 카탈로그에 들어온 프론티어급 오픈 모델들. 공통점은 **네이티브 function calling·structured outputs·
  긴 컨텍스트(256K)·프롬프트 캐싱**을 갖추고, 2026-02-17 체인지로그에서 도구 호출 라운드트립 버그(`tool_call_id` 거부,
  `content: null` + `tool_calls` 거부, `finish_reason` 오표기)가 수정돼 멀티턴 도구 호출이 실제로 동작하게 됐다.
- **실측** (공식 Workers AI 체인지로그 직접 열람): 2026-06-16 `@cf/zai-org/glm-5.2` (262,144 ctx) ·
  2026-06-12 `@cf/moonshotai/kimi-k2.7-code` (1T MoE 코딩 특화, 262.1K ctx) ·
  2026-04-20 `@cf/moonshotai/kimi-k2.6` (1T MoE, 262,144 ctx, 가격 **$0.95/M 입력, $4.00/M 출력, $0.16/M 캐시된 입력**) ·
  2026-04-04 `@cf/google/gemma-4-26b-a4b-it` (MoE 26B, 256K ctx) ·
  2026-03-11 `@cf/nvidia/nemotron-3-120b-a12b` (하이브리드 MoE 120B) ·
  2026-02-13 `@cf/zai-org/glm-4.7-flash` (100+ 언어 멀티턴 도구 호출 특화 고속 모델, 폐기 모델 마이그레이션 대상으로 Cloudflare가 직접 권장).
  2026-03-19 프롬프트 캐싱 문서 신설 (`x-session-affinity` 헤더), Batch API 개편 (`queueRequest: true`).
  2026-03-06 `@cf/deepgram/nova-3` — 10개 언어 지원이나 **한국어 없음** — 한국어 음성 부적합.
  2026-05-08 폐기 목록(2026-05-30 폐기): llama-3-8b, llama-3.1-8b/70b, llama-2-7b, mistral-7b, gemma-7b, gemma-3-12b, phi-2 등.
  **K2.5는 2026-05-30부터 K2.6으로 자동 alias되며 가격이 오른다. K2.5를 신규로 쓰면 안 된다.**
  MyHub가 Workers AI로 쓰는 Clef-flash·bge 계열은 폐기 목록에 없다.
- **왜 맞는가**: MyHub의 FC는 모델이 `[MEMO_CREATE: ...]` 같은 마커 텍스트를 뱉으면 파서가 해석하는 손수 짠 방식이다.
  파서 엣지 케이스(마커 파싱 실패·다단어 주입)가 반복 결함원이었다. 네이티브 도구 호출을 쓰면 모델이 구조화된 `tool_calls`를 반환하고
  런타임이 왕복을 보장하므로, 마커 파서 자체가 사라진다. K2.6/K2.7-Code는 262K 컨텍스트라 긴 대화·메모 컨텍스트를 한 번에 넣을 수 있고,
  프롬프트 캐싱은 매 턴 전체 히스토리를 재전송하는 MyHub 채팅 구조의 비용·지연을 직접 줄인다.
  Batch API는 실시간이 아닌 작업(03:00 수면 통합·메모리 추출·eval)에 맞는다.
- **어떻게**: 외부 모델(Gemini·Groq·NVIDIA)을 당장 교체하지 않는다. 스테이징 POC: 노바(코드 비서) 후보로 K2.7-Code,
  범용 후보로 K2.6 또는 GLM-4.7-flash를 `env.AI.run()` + 네이티브 `tools` 파라미터로 붙이고, 기존 마커 FC 시나리오
  (메모 생성·일정 생성·메모 검색)를 그대로 돌려 성공률·지연·비용을 측정한다.
- **비용·리스크**: K2.6 단가 $0.95/$4.00 per M 토큰은 Gemini flash-lite·Groq 무료 범위와 비교하면 비싸다.
  **무료 뉴런 10,000/일이 K2.6 같은 단가제(per-token) 모델에 적용되는지는 문서에서 확인 못 함 — 미확인.**
  한국어 품질은 미확인 — K2.6·GLM 모두 중국 모델이라 한국어 도구 호출·요약 품질을 스테이징 평가셋으로 직접 재야 한다.
- **출처**: https://developers.cloudflare.com/workers-ai/changelog/ ·
  https://developers.cloudflare.com/workers-ai/models/kimi-k2.6/

### 2-5. Workers 온디맨드 CPU·메모리 프로파일링 (2026-10-09) — cold start 실측 수단

- **무엇**: 운영 중인 Worker·Durable Object에 대해 온디맨드 CPU 또는 메모리 프로파일을 요청하고,
  대시보드에서 인터랙티브 flamegraph로 보며, `.pprof` 파일로 내려받을 수 있다.
  CLI는 `cf workers versions profile latest --worker-id ... --duration-ms 5000 --profile-type cpu` 형태.
- **실측** (공식 블로그, 2026-10-09): 대시보드 Workers Observability 탭의 드롭다운에서 "Flamegraph" 선택.
  프로파일러는 isolate 락을 생명주기 동작에만 잡아 실행 중에도 샘플링이 가능하다고 명시.
  단, **트래픽이 충분한 버전에서만 프로파일이 성공**한다 (트래픽 의존적). 가격(무료 포함 여부)은 블로그·문서에서 확인 못 함 — **미확인**.
- **왜 맞는가**: 감사 §7의 미확인 항목 1번이 "Worker cold start 실측 시간"이다. 외부 curl로는 분리 측정이 불가하다고 적혀 있다.
  프로파일링은 정확히 그 빈틈을 메운다: 운영 Worker에서 `atob()` 전수 디코딩·`STATIC_FILES` 적재·라우트 초기화가 CPU의 몇 %를 차지하는지
  함수 단위로 보인다. ASSETS 이관 전후를 같은 방법으로 재면 이관 효과를 숫자로 증명할 수 있다.
- **어떻게**: 코드 변경 없이, 대시보드 또는 `cf` CLI로 운영 Worker에 CPU 프로파일 5~10초를 걸고, 상위 함수를 확인한다.
  소스맵이 없으면 난독화된 이름만 보이므로, 배포 시 소스맵 업로드 여부를 먼저 확인한다.
  정직한 한계: flamegraph는 **실행 중 CPU**를 보여주지 isolate 초기화 시간 자체를 직접 재지는 못할 수 있다 —
  프로파일 결과가 초기화 구간을 포함하는지는 실행 후 확인하고, 안 되면 "실행 중 CPU 핫스팟 측정"으로 범위를 좁혀 기록한다.
  MyHub는 단일 사용자라 트래픽이 적어 프로파일 캡처가 실패할 수 있다 — 그 경우 트래픽이 있는 시간대에 재시도한다.
- **출처**: https://blog.cloudflare.com/workers-on-demand-profiling/

### 2-6. 카카오 Daum 검색 API (sort=recency) — 뉴스 백업 소스

- **무엇**: 카카오디벨로퍼스 REST API의 Daum 검색. 웹문서·동영상·이미지·블로그·책·카페 검색.
  **뉴스 전용 엔드포인트는 없다** — 웹문서 검색에 뉴스 기사가 포함되는 구조다.
  정렬 파라미터 `sort=accuracy|recency`로 최신순 정렬 가능 (공식 문서 기준 — 적용 시 파라미터 재확인).
- **실측** (카카오디벨로퍼스 공식 쿼터 문서, 2026-10-28 크롤): **Daum 검색 일 50,000건**,
  웹문서·동영상·이미지·블로그·책·카페 각 **일 30,000건**. 무료, 카드 불필요 (쿼터 초과 시에만 유료 API 설정으로 전환 — 설정하지 않으면 초과분 차단).
- **왜 맞는가**: 네이버 뉴스 API와 독립된 2번째 한국 검색 경로다. 네이버 키 발급이 NCP 이관으로 꼬였을 때의 백업,
  네이버 장애 시 폴백, 블로그·카페(배경·여론) 보강용으로 쓸 수 있다. `sort=recency` + 응답 `datetime` 필드로
  클라이언트 하드 필터가 가능하다 (Exa와 달리 날짜 필드가 API 스펙에 있다).
- **어떻게**: 카카오디벨로퍼스 앱 생성 → REST API 키 발급 → Worker Secret(`KAKAO_REST_API_KEY`) 등록.
  `GET https://dapi.kakao.com/v2/search/web?query=...&sort=recency&size=10` 호출, `Authorization: KakaoAK {key}` 헤더.
  뉴스 체인에 폴백 소스로 추가: 네이버(1차) → Daum 웹문서 recency(2차) → Tavily/Exa.
  응답의 `datetime`으로 창 밖 결과 제외, 본문은 기사 URL 직접 fetch.
- **비용·리스크**: 무료枠 내 $0, 카드 불필요. 단, 웹문서 검색이라 뉴스 전용이 아니어서
  "오늘 뉴스" 정밀도는 네이버보다 낮을 수 있음 — 실측으로 판정. Daum 뉴스 커버리지는 네이버보다 좁다.
- **출처**: https://developers.kakao.com/docs/ko/getting-started/quota

### 2-7. es-hangul (Toss) — 초성·자모 검색 + 조사 자동 선택

- **무엇**: 토스가 만든 현대적 한글 처리 JS 라이브러리. `@toss/hangul`의 후계자 (구 패키지는 deprecated).
  ESM, 트리셰이킹 지원. 함수: `disassemble`(자모 분해), `assemble`, `getChoseong`(초성 추출),
  `josa`(조사 자동 선택), `numberToHangul`, `convertQwertyToHangul`, `standardizePronunciation`, `romanize`.
- **실측**: `toss/es-hangul`: **★1,887 · MIT · 업데이트 2026-10-24** · 마지막 푸시 2026-08-27 · 아카이브 아님.
  README에 MIT 명시 ("MIT © Viva Republica, Inc.").
- **왜 맞는가**: 사용자가 "ㅌㅅ"만 쳐도 "토스"를 찾는 초성 검색, "토스"를 "톳"으로 찾는 자모 검색이 한국 서비스의 기대 동작이다.
  FTS5는 음절 단위라 초성 검색을 못 한다. 순수 JS라 Worker 번들에 직접 포함할 수 있고(작음), 서버 비용 0이다.
- **어떻게**: (1) 메모 검색 UI(프론트): 입력이 초성만으로 이뤄지면 `getChoseong`으로 메모 제목과 매칭 (클라이언트 측 필터).
  (2) FTS5 쿼리 확장(서버): 질의를 `disassemble`해 자모 prefix 토큰을 보조 쿼리로 생성 — FTS5의 한국어 조사·어미 한계를 부분 보완.
  (3) 비서 답변 문장 생성: `josa(단어, '을/를')`로 "사과를/사과가" 같은 조사를 자동 선택 (템플릿 문장 품질 개선).
  `hangul-search-js`(★25, 2021년 이후 방치)는 같은 문제를 푸는 구 패키지라 **es-hangul로 대체**한다.
- **출처**: https://github.com/toss/es-hangul

### 2-8. 카카오톡 나에게 보내기 — 브리핑 전달 채널

- **무엇**: 카카오톡 메시지 API 중 "나에게 보내기" (`POST https://kapi.kakao.com/v2/api/talk/memo/default/send`).
  로그인한 본인에게만 메시지를 보낸다.
- **실측** (카카오 데브톡 공식 FAQ): "**나에게 보내기는 발송 제한이 없고 검수 없이, 제한 없이 발송 가능합니다.**"
  친구·메시지 API는 권한(검수)이 필요하지만, 나에게 보내기는 검수 대상이 아니다. 사업자 등록 없이 사용 가능.
  단, **"메모 용도로 제공되며 알림이 발생하지 않는 특성"**이 있어 푸시 알림을 기대하면 안 된다 (사용자가 카톡을 열어야 본다).
  쿼터 문서상 카카오톡 메시지 전송 일 30,000건.
- **왜 맞는가**: 아침 브리핑·일정 리마인드를 사용자가 가장 자주 보는 앱(카톡)으로 보낼 수 있다.
  Web Push는 iOS·브라우저 조건이 까다롭고 VAPID 재등록 이슈가 있었는데, 카톡은 별도 채널로 보완된다.
  단일 사용자 서비스라 "나에게만 보내기"가 정확히 맞는 형태다.
- **어떻게**: 카카오디벨로퍼스 앱 생성 → 카카오 로그인 연동 → `talk_message` 스코프 동의 → 액세스 토큰 발급·갱신
  (리프레시 토큰 관리 필요 — 기존 Google OAuth 토큰 관리 패턴과 동일). 아침 브리핑 cron 완료 후
  `talk/memo/default/send`로 텍스트 템플릿 전송. **Web Push를 대체하지 않고 병행** — 알림이 안 오므로
  "카톡으로 브리핑을 남겨두는" 용도로 안내한다.
- **출처**: https://devtalk.kakao.com/t/api-api/116052 · https://devtalk.kakao.com/t/topic/143572

### 2-9. 네이버 DataLab 검색어 트렌드 API — "지금 뜨는 검색어" 감지

- **무엇**: 네이버 통합검색어 트렌드 조회 API (`POST https://openapi.naver.com/v1/datalab/search`).
  키워드 최대 5개까지 비교, 상대 지수(0~100) 추이 반환. 쇼핑인사이트도 같은 계열.
- **실측**: 네이버 오픈 API 목록에 엔드포인트 등재 확인. 한도: NCP 이관 후 **월 30,000건 기본 무료**
  (2차 출처는 월 최대 50,000건 한시적 무료 — 가입 시 확인). 검색 API와 같은 NCP API HUB 이관 대상 (2027-06-30 지원 종료).
- **왜 맞는가**: 아침 브리핑에 "지금 사람들이 많이 찾는 주제" 섹션을 붙일 수 있다.
  뉴스 체인이 "무슨 일이 있었나"라면, DataLab은 "무엇이 뜨는가"를 보여준다.
- **어떻게**: 네이버 검색 API 키와 함께 발급 (같은 Application). 아침 브리핑 cron에서
  고정 키워드 세트(예: 사용자 관심사 5개)의 7일 추이를 조회해 급등 키워드를 브리핑에 포함.
  상대 지수라 절대 검색량은 안 나오므로 "급등 여부"만 쓴다.
- **출처**: https://naver.github.io/naver-openapi-guide/apilist.html

### 2-10. idb 오프라인 outbox + View Transitions + web-vitals (프론트엔드 묶음)

- **idb** (`jakearchibald/idb`, ★7,432 · ISC · 2026-10-06): IndexedDB를 Promise 기반으로 쓰는 초경량 래퍼.
  지금 오프라인 대응은 **읽기 전용**이다 — sw.js는 네비게이션 실패 시 `/offline.html` 폴백만 하고,
  오프라인에서 쓴 메모·할일·일정은 그대로 유실된다. `sync` 이벤트 핸들러도 없다.
  idb로 outbox 스토어를 만들면 "오프라인에서 메모를 쓰고, 온라인이 되면 자동 전송"이 된다.
  **iOS 핵심 제약**: Background Sync API는 **Chromium 전용**이다 (2026-06 기준 Safari 데스크톱·iOS 전부 미지원, Firefox도 미지원).
  따라서 outbox 드레인은 Background Sync에 기대지 않고 **`online` 이벤트 + `visibilitychange`(앱 복귀 시) + 앱 기동 시** 3개 트리거로 설계해야 한다.
  서버는 멱등성 키(`id`)로 중복 전송을 무시해야 한다 (재시도 시 중복 생성 방지 — Worker 측 `Idempotency-Key` 처리와 함께 설계).
  첨부 파일(바이너리)은 outbox에 넣지 않고 텍스트 쓰기부터 시작한다 (iOS PWA 스토리지 7일 미사용 시 만료·약 50MB 상한 고려).
- **Cross-document View Transitions** (`@view-transition { navigation: auto; }` 3줄 CSS):
  크로스 도큐먼트: Chrome 126+·Edge 126+·Safari 18.2+·Opera 112+, Firefox는 미지원(플래그 뒤).
  미지원 브라우저는 규칙을 무시하고 **그냥 일반 페이지 로딩**을 한다 — 폴백 코드가 필요 없는 점이 확인된 장점.
  MyHub는 정적 HTML 페이지들의 MPA라 정확히 맞는 API다. 사용자의 iPhone은 Safari 18.2+면 바로 동작한다.
  `prefers-reduced-motion` 사용자는 애니메이션을 끄는 미디어 쿼리를 함께 둔다.
- **web-vitals** (`GoogleChrome/web-vitals`, ★8,663 · Apache-2.0 · 2026-10-16): Core Web Vitals(LCP·INP·CLS·FCP·TTFB)를
  브라우저에서 측정하는 Google 공식 라이브러리. perf-audit 실측에서 라이브 TTFB가 0.45~0.67초로 나왔고,
  "서버 측 대기 시간이 지배적"이라는 추정만 있다. **실사용자 체감(LCP·INP)은 측정한 적이 없다.**
  web-vitals로 RUM을 붙이면 "느린 게 서버 TTFB인지, 4.2MB 번들 파싱인지, 이미지인지"가 분리된다.
  전송처는 (a) **Cloudflare Web Analytics**(무료, 카드 불필요 — RUM 자동 수집) 또는 (b) 자사 `/api/metrics` 엔드포인트에 비콘 전송 후 D1 적재.
  (b)는 개인정보(잠긴 메모 내용 등)를 절대 포함하지 않고 메트릭 값·페이지 경로만 보낸다. 샘플링(예: 10%)을 둔다.
- **출처**: https://github.com/jakearchibald/idb · https://github.com/GoogleChrome/web-vitals

### 2-11. 기타 2순위 (한 줄 요약 — 상세는 트랙 원본 참조)

- **Queues 무료 플랜 편입 (2026-02-04)**: Free **10,000 operations/일 포함**, 보관 24시간(고정).
  메시지 1건 전달 ≈ 3 operations. at-least-once(중복 가능) — consumer는 멱등해야 한다.
  아티팩트 생성 요청부터 POC: 생성 요청을 큐에 넣고 consumer가 `job-processor`를 돌리는 형태.
  Workflows와 역할 분담: Queues는 디스패치·버퍼링, Workflows는 다단계 내구성 실행.
  출처: https://developers.cloudflare.com/changelog/product/queues/
- **R2 (Cloudinary 대체)**: 무료 티어(월) 스토리지 **10 GB-month**, Class A 100만 회, Class B 1,000만 회, egress $0.
  신규 업로드부터 R2로 받고, 기존 Cloudinary 파일은 이관 스크립트로 옮긴 뒤 URL 교체.
  잠긴 메모의 첨부는 R2 공개 URL로 두면 안 되고 Worker 경유 인증 서빙을 유지해야 한다.
  출처: https://developers.cloudflare.com/r2/
- **Cloudflare OS Gatekeepers 패턴** (`cloudflare/cloudflare-os`, ★11,596 · Apache-2.0 · push 2026-10-28):
  capability 기반 보안 + **지연 승인**(위험한 동작을 동기 차단하지 않고 시뮬레이션 결과를 주고 나중에 일괄 승인) +
  **관찰 장부**(읽은 자원을 기록해 생성물 공유 시 재검사). **통째 설치 금지 — 설계 패턴만.**
  early access, rough edges라고 README가 명시. 출처: https://github.com/cloudflare/cloudflare-os
- **FastMCP 설계 패턴** (`PrefectHQ/fastmcp`, ★28,219 · Apache-2.0 · push 2026-10-28 · v4.0.2, 구 `jlowin/fastmcp`에서 이전):
  Python이라 Workers에 직접 못 쓰지만, MCP 서버 설계 체크리스트(도구 스키마 자동 생성·OAuth 2.1 미들웨어·`mount` 합성·
  장시간 작업 태스크 확장)가 1-1의 설계 메모가 된다. 출처: https://github.com/PrefectHQ/fastmcp
- **Google ADK-TS** (★1,455 · Apache-2.0 · push 2026-10-28): `SequentialAgent`·`ParallelAgent`·`LoopAgent`가
  Plan & Execute의 다음 단계 설계도와 같다. Node 전용이라 Workers 실행 불가 — 패턴만.
  출처: https://github.com/google/adk-js
- **VoltAgent** (★10,883 · MIT · push 2026-10-15): 트레이스 콘솔 UI 패턴 + eval 스위트 구조를 대시보드 추적 페이지 설계에 반영.
  프레임워크로 갈아타지 않는다. 출처: https://github.com/VoltAgent/voltagent
- **A2A 프로토콜** (`a2a-js` ★647 · Apache-2.0 · push 2026-10-27): 비서 4명 간 핸드오프 메시지 스키마만 차용
  (`task_id`·`delegated_to`·`artifact_ref`). 프로토콜 통째 구현은 과함. 출처: https://github.com/a2aproject/a2a-js
- **Cognee** (★32,830 · Apache-2.0 · push 2026-10-27): "벡터로 후보를 찾고 그래프로 순회해 맥락을 넓히는" 검색 패턴만.
  `remember`·`recall`·`improve`·`forget` 4연산 API 형태를 memory v2 인터페이스 정리와 대조. 설치 금지.
  출처: https://github.com/topoteretes/cognee
- **HippoRAG** (★4,081 · MIT · push 2026-10-06): 엔티티 그래프에서 쿼리 엔티티를 시드로 Personalized PageRank(감쇠 0.85, 2-hop)를
  돌려 후보 메모를 넓히는 실험. 설치 금지, 검색 알고리즘 패턴만. 출처: https://github.com/OSU-NLP-Group/HippoRAG
- **smolagents** (★30,105 · Apache-2.0 · push 2026-10-22): "계획 = 실행 가능한 코드" 대안 설계 — Plan & Execute의 계획 표현을
  "단계 목록"에서 "단계 + 데이터 흐름"으로 정리하는 설계 메모만 남긴다. 실제 코드 실행은 샌드박스 결정 이후에나 검토.
  출처: https://github.com/huggingface/smolagents
- **OpenAI Realtime API** (gpt-realtime-2.1 / GPT-Live 1): 오디오 입력 → 오디오 출력 한 모델, 네이티브 비동기 함수 호출 + 원격 MCP.
  가격(2026-10-09 재확인, 2차 출처): 대화 분당 약 $0.05~0.11 (캐시 활용 시). **구 `gpt-realtime`(1.x)은 2027-01-20 종료 예정.**
  먼저 무료·카드 조건을 확인한다 (OpenAI API는 카드 등록이 사실상 필수 — 사용자 원칙상 사전 결정 사항).
  카드 없이 쓸 수 없으면 POC도 보류. 한국어 지원 여부는 미확인 — POC 전 OpenAI 문서에서 한국어 음성 품질을 확인할 것.
- **Giskard** (★5,931 · Apache-2.0 · pushed 2026-10-28): LLM 보안·품질 스캔 (인젝션·환각·PII 유출).
  garak을 먼저 돌려보고 겹치는 부분을 확인한 뒤에 판단한다. 출처: https://github.com/Giskard-AI/giskard-oss
- **Presidio** (★11,547 · MIT 표기 · pushed 2026-10-27, `microsoft/presidio`→`data-privacy-stack/presidio` 이관):
  PII 탐지·마스킹 설계 대조용. 한국 PII(주민등록번호·카드번호·전화번호·계좌번호)는 기본 recognizer가 커버하지 못하므로
  **커스텀 recognizer 필수**. 서버 도입 금지 — 패턴만. 출처: https://github.com/data-privacy-stack/presidio
- **osv-scanner** (★11,296 · Apache-2.0 · pushed 2026-10-28): 의존성 취약점 스캔 CI 게이트.
  Semgrep이 코드 패턴을 본다면 osv-scanner는 **의존성 자체의 알려진 취약점**을 본다 — 겹치지 않는다.
  출처: https://github.com/google/osv-scanner
- **LlamaFirewall / PromptGuard 2 패턴** (Meta, 2025-04-29): 에이전트용 가드레일 3종.
  코드베이스는 `meta-llama/PurpleLlama` 내 `LlamaFirewall` 디렉토리, 라이선스 **Llama 3.2 Community License (커스텀)** —
  **코드 복사 금지, 패턴만.** 3개 검사 지점(입력·추론·출력) 문서화 + PromptGuard 2 분류 체계를 garak 평가셋 분류에 대조.
- **FIDES 패턴** (MS Agent Framework 미들웨어, 2026): 정보 흐름 제어 — 무결성·기밀성 라벨 전파.
  `microsoft/agent-framework` ★14,347 · MIT · pushed 2026-10-28 (단, FIDES 미들웨어 자체의 라이선스는 미확인).
  1-5 CaMeL의 출처 라벨에 기밀성 축(`locked | personal | public`)을 추가하는 설계로 차용. 프레임워크 도입 금지.
- **AgentDojo** (★960 · MIT · pushed 2026-06-02): 인젝션 방어 벤치마크 — "방어가 된 상태에서 일을 끝내는지"를 재는 기준.
  벤치마크를 그대로 돌리지 않고 태스크 설계(초기 상태·숨은 지시·기대 최종 상태·공격 성공 판정)만 promptfoo 평가셋 설계에 참고.
  출처: https://github.com/ethz-spylab/agentdojo
  (NeurIPS 논문에는 `ethzspylab/agentdojo`로 표기됨 — org명 표기 불일치, 적용 전 직접 확인)
- **Spotlighting / Task Shield 패턴**: 외부 콘텐츠를 구분자·인코딩·마크업으로 표시해 모델이 지시와 데이터를 구분하게 하는 입력 변환 기법 +
  "이 도구 호출이 원래 사용자가 시킨 일인가"를 검사하는 규칙을 승인 게이트에 추가. CaMeL보다 가벼운 방어층.
- **snyk/agent-scan** (구 mcp-scan, ★3,176 · Apache-2.0 · pushed 2026-10-27): MCP 서버·도구 중독 스캔.
  MCP 도입 시에만 CI에서 돌린다. 출처: https://github.com/snyk/agent-scan
- **Cloudflare Image Transformations POC**: on-demand 리사이즈·AVIF, **월 5,000 unique transformation 무료**, 초과분 $0.50/1,000회.
  MyHub는 workers.dev 도메인이라 `/cdn-cgi/image/` URL 형식을 쓸 수 없고, Worker의 `fetch(url, { cf: { image: {...} } })` 옵션을 쓰는 경로가 된다.
  아바타 1개에 대해 변환 동작·지연·무료분 집계를 스테이징에서 실측한 뒤 판단한다. **Cloudflare Images 스토리지 유료 플랜($5/월)은 사용하지 않는다.**
- **esbuild 코드 스플리팅 (public JS만)**: CodeMirror를 "스튜디오 탭을 열 때" 동적 import로 바꾸고,
  memo-bundle의 14개 모듈 중 무거운 모듈을 지연 로딩. **Worker 서버 번들에는 적용하지 말 것**
  (deploy_full.py 경로에서 wrangler partial bundling 미검증). `agent.html` 인라인 스크립트 77,914자를 별도 `agent.js`로 분리하는 것도 함께 검토.
- **axe-core CI 접근성 게이트** (★7,719 · MPL-2.0 · 2026-10-26): Playwright E2E에 a11y 검사 추가.
  로그인 필수 앱이라 공개 페이지(랜딩·로그인)부터 시작하고, 인증 후 페이지는 테스트용 세션으로 진입해 검사한다.
  처음에는 warning만 내고, 규칙이 안정된 뒤 게이트로 승격한다.
  참고: `@axe-core/playwright` 패키지의 GitHub 저장소는 API 404로 **미확인** — npm 패키지명으로 설치 가능 여부는 별도 확인 필요.
- **TanStack Query core POC** (★50,491 · MIT · 2026-10-28): 메모 목록 조회 1곳에 붙여 stale-while-revalidate 동작을 측정한다.
  캐시된 API 응답이 잠긴 메모 내용을 포함하지 않게, 쿼리 키·캐시 범위를 잠금 경계와 함께 설계한다 (캐시는 메모리 내만, 영속화 금지).
- **PWA manifest 고도화**: `id`, `shortcuts` 2~3개(새 메모·오늘 일정·할 일), `display_override`,
  maskable 아이콘, `screenshots` 추가. `file_handlers`·`share_target`·`protocol_handlers`는 iOS 미지원 + 단일 사용자 앱이라 당장은 넣지 않는다.
- **data.go.kr 특일정보 공휴일 API**: 한국천문연구원 "특일 정보" Open API. 무료, data.go.kr 회원가입 후 활용 신청 → 인증키 발급.
  인증키 유효기간이 있어 만료 시 재발급 필요 (블로그 기준 "~2년" — **공식 확인 필요**). 일일 호출 한도는 **미확인**.
  연초(또는 연 2회) cron으로 해당 연도 공휴일을 조회해 D1 `holidays` 테이블에 저장.
  주의: **근로자의날(5/1)은 특일정보에 없어** 별도 병합이 필요하다.
- **Vito STT A/B** (리턴제로): 한국어 STT 정확도 대안. 공식 사이트 기준 "**10시간까지 무료 제공**".
  과거 "월 1,000시간 무료"(2022년 베타), "월 100시간 무료"는 구 정보 — 현재 공식 표기는 10시간 무료로 축소됨.
  10시간 이후 종량제 단가는 **공식 사이트에서 확인 불가 — 가입 시 확인 필요**. **교체하지 않고 A/B 비교부터.**
  한국어 음성 샘플 10건을 Whisper(현행)와 Vito 무료 10시간으로 각각 전사해 비교한다. 무료 소진 후 자동 과금되지 않도록 사용량 가드를 둘 것.
- **KURE-Sparse / KURE-Reranker** (2단계): KURE-v3 dense가 1차 검색을 맡고, Sparse는 FTS5/BM25의 학습형 대체,
  Reranker는 최종 정렬을 맡는 3단 구조. 같은 KURE API 키·같은 한도(일 400만 토큰)를 공유한다.
  dense만으로 부족한 케이스가 확인되면 붙인다.
- **Kiwi / khaiii / KSS 패턴**: Kiwi (`bab2min/Kiwi`, ★802 · Apache-2.0 · 업데이트 2026-10-27),
  khaiii (`kakao/khaiii`, ★1,455 · Apache-2.0 · 푸시 2026-10-10), KSS (`hyunwoongko/kss`, ★467 · BSD-3-Clause · 푸시 2025-11-13).
  셋 다 C++/Python이라 **Workers에서 실행 불가** — 분석 아이디어만 참고 (조사 분리 규칙·미등록 명사 탐지·문장 분리 규칙을
  TS 경량 토크나이저·메모 청킹에 참고). Kiwi 모델 패키지(`kiwipiepy-model`)는 PyPI 분류 LGPLv3 이력 — 코드·모델 복사 전 LICENSE 직접 확인 필수.
- **Workers Builds GA (검토만)**: GitHub 연동 CI/CD. GA 개선: 디스크 8GB → **20GB**, Paid CPU 2 vCPU → **4 vCPU**.
  배포 명령을 `npx wrangler versions upload`로 바꾸면 자동 배포 없이 버전으로만 저장할 수 있다 (문서 명시) —
  MyHub의 버전-승격 흐름과 원리적으로 양립한다. 단, 기본값(`wrangler deploy`)은 MyHub의 안전장치(승격 전 검증·시크릿 가드)를 전부 우회한다.
  **자동 배포는 켜지 않는다.** preview 빌드용으로만 연결하거나, `deploy_full.py`의 시크릿 가드를 우회하지 않는지 먼저 증명해야 한다.
  출처: https://developers.cloudflare.com/workers/ci-cd/builds/
- **Cron Triggers Local Explorer 테스트 (2026-10-17)**: 로컬 개발 서버의 Local Explorer(`/cdn-cgi/local/explorer`)에서
  `scheduled()` 핸들러에 단발성 Cron Trigger 호출을 보낼 수 있게 됐다. 03:00 통합 같은 하루 1회 핸들러를 로컬에서 반복 테스트할 수 있다.
  운영 코드 변경 없음. 출처: https://developers.cloudflare.com/changelog/product/workers/ (2026-10-17 항목)

---

## 3순위 — 지켜보기 / 패턴만 (한 줄씩)

- **Weave** (★1,143 · Apache-2.0 · push 2026-10-26): W&B 트레이싱·평가. Opik을 먼저 보고, 맞지 않을 때만 검토.
- **Vapi / Retell AI**: 호스팅 음성 에이전트 플랫폼. 전화 채널 자체가 불필요해 POC 가치 낮음.
  무료 크레딧은 출처마다 $5와 $10이 엇갈림 — **불일치, 미확인**. 전화 채널이 필요해지면 무료 크레딧으로 Vapi부터 POC하고, 카드가 필요해지면 중단.
- **elizaOS** (★19,681 · MIT · push 2026-10-28): 플러그인(스킬 패키지) 설계만 참고. 통째 도입 금지.
- **Memobase** (★2,939 · Apache-2.0 · push **2026-01-11**): 9개월 이상 업데이트 없음 — 사실상 방치 경계. 참고만.
  (참고: `MemTensor/memobase`는 존재하지 않음 — 404 확인. 올바른 저장소는 `memodb-io/memobase`.)
- **inngest/agent-kit** (★956 · Apache-2.0 · push **2026-04-29**): 6개월 업데이트 없음 — staleness 주의. 패턴만.
- **Dia** (★19,408 · Apache-2.0 · push **2025-11-19**): 11개월 업데이트 없음 + GPU 필요 — 방치 경계. 참고만.
- **Kokoro** (★9,727 · Apache-2.0 · push **2025-08-06**): **한국어가 없다** (확인된 8개 언어에 ko 없음).
  한국인 사용자의 비서 음성으로는 쓸 수 없다. MeloTTS(한국어 지원)를 유지. 도입 금지.
  (저장소명은 `hexgrad/kokoro`, `hexgrad/Kokoro-82M`은 HF 모델명 — GitHub 저장소는 없음, 404 확인.)
- **Zep** (★4,974 · Apache-2.0 · push 2026-10-20): Graphiti의 관리형 상위 — 이미 Graphiti로 다룸. 참고만.
- **OPAQUE** (`cloudflare/opaque-ts` ★112 · BSD-3-Clause · pushed 2026-09-13 / `serenity-kit/opaque` ★125 · MIT · pushed 2026-10-23):
  서버가 PIN을 못 보는 PAKE이나, PIN 6자리의 약점은 길이지 서버 가시성이 아니라서 패스키가 먼저. 지켜보기.
- **Infisical / Doppler**: 시크릿 관리 SaaS·셀프호스팅. 시크릿이 두 곳에 생기면 동기화·로테이션 복잡성만 는다.
  Infisical 셀프호스팅은 통째 설치 금지. Infisical 라이선스는 **복합** (LICENSE 직접 확인: ee/ 외 MIT Expat, ee/ 별도 상용).
- **detect-secrets** (★4,659 · Apache-2.0 · pushed 2026-04-02): gitleaks와 중복, 활동 둔화. gitleaks 하나만 쓴다.
- **TaskTracker / InjecAgent**: 연구 코드, 소규모·방치. InjecAgent는 마지막 push 2024-07-02 — **2년 이상 방치, 도입 금지**.
- **libsodium / @noble/ciphers**: WebCrypto AES-GCM 유지 — 교체 이유 없음. 새로 필요한 암호학이 생기면(예: X25519, Ed25519) noble을 먼저 본다.
- **Yjs / Automerge**: 협업용 CRDT — 단일 사용자라 과함. 오프라인 outbox의 충돌 해소에 아이디어만 참고.
- **rolldown / Vite**: esbuild를 직접 쓰고 이미 빠르다. 번들러 교체는 빌드 파이프라인·배포 스크립트 전체를 건드리는 작업이라 실익 낮음.
- **Speculation Rules**: Chromium 전용, iOS 무용 + 로그인 앱이라 prerender 효용 낮음. 후순위.
- **D1 읽기 복제** (퍼블릭 베타, 2025-04-10~): 단일 사용자(한국)라 읽기 트래픽이 적고, 북마크 plumbing 복잡도 + 래그 결함원. 후순위.
- **Durable Objects 2026 변경분**: DO가 활성 outbound 연결이 있는 동안 **최대 15분까지 살아남는다** (기존 70~140초).
  SQLite 스토리지 과금 시작 2026-01-07. agents SDK POC 시 전제 조건으로만 기록.
- **Kanana / HyperCLOVA X**: Apache 2.0이나 **호스팅된 무료 API가 없다** — 지켜보기만.
  Kanana-2 "GAIA 85%" 주장은 3차 출처 기준이라 **미검증**. HyperCLOVA X API는 CLOVA Studio(NCP) 경유 **유료**.
- **카카오 로컬 API**: 키워드 장소 검색 **일 100,000건** 무료. 캘리 약속 장소 검색에 쓸 수 있으나, 지금 캘리의 핵심은 일정 생성·조회라 후순위.
- **Declarative Web Push + Badging API**: Safari 18.4+ 지원. MyHub 푸시는 알림 중심이라 현재 방식으로 충분.
  Badging API만 작은 POC로 (`navigator.setAppBadge(n)` 호출이 설치 PWA에서 동작하는지) 확인하고, 되면 일정 알림 수에 붙인다.
- **vite-plugin-pwa** (★4,306 · MIT · 2026-10-09): Vite 전제 — Vite 이전 시에만. 보류.
- **Dexie** (★14,667 · Apache-2.0 · 2026-10-27): idb 고수준 래퍼. idb로 부족할 때만.

---

## 이전 조사 후속 업데이트 (새 후보가 아니라 전제 변경)

- **Workers 플랫폼 한도 상향 (2026-10-02)** — **코디네이터 교차 검증 완료**: 공식 체인지로그(2026-09-04) + Limits 문서 직접 확인.
  Worker 크기: **압축 기준 10MB 상한 → 비압축 64MiB 상한** (Free·Paid 동일). 스타트업 시간: 400ms → **1초**.
  WebSocket 메시지: 1MiB → **32MiB**. 정적 에셋: Worker 버전당 파일 수 Free 20,000개 / Paid 100,000개, 파일당 25MiB.
  **주의 — subrequests 한도 불일치**: 공식 블로그는 "요청당 subrequest 최대 100만 개(기존 1,000개)"라고 쓰나,
  현행 공식 Limits 문서는 **Free 50개/요청·Paid 10,000개/요청**이다. Limits 문서를 정본으로 보고, 블로그의 100만 개 수치는 미확인으로 둔다.
  → 감사 이슈 #1(번들 4.2MB)의 전제가 바뀐다. 10MB 압축 상한 대비 압박이 사라져, 번들 축소는
  "배포가 막힐 수 있는 긴급 과제"가 아니라 "cold start 개선 과제"로 격하된다. 단, **한도가 올랐지 cold start 비용이 사라진 건 아니다** —
  ASSETS 이관(HEAD a014850 완료)의 효과는 여전히 유효하다. 번들 크기 예산(예: 2MB 목표)은 유지한다.
  출처: https://blog.cloudflare.com/enterprise-for-all-update/ · https://developers.cloudflare.com/workers/platform/limits/
- **AI Search GA (2026-10-01) — 과금 시작일 확정**: 사용량 기반 과금은 **2026-11-01 시작**.
  가격(2차 정리): 인제스천 $0.75/1M 토큰, 이미지 처리 +$0.50/1M 토큰, 스토리지 $2.00/GB-month,
  시맨틱 쿼리 $0.75/1,000회, 전문 쿼리 $0.10/1,000회.
  무료 할당(월): 인제스천 500만 토큰, 스토리지 10GB, 시맨틱·전문 쿼리 각 1,000회.
  하이브리드 검색이 신규 인스턴스의 기본값이 됐고(2026-04-16 relevance boosting 포함),
  OCR은 전 계정에 제공, 파일 한도는 10MiB로 상향됐다.
  → 이전 결론("측정 후 판단")은 유지하되, **무료 할당을 넘기면 바로 과금**되므로 도입 전 월 사용량 추정이 필수가 됐다.
  잠긴 메모 제외 경계는 여전히 미검증.
- **Cloudflare Web Search API — 가격 확인**: AI Gateway 크레딧 기준 **$0.25/1,000회 검색** (2차 정리).
  문서는 "open beta" 표기(2026-10-02 업데이트). 이전 조사에서 "Binding 402·REST 403으로 측정 불가"였던 것과 달리,
  이제 REST 경로가 열려 있는 것으로 보이므로 날짜 정확도 실측을 다시 시도해 볼 수 있다.
  출처: https://developers.cloudflare.com/changelog/product-group/ai/
- **Workers AI 모델 폐기 (2026-05-30)**: K2.5 alias 포함 구형 모델 폐기 완료.
  MyHub가 Workers AI로 참조하는 모델이 폐기 목록에 있는지 코드에서 한 번 확인할 것 (이번 조사는 코드 대조를 하지 않음 — 미확인).
- **관측성 과금 (2026-12-01 예정)**: 이전 문서에 "2026-12-01부터 통합 관측성 과금"으로 기록된 바 있다.
  이번 조사에서 변경 사항은 확인하지 못함 — 미확인.
- **D1 무료 티어** (2차 출처 기준, 미확인): 일 500만 행 읽기·10만 행 쓰기. 행 스캔 기준으로 셈 — 인덱스 없는 SELECT가 일일 한도를 갉아먹는다.
  저장 용량은 출처 간 불일치(500MB vs 5GB)가 있어 **미확인**으로 둔다.
- **기타 2026-10 Cloudflare 소식** (코디네이터 교차 검증 중 확인 — 지켜보기): Birthday Week(10-05)에
  post-quantum WebCrypto(ML-KEM·ML-DSA) 옵트인 지원 추가, 10-09 Deno 팀 Cloudflare 합류(셀프호스팅 workerd 지원 방향),
  10-14 온디맨드 프로파일링, 10-15 Gateway-to-Workers 통합 퍼블릭 베타(Zero Trust Gateway라 MyHub과 무관).
  Clef·Clef-flash는 10-01 Workers AI에 정식 탑재, Clairic은 10-19 프리뷰 진입 (이전 조사에서 다룬 항목의 후속).

---

## 적용 금지 / 부적합 (이번 조사에서 확인된 것 — 통합)

| 후보 | 사유 |
|---|---|
| OpenAI AgentKit (Agent Builder + Evals) | **2026-11-30 종료 예정** (OpenAI 공식 발표 2026-06-03 업데이트). 신규 도입 금지 |
| Claude Agent SDK (TS) 코드 복사·도입 | LICENSE.md가 오픈소스 라이선스가 아니라 **"© Anthropic PBC, Commercial Terms of Service 적용"** (직접 확인). 코드 복사 금지. Workers 실행 불가(네이티브 바이너리 번들). Python 형제는 MIT이나 TS는 상용 약관이라 라이선스가 다름 |
| TruffleHog 코드 복사·도구 내장 | **AGPL-3.0** (API 실측 ★28,741) — gitleaks(MIT)로 대체 |
| HashiCorp Vault 도입 | API상 NOASSERTION, BSL-1.1로 알려진 상용 라이선스(직접 미확인) + 셀프호스팅 부담 — Cloudflare Secrets 유지 |
| PurpleLlama / LlamaFirewall 코드 복사 | **Llama 3.2 Community License (커스텀)** — 패턴만 |
| Infisical ee/ 디렉토리 사용 | 별도 상용 라이선스 (복합 라이선스, LICENSE 직접 확인) — 사용 금지 |
| Infisical / Doppler 셀프호스팅 | 통째 설치 금지 — 클라우드 무료 범위 미확인이라 보류 |
| Naver Developers(구) 경로로 네이버 API 키 발급 | 2027-06-30 지원 종료·기존 키 차단 — **NCP API HUB로 발급해야 함** |
| Papago NMT API | **무료 종료 (2024-02-29)**, NCP 유료 이관 — 무료·무카드 원칙 위반 |
| Clova Voice / Clova Speech (NCP) | 종량제, 무료 티어 없음. **Clova Voice는 무호출 시에도 기본료 발생** (공식 문서 명시). NCP 결제 필요 → 카드 원칙 위반 |
| Clova Dubbing 무료 / 클로바노트 무료 | 웹·앱 서비스로 **API가 없음**. MyHub 음성 경로에 붙일 수 없음 |
| Upstage Solar API | 가입 $10 크레딧(3개월 유효)뿐인 trial-only. 무료 티어 데이터가 서비스 개선·AI 연구에 사용될 수 있음 (약관 22조 6항) — 메모 전송 부적합 |
| Kokoro TTS | Apache 2.0이나 **한국어 네이티브 보이스 없음, espeak-ng G2P 폴백만**. MeloTTS 유지 |
| hangul-search-js / daon | 5년 방치 / 라이선스 미표기(NOASSERTION) + 2018 방치 — 참고 금지 |
| Squoosh 코드·CLI 도입 | 저장소 404(아카이브/이관됨) + Google 적극 개발 중단 + CLI 2023년 은퇴 — 2년+ 방치 기준. sharp로 간다 |
| thumbhash / blurhash 코드 복사·도입 | 최근 커밋 2024-05-26 / 2024-07-08 (2년 3~5개월 전) — 2년 이상 방치 기준. 대안은 sharp로 20px 블러 썸네일을 빌드타임에 만들어 인라인하는 패턴 |
| localForage 도입 | 최근 커밋 2024-07-30 (2년 3개월 전) — 2년 이상 방치 기준. idb로 간다 |
| InjecAgent 도입 | 마지막 push 2024-07-02 — 2년 이상 방치, 참고만 |
| Memobase·inngest/agent-kit·Dia 도입 | 6~11개월 stale — 참고만 |
| 에이전트 프레임워크로 갈아타기 (ADK·VoltAgent·elizaOS·smolagents·AgentKit 전체 이전) | 사실상 재작성 — 패턴만 |
| 통째 설치류 (Hindsight/Cognee Docker + PostgreSQL, Zep 자가 호스팅, Cloudflare OS 전체, Kiwi/khaiii/Kanana/HCX 셀프호스팅) | 셀프호스팅 부담 — 사용자 지시로 금지. 패턴만 |
| MCP 참조 서버(`modelcontextprotocol/servers`) 코드 복사 | API상 라이선스 NOASSERTION (서버별 라이선스 혼재) — 개별 확인 전 복사 금지 |
| MCP sampling·roots 신규 구현 | 2026-07-28 스펙에서 폐지 예고 (2027-07경 중단 예상) — MRTR로 대체 |
| Kimi K2.5 신규 사용 | **2026-05-30 폐기·K2.6으로 자동 alias(가격 인상)** — 신규 사용 금지, K2.6/K2.7로 갈 것 |
| 구형 Workers AI 모델 (llama-3/3.1, mistral-7b, gemma-7b 등) | 2026-05-30 폐기 완료 — 참조 시 교체 필요 |
| Containers / Sandbox를 샌드박스로 즉시 도입 | 유료($5/월 Paid 전제 + vCPU 과금) — 기존 보류 결론 유지, 카드·과금 동의 필요 시 사용자 결정 사항 |
| Browser Rendering / Browser Run 도입 | 유료 — 필요성 없음 |
| Deepgram Nova-3를 한국어 STT로 | 10개 지원 언어에 한국어 없음 — 부적합 |
| Workers Builds 자동 배포(`wrangler deploy` 기본값) | 시크릿 가드·승격 검증 우회 — `deploy_full.py` 절차를 깨뜨릴 수 있어 자동 배포 금지 |
| AI Search 무검증 도입 | 2026-11-01 과금 시작 + 무료 할당 초과 시 즉시 과금 + 잠긴 메모 제외 미검증 — 측정·추정 전 도입 금지 |
| D1 읽기 복제 즉시 적용 | 단일 사용자에 효과 미미 + 북마크 plumbing 복잡도 + 래그 결함원 — 후순위 |
| R2 Data Catalog / R2 SQL | 분석용 기능, MyHub 파일 저장과 무관 |
| Gateway-to-Workers 통합 | **Zero Trust Gateway**(네트워크 게이트웨이)이지 AI Gateway가 아니다. 사용자는 Zero Trust의 초과 과금 동의를 거부한 바 있어, MyHub과 무관 — 적용 안 함 |
| Vapi/Retell 종량 상시 사용 | 무료 크레딧 소진 후 과금, 카드·유료 전제 — POC 이후 단계에서 사전 결정 필요 |
| gpt-realtime 1.x 계열 사용 | 2027-01-20 종료 예정 — 쓸 거면 2.x 계열로만 |
| partytown 도입 | MyHub의 서드파티 스크립트(CodeMirror·marked·highlight.js·DOMPurify·lucide)는 DOM이 필요해 워커로 이전 불가 — 이전할 대상 자체가 없음 |
| web-push 라이브러리 도입 | Node.js 전용이라 Workers에서 직접 실행 불가. MyHub는 VAPID 서명을 WebCrypto로 이미 구현済み |
| Cloudflare Images 스토리지 ($5/월) | 변환 무료분(5,000회/월)은 사용 가능하나, 이미지 저장 유료 플랜은 카드·과금 전제라 사용자 원칙상 사용 금지 |
| Vite 이전 없는 vite-plugin-pwa 단독 도입 | Vite 전제 플러그인 — 빌드 도구 이전 없이 도입 불가 |
| Background Sync / Periodic Background Sync 단독 의존 설계 | **Safari·iOS·Firefox 전부 미지원** (2026-06 기준). 이 API에만 기대는 오프라인 설계는 iPhone에서 동작하지 않는다 |
| OPAQUE 당장 도입 | PIN 6자리의 약점은 길이지 서버 가시성이 아님 — 패스키가 먼저 |
| MCP 스캔 도구 선행 도입 | MCP 서버가 아직 없음 — 도입 시에만 |
| Kanana / HyperCLOVA X 호스팅 | 무료 호스팅 API 없음 — 지켜보기만 |
| konlpy / soynlp | 이전 조사에서 제외됨 (GPL/LGPL + Python, Workers 불가) — 중복 언급만 |
| KoBEST / KMMLU | 공식 저장소 404 — 이전 조사에서 제외됨 |

---

## 조사 중 발견한 결함 (본 조사 범위 밖이나 기록 — 미수정)

- **`backup.html:10`의 `lucide@latest` 미고정 CDN**: `https://unpkg.com/lucide@latest/dist/umd/lucide.min.js`를
  버전 고정 없이 + SRI 없이 로딩하고 있다. `@latest`는 배포 시점에 내용이 바뀔 수 있어 재현성·공급망 리스크가 있다.
  `lucide@<고정버전>`으로 고정하거나 npm에서 받아 번들에 넣는 것이 맞다.
  (2-11의 CodeMirror CDN→npm 전환과 함께 정리하는 것이 자연스럽다.)
- **CDN 스크립트 전반에 SRI 없음**: cdnjs(CodeMirror·marked·highlight.js)·jsdelivr(DOMPurify)·unpkg(lucide)
  모두 SRI 해시가 없다. esbuild 코드 스플리팅(2-11)의 npm 전환 시 함께 해소되는 항목이다.

## OWASP 기준 (도구 아니지만 감사 체크리스트로 사용 — 트랙 4)

- **OWASP Top 10 for LLM Applications 2025 (v2.0)**: LLM01 프롬프트 인젝션, LLM02 민감정보 유출,
  LLM03 공급망, LLM04 데이터·모델 중독, LLM05 부적절한 출력 처리, LLM06 과도한 권한,
  LLM07 시스템 프롬프트 유출(신규), LLM08 벡터·임베딩 취약점(신규), LLM09 오정보, LLM10 무제한 소비.
- **OWASP Top 10 2026년판**: 2026-09 발행. 과도한 권한(excessive agency)이 3위로 올라갔다(검색 결과 기준 — 공식 문서는 미확인).
- **OWASP Top 10 for Agentic Applications (2025-12)**: 에이전트 전용 위협 분류.
  안전하지 않은 에이전트 핸드오프, 도구 호출 체인 전반의 불충분한 인가 등을 다룬다.
  MyHub의 비서 핸드오프·FC 체인 감사에 직접 relevant하다.
- **OWASP AI Testing Guide v1 (2026)**: LLM Top 10 항목별 테스트 카테고리와 거버넌스 문서화 요구사항.
  security-audit 스킬의 체크리스트와 대조할 만하다.
- **참고 연구(지켜보기)**: Meta **Agents Rule of Two**(2025-10) — 에이전트는
  (A) 신뢰할 수 없는 입력 처리, (B) 민감 데이터 접근, (C) 외부 상태 변경 중 최대 2개만 가져야 한다는 아키텍처 규칙.
  Anthropic **Constitutional Classifiers**, Meta **SecAlign**(arXiv 2025-07),
  **Agent-Sentry**(arXiv 2026-03, 실행 provenance로 이상 차단, 공격 90%+ 차단·유틸리티 98% 유지 보고) — 모두 연구 단계라 패턴 참고로만 기록한다.

## 미확인 항목 (통합 — 후속 실측 필요)

- Workflows 스텝·스토리지 과금 시작일 (공식 가격표 문구와 2026-08 실제 청구 사례가 엇갈림)
- Workers 온디맨드 프로파일링 가격 (무료 포함 여부)
- K2.6·GLM-4.7-flash 등 단가제 모델에 무료 뉴런 10,000/일이 적용되는지 여부
- Vectorize 무료 티어 범위(저장 벡터 수·월 쿼리 수) — 가격표로 존재는 확인, 실제 인덱스 생성 시 무료 계정 허용 여부는 사용 전 확인 필요
- D1 무료 티어 저장 용량 (출처 간 500MB vs 5GB 불일치)
- Workers AI 폐기 모델이 MyHub 코드에서 참조되는지 여부 (코드 대조 미수행)
- K2.6·GLM-4.7-flash·bge-m3의 한국어 품질 (스테이징 평가 필요)
- R2 가격의 공식 가격표 직접 대조 (이번 조사는 2026-10-01 기준 2차 정리 인용)
- MCP TS SDK의 현 버전 번호 (2차 출처의 v1.30.0 계열 인용 — 직접 확인하지 않음)
- MCP TS SDK·FastMCP의 테스트·CI 존재 여부 (루트 미조회)
- MCP 2026-07-28 스펙의 dual-era(구·신 클라이언트 동시 지원) 동작 여부 (2차 출처만 있음)
- Hindsight LongMemEval 94.6%의 독립 재현 여부 (자사 주장)
- Chatterbox 23+ 언어에 한국어 포함 여부·한국어 품질
- OpenAI Realtime API의 한국어 음성 품질·공식 문서 URL (이번 조사에서 직접 열지 않음)
- Vapi 무료 크레딧 $5 vs $10 불일치
- evalite·inngest/agent-kit·Memobase·Dia의 방치 여부 최종 판정 (6~11개월 무업데이트는 확인됐으나, 유지보수 중단 선언이 있는지는 미확인)
- Weave·Vapi·Retell의 무료 범위·카드 조건 (공식 가격표 직접 확인하지 않음)
- VoltAgent 콘솔이 별도 서버를 요구하는지 여부
- Turnstile 가격 공식 문서 직접 확인 (이번 조사는 보도 종합 기준)
- FIDES 미들웨어 자체의 저장소 위치·라이선스 (프레임워크 본체는 MIT 실측)
- Presidio LICENSE 파일 직접 확인 (저장소 표기 기준 MIT)
- NCP API HUB 가입 시 카드 등록 필요 여부 (검색 API 무료枠만 쓸 때) — **코디네이터 교차 검증에서 카드 등록 필요 보고 확인, 가입 시 직접 확인할 것**
- 네이버 DataLab·쇼핑인사이트 무료 한도: 월 30,000건 vs 월 최대 50,000건(한시적 무료) — 콘솔에서 확인
- Vito STT 10시간 이후 종량제 단가 — 가입·요금표 확인 필요
- data.go.kr 특일정보 인증키 유효기간·일일 호출 한도 — 가입 시 확인
- 카카오 Daum 웹문서 검색 `sort=recency` 파라미터 동작 — 공식 문서 재확인 후 적용
- 언론사 직접 RSS의 Worker egress 허용 여부 — **스테이징 Worker에서 직접 fetch 실측이 1순위 실험**
- YNA RSS 저작권 표기("AI 학습 및 활용 금지")의 실무 범위
- KURE API 무료 한도의 지속성 — 정책 변경 모니터링 (bge-m3 폴백 유지)
- Kiwi `kiwipiepy-model` 패키지의 라이선스 — PyPI 분류 LGPLv3 이력 vs 코어 Apache-2.0, 사용 전 직접 확인
- Cloudflare Image Transformations의 MyHub 경로 실측 (workers.dev에서 Worker `fetch(cf:{image})` 옵션이 ASSETS 원본에 동작하는지)
- Speed Brain의 MyHub 실효성 (공식 문서상 "Worker를 호출하지 않는 페이지"만 대상 — Worker 서빙 HTML인 MyHub에 동작하는지 미확인)
- zod/mini 교체 후 실제 번들 감소폭 (공식 수치 1.88kb gzip은 샘플 스키마 기준 — 교체 후 esbuild metafile로 재측정 필요)
- `@axe-core/playwright` 저장소 (GitHub API에서 404 — npm 패키지명으로 설치 가능 여부는 별도 확인 필요)
- idb-keyval 라이선스 (LICENSE 파일 404 — idb를 1순위로 쓰고 idb-keyval은 라이선스 확인 전까지 보류)
- Declarative Web Push 세부 동작 (Safari 18.4 지원은 확인했으나 MyHub 푸시 흐름에 붙이는 방법은 미확인)
- `navigator.storage.persist()`의 iOS 실효성 (7일 캐시 만료 회피에 도움이 되는지 미확인)

## 지금 바로 검토할 것 3가지 (코디네이터 추천)

1. **언론사 직접 RSS 실험 + 네이버 API HUB 이관 대응 (1-3·1-4)** — 뉴스 신선도는 비서의 존립 조건이다.
   RSS 실험은 스테이징 fetch 한 번이면 판정이 나고, 네이버 키 발급 경로는 사용자가 지금 당장 알아야 하는 정정이다
   (2027-06-30 차단 + NCP 카드 필요 여부 확인).
2. **한국어 시맨틱 검색 A/B (1-2)** — trigram이 키워드 계층을 맡았으니, bge-m3 vs KURE 중 승자를 가리는 평가셋 측정이 다음 단계다.
   Vectorize 무료 티어 존재는 가격표로 확인됐으니 POC 장벽은 낮다.
3. **MCP 서버 노출 (1-1)** — MyHub 도구를 표준으로 여는 작업. 읽기 도구부터, Inspector 검증, 승인 게이트·잠금 제외를 서버 단에서 강제.
   2026-07-28 스펙 기준(신규 구현은 sampling·roots 금지, MRTR로 승인 흐름 설계).

> 다음 단계 제안: 1-1·1-2·1-3·1-4 중 사용자가 고른 것부터 POC·측정한다.
> 패스키(1-5)는 RP ID 결정이 먼저고, Turnstile(1-6)은 위젯 키 발급이 필요하다.
> sharp(1-7)·zod/mini(1-8)는 의존성·리스크가 작아 1순위 중에서도 먼저 처리할 수 있다.
> Workflows(1-9)·BFCL(1-10)은 POC·설계부터, CaMeL(2-2)은 garak 실제 모델 프로브 결과가 나온 뒤에 설계한다.

## 다음 조사 주제 제안

1. **1순위 효과 측정** — MCP 노출 후 외부 클라이언트 연결 실측, 시맨틱 검색 A/B 결과, RSS 실험 결과, Workflows POC 비용·지연.
   이번 조사 1순위의 POC가 끝나면 그 결과를 모아 다음 조사에서 판정한다.
2. **Workers AI 무료 범위 실사용량 대조** — 뉴런 10,000/일·Vectorize 무료枠·D1 행 한도를 실제 운영 사용량과 대조해
   무료 티어 안에서 어디까지 갈 수 있는지 숫자로 정리한다 (이번 조사에서 미확인으로 남은 항목 다수).
3. **Opik vs TruLens 중 하나만 POC** — 이전 조사에서 미결로 남은 관측성 선택. promptfoo + D1 스팬 조합과 대조한다.
4. **Clef-flash 평가셋 구축 + 3자 측정** — 2026-10-26 조사 결론("지금 켜지 말 것")의 후속.
   한국어 평가셋으로 flash vs Clef 27B vs 시맨틱 라우터를 측정하고 임계값을 재설정한다.
5. **Deno 합류 후 workerd 셀프호스팅 방향** — 2026-10-09 Deno 팀 Cloudflare 합류 소식의 후속.
   셀프호스팅 workerd가 지원 모델이 되면 로컬 개발·스테이징에 미치는 영향을 본다 (통째 설치는 여전히 금지).
6. **Post-quantum WebCrypto (ML-KEM·ML-DSA)** — 2026-10-05 Birthday Week 옵트인 지원.
   메모 암호화(AES-GCM)와의 관계, 키 교환·서명 용도를 본다. 당장은 지켜보기.
