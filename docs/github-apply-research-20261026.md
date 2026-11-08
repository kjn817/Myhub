# GitHub·생태계 조사 — MyHub에 적용하면 좋을 것들 (2026-10-26)

> 조사만 수행한 문서. 코드 변경 없음, 커밋하지 말 것.
> 조사일: 2026-10-26 (KST). 수단: GitHub REST API(미인증, 60/hr) + GitHub MCP(인증) + 웹 검색(Cloudflare 소식만).
> 모든 ★ 수·라이선스·최근 업데이트는 2026-10-26 실측. "알려진 사실"로 쓴 항목이 아니라 API 응답 그대로다.

## 조사 범위와 제외 목록

이미 조사·적용한 것은 중복 조사하지 않았다: Suna, OpenManus, Letta, Leon, Khoj, Goose, Agent Zero,
MetaGPT, crewAI, HumanLayer, ai-memory, security-audit-skill, Octop, mem0, OpenClaw, DeepSeek Harness(지켜보기),
context-mode, agent-framework, ppt-master, n8n, Vercel AI SDK·LiteLLM·OpenAI Agents SDK·Gemini JS SDK·
LangChain.js·Instructor·jsonrepair, Clef-flash, Exa 뉴스 검색.

이번 조사 초점: (1) 뉴스 신선도 — Exa 발행일 위조 + Worker에서 Google News RSS 503,
(2) 음성, (3) Gmail·캘린더 연동, (4) eval·관측성, (5) 메모리 심화, (6) Cloudflare 생태계 2026-10 소식,
(7) PWA·푸시·AI 스튜디오·코드 위생.

## 라이선스 규칙 (사용자 지시, 전 후보 공통)

- AGPL 코드 복사 금지 → 패턴 참고만. 이번 조사에서 해당: **RSSHub (AGPL-3.0)**.
- 라이선스 미표기 코드 참고 금지 → API상 `NO-LICENSE`/`NOASSERTION`인 후보는 라이선스 직접 확인 전까지 패턴 참고만.
  해당: langfuse(복합 라이선스), cloudflare/sandbox-sdk, fish-speech, NangoHQ/integration-templates.
- ELv2(Elastic License 2.0)는 소스 공개 라이선스이나 호스팅 서비스 제공에 제한이 있어 MyHub에서는 패턴 참고만.
  해당: **Phoenix, Nango**.
- 프리뷰·pre-1.0은 패턴 참고로만, 통째 설치(셀프호스팅 부담)는 하지 않는다.
  해당: cloudflare/agents(0.24.0 pre-1.0), Langfuse/Phoenix 풀 플랫폼 자가 호스팅.

## 우선순위 요약

| 순위 | 후보 | 한 줄 | 적용 형태 |
|---|---|---|---|
| 1 | promptfoo | 라이브 eval 하네스 (프롬프트 버전·회귀 테스트) | CI에 별도 harness로 도입, Worker 코드에 안 넣음 |
| 1 | 기사 날짜 직접 검증 패턴 (newspaper3k / trafilatura / article-extractor / dateparser) | Exa 가짜 발행일을 우회하는 유일한 확실한 방법 | TS로 패턴만 포팅 (Python 라이브러리 설치 안 함) |
| 1 | Cloudflare Web Search API (2026-10-04 출시) | AI Gateway 내장 웹검색, Exa 포함 3개 파트너 | 뉴스 소스 후보로 라이브 테스트 |
| 1 | knip (+ madge, jscpd) | 미사용 코드·순환 참조·복붙 탐지 | CI 게이트로 도입 |
| 1 | Cloudflare AI Gateway 통합 (2026-08-07) | env.AI.run()에 gateway 달면 로그·캐시·재시도·과금 통합 | Workers AI 호출 경로에 gateway 옵션 추가 |
| 2 | cloudflare/agents SDK | DO 기반 상태형 에이전트 런타임 | 비서 1명으로 POC 후 판단 |
| 2 | OpenLLMetry / OpenLIT (OTEL 스팬 규약) | LLM 호출 트레이스 표준 스키마 | ai_usage·트레이스 테이블 스키마 패턴으로 차용 |
| 2 | agent-prism | 트레이스 시각화 React 컴포넌트 | 대시보드 트레이스 뷰어 UI 패턴 |
| 2 | Graphiti | 실시간 시간 지식 그래프 | 메모리 시간축·엔티티 관계 패턴 |
| 2 | memora | dedup + supersede 계보 | 우리 supersede 로직 대조 검증용 |
| 2 | Pipecat / LiveKit (agents-js) | 실시간 음성 파이프라인 | 음성 아키텍처 패턴 (서버는 파이썬이라 직접 도입 안 함) |
| 2 | vitest-plugin + miniflare (workers-sdk) | 실제 workerd 런타임에서 테스트 | Jest mock 보완용 실런타임 테스트 |
| 2 | workbox | PWA 서비스워커 캐싱 전략 | sw.js 캐싱 전략 패턴 |
| 2 | E2B | AI 스튜디오용 샌드박스 코드 실행 | 무료 티어 카드 조건 확인 후 평가 |
| 3 | DeepEval / inspect_ai / RAGAS | eval 심화 (메트릭·안전성·RAG) | promptfoo 이후 단계 |
| 3 | Langfuse / Phoenix | 풀 관측·평가 플랫폼 | 무거움 + 라이선스 주의 → 패턴만 |
| 3 | supermemory / mcp-memory-service / automem / GraphRAG | 메모리 심화 | 패턴만 |
| 3 | RSSHub 공개 인스턴스 실험 / RSS-Bridge / miniflux | RSS 인프라 패턴 + 503 우회 실험 | 패턴만, 공개 인스턴스 의존은 실험 후 판단 |
| 3 | fish-speech / Moshi / faster-whisper / Coqui TTS | 음성 심화 | 지켜보기, MeloTTS 유지 |
| 3 | Nango (ELv2) / google-api-nodejs-client | Gmail·캘린더 통합 패턴 | 패턴만 |
| 3 | sandbox-sdk (Cloudflare Sandbox) | AI 스튜디오 샌드박스 | 유료 $5/월 — 보류 유지 |
| — | bolt.new | AI 스튜디오 참고 | 이슈 8,184건, 무거움 — 참고만 |

---

## 1순위 — 지금 바로 적용할 것

### 1-1. promptfoo — 라이브 eval 하네스 (eval 갭의 정답)

- **무엇**: LLM 앱 평가·레드티밍 CLI/라이브러리. YAML로 프롬프트 버전·데이터셋·어설션(LLM-as-judge 포함)을
  정의하고 CI에서 돌린다. "Test your prompts, agents, and RAGs."
- **실측**: ★26,435 · MIT · 업데이트 2026-10-26 · 이슈 861 · 루트에 `test/` + vitest 설정 3종 + `.github` CI 존재.
  README 명시: "Promptfoo is now part of OpenAI. Promptfoo remains open source and MIT licensed."
- **왜 MyHub에 맞는지**: MyHub는 Jest 커버리지 99%이나 **라이브 종단 평가가 약하다**는 게 반복된 약점이다
  (뉴스 신선도·FC·메모리 주입이 라이브에서만 터짐). promptfoo는 실제 HTTP 엔드포인트를 대상으로 평가를 돌릴 수 있어
  "배포 후 실측"을 CI화할 수 있다. 프롬프트 버전 관리(`promptVersion: persona-v1`)와 회귀 테스트 요구와 정확히 맞는다.
- **어디에·어떻게 적용**: Worker 코드에 넣지 않는다. `tests/evals/`에 promptfoo 설정(YAML) + 평가셋을 두고,
  스테이징/운영 `/api/ai/chat`에 대해 시나리오(뉴스 신선도·메모 생성·일정 생성·잠긴 메모 거부·인젝션 거부)를
  `promptfoo eval`로 실행. 뉴스 케이스는 "오늘 뉴스" 질의 후 응답 속 날짜가 오늘/어제인지 어설션으로 검증.
  GitHub Actions나 로컬 스크립트에서 배포 후 게이트로 사용.
- **테스트·결함 체크**: 자체 테스트 디렉토리 + CI 존재. 이슈 861건은 규모 대비 정상 범위. 결함 보고에서
  평가 자체의 flakiness(LLM-as-judge 변동성)는 어설션을 결정적 규칙 위주로 설계해 피할 것.
- **금지 사유**: 없음 (MIT).

### 1-2. 기사 날짜 직접 검증 패턴 — Exa 가짜 발행일 우회의 핵심

- **무엇**: 기사 URL을 직접 fetch해 HTML에서 진짜 발행일을 읽는 패턴. 세 프로젝트가 같은 결론을 준다:
  - **newspaper3k** (`codelucas/newspaper`): ★15,181 · MIT · 2026-10-26 · 이슈 513.
    기사 본문·메타데이터 추출, `publish_date`를 `<meta property="article:published_time">`·JSON-LD 등에서 추출.
  - **trafilatura** (`adbar/trafilatura`): ★7,022 · Apache-2.0 · 2026-10-25 · 이슈 75.
    `tests/` + `.github` CI + codecov 존재. 텍스트·메타데이터(JSON 출력 `with_metadata=True`) 추출.
    README: "makes sense of the data and metadata". HuggingFace·IBM·MSR·NVIDIA 등에서 사용.
  - **article-extractor** (`extractus/article-extractor`): ★1,913 · MIT · 2026-10-24 · 이슈 0(이슈 기능 꺼짐).
    URL에서 기사 추출 전용 경량 라이브러리.
  - **dateparser** (`scrapinghub/dateparser`): ★2,860 · BSD-3-Clause · 2026-10-25 · 이슈 247.
    사람 읽는 날짜 파싱 ("26일", "October 26, 2026" 등). URL·제목 속 날짜 파싱에 사용.
  - **readability** (`mozilla/readability`): ★11,516 · Apache-2.0 · 2026-10-26 · 이슈 318.
    본문 추출 전용(날짜 없음) — 날짜 검증이 아니라 본문 확인용으로만 참고.
- **왜 MyHub에 맞는지**: 라이브 로그로 확정된 원인 1번이 "Exa가 오래된 글에 최근 날짜를 찍는다"는 것이다.
  Exa의 `publishedDate`를 믿는 한 하드 필터는 뚫린다. **유일하게 믿을 수 있는 것은 기사 페이지 자체의 날짜**다.
  이미 URL 날짜 가드(0a2301f 후속 수정안)가 같은 방향이지만, URL에 날짜가 없는 기사(대부분의 언론사)는
  HTML 메타데이터(`article:published_time`, JSON-LD `datePublished`, `<time datetime>`)로 확인해야 한다.
- **어디에·어떻게 적용**: Python 라이브러리를 설치하지 않는다. 패턴만 TS로 포팅해
  `src/services/news-sources.ts`의 Exa 결과 후처리 단계에 "날짜 검증 fetch"를 추가한다:
  상위 N개 후보 URL을 fetch(타임아웃 5초, 병렬 3개) → HTML에서 날짜 메타 3종을 파싱 → 창 밖이면 제외.
  fetch 실패 시에는 해당 항목을 제외(엄격 모드)하거나 URL 날짜 가드에만 의존 — 실패를 "신선함"으로 간주하지 않는다.
  `dateparser` 패턴(다국어·자유 형식 날짜 파싱)은 한국어 날짜("10월 26일") 파싱에 참고.
  > **2026-10-26 추기 — 커밋 7089ef9와 직접 연결**: URL 날짜 가드(`extractUrlDate`)·마커 날짜 소독·
  > RSS UA·sources 일치는 7089ef9로 이미 구현됐다. 그러나 **잔존 간극 1건이 남았다**: tail 로그 fixture 5건 중
  > bbcbreakingnews 미러 1건은 가짜 날짜가 자정이 아닌 시각(21:23:30)이고 URL에도 날짜가 없어
  > 신호만으로는 구분이 안 된다 (테스트에 KNOWN RESIDUAL GAP으로 명시됨). 이 항목을 닫는 방법이 바로
  > **페이지 직접 fetch → HTML 메타 날짜 확인**이다. 즉 이 절은 7089ef9의 다음 단계이자 잔존 간극의 정답이다.
  > 미러 도메인 차단 정책도 대안이지만, 페이지 날짜 확인이 더 근본적이다.
- **테스트·결함 체크**: trafilatura는 테스트·CI·커버리지 존재. newspaper3k는 이슈 513건으로 다소 많으나
  대부분 사용법·엣지 케이스 문의이며, 핵심 추출 로직은 10년 넘게 검증됨. article-extractor는 이슈 0건이나
  이슈 기능 자체가 꺼져 있어 결함 가시성이 낮음 — 1차 참고는 trafilatura/newspaper3k로 할 것.
- **금지 사유**: 없음 (MIT/Apache-2.0/BSD). 단, **설치하지 말고 패턴만 포팅**할 것 (Workers는 Python 실행 불가).

### 1-3. Cloudflare Web Search API — 뉴스 소스의 제3의 길 (2026-10-04 출시)

- **무엇**: Cloudflare가 AI Gateway 안에 내장한 웹검색 API. 파트너는 Ceramic.ai·Exa·Linkup.
  "fresh, verified web results"를 표방하며, Workers Binding으로 한 줄이면 에이전트에 웹검색을 붙일 수 있다.
  BYOK(자기 키) 지원, 파트너 정가 그대로(마크업 없음), AI Gateway 크레딧으로 과금.
  이전 조사(`docs/exa-news-research-20261026.md`)에서 "보류"로 분류했던 바로 그 API가 **2026-10-04에 출시**됐다.
  AI Gateway에 네이티브 Server Tools로 웹검색을 넣는 작업도 진행 중(첫 도구가 웹검색 예정).
- **실측**: 출시일 2026-10-04 (Cloudflare 발표·보도 기준). GitHub 저장소가 아니라 Cloudflare 제품이라 ★ 없음.
- **왜 MyHub에 맞는지**: 지금 뉴스 체인은 Exa 직접 호출 + RSS(503) + 키 없는 네이버·Tavily로, 믿을 소스가 없다.
  Web Search API는 (a) Exa를 거치되 Cloudflare가 결과를 한 번 더 가공·검증하는 경로이고,
  (b) 파트너가 3개라 Exa 단독 장애·메타데이터 문제를 분산할 수 있고, (c) AI Gateway 관측성(로그·지연·비용)이
  그대로 따라온다. 무엇보다 **Exa `publishedDate`를 그대로 믿지 않고 이 API의 날짜 필드가 어떤지 실측**할 수 있다.
- **어디에·어떻게 적용**: `src/services/news-sources.ts`에 소스 하나를 추가하는 게 아니라,
  먼저 **실험용 스크립트**로 라이브에서 질의 10건을 던져 반환되는 날짜 필드의 정확도를 측정한다
  (Exa와 같은 가짜 날짜를 주면 탈락, 정확하면 체인의 Exa 자리를 대체하거나 1차로 승격).
  과금은 AI Gateway 크레딧 — 무료 티어 범위 확인 후, 카드가 필요하면 중단한다 (사용자 원칙).
- **테스트·결함 체크**: 출시 3주 된 신제품이라 결함·지연 리포트가 아직 적다. "검증된" 단계가 아니라
  "출시 직후" 단계이므로, 도입이 아니라 **측정 후 판단**이 맞다. Exa가 파트너 중 하나라 Exa의 날짜 문제가
  그대로 전파될 가능성도 있어, 날짜 정확도 실측이 필수다.
- **금지 사유**: 없음. 단, 바로 체인에 넣지 말고 날짜 실측부터.

### 1-4. knip (+ madge, jscpd) — 코드 위생, 500줄 규칙의 자동화

- **무엇**:
  - **knip** (`webpro-nl/knip`): ★12,519 · ISC · 2026-10-26 · 이슈 21.
    JS/TS 프로젝트의 미사용 파일·의존성·export를 찾는 표준 도구.
  - **madge** (`pahen/madge`): ★10,177 · MIT · 2026-10-24 · 이슈 127.
    CommonJS/AMD/ES6 모듈 의존성 그래프 + 순환 참조 탐지.
  - **jscpd** (`kucherenko/jscpd`): ★6,450 · MIT · 2026-10-26 · 이슈 49.
    220+ 언어 복붙 탐지기, Rust 엔진, GitHub Action 지원.
- **왜 MyHub에 맞는지**: 코드 헌법에 파일 500줄 이하·모듈 간 직접 import 금지·복붙 금지 규칙이 있으나
  **자동 검사가 없다**. 현재 `src/modules/ai/routes.ts` 1,944줄, `src/services/ai.ts` 1,216줄 등
  규칙 위반이 누적돼 있다. knip은 미사용 export를, madge는 모듈 경계 위반(순환 참조)을,
  jscpd는 복붙을 잡아낸다 — 모두 "사람이 눈으로 보는" 단계를 자동화한다.
- **어디에·어떻게 적용**: 세 도구 모두 devDependency로만 설치해 CI 게이트(또는 `npm run lint:deadcode`)로 둔다.
  knip부터: `knip --no-progress`를 실행해 미사용 export 목록을 뽑고, 오탐을 설정으로 제외한 뒤,
  이후 PR/배포 전 검사에 포함. madge로 `src/modules/*` 간 순환 참조를 월 1회 검사.
  jscpd는 임계값(예: 50토큰 이상 중복)을 정해 리팩터링 목록을 만든다. **자동 삭제는 하지 않는다**
  (knip의 `--fix`나 jscpd의 자동 제거는 오탐 위험 — 목록만 내고 사람이 판단).
- **테스트·결함 체크**: knip 루트에는 `tests/` 디렉토리가 보이지 않았으나(패키지 구조상 `packages/knip` 하위일 가능성 —
  미확인으로 표기), 이슈가 21건으로 매우 적어 유지보수가 안정적이다. madge·jscpd는 장수 프로젝트로
  알려진 논리 오류 리포트는 없다. 단, knip의 미사용 판정은 동적 import·re-export에서 오탐이 날 수 있어
  설정으로 제외 목록을 관리해야 한다.
- **금지 사유**: 없음 (ISC/MIT).

### 1-5. Cloudflare AI Gateway 통합 관측성 (2026-08-07)

- **무엇**: Workers AI와 AI Gateway가 단일 AI 컨트롤 플레인으로 통합됐다 (2026-08-07 변경 로그).
  `env.AI.run(model, input, { gateway: { id: "default" } })`로 호출하면 로그·분석(볼륨·오류·지연·토큰·비용)·
  캐시·속도 제한·재시도를 게이트웨이에서 제공한다. 외부 프로바이더도 같은 `env.AI.run()` 경로로 부를 수 있고,
  선불 AI Gateway 크레딧으로 Workers AI·외부 모델 과금을 통합한다.
- **실측**: Cloudflare 공식 변경 로그(developers.cloudflare.com) 2026-08-07 항목.
- **왜 MyHub에 맞는지**: MyHub는 `ai_usage` D1 원장으로 모델별 호출·성공·지연을 직접 기록하고 있으나,
  **게이트웨이 단의 캐시·재시도·속도 제한·비용 집계가 없다**. 특히 Gemini·Groq·NVIDIA 외부 호출은
  각자 재시도 로직을 갖고 있어 실패 패턴 파악이 어렵다. 게이트웨이를 통하면 "어떤 모델이 얼마나 실패하는지"가
  한 곳에서 보인다. (단, MyHub는 외부 모델을 직접 호출하므로 게이트웨이에 올리려면 호출 경로 변경이 필요 —
  Workers AI 경로부터 시작.)
- **어디에·어떻게 적용**: `src/services/ai.ts`의 Workers AI 호출부터 `gateway: { id: "default" }` 옵션을 달아
  로그·캐시가 쌓이는지 확인. 외부 프로바이더(Gemini/Groq/NVIDIA)는 AI Gateway의 외부 프로바이더 라우팅으로
  옮길지, 기존 직접 호출을 유지할지 별도 판단 (키 관리·ZDR 등 보안 경계와 맞물려 있어 즉시 이동 금지).
  비용은 선불 크레딧 — 무료 범위 내에서만 사용하고 카드가 필요하면 중단.
- **테스트·결함 체크**: Cloudflare 공식 기능이라 별도 테스트 코드 체크 대상이 아니다.
  다만 게이트웨이 경유 시 지연이 늘어날 수 있어, 도입 후 `ai_usage`의 지연 분포를 전후 비교할 것.
- **금지 사유**: 없음.

---

## 2순위 — POC·패턴 차용 후 판단

### 2-1. cloudflare/agents SDK — 상태형 에이전트 런타임 (가장 큰 플랫폼 베팅)

- **무엇**: Cloudflare Agents SDK. 각 에이전트가 Durable Object가 되어 **지속적 정체성·로컬 SQLite 저장소·
  실시간 WebSocket·스케줄링·복구 가능한 실행**을 갖는다. 유휴 시 하이버네이션(비용 0에 가까움), MCP·워크플로·
  채널(채팅·음성·이메일·Slack) 내장. `npm install agents`로 추가, `routeAgentRequest`로 연결.
  하네스는 Think(`@cloudflare/think`)·PiHarness(베타)·직접 구현 중 선택.
- **실측**: ★5,888 · MIT · 2026-10-26 · 이슈 209 · `.github` CI 존재.
  버전은 0.24.0으로 **pre-1.0** (2026-10 기준 커뮤니티 비교 글). DO 요금: 요청 100만 건당 $0.15 +
  지속 시간 100만 GB-초당 $12.50, 하이버네이션 중에는 과금 없음. 요청·메시지당 30초 컴퓨트 제한.
  Sandbox·Containers는 2026-04-13 GA.
- **왜 MyHub에 맞는지**: MyHub의 에이전트 상태(대화 기록·스케줄·승인·핸드오프)는 D1·KV에 손으로 구현돼 있다.
  Agents SDK는 이 상태·스케줄·실시간 동기화를 런타임이 맡는다. 특히 (a) 비서별 Durable Object로
  **대화 상태의 원자성·동시성**이 좋아지고, (b) WebSocket 실시간 스트리밍이 공짜로 따라오며,
  (c) `this.setState()`·`this.sql`로 에이전트별 로컬 상태가 생긴다.
- **어디에·어떻게 적용**: **당장 갈아엎지 않는다.** 비서 1명(예: 캘리·스케줄러)을 Agents SDK로 구현한 POC를
  별도 Worker에 올려, (1) 기존 D1 대화 기록과 양립하는지, (2) 30초 제한이 FC 루프에 걸리는지,
  (3) 하이버네이션 복귀 지연이 체감되는지를 측정한다. POC 통과 후에만 점진 이전을 검토.
  주의: `McpAgent`는 폐기돼 `createMcpHandler`를 써야 한다. DO는 Workers Paid($5/월) 전제 —
  무료 티어 유지를 원하면 DO 무료 한도를 먼저 확인할 것.
- **테스트·결함 체크**: 루트에 `tests/`가 보이지 않았으나 모노레포라 패키지별 테스트는 미확인으로 표기.
  pre-1.0이라 API 변경 리스크가 있다 (0.24.0). 커뮤니티 비교 글에서 지적된 제약: 30초 제한, 컨테이너 최대
  4 vCPU/12 GiB/20 GB, 호스팅 도구 카탈로그 없음.
- **금지 사유**: pre-1.0이라 패턴 참고 + POC까지만. 통째 이전 금지.

### 2-2. OpenLLMetry / OpenLIT — LLM 호출 트레이스 표준 스키마 (관측성 패턴)

- **무엇**: OpenTelemetry 기반 LLM 관측성 SDK. LLM 호출·도구 호출·토큰 사용량을 OTEL 스팬으로 남기는
  **규약(시맨틱 컨벤션)**이 핵심이다.
  - **OpenLLMetry** (`traceloop/openllmetry`): ★7,507 · Apache-2.0 · 2026-10-25 · 이슈 809.
  - **OpenLIT** (`openlit/openlit`): ★2,883 · Apache-2.0 · 2026-10-25 · 이슈 177.
    "trace, evaluate, guard"를 한 플랫폼으로 묶은 "agent harness engineering platform"을 표방.
- **왜 MyHub에 맞는지**: MyHub는 이미 `ai_usage` 원장 + 도구 실행 감사(`tool_execution_audit`)를 갖고 있으나
  스키마가 자체 규격이다. OTEL 스팬 규약을 차용하면 (a) "어떤 프롬프트 버전이 어떤 도구 호출을 했는지"가
  표준 형태로 남고, (b) 나중에 Langfuse/Phoenix 같은 뷰어로 갈아끼우기가 쉬워진다.
  KREAM JARVIS 교훈("LLM 호출은 전부 트레이스로 남길 것")과도 맞는다.
- **어디에·어떻게 적용**: SDK를 설치하지 않는다. **스팬 스키마만 차용**해 기존 `tool_execution_audit`·`ai_usage`에
  필드를 추가한다: `trace_id`·`span_id`·`parent_span_id`·`prompt_version`·`model`·`input_tokens`·
  `output_tokens`·`tool_name`·`tool_call_id`·`duration_ms`·`status`. 이미 있는 필드는 이름만 맞춘다.
  D1에 저장하므로 외부 전송 없음 (잠긴 메모는 트레이스에도 안 남긴다 — 기존 보안 경계 유지).
- **테스트·결함 체크**: 두 프로젝트 모두 테스트 존재 여부는 루트 미조회로 미확인 표기.
  OpenLLMetry 이슈 809건은 규모·적용 범위 대비 정상 범위이나, 스팬 규약 버전 변경 시 추종 비용이 있다.
  규약만 차용하므로 SDK 결함은 MyHub에 전파되지 않는다.
- **금지 사유**: 없음 (Apache-2.0). 단, SDK 설치 금지 — 스키마만 차용.

### 2-3. agent-prism — 트레이스 뷰어 UI 패턴

- **무엇**: AI 에이전트 트레이스를 시각화하는 React 컴포넌트 모음 (`evilmartians/agent-prism`).
- **실측**: ★403 · MIT · 2026-10-25 (검색 결과 기준).
- **왜 MyHub에 맞는지**: MyHub 대시보드에 에이전트 실행 기록을 보여줄 방법이 없다. 트레이스를 표로만 보면
  "어디서 실패했는지"가 안 보인다. agent-prism의 타임라인·스팬 트리 UI 패턴을 참고하면
  2-2의 스팬 데이터를 사람이 읽을 수 있게 된다.
- **어디에·어떻게 적용**: 컴포넌트를 그대로 가져오지 말고, **타임라인 렌더링 패턴**(스팬 중첩·지연 막대·상태 색상)만
  `public/memory.html` 또는 별도 추적 페이지에 구현한다. 데이터는 2-2의 D1 스팬.
- **테스트·결함 체크**: 소규모(★403)라 테스트 유무 미확인. UI 패턴 참고 수준이라 리스크 낮음.
- **금지 사유**: 없음 (MIT).

### 2-4. Graphiti — 실시간 시간 지식 그래프 (메모리 시간축 패턴)

- **무엇**: AI 에이전트용 실시간 지식 그래프 구축 (`getzep/graphiti`). 시간(temporal) 엣지 + 엔티티 해소가 핵심.
  Zep 메모리 엔진의 기반이다.
- **실측**: ★32,224 · Apache-2.0 · 2026-10-26 · 이슈 519.
- **왜 MyHub에 맞는지**: MyHub 메모리는 mem0·ai-memory 패턴(사실 추출·그래프·노화·supersede)을 이미 갖고 있으나
  **시간축이 약하다** ("언제"가 바뀌면 옛날 사실이 그대로 남는다). Graphiti의 시간 엣지(사실마다 유효 기간)와
  엔티티 해소(같은 사람·장소의 다른 표기 통합) 패턴이 다음 단계다.
- **어디에·어떻게 적용**: Python/Neo4j 기반이라 설치하지 않는다. **패턴만 차용**: `memory_fact_entities`에
  `valid_from`·`valid_until`을 추가하고, 새 사실이 오면 기존 사실의 `valid_until`을 닫는 규칙을
  memory-consolidation에 넣는다. 엔티티 해소는 정규화 함수(공백·조사 제거)부터 시작.
- **테스트·결함 체크**: 대형 프로젝트, 이슈 519건은 규모 대비 정상. 패턴 차용이라 코드 결함은 전파되지 않음.
- **금지 사유**: 없음 (Apache-2.0). 설치 금지 — 패턴만.

### 2-5. memora — supersede 로직 대조 검증용

- **무엇**: AI 에이전트용 지속 메모리 (`agentic-box/memora`). dedup 흡수 + **supersession 계보**가 특징.
- **실측**: ★746 · MIT · 2026-10-26 · 이슈 5 (매우 적음).
- **왜 MyHub에 맞는지**: MyHub memory-consolidation도 supersede/restore + 공백 summary 가드를 갖고 있다
  (2026-10-26 수정). memora는 같은 문제를 더 작은 코드로 풀었을 가능성이 커, **우리 로직의 대조군**으로 좋다.
  특히 "대체됐는데 다시 살아나는" 경우의 처리와 dedup 임계값을 비교할 수 있다.
- **어디에·어떻게 적용**: 코드를 읽고 `docs/`에 비교 메모만 남긴다. 우리 consolidation의 테스트 케이스에
  memora의 엣지 케이스(동일 사실 재흡수·대체 체인·복원)를 추가하는 식으로 반영.
- **테스트·결함 체크**: 이슈 5건으로 매우 조용 — 작은 프로젝트라 테스트 규모도 작을 가능성. 대조용이라 리스크 없음.
- **금지 사유**: 없음 (MIT).

### 2-6. Pipecat / LiveKit — 실시간 음성 파이프라인 패턴

- **무엇**: 실시간 음성 에이전트 프레임워크 2종.
  - **Pipecat** (`pipecat-ai/pipecat`): ★16,816 · BSD-2-Clause · 2026-10-26 · 이슈 439.
    `tests/` + `.github` CI 존재. Daily가 유지. 음성 에이전트·멀티모달·실시간 AI 프레임워크.
  - **LiveKit Agents** (`livekit/agents`): ★14,935 · Apache-2.0 · 2026-10-26 · 이슈 806.
    실시간 음성·영상 AI 에이전트. **TS 버전** `livekit/agents-js`도 있음: ★951 · Apache-2.0 ·
    2026-10-25 · 이슈 502 (★ 대비 이슈가 많아 주의).
- **왜 MyHub에 맞는지**: MyHub 음성은 Whisper 전사 + MeloTTS 합성까지만 구현됐고 실시간이 아니다.
  실시간 음성의 핵심은 STT→LLM→TTS 파이프라인이 아니라 **VAD(음성 감지)·인터럽션(말 끊기)·스트리밍·
  턴테이킹**이다. 두 프로젝트가 이 패턴의 사실상 표준이다.
- **어디에·어떻게 적용**: 서버 프레임워크를 설치하지 않는다 (둘 다 Python 중심, Workers에 안 맞는다).
  **파이프라인 상태머신 패턴만** `docs/voice-design.md` 수준으로 정리해 음성 2단계 설계에 반영한다:
  VAD → 부분 전사 → LLM 스트리밍 → TTS 청크 재생 → 사용자 개입 시 즉시 중단·컨텍스트 절단.
  브라우저 쪽은 WebRTC 전송이 필요하면 LiveKit의 TS 클라이언트 SDK를 검토한다 (agents-js 자체는 서버용).
- **테스트·결함 체크**: pipecat은 테스트·CI 존재. livekit/agents-js는 이슈 502건으로 ★951 대비 많아
  TS 버전의 성숙도가 낮아 보인다 — TS 서버 도입은 보류하고 패턴만 참고할 것.
- **금지 사유**: 없음 (BSD/Apache-2.0). 서버 프레임워크 통째 도입 금지 — Workers와 맞지 않음.

### 2-7. vitest-plugin + miniflare (workers-sdk) — 실런타임 테스트

- **무엇**: `cloudflare/workers-sdk` (★4,663 · Apache-2.0 · 2026-10-26 · 이슈 601) 안의
  `vitest-plugin` + `miniflare` 패키지. 실제 workerd 런타임에서 테스트를 돌리는 Cloudflare 공식 도구.
- **왜 MyHub에 맞는지**: MyHub는 Jest + mock으로 99% 커버리지를 달성했으나, 라이브에서만 터지는 결함
  (Exa 날짜·RSS 503·FC)이 반복된다. mock은 "mock이 믿는 것"만 검증한다. miniflare로 D1·KV·fetch를
  실제 런타임 의미로 돌리면 **mock과 실제의 괴리**를 줄일 수 있다. `wrangler`도 같은 저장소에 있다
  (MyHub는 wrangler 미설치 상태).
- **어디에·어떻게 적용**: Jest를 버리지 않는다. `tests/runtime/`에 miniflare 기반 테스트를 별도로 두고,
  뉴스 체인·FC·인증 같은 **런타임 의존도가 높은 경로만** 실런타임으로 검증한다.
  wrangler 설치는 `wrangler.toml`의 `main`이 `src/index-inline.ts`를 가리켜야 한다는 기존 주의사항을 지킨다.
- **테스트·결함 체크**: Cloudflare 공식 도구. miniflare는 로컬 시뮬레이터라 실제 egress(Google 503 등)는
  재현하지 못한다 — "실런타임 ≠ 실망"임을 명심하고 라이브 평가는 promptfoo(1-1)가 담당한다.
- **금지 사유**: 없음 (Apache-2.0).

### 2-8. workbox — PWA 서비스워커 캐싱 전략

- **무엇**: PWA용 JS 라이브러리 모음 (`GoogleChrome/workbox`). ★13,034 · MIT · 2026-10-25 · 이슈 84.
- **왜 MyHub에 맞는지**: MyHub는 PWA(매니페스트·sw.js·푸시)를 갖고 있으나 캐싱 전략이 손으로 돼 있다.
  정적 에셋은 불변 캐시, API는 네트워크 우선, 오프라인 폴백 같은 전략을 workbox의
  stale-while-revalidate / network-first 패턴으로 정리할 수 있다.
- **어디에·어떻게 적용**: workbox를 번들에 넣지 말고, **캐싱 전략 표만** `sw.js`에 반영한다.
  정적(`?v=` 버전 있음)은 CacheFirst, `/api/*`는 NetworkOnly(인증·신선도), 네비게이션은 오프라인 폴백 페이지.
- **테스트·결함 체크**: Google 공식, 장수 프로젝트. 패턴 차용이라 리스크 낮음.
- **금지 사유**: 없음 (MIT).

### 2-9. E2B — AI 스튜디오 샌드박스 (카드 조건 확인 필수)

- **무엇**: 에이전트용 보안 코드 실행 환경 (`e2b-dev/E2B`). ★14,557 · Apache-2.0 · 2026-10-26 · 이슈 111.
  "Open-source, secure environment with real-world tools for enterprise-grade agents."
- **왜 MyHub에 맞는지**: AI 스튜디오는 미리보기 백지·v2 수정 FAIL 등 샌드박스 부재가 품질 관문이다.
  지금은 dry-run + 미리보기 + 명시 승인으로 버티고 있는데, E2B는 실제 격리 실행을 제공한다.
  Cloudflare Sandbox가 유료($5/월)라 보류된 상황에서 E2B는 대안 후보.
- **어디에·어떻게 적용**: **바로 도입하지 않는다.** 무료 티어 조건(카드 필요 여부·월 한도)을 먼저 확인한다
  (사용자 원칙: 카드·초과 과금 동의가 필요한 무료 서비스 기피). 카드 없이 쓸 수 있으면
  AI 스튜디오 미리보기용으로만 작은 POC를 하고, 아니면 Cloudflare Sandbox와 함께 보류.
- **테스트·결함 체크**: 대형 프로젝트, 이슈 111건은 규모 대비 적음. SDK 결함보다 **과금·한도**가 리스크.
- **금지 사유**: 없음 (Apache-2.0). 단, 카드가 필요하면 도입 금지.

---

## 3순위 — 지켜보기 / 패턴만

### 3-1. DeepEval / inspect_ai / RAGAS — eval 심화

- **DeepEval** (`confident-ai/deepeval`): ★19,106 · Apache-2.0 · 2026-10-26 · 이슈 782.
  LLM 평가 프레임워크(G-Eval 등 메트릭). pytest 기반이라 CI에 별도 harness로 붙일 수 있다.
  promptfoo(1-1) 이후, 메트릭 기반 평가가 필요해지면 검토.
- **inspect_ai** (`UKGovernmentBEIS/inspect_ai`): ★3,093 · MIT · 2026-10-26 · 이슈 454.
  영국 AI Safety Institute의 평가 프레임워크. 안전성 평가(잠금 우회 시도·인젝션·권한 경계)에 강하다.
  보안 감사(run-001~004)의 "공격자 관점 테스트"를 자동화할 때 검토.
- **RAGAS** (`vibrantlabsai/ragas`, 구 explodinggradients): ★16,151 · Apache-2.0 · 2026-10-26 · 이슈 636.
  RAG 평가 메트릭(faithfulness·context precision 등). 메모리 검색 품질(검색은 되는데 쓰이지 않는 기억)을
  수치화할 때 검토. 단, RAGAS 자체가 LLM을 써서 평가하므로 비용·변동성이 있다.
- 공통: 셋 다 Python 기반이라 Worker에 안 들어가고 CI harness로만 쓴다. 1-1이 먼저다.

### 3-2. Langfuse / Phoenix — 풀 관측·평가 플랫폼 (무거움 + 라이선스 주의)

- **Langfuse** (`langfuse/langfuse`): ★36,494 · 업데이트 2026-10-26 · 이슈 1,151.
  API상 라이선스가 `NOASSERTION`이고, LICENSE 파일은 "Copyright (c) 2023-2026 ClickHouse, Inc."로 시작하는
  **복합 라이선스**다. 2026년 ClickHouse 인수 이후 라이선스 구조가 바뀌었다.
  트레이스·평가·프롬프트 관리를 한 번에 주는 풀 플랫폼이나, 자가 호스팅 부담이 크다.
  **복사 전 라이선스 직접 확인 필수. 당장은 대시보드·데이터셋 설계 패턴만 참고.**
- **Phoenix** (`Arize-ai/phoenix`): ★12,005 · 업데이트 2026-10-26 · 이슈 1,225.
  LICENSE 파일이 **Elastic License 2.0 (ELv2)**이다. 트레이스 UI·평가가 강하나,
  ELv2는 호스팅 서비스 제공에 제한이 있어 MyHub에는 **패턴만** 참고한다.
- 공통: 둘 다 "설치해서 쓰는" 쪽이 아니라 "어떻게 보여주고 어떻게 평가하는지"를 배우는 용도.
  2-2의 OTEL 스키마 + 2-3의 트레이스 뷰어 조합이 MyHub 규모의 정답이다.

### 3-3. supermemory / mcp-memory-service / automem / GraphRAG — 메모리 심화

- **supermemory** (`supermemoryai/supermemory`): ★31,400 · MIT · 2026-10-26 · 이슈 34.
  "Memory and context engine + app" — 로컬 실행 가능, Memory API 제공. 메모리 API 설계(ingest/search·시간 감쇠)
  패턴 참고. 단, 외부 서비스로 메모리를 보내는 구조라 MyHub의 잠금 경계와 충돌할 수 있어 **설계만** 참고.
- **mcp-memory-service** (`doobidoo/mcp-memory-service`): ★2,046 · Apache-2.0 · 2026-10-26 · 이슈 30.
  MCP + REST로 메모리를 노출하는 지속 메모리. MyHub에 MCP 서버를 붙일 때 메모리 노출 패턴으로 참고.
- **automem** (`verygoodplugins/automem`): ★823 · MIT · 2026-10-26 · 이슈 17.
  그래프 + 벡터 스토어로 결정·관계를 회상하는 장기 메모리. 소규모라 읽기 좋은 대조군.
- **GraphRAG** (`microsoft/graphrag`): ★36,448 · MIT · 2026-10-26 · 이슈 56.
  그래프 기반 RAG. Leiden 커뮤니티 탐지 + 계층 요약이 핵심인데, MyHub의 메모리 요약 페이지의 고급 버전이다.
  Python·LLM 다회 호출이라 무겁고, **커뮤니티 요약 패턴만** 참고한다.
- 공통: mem0·ai-memory를 이미 적용한 상태라, 이 그룹은 "다음 단계 아이디어" 수준이다.

### 3-4. RSS 인프라 패턴 + 503 우회 실험

- **RSSHub** (`DIYgod/RSSHub`): ★46,665 · **AGPL-3.0** · 2026-10-26 · 이슈 39 ·
  vitest 설정 + `.github` CI 존재. "Everything is RSSible."
  **AGPL이라 코드 복사 금지.** 참고할 것: (a) 피드별 날짜 정규화 로직, (b) 사이트별 스크레이퍼(route) 구조,
  (c) 캐시·재시도 정책. 추가로 **공개 인스턴스(rsshub.app)를 경유해 Google News RSS 503을 우회**할 수 있는지
  실험해 볼 만하다 (Worker → rsshub.app → Google). 단, 제3자 공개 서비스 의존이라
  신선도·가용성을 측정한 뒤에만 판단하고, 주 경로로 삼지 않는다.
- **RSS-Bridge** (`RSS-Bridge/rss-bridge`): ★9,321 · Unlicense · 2026-10-26 · 이슈 288.
  "The RSS feed for websites missing it." 피드가 없는 사이트(한국 언론사 개별 페이지 등)에
  피드를 만들어주는 패턴. 네이버 뉴스 API가 1차, RSS-Bridge식 브릿지는 특정 언론사 보강용으로만 검토.
- **miniflux** (`miniflux/v2`): ★9,836 · Apache-2.0 · 2026-10-26 · 이슈 279.
  미니멀 피드 리더. 피드 파싱·날짜 정규화의 엣지 케이스 처리가 단단하다.
  MyHub의 손수 짠 RSS 파서(정규식 기반)가 놓치는 케이스의 대조군으로 참고.
- 공통: RSS 프로젝트는 통째 설치(셀프호스팅 부담) 금지 — 패턴 + 공개 인스턴스 실험까지만.

### 3-5. 음성 심화 — 지켜보기

- **fish-speech** (`fishaudio/fish-speech`): ★33,405 · 라이선스 API상 NOASSERTION · 2026-10-26 · 이슈 25.
  SOTA 오픈소스 TTS. MeloTTS가 이미 구현돼 있어 당장 교체할 이유가 없다. 라이선스 직접 확인 전에는 참고만.
- **Moshi** (`kyutai-labs/moshi`): ★11,302 · Apache-2.0 · 2026-10-26 · 이슈 97.
  full-duplex 음성-텍스트 파운데이션 모델 + Mimi 코덱. 연구용 모델이라 Workers에 안 맞고,
  실시간 대화의 목표 아키텍처(풀듀플렉스)를 이해하는 용도로만 참고.
- **faster-whisper** (`SYSTRAN/faster-whisper`): ★26,146 · MIT · 2026-10-26 · 이슈 18.
  CTranslate2 기반 빠른 Whisper. 서버용이라 Workers에 안 맞고, VAD + 청크 스트리밍 전사 패턴만 참고.
- **Coqui TTS** (`coqui-ai/TTS`): ★46,142 · MPL-2.0 · 2026-10-26 · 이슈 3.
  TTS 툴킷. MeloTTS 대안으로만 기록하고, 당장은 보류.

### 3-6. Gmail·캘린더 통합 패턴

- **Nango** (`NangoHQ/nango`): ★12,994 · **ELv2** (LICENSE 파일 기준) · 2026-10-26 · 이슈 114.
  1,000개 API 연결(OAuth + 동기화). Gmail·캘린더의 토큰 갱신·증분 동기화·스코프 관리 패턴 참고.
  ELv2라 코드 복사 금지, **패턴만**. 자가 호스팅은 무거우니 하지 않는다.
- **google-api-nodejs-client** (`googleapis/google-api-nodejs-client`): ★12,276 · Apache-2.0 ·
  2026-10-26 · 이슈 222. Google 공식 Node.js 클라이언트. Workers에서는 무거워 직접 쓰지 않고,
  Gmail·Calendar API의 요청 형태·페이징·에러 코드 패턴만 참고한다.
- 공통: OAuth 구현은 이미 돼 있어, 이 그룹은 "연결 후 운영 패턴"(토큰 갱신 실패 시 재동의 유도,
  동기화 주기, 쓰기 승인 게이트) 정리에만 쓴다.

### 3-7. Cloudflare Sandbox SDK — 보류 유지

- **무엇**: `cloudflare/sandbox-sdk` — ★1,154 · 라이선스 API상 NOASSERTION · 2026-10-26 · 이슈 0.
  Cloudflare 엣지에서 샌드박스 코드 환경을 실행하는 SDK. Sandbox·Containers는 2026-04-13 GA.
- **왜 보류**: 유료($5/월 Workers Paid 전제 + 컨테이너 vCPU $0.072/시간). 사용자 원칙상 카드·유료 전제는
  사전 결정이 필요하다. E2B(2-9)와 함께 "AI 스튜디오 샌드박스" 결정 때 같이 본다.
  라이선스도 NOASSERTION이라 직접 확인 전까지는 패턴 참고만.

---

## 적용 금지 / 부적합 (이번 조사에서 확인된 것)

| 후보 | 사유 |
|---|---|
| RSSHub 코드 복사 | **AGPL-3.0** — 복사 금지, 패턴 참고만. 공개 인스턴스 경유 실험은 별개로 가능 |
| rssguard / selfoss / tt-rss | GPL-3.0 (검색 결과 기준) — 통째 도입 금지, 패턴 참고만 |
| Langfuse 코드 복사 | LICENSE가 ClickHouse 복합 라이선스 — 직접 확인 전 복사 금지 |
| Phoenix 코드 복사 | **ELv2** — 호스팅 서비스 제공 제한, 패턴만 |
| Nango 코드 복사 | **ELv2** — 패턴만 |
| sandbox-sdk 코드 복사 | 라이선스 NOASSERTION — 직접 확인 전 복사 금지 |
| fish-speech 코드 복사 | 라이선스 NOASSERTION — 직접 확인 전 복사 금지 |
| vocode | 저장소 소실 (404, `vocode/vocode`·`vocode-ai/vocode` 모두) — 프로젝트가 사라졌거나 이전됨. 음성은 Pipecat/LiveKit으로 간다 |
| bolt.new (`stackblitz/bolt.new`) | MIT ★16,577이나 이슈 **8,184건**으로 결함·유지보수 부담이 크고, 풀스택 앱 빌더라 MyHub AI 스튜디오와 범위도 다름 — 참고만 |
| livekit/agents-js 서버 도입 | ★951 대비 이슈 502건으로 TS 버전 성숙도가 낮음 — 패턴만, 서버 도입 보류 |
| 통째 설치류 (Langfuse/Phoenix 자가 호스팅, RSSHub/miniflux 셀프호스팅, Nango 자가 호스팅) | 셀프호스팅 부담 — 사용자 지시로 금지 |

## Cloudflare 생태계 후속 메모 (2026-10 소식, GitHub 외 공식 소식)

- **AI Search GA (2026-10-01)**: 이미지 픽셀 임베딩·스캔 PDF OCR·최대 10 MiB 파일·모든 채팅 모델과 동작.
  메모 검색(FTS5)의 관리형 대안으로 검토할 수 있으나, 과금·지연·잠긴 메모 제외 경계를 먼저 따져야 한다.
  Agents SDK의 `ai_search_namespaces` 바인딩과 함께 쓴다.
- **Clef-omni + 더 빠르고 저렴한 Clef-flash (2026-10-09)**: Clef 계열에 멀티모달(Clef-omni)이 추가되고
  Clef-flash 가격 인하 + 속도 최대 2배. 이전 Clef 조사(평가셋 전에는 켜지 말 것)의 결론은 그대로이나,
  평가셋 구축 시 비용·속도 가정이 달라졌음을 기록한다.
- **Clairic 추출 모델 (2026-10-19)**: 비정형 입력에서 추출·계산·예측하는 System One급 모델.
  메모리 사실 추출(`memory.llm_extract_enabled` OFF 상태)의 대안 경로로, A/B 측정 때 후보에 넣을 만하다.
- **관측성 통합 (2026-10)**: 요청 트레이싱 오픈 베타, 통합 SQL API(베타)로 Workers 로그·트레이스·Analytics Engine을
  한 SQL로 조회, Observability MCP 서버 + `cf` CLI, Logpush가 모든 셀프서브 플랜으로 확대, 알림·웹훅 전 플랜.
  무료 0.5 GB/일 수집·7일 보관. 2026-12-01부터 통합 관측성 과금. → 2-2 스팬 설계와 함께,
  "Worker 로그를 D1이 아니라 Cloudflare 관측성에서 보는" 쪽으로 무게중심을 옮길지 검토할 만하다.
- **iOS 키보드 문제**: 이번 조사에서 맞는 GitHub 프로젝트를 찾지 못했다. 웹 플랫폼 문제라
  visualViewport 기반 처리가 정답에 가깝고, 프로젝트 도입으로 풀릴 일이 아니다 — 기존 미해결 항목으로 유지.

## 지금 바로 적용할 것 3가지

1. **promptfoo로 라이브 eval 하네스 만들기 (1-1)**
   — Jest 99%가 잡지 못하는 라이브 종단 결함(뉴스 신선도·FC·메모리 주입)을 CI화하는 유일한 직접 수단.
   뉴스 케이스(응답 속 날짜가 오늘/어제인지)부터 시작한다. Worker 코드 변경 없이 `tests/evals/`만 추가.
2. **기사 날짜 직접 검증 패턴을 TS로 포팅 (1-2)**
   — Exa 가짜 발행일을 믿는 한 뉴스 필터는 계속 뚫린다. 기사 HTML의 `article:published_time`·
   JSON-LD `datePublished`·`<time>`를 직접 읽어 창 밖이면 제외한다. URL 날짜 가드와 함께 이중 잠금.
   Python 라이브러리 설치 없이 패턴만 포팅한다.
3. **knip을 CI 게이트로 도입 (1-4)**
   — 500줄 규칙·모듈 경계·복붙 금지가 사람 눈에만 의존하고 있다. knip(미사용 코드)부터 돌리고
   madge(순환 참조)·jscpd(복붙)를 이어 붙인다. 자동 삭제 없이 목록만 내고 사람이 판단한다.

> 다음 단계 제안: 1-1·1-2·1-4 중 사용자가 고른 것부터 작업한다. 1-3(Web Search API)은 날짜 실측 실험부터,
> 2-1(Agents SDK)은 POC 범위·비용 확인이 먼저다.
