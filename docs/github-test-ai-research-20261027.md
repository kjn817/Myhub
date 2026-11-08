# GitHub 3차 조사 — 테스트·AI 관련, MyHub에 도움이 될 것들 (2026-10-27)

> 조사만 수행한 문서. 코드 변경 없음, 커밋하지 말 것.
> 조사일: 2026-10-27 (KST). 수단: GitHub REST API(미인증) + GitHub MCP(연결 확인용) + 웹 검색(Cloudflare 소식만).
> 모든 ★ 수·라이선스·최근 업데이트·열린 이슈 수는 2026-10-27 실측. API 응답 그대로이며, API가
> `NOASSERTION`으로 잡은 라이선스는 LICENSE 파일을 직접 읽어 확인하고 그 결과를 별도로 적었다.
> 총 42개 저장소 실측 + KMMLU 1건 미확인.

## 조사 범위와 제외 목록

이미 조사·적용한 것은 중복 조사하지 않았다: promptfoo, DeepEval, inspect_ai, RAGAS, Langfuse, Phoenix,
supermemory, mcp-memory-service, automem, GraphRAG, mem0, ai-memory, OpenManus, Suna, Letta, Leon, Khoj,
Goose, Agent Zero, MetaGPT, crewAI, HumanLayer, Octop, openclaw, agent-framework, context-mode, n8n,
ppt-master, DeepSeek Harness, cloudflare/agents, cloudflare/security-audit-skill, knip, Graphiti, memora,
Pipecat, LiveKit, workbox, E2B, RSSHub, RSS-Bridge, miniflux, Nango, Vercel AI SDK, LiteLLM, LangChain.js,
OpenAI Agents SDK, Gemini JS SDK, newspaper3k, trafilatura, vitest-plugin+miniflare, OpenLLMetry/OpenLIT,
agent-prism, Cloudflare Web Search API, AI Gateway, Clairic, fish-speech, Moshi, faster-whisper,
sandbox-sdk, vocode, bolt.new. (Dify는 이전 조사에서 통째 도입 금지로 판정돼 이번 조사에서 제외.)

이번 조사 초점 (사용자 지시): (1) 테스트 품질 — 사용자가 방금 정한 원칙 "테스트는 항상 의미 있는
테스트여야 한다. 커버리지 높이기 위한 테스트 금지"에 직접 답하는 도구, 즉 **테스트가 결함을 잡는지 재는 도구**
(뮤테이션 테스팅·속성 기반 테스트), (2) AI 평가·가드레일 — 메모발 프롬프트 인젝션 경계가 MyHub의
핵심 보안 경계라 레드티밍·가드레일이 직접 relevant, (3) AI 프레임워크·라우팅 (아직 안 본 것만),
(4) Workers/D1·PWA·한국어 관련.

## 라이선스 규칙 (사용자 지시, 전 후보 공통)

- AGPL 코드 복사 금지 → 패턴 참고만. 이번 조사에서 해당: **renovatebot/renovate (AGPL-3.0)**.
  단, Renovate를 GitHub App/봇으로 쓰는 것은 코드 복사가 아니므로 별도 판정(2-13 참조).
- 라이선스 미표기(API상 `NOASSERTION`)는 LICENSE 파일을 직접 읽어 확인했다. 확인 결과:
  MIT — pact-js, openai/evals; Apache-2.0 — NeMo-Guardrails, expect-type; 복합 — mastra
  (Apache-2.0 + `ee/` 별도 라이선스); 커스텀 — PurpleLlama (Llama 3.2 Community License).
- GPL/LGPL 계열 코드 복사 금지 → 패턴 참고만. 해당: **konlpy (GPL-3.0), soynlp (LGPL-3.0)**,
  **semgrep (LGPL-2.1)**은 스캐너로 쓰는 것이지 코드를 복사하는 것이 아니라 적용 가능.
- ELv2·커스텀 라이선스는 코드 복사 금지, 패턴만. 해당: **PurpleLlama**.
- 프리뷰·pre-1.0은 패턴 참고로만, 통째 설치(셀프호스팅 부담)는 하지 않는다.
- 유료 SaaS·카드 필요 시 적용 불가로 기록한다.

## 우선순위 요약

| 순위 | 후보 | 한 줄 | 적용 형태 |
|---|---|---|---|
| 1 | StrykerJS | 뮤테이션 테스팅 — 테스트가 결함을 잡는지 자동 측정 | Jest 러너로 핵심 파일부터, CI 게이트는 점수 임계값 합의 후 |
| 1 | fast-check | 속성 기반 테스트 — 파서·필터 순수 로직의 엣지 케이스 발굴 | 단위 테스트에 프로퍼티 추가, 의존성 1개 |
| 1 | garak | LLM 레드티밍 — 프롬프트 인젝션·탈옥·유출을 체계적으로 찌름 | Python CI 하네스, 운영 코드에 안 넣음 |
| 1 | Semgrep | 정적 보안 스캔 — 비밀키·XSS·SQLi를 CI에서 자동 탐지 | CI 스캔, 규칙은 MyHub 경계에 맞게 선별 |
| 1 | MSW | HTTP 레벨 API 모킹 — fetch 손목(mock)보다 실제에 가깝게 | 뉴스 체인·외부 API 테스트의 fetch 목 교체 |
| 2 | llm-guard | 입출력 가드레일 (인젝션·PII·유해성 탐지) | CI 평가용 + 패턴 차용 (Workers에서 직접 실행 불가) |
| 2 | NeMo Guardrails | 가드레일 설계 (Colang 흐름·input/output rails) | 설계 패턴만 차용 |
| 2 | Opik | LLM 관측·평가 (트레이스·데이터셋·스코어러) | 평가 하네스 후보, 자가 호스팅은 안 함 |
| 2 | Portkey gateway | AI 게이트웨이 (라우팅·가드레일·캐시·폴백) | Cloudflare AI Gateway 대안·비교용 |
| 2 | Pact | 계약 테스트 — Deno 릴레이 계약을 깨지지 않게 고정 | 릴레이 요청·응답 계약 테스트 |
| 2 | autoevals | 작은 평가 스코어러 모음 (Braintrust) | promptfoo 어설션 보강용 |
| 2 | openai/evals | eval 하네스 패턴 (레지스트리·데이터셋 구조) | promptfoo 평가셋 설계 참고 |
| 2 | lm-evaluation-harness | LLM 평가 하네스 표준 | 라우터·모델 비교 평가용 (무거움 주의) |
| 2 | tau-bench | 대화형 에이전트 벤치마크 (도구 사용·대화) | 비서 종단 평가 설계 참고 |
| 2 | Helicone | LLM 관측성 프록시 (로그·캐시·비용) | 프록시 경유 평가 — 카드·키 조건 확인 후 |
| 2 | nock | 가벼운 HTTP 모킹 | MSW보다 가벼운 대안 |
| 2 | tsd / expect-type | 타입 테스트 (d.ts·제네릭 계약) | 타입 계약이 있는 곳만 선별 |
| 2 | Renovate (봇으로) | 의존성 업데이트 자동화 | GitHub App으로 사용 (코드 복사·셀프호스팅 금지) |
| 2 | Biome | 린터·포매터 (Rust 기반, 빠름) | tsc·Jest와 별개로 코드 위생 검사 |
| 2 | Lighthouse | PWA·성능 감사 | CI에서 PWA 점수 게이트 |
| 2 | Guardrails AI | 가드레일 프레임워크 (XML 스펙·검증기) | 패턴만 (Python 서버 필요) |
| 2 | TruLens | LLM 평가·트레이싱 | Opik 이후 검토 |
| 3 | Cypress | E2E (브라우저) | Playwright 이미 있음 + VM Chromium 차단 — 중복 |
| 3 | Rebuff / HarmBench / JailbreakBench | 인젝션 탐지·유해성 벤치마크 | 2년 가까이 방치됨 — 참고만 |
| 3 | PurpleLlama | Llama Guard (모델 기반 가드) | 커스텀 라이선스 + 모델 호스팅 필요 — 패턴만 |
| 3 | SWE-bench / AgentBench | 코드·에이전트 벤치마크 | 무거움, 노바 평가 때만 검토 |
| 3 | mastra / langgraphjs / LlamaIndexTS / agno / pydantic-ai / autogen / semantic-kernel | 에이전트 프레임워크 | 손수 짠 오케스트레이션과 교체할 이유 없음 — 패턴만 |
| 3 | konlpy / soynlp | 한국어 형태소 분석 | GPL/LGPL + Python — Workers 불가, 아이디어만 |
| 3 | KLUE | 한국어 평가 데이터셋 | Clef 한국어 평가셋 재료로만 참고 |
| 3 | Socket.dev | 공급망 보안 스캔 | 서비스형, 카드 조건 확인 후 |
| 3 | arethetypeswrong | 패키지 타입 검사 | MyHub는 패키지를 안 팔아 적합성 낮음 |

---

## 1순위 — 지금 바로 적용할 것

### 1-1. StrykerJS — "테스트가 결함을 잡는지"를 재는 유일한 직접 수단

- **무엇**: JS/TS용 뮤테이션 테스팅 프레임워크 (`stryker-mutator/stryker-js`).
  테스트 코드를 돌리는 게 아니라 **프로덕션 코드를 일부러 조금씩 깨뜨려**(조건 뒤집기, 상수 바꾸기,
  연산자 교체) 테스트가 그걸 잡는지 측정한다. 잡지 못하면 "survived mutant" — 즉 테스트가
  있어도 없는 것과 같은 부분이다. Jest 러너(`@stryker-mutator/jest-runner`)와
  Vitest 러너(`@stryker-mutator/vitest-runner`)가 공식 패키지로 있다 (패키지 목록 API로 확인).
- **실측**: ★3,278 · Apache-2.0 · 업데이트 2026-10-26 · 이슈 127.
- **왜 MyHub에 맞는지**: 사용자가 방금 정한 테스트 원칙("성질이 깨지면 테스트가 실패해야 한다")을
  **자동으로 재는 도구**다. 지금 MyHub는 커버리지 99%·4926 테스트지만, gate-* 65개 파일이
  `expect(true)` 연극이었고 runtime 테스트는 0039 결함을 "알려진 결함" 핀으로 박아두고 있었다 —
  커버리지는 그걸 하나도 잡지 못했다. Stryker는 바로 그 빈틈을 수치화한다.
  방금 내가 수작업으로 한 카나리아 검증(옛 0039로 되돌려 새 테스트 9건이 실패하는지 확인)이
  Stryker의 수작업 버전이다. Stryker는 그걸 전 파일에 대해 자동으로 한다.
- **어디에·어떻게 적용**: 처음부터 전체에 돌리지 않는다 (느리다 — 뮤턴트마다 테스트를 다시 돈다).
  핵심 파일부터 스코프를 좁힌다: `src/services/news-sources.ts`(날짜 필터·하드 필터),
  `src/services/article-date.ts`, `src/lib/news-summary.ts`, `src/modules/auth/routes.ts`(PIN 잠금),
  `src/services/memo-tools.ts`(마커 파서), `src/services/ai.ts`(FC 게이트).
  `npx stryker run`으로 뮤테이션 스코어를 뽑고, survived mutant가 나온 곳의 테스트를 보강한다.
  CI 게이트(예: 스코어 80% 이상)는 팀 합의 후에 — 처음에는 리포트만 본다.
  Jest 러너가 있으니 기존 Jest 설정을 그대로 쓴다. miniflare 런타임 테스트와는 별개로 돈다.
- **테스트·결함 체크**: 이슈 127건은 규모 대비 정상. Stryker 자체의 결함이 MyHub 코드에 전파되지는 않는다
  (측정 도구라서). 주의할 점: 뮤테이션 실행 시간이 길어 CI 타임아웃·비용을 봐야 하고,
  동등 뮤턴트(깨뜨려도 동작이 같은 경우 — 예: `x >= 0`을 `x > -1`로 바꾸는 것)는
  수작업으로 제외 목록을 관리해야 한다.
- **금지 사유**: 없음 (Apache-2.0).

### 1-2. fast-check — 속성 기반 테스트 (파서·필터의 엣지 케이스 발굴기)

- **무엇**: JS/TS용 속성 기반 테스트 라이브러리 (`dubzzz/fast-check`).
  테스트 케이스를 손으로 하나하나 적는 대신 **성질(property)을 적으면 무작위 입력을 수백 개 생성해
  반례를 찾는다**. 예: "어떤 날짜 문자열을 넣어도 파서는 크래시를 내지 않고, 창 밖 날짜는 항상 제외한다",
  "어떤 마커 문자열을 넣어도 파서는 원본 마커를 사용자에게 노출하지 않는다".
- **실측**: ★5,219 · MIT · 업데이트 2026-10-26 · 이슈 54.
- **왜 MyHub에 맞는지**: MyHub의 결함은 대부분 **순수 로직의 엣지 케이스**에서 터졌다 —
  마커 파서가 `{"title","content"}`를 못 읽은 것, FTS 쿼리 빌더가 다단어 질문을 AND로만 묶은 것,
  URL 날짜 가드의 연합뉴스 긴 ID 오탐, `parseRRule`의 무효 날짜, `truncateJson`의 무효 JSON.
  이런 것들은 예제 기반 단위 테스트로는 놓치기 쉽고, 속성 테스트가 잘 잡는다.
  특히 `sanitizeNewsQueryDate`(마커 날짜 소독), `extractUrlDate`, `buildFtsQuery`,
  `filterNewsWindow`, 마커 파서들이 1차 대상이다. 의존성이 없고(순수 TS), Workers 코드에 안 들어가고
  테스트 코드에만 들어간다.
- **어디에·어떻게 적용**: `tests/unit/`에 프로퍼티 테스트를 추가한다. 예:
  `fc.assert(fc.property(fc.string(), (s) => sanitizeNewsQueryDate(s, now)에는 '2025년' 같은 과거 날짜가 남지 않는다))`,
  `fc.assert(fc.property(fc.date(), ...))` 식으로. 처음에는 3~5개 성질부터 시작하고,
  반례가 나오면 그 반례를 회귀 테스트로 고정한다 (fast-check의 `seed`로 재현 가능).
  커버리지를 올리려고 넣는 것이 아니라, **반례를 찾는 것이 목적**임을 전제로 한다.
- **테스트·결함 체크**: 이슈 54건으로 매우 안정적. 라이브러리 자체 결함 리스크 낮음.
  주의: 무작위 입력이라 flaky처럼 보일 수 있으나, fast-check는 실패한 seed를 출력해 재현이 된다.
  CI에서는 seed를 고정하거나 실패 시 seed를 로그에 남긴다.
- **금지 사유**: 없음 (MIT).

### 1-3. garak — LLM 레드티밍 (인젝션 경계의 체계적 공격자)

- **무엇**: LLM 취약점 스캐너 (`NVIDIA/garak`). README 명시: "garak checks if an LLM-backed
  application can be made to fail in a way we don't want." 프로브가 환각·데이터 유출·
  **프롬프트 인젝션**·오정보·유해성 생성·탈옥 등 약점을 체계적으로 찌른다.
  `probes.promptinject`, `probes.encoding`, `probes.dan` 등 프로브 패밀리별로 지정 실행이 가능하고,
  각 시도마다 탐지기가 FAIL 여부를 판정한다.
- **실측**: ★9,716 · Apache-2.0 · 업데이트 2026-10-23 · 이슈 513.
- **왜 MyHub에 맞는지**: MyHub의 **핵심 보안 경계가 메모발 프롬프트 인젝션**이다
  (잠긴 메모는 AI 접근 계층에서 원천 차단, 비밀정보 마스킹, 인젝션 거부 테스트 존재).
  지금까지는 손으로 만든 인젝션 케이스 몇 개로만 검증했다. garak은 인코딩 기반 인젝션,
  DAN류 탈옥, 데이터 유출 유도 등 수백 개 공격 패턴을 자동으로 던져
  "어떤 인젝션은 막히고 어떤 인젝션은 뚫리는지"를 수치로 보여준다.
  특히 에코·루미가 외부 모델(Gemini·NVIDIA)이라 모델별 취약성이 다를 수 있어, 모델별 스캔이 의미 있다.
- **어디에·어떻게 적용**: Python 기반이라 Worker 코드에 안 들어간다. CI 하네스로 쓴다:
  `tests/evals/`의 promptfoo 하네스와 나란히 두고, 스테이징/운영 `/api/ai/chat`을 대상으로
  garak의 REST 어댑터(또는 OpenAI 호환 엔드포인트)로 인젝션·탈옥 프로브를 돌린다.
  처음에는 `probes.promptinject` + `probes.encoding` + `probes.dan` 3종만 스코프를 좁힌다.
  결과가 나오면 뚫린 패턴을 회귀 테스트(인젝션 거부 케이스)로 고정한다.
  단, 운영에 돌릴 때는 **쓰기 케이스(메모 생성 등)가 실제 데이터를 만들지 않게** 스코프를
  읽기·거부 케이스로 제한하고, 실행은 사전 승인하에 한다 (promptfoo 라이브 게이트와 같은 조건).
- **테스트·결함 체크**: NVIDIA 유지, 이슈 513건은 규모 대비 정상. garak 자체가 공격 도구라
  **운영 키·운영 데이터에 대한 스캔은 스코프를 엄격히 제한**해야 한다.
  프로브가 LLM을 많이 호출하므로 비용(외부 모델 토큰)도 사전에 본다.
- **금지 사유**: 없음 (Apache-2.0).

### 1-4. Semgrep — 정적 보안 스캔 (보안 감사를 CI화)

- **무엇**: 정적 분석·보안 스캐너 (`semgrep/semgrep`). 규칙 기반으로 코드에서 비밀키 하드코딩,
  XSS 싱크, SQL 인젝션, 안전하지 않은 정규식 등을 찾는다. `semgrep ci`로 CI에 붙인다.
- **실측**: ★17,293 · **LGPL-2.1** · 업데이트 2026-10-27 · 이슈 955.
- **왜 MyHub에 맞는지**: MyHub는 `skills/security-audit/`로 수작업 보안 감사(run-001~004)를 해왔고,
  그 과정에서 PIN race·OTP race·CSP 부재 같은 결함을 찾았다. 하지만 감사는 사람이 할 때만 돈다.
  Semgrep은 그 중 **기계적으로 찾을 수 있는 부분**(하드코딩된 비밀키·`as any` 남발·위험한
  `innerHTML` 사용·정규식 DoS 패턴)을 매 커밋마다 검사한다. MyHub 헌법이 "암호화 키는 Worker Secret만,
  코드에 하드코딩 금지"라고 못 박고 있는 것과 정확히 맞는다.
- **어디에·어떻게 적용**: `semgrep ci`를 CI 게이트로 붙이되, 처음에는 MyHub 경계에 맞는 규칙만 선별한다:
  `secrets` (하드코딩 키·토큰), `javascript.lang.security` (XSS·인젝션),
  `typescript` 관련 규칙. 오탐이 나오면 규칙을 끄는 게 아니라 **왜 오탐인지 기록하고 제외 목록을 관리**한다.
  Semgrep은 스캐너로 쓰는 것이지 코드를 복사하는 것이 아니라 LGPL이 문제가 되지 않는다
  (LGPL은 라이브러리를 링크할 때의 조건이지, 도구 사용이 아니다).
- **테스트·결함 체크**: 이슈 955건은 규모 대비 정상. 규칙 오탐이 가장 큰 운영 비용이라,
  처음에는 warning만 내고 차단 게이트는 규칙이 안정된 뒤에 건다.
- **금지 사유**: 없음 (LGPL-2.1, 도구 사용).

### 1-5. MSW — HTTP 레벨 API 모킹 (fetch 손목의 다음 단계)

- **무엇**: API 모킹 라이브러리 (`mswjs/msw`, Mock Service Worker). 테스트에서 실제 HTTP 요청을
  가로채서 핸들러가 응답을 돌려준다. `jest.fn`으로 `global.fetch`를 통째로 갈아끼우는 것과 달리,
  **실제 fetch 호출 경로·헤더·URL을 그대로 두고 응답만 바꾼다**.
- **실측**: ★18,311 · MIT · 업데이트 2026-10-17 · 이슈 17 (매우 적음).
- **왜 MyHub에 맞는지**: MyHub 테스트는 외부 API(Exa·RSS·Tavily·네이버·Gemini·Groq·NVIDIA)를
  `jest.fn(async () => ...)`으로 흉내낸다. 이 방식은 "mock이 믿는 것"만 검증해서, 실제 호출 형태
  (URL·메서드·헤더·본문)가 틀려도 테스트가 통과한다. 뉴스 체인 테스트가 대표적이다.
  MSW를 쓰면 핸들러가 URL·메서드를 보고 응답을 고르므로, **호출 형태가 틀리면 테스트가 실패**한다.
  특히 Exa 요청 파라미터(category·startPublishedDate·userLocation)가 의도대로 나가는지,
  RSS 요청에 UA 헤더가 붙는지 같은 것들을 검증할 수 있다.
  Node 환경에서는 `setupServer`로 쓰고, 브라우저 테스트에서는 Service Worker로 쓴다.
- **어디에·어떻게 적용**: 뉴스 체인·`externalWebSearch`·Google OAuth·Cloudinary 테스트부터
  `global.fetch = jest.fn(...)`을 MSW 핸들러로 바꾼다. 핸들러는 `tests/helpers/`에 두고,
  Exa·RSS·Tavily·네이버별로 응답 픽스처를 분리한다. 기존 테스트를 전부 갈아엎지 않고,
  **새로 고치는 테스트부터** MSW로 쓴다 (점진 이전).
- **테스트·결함 체크**: 이슈 17건으로 매우 안정적. MSW 자체 결함 리스크 낮음.
  주의: MSW v2는 Node 18+·`setupServer` API가 v1과 다르다 — 최신 문서 기준으로 쓴다.
- **금지 사유**: 없음 (MIT).

---

## 2순위 — POC·패턴 차용 후 판단

### 2-1. llm-guard — 입출력 가드레일 (평가용 + 패턴 차용)

- **무엇**: LLM 입출력 보안 라이브러리 (`protectai/llm-guard`). 프롬프트 인젝션 탐지,
  PII·비밀정보 탐지, 유해성·독성 탐지, 주제 제한 등을 입출력 단계에서 검사한다.
- **실측**: ★3,219 · MIT · 업데이트 2026-07-08 · 이슈 38.
- **왜 MyHub에 맞는지**: MyHub의 인젝션 경계는 지금 **규칙 기반**(마커 파서·잠금 체크·마스킹)으로 돼 있다.
  llm-guard는 같은 경계를 모델 기반으로 한 번 더 검사하는 레이어다. 특히 메모 내용을 AI에 보내기 전
  "이 메모에 인젝션 시도가 있는가"를 판정하는 스캐너로 쓸 수 있다.
- **어디에·어떻게 적용**: **Workers에서 직접 실행 불가** (Python 라이브러리). 두 가지 용도만 본다:
  (a) CI 평가용 — promptfoo/garak 하네스 옆에 두고, 인젝션 케이스셋을 llm-guard 탐지기로 채점한다.
  (b) 패턴 차용 — 탐지 규칙(정규식·휴리스틱) 중 TS로 옮길 수 있는 것만 `src/services/`에 포팅한다.
  런타임에 Python 서비스를 따로 띄우는 선택지는 셀프호스팅 부담이라 하지 않는다.
- **테스트·결함 체크**: 업데이트가 2026-07-08로 3개월 전 — 활발하지는 않으나 유지되고 있다.
  탐지기의 오탐(정상 메모를 인젝션으로 판정)이 가장 큰 리스크라, 차단이 아니라 **점수·로그부터** 본다.
- **금지 사유**: 없음 (MIT). 단, 런타임 도입 금지 — 평가·패턴까지만.

### 2-2. NeMo Guardrails — 가드레일 설계 패턴 (Colang)

- **무엇**: NVIDIA의 가드레일 프레임워크 (`NVIDIA/NeMo-Guardrails`). 대화 흐름을 Colang이라는
  DSL로 정의하고 input/output rails(입력 검사·출력 검사·주제 이탈 방지·사실 확인)를 건다.
- **실측**: ★7,375 · Apache-2.0 (LICENSE.md 직접 확인) · 업데이트 2026-10-26 · 이슈 271.
- **왜 MyHub에 맞는지**: MyHub 비서는 페르소나·capability·승인 게이트를 손으로 구현해 놨다.
  NeMo의 input rail(인젝션·주제 이탈 검사) → 본처리 → output rail(출처 형식·인용 잠금 검사) 구조는
  MyHub의 처리 파이프라인과 같은 모양이다. 특히 "모델 답변이 출처 형식을 안 지키면 다시 쓰게 한다"는
  output rail 패턴이 뉴스 출처 검증과 직접 연결된다.
- **어디에·어떻게 적용**: Python 서버를 띄우지 않는다. **설계 패턴만 차용**한다:
  `docs/`에 NeMo의 rail 구조를 MyHub 파이프라인(검색→작성→검증)에 대조한 메모를 남기고,
  검증 단계(validateItemSources·인용 잠금)를 "output rail" 개념으로 정리한다.
- **테스트·결함 체크**: 활발히 유지됨. 패턴 차용이라 코드 결함은 전파되지 않는다.
- **금지 사유**: 없음 (Apache-2.0). 서버 도입 금지 — 패턴만.

### 2-3. Opik — LLM 관측·평가 (Langfuse 대안의 가벼운 쪽)

- **무엇**: LLM 평가·관측 플랫폼 (`comet-ml/opik`). 트레이스·데이터셋·프롬프트 버전·스코어러를
  묶은 오픈소스 플랫폼. Comet ML이 유지한다.
- **실측**: ★22,950 · Apache-2.0 · 업데이트 2026-10-27 · 이슈 184.
- **왜 MyHub에 맞는지**: MyHub는 OTEL 스팬 스키마(2-2 전 조사)를 D1에 심었고 promptfoo 하네스를 갖고 있다.
  Opik은 그 두 개를 묶은 상용급 대안이다 — 트레이스를 쌓고, 평가 데이터셋을 돌리고, 스코어로 회귀를 잡는다.
  Langfuse(복합 라이선스)·Phoenix(ELv2)보다 라이선스가 깨끗하고(Apache-2.0), 규모도 크다.
- **어디에·어떻게 적용**: **자가 호스팅은 하지 않는다** (통째 설치 금지). 먼저 Opik Cloud의 무료 범위를
  확인하고(카드 필요 시 중단), 트레이스·데이터셋·스코어러의 **설계 패턴**을 promptfoo 하네스 +
  D1 스팬 테이블에 대조한다. Opik의 스코어러(정확도·환각·관련성) 정의를 promptfoo 어설션으로
  옮길 수 있는지만 본다.
- **테스트·결함 체크**: 이슈 184건으로 규모 대비 적음. 클라우드 무료 범위가 관건이라, 조건 확인 전에는
  패턴 참고로만 둔다.
- **금지 사유**: 없음 (Apache-2.0). 자가 호스팅 금지, 카드 필요 시 중단.

### 2-4. Portkey gateway — AI 게이트웨이 대안 (라우팅·가드레일·캐시)

- **무엇**: AI 게이트웨이 (`Portkey-AI/gateway`). 200개 이상 LLM을 하나의 OpenAI 호환 API로 묶고,
  라우팅·폴백·재시도·캐시·가드레일·비용 추적을 제공한다. 참고: `Portkey-AI/portkey` 저장소는
  404라, 게이트웨이 본체는 `Portkey-AI/gateway`다.
- **실측**: ★13,276 · MIT · 업데이트 2026-05-25 · 이슈 316.
- **왜 MyHub에 맞는지**: MyHub는 모델 라우팅(비서별 프로바이더 핀)·키 풀 라운드로빈·서킷브레이커·
  폴백 체인을 손으로 구현했다. Portkey는 그걸 통째로 해주는 게이트웨이다.
  특히 Gemini 장애 시 릴레이 경유·키 풀 회전 같은 로직을 게이트웨이에 맡길 수 있다.
  다만 MyHub는 이미 Cloudflare AI Gateway 관측성을 붙였고, 직접 호출 경로가 보안 경계(ZDR 등)와
  얽혀 있어 **당장 갈아탈 이유가 없다**. 비교·대안 검토용이다.
- **어디에·어떻게 적용**: 도입하지 않는다. Cloudflare AI Gateway와 Portkey의 기능 대조표만
  `docs/`에 남기고, 폴백·재시도·가드레일 규칙 중 MyHub에 없는 것을 뽑아낸다.
  게이트웨이를 실제로 쓴다면 클라우드(카드 조건 확인)부터 보고, 셀프호스팅은 하지 않는다.
- **테스트·결함 체크**: 업데이트가 2026-05-25로 5개월 전 — 활발하지 않다. 도입 전에는
  최신 커밋·유지 상태를 다시 확인할 것.
- **금지 사유**: 없음 (MIT). 셀프호스팅 금지, 카드 필요 시 중단.

### 2-5. Pact — 계약 테스트 (Deno 릴레이 계약 고정)

- **무엇**: 소비자 주도 계약 테스트 (`pact-foundation/pact-js`). 소비자가 기대하는 요청·응답을
  계약 파일로 만들고, 제공자가 그 계약을 만족하는지 검증한다.
- **실측**: ★1,825 · MIT (LICENSE 파일 직접 확인 — API는 NOASSERTION) · 업데이트 2026-10-27 · 이슈 107.
- **왜 MyHub에 맞는지**: MyHub에는 **진짜 계약**이 하나 있다 — Workers ↔ Deno Gemini 릴레이
  (`GEMINI_RELAY_URL`, `GEMINI_RELAY_SECRET`로 인증하는 POST). 릴레이 서버는 사용자가 직접 배포한
  별도 프로젝트라, 어느 쪽이 바뀌면 조용히 깨진다. 릴레이가 직접 Gemini 실패 시에만 타는 예비 경로라
  평소에는 깨진 줄도 모른다. Pact로 릴레이 요청(헤더·본문)·응답(상태·본문 형태)을 계약으로 고정하면
  릴레이 쪽 변경이 MyHub 테스트에서 잡힌다.
- **어디에·어떻게 적용**: 릴레이 계약부터 하나만 만든다. 소비자(MyHub Worker)가 기대하는
  릴레이 POST 요청·성공 응답을 Pact 계약으로 적고, CI에서 계약을 검증한다.
  Pact Broker(서버)는 안 띄우고 계약 파일을 repo에 둔다.
- **테스트·결함 체크**: 이슈 107건은 규모 대비 정상. 계약 테스트는 양쪽이 모두 돌려야 의미가 있어,
  릴레이 쪽(사용자 배포 프로젝트)에 검증 단계를 넣을 수 있을 때만 가치가 있다 — 그 점은 사용자 결정 사항.
- **금지 사유**: 없음 (MIT).

### 2-6. autoevals — 작은 평가 스코어러 모음

- **무엇**: Braintrust의 평가 스코어러 라이브러리 (`braintrustdata/autoevals`).
  정확도·관련성·유사도 등 평가 함수를 작은 단위로 제공한다. (참고: `braintrustdata/braintrust`
  저장소는 404라, 평가용 오픈소스는 autoevals가 본체다.)
- **실측**: ★1,069 · MIT · 업데이트 2026-10-22 · 이슈 48.
- **왜 MyHub에 맞는지**: promptfoo 하네스의 어설션은 지금 결정적 규칙 위주다. autoevals의
  스코어러(예: Levenshtein 유사도·JSON 일치·LLM-as-judge 래퍼)를 promptfoo 어설션에
  보강하면 "답이 비슷하지만 미묘하게 틀린" 경우를 잡을 수 있다.
- **어디에·어떻게 적용**: promptfoo 설정의 어설션으로 스코어러를 가져온다. 단, LLM-as-judge류는
  비용·변동성이 있어 결정적 규칙을 먼저 두고 보강용으로만 쓴다.
- **테스트·결함 체크**: 소규모·활발 유지. 스코어러 자체 결함보다 **판정 기준이 MyHub에 맞는지**가 관건.
- **금지 사유**: 없음 (MIT).

### 2-7. openai/evals — eval 하네스 패턴

- **무엇**: OpenAI의 평가 프레임워크 (`openai/evals`). 평가를 레지스트리 + 데이터셋 + 스코어러
  구조로 정리한 원조 격이다.
- **실측**: ★19,657 · MIT (LICENSE.md 직접 확인) · 업데이트 2026-04-14 · 이슈 350.
- **왜 MyHub에 맞는지**: promptfoo 평가셋의 구조(레지스트리·버전·스코어러 분리)를 설계할 때
  참고할 원형이다. 특히 "평가 케이스마다 어떤 모델·어떤 프롬프트 버전으로 돌렸는지"를
  기록하는 방식이 MyHub의 프롬프트 버전 관리와 맞는다.
- **어디에·어떻게 적용**: 코드를 가져오지 않고, 평가셋 디렉토리 구조·메타데이터 스키마만 참고해
  `tests/evals/`를 정리한다.
- **테스트·결함 체크**: 업데이트가 2026-04-14로 6개월 전 — 활발하지 않다. 패턴 참고용이라 리스크 없음.
- **금지 사유**: 없음 (MIT). 패턴만.

### 2-8. lm-evaluation-harness — LLM 평가 하네스 표준

- **무엇**: EleutherAI의 LLM 평가 하네스 (`EleutherAI/lm-evaluation-harness`).
  수백 개 벤치마크 태스크를 하나의 인터페이스로 돌리는 사실상 표준.
- **실측**: ★14,321 · MIT · 업데이트 2026-09-14 · 이슈 1,261.
- **왜 MyHub에 맞는지**: 라우터(Clef-flash vs 27B vs 시맨틱 라우터) 3자 측정이나 모델 비교를 할 때,
  평가 태스크를 직접 만드는 대신 표준 하네스에 얹을 수 있다. 특히 한국어 태스크가 있는지 확인하면
  Clef 한국어 평가셋 구축의 출발점이 된다.
- **어디에·어떻게 적용**: 바로 도입하지 않는다. 한국어 태스크 존재 여부와 MyHub 모델(Gemini·NVIDIA·Groq)을
  하네스에 붙이는 비용을 먼저 확인한다. 무겁고(의존성·실행 시간) Python 기반이라 CI 하네스로만 쓴다.
- **테스트·결함 체크**: 이슈 1,261건으로 많으나 규모·사용처 대비 정상 범위. 하네스 자체가 무거워
  도입 전에 실행 비용을 잰다.
- **금지 사유**: 없음 (MIT).

### 2-9. tau-bench — 대화형 에이전트 벤치마크

- **무엇**: 도구 사용 대화 에이전트 벤치마크 (`sierra-research/tau-bench`). 사용자가 대화로
  일을 시키고 에이전트가 API 도구를 써서 해결하는지를 평가한다. 참고: `tau-bench/tau-bench`
  저장소는 404라, 본체는 `sierra-research/tau-bench`다. 후속 `tau2-bench`도 같은 org에 있다.
- **실측**: ★1,480 · MIT · 업데이트 2026-03-18 · 이슈 56.
- **왜 MyHub에 맞는지**: MyHub 비서의 핵심이 바로 이것이다 — 대화로 메모·일정·할 일을 시키면
  도구를 써서 해결하는지. τ-bench의 태스크 설계(사용자 시뮬레이션·도구 호출 검증·최종 상태 비교)는
  MyHub 비서 종단 평가(promptfoo 시나리오)의 설계 참고가 된다.
- **어디에·어떻게 적용**: 벤치마크를 그대로 돌리지 않는다. 태스크 작성법(초기 상태·사용자 발화·
  기대 최종 상태)만 promptfoo 시나리오 설계에 참고한다.
- **테스트·결함 체크**: 업데이트가 2026-03-18로 7개월 전. 패턴 참고용이라 리스크 없음.
- **금지 사유**: 없음 (MIT). 패턴만.

### 2-10. Helicone — LLM 관측성 프록시

- **무엇**: LLM 관측성 플랫폼 (`helicone/helicone`). 프록시 경유로 모든 LLM 호출을 로깅·캐싱·
  비용 추적하고, 프롬프트 실험·평가를 붙인다.
- **실측**: ★6,239 · Apache-2.0 · 업데이트 2026-10-24 · 이슈 176.
- **왜 MyHub에 맞는지**: MyHub는 `ai_usage` D1 원장으로 호출을 기록하지만, 프록시 단의
  캐시(동일 요청 재사용)·비용 집계·프롬프트 실험은 없다. Helicone은 그걸 프록시 한 줄로 준다.
- **어디에·어떻게 적용**: **바로 붙이지 않는다.** 외부 모델 호출 경로에 프록시를 끼우면
  보안 경계(Groq ZDR·키 관리)와 지연이 달라진다. 먼저 무료 범위·카드 조건을 확인하고,
  캐시·비용 집계 기능 중 MyHub에 없는 것만 추려낸다. 셀프호스팅은 하지 않는다.
- **테스트·결함 체크**: 활발 유지. 프록시 경유 시 지연·장애 지점이 하나 늘어난다는 것이 리스크.
- **금지 사유**: 없음 (Apache-2.0). 카드 필요 시 중단, 셀프호스팅 금지.

### 2-11. nock — 가벼운 HTTP 모킹 (MSW 대안)

- **무엇**: Node HTTP 모킹 라이브러리 (`nock/nock`). `http.request`를 가로채서 미리 정한 응답을 준다.
- **실측**: ★13,134 · MIT · 업데이트 2026-10-20 · 이슈 110.
- **왜 MyHub에 맞는지**: MSW(1-5)와 같은 문제를 더 가볍게 푼다. MSW가 무겁다고 느껴지면 nock으로
  외부 API 테스트의 fetch를 흉내낼 수 있다. 단, nock은 Node의 http 모듈을 가로채는 방식이라
  Workers의 fetch(undici)와는 동작이 다를 수 있어, MSW보다 실런타임과의 괴리가 있다.
- **어디에·어떻게 적용**: MSW를 먼저 보고, MSW가 맞지 않을 때만 대안으로 둔다. 둘 다 도입하지 않는다.
- **테스트·결함 체크**: 장수·안정적. Workers fetch와의 괴리가 리스크라, MSW가 1순위다.
- **금지 사유**: 없음 (MIT).

### 2-12. tsd / expect-type — 타입 테스트

- **무엇**: TypeScript 타입 계약 테스트 도구.
  - **tsd** (`tsdjs/tsd`): ★2,548 · MIT · 업데이트 2025-08-05 · 이슈 54.
    `.test-d.ts` 파일로 타입 단언(`expectType`, `expectAssignable`)을 검사한다.
  - **expect-type** (`mmkal/expect-type`): ★567 · Apache-2.0 (LICENSE 파일 직접 확인) ·
    업데이트 2026-10-26 · 이슈 21. vitest/jest 안에서 타입 단언을 한다.
- **왜 MyHub에 맞는지**: MyHub는 `strict: true` + `as any` 금지 헌법을 갖고 있으나, 타입 계약이
  깨졌을 때 잡는 테스트는 없다. 특히 공용 서비스 경계(`src/services/` 함수 시그니처·
  마커 파서 반환 타입·D1 래퍼 타입)가 바뀌면 런타임에서야 터진다. expect-type이 vitest/jest
  안에서 돌아서 MyHub 테스트에 바로 붙는다.
- **어디에·어떻게 적용**: 공용 경계 타입부터 선별한다 — 마커 파서 반환 타입, `NewsSourceItem`,
  `ToolCall` 변환 타입 등. 전체 타입을 테스트하지 않고, **바뀌면 조용히 깨지는 계약만** 골라 적는다.
  tsd는 업데이트가 2025-08-05로 1년 넘게 멈춰 있어 expect-type 쪽이 낫다.
- **테스트·결함 체크**: expect-type은 작고 활발함. 타입 테스트는 런타임 결함을 잡지 못한다는 한계가 있어,
  보조 수단으로만 쓴다.
- **금지 사유**: 없음 (MIT/Apache-2.0).

### 2-13. Renovate (봇으로 사용) — 의존성 업데이트 자동화

- **무엇**: 의존성 업데이트 봇 (`renovatebot/renovate`). package.json의 의존성을 스캔해
  업데이트 PR을 자동으로 만든다. Mend(구 WhiteSource)가 유지한다.
- **실측**: ★22,911 · **AGPL-3.0** · 업데이트 2026-10-27 · 이슈 1,503.
- **왜 MyHub에 맞는지**: MyHub는 wrangler 4.147→4.152 강제 bump 같은 의존성 변경을 손으로 처리하고 있다.
  Renovate가 의존성 업데이트 PR을 만들어주면 보안 패치·호환성 깨짐을 조기에 알 수 있다.
  특히 vitest-plugin이 wrangler 버전을 강제하는 식의 결합을 PR 단위로 볼 수 있다.
- **어디에·어떻게 적용**: **GitHub App(봇)으로만 쓴다.** 코드를 복사하거나 셀프호스팅하지 않는다
  (AGPL). GitHub Marketplace에서 Renovate 앱을 설치하고, 설정 파일(`renovate.json`)만 repo에 둔다.
  major 업데이트는 자동 머지하지 않고 사람이 확인한다. Dependabot(깃허브 내장)과의 선택은 별도 판단.
- **테스트·결함 체크**: 이슈 1,503건으로 많으나 규모·사용처 대비 정상. 봇이라 코드 결함이 전파되지 않는다.
  주의: PR 폭주(의존성이 많음)를 막으려면 스케줄·그룹핑 설정을 먼저 정한다.
- **금지 사유**: AGPL-3.0 — 코드 복사·셀프호스팅 금지. 봇 사용만.

### 2-14. Biome — 린터·포매터

- **무엇**: Rust 기반 JS/TS 린터·포매터 (`biomejs/biome`). ESLint+Prettier를 하나로 합친 빠른 도구.
- **실측**: ★26,004 · Apache-2.0 · 업데이트 2026-10-27 · 이슈 552.
- **왜 MyHub에 맞는지**: MyHub에는 린터가 없다 (tsc + Jest만 있다). `as any` 남발·미사용 변수·
  일관성 없는 포맷을 기계적으로 잡을 수 있다. knip(미사용 코드)과 겹치는 부분도 있으나,
  Biome은 **코드 품질 규칙**(복잡도·안전하지 않은 패턴)까지 본다.
- **어디에·어떻게 적용**: `biome check`를 CI에 붙이되, 규칙은 처음에는 포맷 + 명백한 오류만 켜고
  점진적으로 조인다. 기존 코드 전체를 한 번에 고치지 않는다 (새 코드부터).
- **테스트·결함 체크**: 활발 유지. 린터라 코드 결함 전파 없음. 규칙 오탐은 설정으로 관리.
- **금지 사유**: 없음 (Apache-2.0).

### 2-15. Lighthouse — PWA·성능 감사

- **무엇**: 웹 품질 감사 도구 (`GoogleChrome/lighthouse`). PWA·성능·접근성·SEO 점수를 낸다.
- **실측**: ★30,953 · Apache-2.0 · 업데이트 2026-10-25 · 이슈 437.
- **왜 MyHub에 맞는지**: MyHub는 PWA(매니페스트·sw.js·푸시·오프라인 폴백)를 갖고 있고,
  iOS 키보드 같은 모바일 UX가 약점이다. Lighthouse CI로 PWA 점수·성능 회귀를 잡을 수 있다.
- **어디에·어떻게 적용**: CI에서 정적 페이지·랜딩에 대해 Lighthouse를 돌리고 PWA 카테고리 점수를
  게이트로 둔다. 단, 로그인 필수 앱이라 인증이 필요한 화면은 감사 범위를 공개 페이지로 한정한다.
- **테스트·결함 체크**: Google 공식, 장수. 로그인 앱이라 감사 범위가 좁아지는 것이 한계.
- **금지 사유**: 없음 (Apache-2.0).

### 2-16. Guardrails AI — 가드레일 프레임워크 (패턴만)

- **무엇**: 가드레일 프레임워크 (`guardrails-ai/guardrails`). RAIL(XML) 스펙으로 출력 검증기를
  정의하고, 실패 시 재시도·수정한다.
- **실측**: ★7,561 · Apache-2.0 · 업데이트 2026-10-25 · 이슈 61.
- **왜 MyHub에 맞는지**: MyHub의 뉴스 출처 검증(validateItemSources)·인용 잠금은 사실상
  "출력 가드레일"이다. Guardrails AI의 검증기·재시도 패턴(검증 실패 시 모델에게 다시 쓰게 하기)이
  같은 모양이다.
- **어디에·어떻게 적용**: Python 서버를 띄우지 않는다. 검증기 설계(검증→실패 사유→재시도) 패턴만
  `docs/`에 정리하고, 뉴스 검증·인용 잠금 로직에 대조한다.
- **테스트·결함 체크**: 활발 유지. 패턴 차용이라 리스크 없음.
- **금지 사유**: 없음 (Apache-2.0). 서버 도입 금지 — 패턴만.

### 2-17. TruLens — LLM 평가·트레이싱 (Opik 이후 검토)

- **무엇**: LLM 앱 평가·트레이싱 (`truera/trulens`). RAG 트라이어드(groundedness·answer relevance·
  context relevance) 피드백 함수로 평가한다.
- **실측**: ★3,613 · MIT · 업데이트 2026-10-26 · 이슈 117.
- **왜 MyHub에 맞는지**: 메모리 검색 품질("검색은 되는데 쓰이지 않는 기억")을 수치화할 때
  TruLens의 RAG 평가(검색 결과와 답변의 근거 일치)가 맞는다. Opik(2-3)과 겹치므로 둘 중 하나만 본다.
- **어디에·어떻게 적용**: Opik을 먼저 보고, Opik이 맞지 않을 때만 검토한다. Python 기반이라 CI 하네스로만 쓴다.
- **테스트·결함 체크**: 활발 유지. RAGAS와 같은 계열이라 promptfoo 이후 단계다.
- **금지 사유**: 없음 (MIT).

---

## 3순위 — 지켜보기 / 패턴만

### 3-1. Cypress — E2E (중복)

- **무엇**: 브라우저 E2E 프레임워크 (`cypress-io/cypress`).
- **실측**: ★51,017 · MIT · 업데이트 2026-10-27 · 이슈 1,158.
- **왜 3순위인지**: Playwright가 이미 repo에 있고(`tests/e2e/`, Jest에서 제외), VM에서는 Chromium
  다운로드가 차단돼 브라우저 E2E 자체가 안 돈다. Cypress를 추가해도 같은 벽에 부딪힌다.
  Playwright로 충분하고, E2E는 사용자가 실기기로 하는 QA가 담당하고 있다.
- **금지 사유**: 없음 (MIT). 도입할 이유 없음.

### 3-2. Rebuff / HarmBench / JailbreakBench — 방치된 평가 도구

- **Rebuff** (`protectai/rebuff`): ★1,532 · Apache-2.0 · 업데이트 **2024-08-07** · 이슈 32.
  프롬프트 인젝션 탐지 라이브러리. 2년 넘게 업데이트가 없어 사실상 방치됐다. garak·llm-guard로 간다.
- **HarmBench** (`CenterForAISafety/HarmBench`): ★1,082 · MIT · 업데이트 **2024-08-16** · 이슈 41.
  유해성 벤치마크(데이터셋). 2년 방치. 안전성 평가 데이터셋으로만 참고하고, 하네스는 promptfoo·garak으로 간다.
- **JailbreakBench** (`JailbreakBench/jailbreakbench`): ★690 · MIT · 업데이트 2025-04-04 · 이슈 12.
  탈옥 벤치마크. 규모가 작고 업데이트가 뜸하다. garak의 DAN 프로브가 같은 역할을 한다.
- 공통: 도입 금지, 참고만. 오래된 평가셋은 모델이 이미 외운 답을 낼 수 있어(데이터 오염) 가치가 떨어진다.

### 3-3. PurpleLlama — Llama Guard (커스텀 라이선스 + 모델 호스팅)

- **무엇**: Meta의 AI 안전 도구 모음 (`meta-llama/PurpleLlama`). Llama Guard(입출력 유해성 분류 모델)가 핵심.
- **실측**: ★4,448 · 라이선스 API상 NOASSERTION — LICENSE 파일 직접 확인 결과 **Llama 3.2 Community
  License (커스텀)** · 업데이트 2026-10-12 · 이슈 89.
- **왜 3순위인지**: Llama Guard는 모델을 직접 호스팅해야 해서 Workers에 안 맞고,
  커스텀 라이선스라 코드 복사도 안 된다. 가드 모델의 분류 체계(카테고리 정의)만 참고한다.
- **금지 사유**: 커스텀 라이선스 — 코드 복사 금지, 패턴만.

### 3-4. SWE-bench / AgentBench — 무거운 벤치마크

- **SWE-bench** (`SWE-bench/SWE-bench`): ★6,094 · MIT · 업데이트 2026-09-18 · 이슈 52.
  코드 수정 벤치마크(깃허브 이슈 → 패치). 노바(코드 비서) 평가에 쓸 수 있으나 Docker·실행 환경이 무겁다.
- **AgentBench** (`THUDM/AgentBench`): ★3,792 · Apache-2.0 · 업데이트 2026-02-08 · 이슈 80.
  에이전트 벤치마크(웹·게임·OS 등). 업데이트가 8개월 전이고 태스크가 MyHub와 거리가 멀다.
- 공통: 벤치마크를 그대로 돌리지 않는다. 태스크 설계만 참고하고, 노바 평가는 별도 판단.

### 3-5. 에이전트 프레임워크 7종 — 교체할 이유 없음, 패턴만

MyHub의 오케스트레이션(concierge/keeper/builder/scheduler + FC 루프 + 핸드오프 + 승인 게이트)은
손으로 구현돼 있고 동작한다. 프레임워크로 갈아타는 것은 사실상 재작성이라, 아래는 패턴 참고만 한다.

- **mastra** (`mastra-ai/mastra`): ★29,095 · 업데이트 2026-10-27 · 이슈 621.
  라이선스 **복합**: 기본 Apache-2.0이나 `ee/` 디렉토리는 별도 상용 라이선스(LICENSE.md 직접 확인).
  TS 네이티브 에이전트 프레임워크(워크플로·메모리·평가 내장). ee/ 부분은 사용 금지.
- **langgraphjs** (`langchain-ai/langgraphjs`): ★3,376 · MIT · 업데이트 2026-10-27 · 이슈 191.
  LangChain의 그래프 기반 에이전트 런타임(TS). 상태 머신·체크포인팅 패턴이 MyHub의 agent_runs와
  같은 문제라, 체크포인팅 설계만 참고한다.
- **LlamaIndexTS** (`run-llama/LlamaIndexTS`): ★3,082 · MIT · 업데이트 2026-03-11 · 이슈 149.
  RAG·에이전트 TS 프레임워크. 업데이트가 7개월 전으로 뜸하다. RAG 인덱싱 패턴만 참고.
- **agno** (`agno-agi/agno`): ★42,905 · Apache-2.0 · 업데이트 2026-10-27 · 이슈 1,936.
  Python 중심 에이전트 프레임워크(멀티모달·팀). ★는 크나 Python이라 Workers와 맞지 않는다.
  팀·위임 패턴만 참고.
- **pydantic-ai** (`pydantic/pydantic-ai`): ★20,889 · MIT · 업데이트 2026-10-27 · 이슈 1,528.
  Pydantic의 타입 안전 에이전트 프레임워크(Python). 타입으로 도구 계약을 고정하는 패턴이
  MyHub의 FC 도구 정의와 같은 문제라, 타입 설계만 참고한다.
- **autogen** (`microsoft/autogen`): ★61,576 · 업데이트 2026-10-16 · 이슈 1,124.
  라이선스 API·LICENSE 파일 모두 **CC-BY-4.0** (코드에 CC 라이선스는 이례적 — 복사 전 직접 확인 필요).
  멀티 에이전트 대화 패턴의 원조 격이나, 코드 라이선스가 불분명해 패턴 참고로만 둔다.
- **semantic-kernel** (`microsoft/semantic-kernel`): ★28,701 · MIT · 업데이트 2026-10-26 · 이슈 350.
  MS의 에이전트 SDK(플러그인·계획·메모리). 플러그인(스킬 패키지) 설계만 참고한다.

### 3-6. konlpy / soynlp — 한국어 형태소 분석 (Workers 불가)

- **konlpy** (`konlpy/konlpy`): ★1,495 · **GPL-3.0** (LICENSE 파일 직접 확인) · 업데이트 **2023-08-28** ·
  이슈 145. 한국어 형태소 분석 패키지(Python). 3년 방치 + GPL이라 코드 복사 금지.
- **soynlp** (`lovit/soynlp`): ★996 · **LGPL-3.0** (LICENSE 파일 직접 확인) · 업데이트 2026-10-04 · 이슈 26.
  비지도 한국어 분석(품사·키워드 추출). Python이라 Workers에서 실행 불가.
- **왜 참고만 하는지**: MyHub의 한국어 처리는 FTS5 토큰화·조사 분리·엔티티 정규화 수준인데,
  형태소 분석기가 있으면 "보라돌이" 같은 고유명사 처리·조사 분리가 정확해진다. 그러나 Python
  라이브러리를 Workers에서 돌릴 수 없어, **분석 아이디어**(조사 분리 규칙·명사 추출 방식)만 참고한다.
  실제 형태소 분석이 필요해지면 Workers AI의 한국어 임베딩(bge)·Clef 라우터 쪽이 현실적이다.
- **금지 사유**: GPL/LGPL 코드 복사 금지, Python이라 도입 불가.

### 3-7. KLUE — 한국어 평가 데이터셋 (Clef 평가셋 재료로만)

- **무엇**: 한국어 이해 평가 벤치마크 (`KLUE-benchmark/KLUE`). NLI·NER·의존 구문 분석 등 태스크 모음.
- **실측**: ★606 · CC-BY-SA-4.0 · 업데이트 2026-06-30 · 이슈 19.
- **왜 참고만 하는지**: Clef-flash 한국어 평가셋(100~200건)을 구축할 때 한국어 문장 재료로 쓸 수 있다.
  다만 KLUE는 의도 분류가 아니라 일반 NLP 벤치마크라, 그대로 쓰지 않고 문장만 참고한다.
  참고: KoBEST는 공식 저장소를 찾을 수 없었다(`monologg/KoBEST` 404, 검색에도 공식 저장소 없음 — 미확인).
  KMMLU도 공식 저장소 확인 불가(HAERAE-Hub/KMMLU 404) — 미확인으로 기록한다.
- **금지 사유**: 없음 (CC-BY-SA-4.0 — 데이터셋 사용 시 출처 표기).

### 3-8. Socket.dev — 공급망 보안 스캔 (서비스형)

- **무엇**: 의존성 공급망 보안 (`SocketDev/socket-cli` — CLI. 참고: `SocketDev/socket` 저장소는 404).
- **실측**: ★336 · MIT · 업데이트 2026-10-26 · 이슈 27.
- **왜 3순위인지**: 의존성의 악성 코드·유출 토큰을 스캔한다. Semgrep(1-4)·Renovate(2-13)와 겹치고,
  본 스캔은 서비스형이라 무료 범위·카드 조건을 확인해야 한다. CLI ★336으로 규모가 작다.
- **금지 사유**: 없음 (MIT). 카드 필요 시 중단.

### 3-9. arethetypeswrong — 패키지 타입 검사 (적합성 낮음)

- **무엇**: npm 패키지의 타입 선언이 올바른지 검사하는 도구. 본체는 `arethetypeswrong/arethetypeswrong.github.io`.
- **실측**: ★1,611 · MIT · 업데이트 2026-07-09 · 이슈 35.
- **왜 3순위인지**: MyHub는 npm 패키지를 배포하지 않아, 패키지 타입 검사와 직접 관련이 없다.
  expect-type(2-12)이 MyHub 안의 타입 계약을 보는 쪽이 맞다.
- **금지 사유**: 없음 (MIT).

---

## 적용 금지 / 부적합 (이번 조사에서 확인된 것)

| 후보 | 사유 |
|---|---|
| renovate 코드 복사·셀프호스팅 | **AGPL-3.0** — 봇으로 쓰는 것만 허용, 코드 복사·셀프호스팅 금지 |
| konlpy 코드 복사 | **GPL-3.0** (LICENSE 확인) — 복사 금지, 아이디어만 |
| soynlp 코드 복사 | **LGPL-3.0** (LICENSE 확인) — 복사 금지, 아이디어만 |
| PurpleLlama 코드 복사 | **Llama 3.2 Community License (커스텀)** — 복사 금지, 분류 체계만 참고 |
| mastra `ee/` 디렉토리 사용 | 별도 상용 라이선스 (복합 라이선스) — 사용 금지 |
| autogen 코드 복사 | **CC-BY-4.0** (API + LICENSE 파일 일치) — 코드에 CC 라이선스는 이례적, 복사 전 직접 확인 필요 |
| Rebuff / HarmBench 도입 | 2년 이상 업데이트 없음 (2024-08) — 사실상 방치, 참고만 |
| 통째 설치류 (Portkey/Helicone/Opik 셀프호스팅, NeMo Guardrails 서버, Guardrails AI 서버) | 셀프호스팅 부담 — 사용자 지시로 금지, 패턴·클라우드 평가만 |
| KoBEST / KMMLU | 공식 저장소 확인 불가 (404) — 참고 불가, 미확인 |
| Cypress 도입 | Playwright 이미 있음 + VM Chromium 차단 — 중복 |
| 에이전트 프레임워크로 갈아타기 (mastra·agno·autogen 등) | 사실상 재작성 — 패턴만 |

## Cloudflare 생태계 후속 메모 (2026-10-27 확인, 이전 문서 이후 신규 사항만)

- **Workers AI 뉴런 과금 정리 (2026-10 기준)**: 매일 10,000 뉴런 무료, 초과분은 1,000 뉴런당 $0.011
  (Workers Paid 전제). 무료 할당은 매일 00:00 UTC 리셋. MyHub가 Workers AI로 쓰는 것(Clef-flash 라우터·
  bge 임베딩)은 무료 범위 안에 들어가는지, `ai_usage`와 함께 볼 만하다. Paid 전환이 필요해지면
  카드·과금 동의가 필요하므로 사전 결정 사항이다 (사용자 원칙).
- **Clef·Clef-omni·Clairic**: 이전 문서(2026-10-26) 이후 신규 소식 없음. Clef-flash 평가셋 전에는
  켜지 말 것(이전 결론 유지). Clef-omni는 멀티모달 결정 모델이라 음성·이미지 라우팅의 다음 단계 후보로만 기록한다.
- **Lovable의 Workers 이전 사례 (2026-10-23)**: 7천만 개 AI 생성 앱을 Workers로 옮긴 사례가 보도됐다.
  MyHub과 직접 관련은 없으나, Workers에서 대규모 앱을 돌릴 때의 병목이 메모리(128 MB 격리)라는 점은
  MyHub 번들(4.2 MB)·DO 설계에도 참고가 된다.

## 지금 바로 적용할 것 3가지

1. **StrykerJS로 뮤테이션 스코어 재기 (1-1)**
   — "테스트가 진짜 잡는지"를 숫자로 만드는 유일한 직접 수단. 뉴스 날짜 필터·인증 잠금·마커 파서
   3~6개 핵심 파일부터 스코프를 좁혀 돌리고, survived mutant가 나온 곳의 테스트를 보강한다.
   카나리아 검증을 자동화하는 셈이다. 처음에는 리포트만 보고, CI 게이트는 나중에 합의한다.
2. **fast-check 속성 테스트를 파서·필터에 붙이기 (1-2)**
   — 마커 파서·날짜 필터·FTS 쿼리 빌더처럼 순수 로직에 성질 3~5개부터 적는다.
   반례가 나오면 그 반례를 회귀 테스트로 고정한다. 의존성 1개, Workers 코드 변경 없음.
3. **garak으로 인젝션 경계 레드티밍하기 (1-3)**
   — 메모발 인젝션이 MyHub의 핵심 보안 경계다. promptinject·encoding·DAN 프로브부터
   스테이징/운영 채팅에 대고 돌려 뚫리는 패턴을 찾아 회귀 테스트로 고정한다.
   쓰기 케이스는 스코프에서 빼고, 실행은 사전 승인하에 한다.

> 다음 단계 제안: 1-1·1-2·1-3 중 사용자가 고른 것부터 작업한다. 1-4(Semgrep)·1-5(MSW)는
> 테스트 인프라 정리와 함께 붙이면 된다. 2순위는 1순위가 돈 뒤에 검토한다.
