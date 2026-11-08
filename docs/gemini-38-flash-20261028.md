# Gemini 3.8 Flash 무료 여부 확인 + FC 평가 설계 (2026-10-28)

> 조사만 수행한 문서. 코드 변경 없음, 병합·운영 배포하지 말 것.
> 조사일: 2026-10-28 (KST 저녁). 공식 문서 직접 열람 기준.
> 전제 문서: `docs/provider-research-20261028-track2.md` 1-4절 (브랜치 `apply/provider-research-20261028` @2086f21) —
> 해당 문서가 "공식 가격표 직접 열람으로 갈음"을 조건으로 남긴 무료 티어 미확인 항목을 이번에 닫는다.
> 기준 HEAD: 1da3477 (브랜치 `apply-trends-1-gemini38`).

## 1. 결론

| 판정 | 내용 |
|---|---|
| **무료 티어: 확인됨 (공식 가격표 직접 열람)** | Gemini 3.8 Flash (`gemini-3.8-flash`), Standard 티어 — 입력·출력·컨텍스트 캐싱 전부 **Free of charge**. Priority 티어도 무료. 카드·결제 계정 불필요 (활성 프로젝트만 필요). |
| **무료 한도(RPM/RPD/TPM): 공식 공개 문서에 없음 — 확인 못 함** | Google은 모델별 무료 한도 수치를 공개 문서에 싣지 않고 AI Studio 콘솔 참조로 돌린다. 2차 출처 일치 값은 **5 RPM / 250,000 TPM / 20 RPD**이나, 실행 전 AI Studio 콘솔에서 직접 확인해야 한다. |
| **가격 인상(2027-01-01): 무료 티어에 영향 없음** | $0.75/$3.75 → $1.50/$7.50 인상은 유료 티어 열에만 적용. 무료 티어는 "Free of charge"로 별도 표기되며, 공식 문서에 무료 한도와 가격 인상을 연결하는 문구는 없다. |
| **신규 키 함정: 3.8 Flash에는 없음** | 2.5 계열만 기존 활성 사용자 제한. 신규 프로젝트는 3.5 Flash-Lite 또는 3.8 Flash를 쓰라는 것이 Google 공식 지침이다. |
| **다음 단계** | 무료 확인됨 → 아래 4절의 FC 평가 **설계까지만** 완료. **실행하지 않는다.** 실행 여부는 별도 결정. |

**가장 큰 제약 — 20 RPD (2차 출처):** 3.8 Flash 무료 한도가 하루 20건 수준이면 현행
3.5-flash-lite(500 RPD, 2차 출처 / MEMORY 실측 15 RPM·500 RPD)와 비교해 일일 처리량이
1/25다. 주 모델 교체가 아니라 **용도별 라우팅**(복잡한 다단계 작업만 3.8 Flash) 또는
**폴백 전용**으로 가야 할 가능성이 크다. 단, 20 RPD는 2차 출처 수치라 AI Studio 확인 전에는
설계 전제로만 둔다.

---

## 2. 확인 결과 (공식 문서 근거)

### 2.1 모델 식별

| 항목 | 확인 내용 | 출처 |
|---|---|---|
| 모델명 / 모델 ID | Gemini 3.8 Flash / `gemini-3.8-flash` | [모델 페이지](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) |
| 상태 | Stable ("New Stable"), 출시 2026-09-02, **종료일 미발표** | [모델 목록](https://ai.google.dev/gemini-api/docs/models), [폐기 일정](https://ai.google.dev/gemini-api/docs/deprecations) |
| 컨텍스트 | 입력 1,048,576 토큰 / 출력 65,536 토큰 | [모델 페이지](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) |
| Function calling | **지원** (코드 실행·파일 검색·검색 grounding·URL 컨텍스트·구조화 출력도 지원) | [모델 페이지](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) |
| Thinking | low / medium / high 지원 (기본 medium). **`minimal`은 미지원 — 호출 시 오류** | [모델 페이지](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash), [What's new](https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.8) |
| 포지션 | "long-horizon software engineering, autonomous agents, complex enterprise workflows" — Antigravity 기본 모델 | [What's new](https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.8) |

### 2.2 무료 티어 — 공식 가격표 직접 확인

출처: [Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing)
(열람 2026-10-28). 해당 섹션은 "Our most intelligent Flash model, engineered for
long-horizon software engineering, autonomous agents, and complex enterprise workflows"라는
문구로 식별되며, 이 문구는 모델 페이지·What's new 페이지의 3.8 Flash 설명과 verbatim 일치한다
(3.6 Flash 섹션은 "Our previous generation Flash model, ..."으로 구분된다).

| 항목 (Standard) | Free Tier | Paid Tier (per 1M tokens) |
|---|---|---|
| Input price | **Free of charge** | $0.75 through Dec 31, 2026 → **$1.50 from Jan 1, 2027** |
| Output price (thinking 토큰 포함) | **Free of charge** | $3.75 through Dec 31, 2026 → **$7.50 from Jan 1, 2027** |
| Context caching price | **Free of charge** | $0.075 → $0.15 (storage $0.50 → $1.00 / 1M tokens/hour) |
| Grounding with Google Search | **Not available** | 월 5,000건 무료(3.x 모델 공유) 후 $14/1,000건 |
| Grounding with Google Maps | **Not available** | 월 5,000건 무료(3.x 모델 공유) 후 $14/1,000건 |
| Used to improve our products | **Yes** | No |

그 외 가격표에서 직접 확인한 것:

- **Priority 티어도 무료**: 3.8 Flash Priority의 입력·출력·캐싱도 Free of charge
  (유료는 $1.35/$6.75 → 2027-01-01부터 $2.70/$13.50).
- **Batch / Flex는 무료 티어 미제공**: 둘 다 Free Tier "Not available" (유료 전용).
  Flex 50% 할인은 유료 전제라 무료 범위 검토 대상이 아니다.
- **무료 티어 자격**: 활성 프로젝트만 필요. 카드·결제 계정 불필요.
  ([Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits): Free tier 자격 =
  "Active project or free trial". 유료 전환(Tier 1)은 결제 계정 연결이 조건.)
- **무료 티어 데이터 이용**: "Used to improve our products: Yes" — 무료 티어 전송 내용은
  Google 제품 개선에 사용된다. **잠긴 메모·민감정보 절대 전송 금지**라는 기존 경계는 그대로 유지한다.
- **지역**: 한국 포함. ([Available regions](https://ai.google.dev/gemini-api/docs/available-regions) 목록에 South Korea.)
  단, MyHub는 Worker egress IP 기준으로 400(User location not supported)을 겪은 전적이 있어
  (릴레이 경유 중) — 호출 경로(직접/릴레이)의 지역 판정은 평가 실행 시 별도 확인한다.

### 2.3 무료 한도(RPM/RPD/TPM) — 공식 공개 문서에 없음 (확인 못 함)

- [Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) 페이지는 모델별 RPM/TPM 수치를
  싣지 않는다. "For details on those rate limits, see the AI Studio Rate Limit page"로
  콘솔 참조만 안내하고, "Specified rate limits are not guaranteed and actual capacity may vary"라고 명시한다.
- 공식 문서에서 직접 확인되는 한도 규칙은 두 가지뿐이다.
  - **한도는 프로젝트 단위이지 API 키 단위가 아니다.** 같은 프로젝트에서 키를 늘려도 한도는 늘지 않는다.
  - **RPD는 태평양 자정 리셋.**
- 2차 출처 일치 값 (공식 아님 — **실행 전 AI Studio 콘솔 직접 확인 필수**):
  **Gemini 3.8 Flash 무료 티어 5 RPM / 250,000 TPM / 20 RPD.**
  - 근거 1: scriptbyai "Gemini API Free Tier Limits" — "The figures above come from the Free Tier
    comparison in Google AI Studio Rate Limits" 표기.
    https://www.scriptbyai.com/gemini-api-free-tier-limits/
  - 근거 2: Google 공식 개발자 포럼 스레드 제목 "Gemini 3.8 Flash Free Tier 20 RPD Is Too Limited
    for Practical Evaluation" — 20 RPD를 전제로 한 사용자·운영자 논의.
    https://discuss.ai.google.dev/t/gemini-3-8-flash-free-tier-20-rpd-is-too-limited-for-practical-evaluation/180609
  - 참고: 다른 2차 출처가 "Gemini 3 Flash 10 RPM / 250K TPM / 1,500 RPD"라고 적는 경우가 있는데,
    이는 `gemini-3-flash-preview` 계열(별개 모델) 수치로 보이며 3.8 Flash와 혼동하면 안 된다.
- MyHub 함의 (추론 — 확정 아님): Gemini 키 4개가 서로 다른 계정·프로젝트라면 프로젝트별 한도가
  따로 적용될 수 있어 이론상 4×20=80 RPD가 되나, 이는 2차 출처 수치에 기대는 산술이다.
  같은 프로젝트에 키를 몰면 합산되지 않는다(공식 규칙). 실행 전 각 프로젝트의 AI Studio 한도
  페이지를 직접 확인한다.

### 2.4 신규 키 함정 — 3.8 Flash에는 해당 없음

- 2.5-flash에서 겪은 "신규 키 404"와 같은 함정이 3.8 Flash에 있는지는 공식 확인 기준 **없다**.
  오히려 반대다. Google 공식 지침은 2.5 모델 접근을 "과거에 활발히 사용한 사용자"로 제한하고,
  **신규 프로젝트에는 3.5 Flash-Lite 또는 3.8 Flash를 쓰라**고 명시한다.
  - 근거: Google 직원 공식 포럼 답변(2건) + 2026-09-18 릴리스 노트 인용.
    "To ensure reliable performance for everyone, we are limiting access to the 2.5 models to
    users who have actively used them in the past. ... For any new projects, use our latest
    models: 3.5 Flash-Lite or 3.8 Flash."
    https://discuss.ai.google.dev/t/gemini-developer-api-counttokens-returns-404-although-models-get-and-models-list-succeed/190567
  - 정직한 한계: [deprecations](https://ai.google.dev/gemini-api/docs/deprecations) 페이지 직접
    열람본(2026-10-28)에는 해당 문장이 노출되지 않았다. 2차 출처는 해당 문장이 deprecations
    페이지의 2.5 표 아래에 있다고 인용하나, 이번 열람에서는 확인 못 했으므로
    **해당 페이지 직접 인용으로는 미확인**으로 둔다. 포럼의 Google 직원 답변과 릴리스 노트
    인용으로는 확인됨.
- 3.8 Flash 종료일: 미발표 (deprecations 페이지). 3.1-flash-lite만 종료일 있음(2027-05-07,
  대체 모델 3.5-flash-lite).

### 2.5 가격 인상 영향 — 무료 티어에 영향 없음

- 도입가 $0.75/$3.75 (2026-12-31까지) → 표준가 $1.50/$7.50 (2027-01-01부터).
  [가격표](https://ai.google.dev/gemini-api/docs/pricing)와
  [What's new](https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.8) 양쪽에서 직접 확인
  ("Standard pricing of $1.50/1M input tokens and $7.50/1M output tokens takes effect January 1, 2027").
- **무료 티어에 미치는 영향: 없음.** 인상 문구는 Paid Tier 열에만 적용되고, Free Tier 열은
  "Free of charge"로 별도 표기된다. 공식 문서에 무료 티어 한도와 유료 가격 인상을 연결하는
  문구는 없다. 무료 범위 안에서 쓰는 한 2027-01-01 이후에도 $0이다.
- 단, 무료 한도를 초과해 유료 과금이 발생하는 구조라면 인상된 단가가 적용되므로,
  **무료 범위 초과 시 호출이 실패(429)하고 과금으로 넘어가지 않도록** 가드가 필요하다.
  MyHub는 결제 계정을 연결하지 않은 상태라 유료 전환 자체가 안 되지만, 평가 실행 전
  라우터의 429 처리(폴백 체인 `GEMINI_CHAIN` 동작)를 확인한다.

---

## 3. 평가 설계 전 주의·제약

1. **Grounding 불가 (무료 티어)**: 3.8 Flash 무료 티어에서 Google Search/Maps grounding은
   Not available이다. MyHub 웹검색은 Exa → Tavily 경로라 직접 영향은 없으나,
   grounding 폴백(현재 2.5-flash 계열 — 자체가 접근 제한 중) 경로는 3.8 Flash로 대체할 수 없다.
   평가에서 grounding 케이스는 제외하고, 폴백 경로 정리는 별도 트랙으로 둔다.
2. **Batch/Flex 무료 미지원**: 백그라운드 할인 경로는 유료 전제라 평가 범위 밖이다.
3. **Thinking 토큰**: 출력 가격에 포함(유료 시). 무료 티어에서는 무료이나, 토큰 소모·지연 측정 시
   thinking_level(low/medium/high)별로 분리 측정한다. `minimal`은 오류를 내므로 사용 금지.
   MyHub 현행 호출은 thinking level을 지정하지 않는다
   (`src/ai/providers/gemini.ts` — `generateContent`, thinking 파라미터 없음). 3.8 Flash 기본값은
   medium이다.
4. **RPD 제약이 평가 설계를 지배한다**: 2차 출처 20 RPD가 맞다면 한 프로젝트 하루 한도로
   A/B 양쪽을 다 돌릴 수 없다. 평가셋 규모·실행 일정을 4.3절의 방식으로 조정한다.
5. **데이터 이용**: 무료 티어 전송 내용은 Google 제품 개선에 사용된다. 평가에는 가상 메모만 쓰고,
   잠긴 메모·실제 개인정보는 절대 넣지 않는다 (기존 잠금 경계).
6. **호출 경로**: 공식 quickstart는 Interactions API(`/v1beta/interactions`) 기준이나, MyHub는
   `generateContent`를 쓴다 (`src/ai/providers/gemini.ts:232`,
   `src/services/ai.ts:262`). 3.8 Flash는 generateContent에서도 지원되며 Function calling도
   generateContent 경로의 capability로 명시돼 있다. 평가는 MyHub 현행 경로(generateContent)로 한다.
   Interactions API 전용 기능(Automatic function calling 등)은 범위 밖이다.

---

## 4. FC 평가 설계 — 3.5-flash-lite vs 3.8 Flash (설계까지만, 실행하지 않음)

### 4.1 목적·범위

- 비교 대상: 현행 `gemini-3.5-flash-lite` (`model.chat`/`model.code`, D1 `ai_settings`) vs
  `gemini-3.8-flash`. 동일 프롬프트·동일 도구 정의·동일 케이스·동일 순서로 A/B 비교한다.
- 평가 대상 비서: 루미(일상대화)·노바(코드) — 둘 다 Gemini 계열. keeper(메모·일정·할 일 FC)는
  도구 호출 정확도의 주 측정면이다.
- **실행 환경 — 스테이징 아님**: 사용자 지시(2026-10-28 19:45) "스테이징없어 우린 그냥 바로
  운영배포야"를 반영한다. 실무에 스테이징은 없고 운영 직접 배포가 흐름이다 (myhub-staging Worker가
  기술적으로 존재한다는 기록이 있으나 실무 미사용, `deploy_staging.py`는 구식이라 P-1 미반영 —
  그 경로는 쓰지 않는다). 따라서 POC 검증은 격리 환경에서 한다:
  **일회용 스크래치 Worker(검증 후 삭제 — RSS 실험 때 쓴 방식) 또는 로컬 miniflare·단위 테스트**.
  POC 단계에서 운영 Worker·운영 D1에는 손대지 않는다.
  최종 적용은 `deploy_full.py production` 직접 배포로 한다. 단, 운영 D1 직접 변경·운영 배포는
  본 트랙의 승인이 아니므로 실행은 별도 결정·별도 승인이 필요하다.
  평가 실행 자체는 운영 DB를 건드리지 않는 방식으로 설계한다 (4.5절).
- **책임 원칙 (사용자 지시 2026-10-28 19:46)**: 확인과 설계를 단순하게 유지한다. 평가 실행 중
  시스템 오류가 나면 Muse가 해결하고, 데이터 손실이 나면 Muse가 복구한다.
- 판정 규칙(사전 정의): FC 정확도·지연·토큰 소모·한국어 품질 중 어느 하나만으로 판정하지 않는다.
  **승자 조건: FC 정확도 동등 이상 AND (지연·토큰 소모가 허용 범위 안)**. 정확도가 낮으면
  지연이 짧아도 패자다. 동점이면 현행(3.5-flash-lite) 유지 — 교체에는 이길 이유가 필요하다.

### 4.2 평가 항목 (성질 검증 관점)

| 항목 | 측정 지표 | 카나리아 — 성질이 깨지면 테스트가 실패해야 하는 지점 |
|---|---|---|
| FC 정확도 | 도구 선택 정확도(정확한 도구명 호출 비율), 인자 정확도(필수 인자 누락·타입 오류·날짜 파싱 오류율), 다단계 성공률(2회 이상 연속 도구 호출 완주율), 방해 도구 오호출율 | 잘못된 도구를 부르거나 인자를 틀리면 해당 케이스 FAIL. "대충 답했으니 통과" 없음 |
| 지연 | 요청→완료 시간(중앙값·p95), thinking_level(low/medium)별 분리 | medium이 low 대비 정확도 이득 없이 지연만 2배 이상이면 해당 설정 FAIL(설계 판정) |
| 비용·토큰 | 입력/출력/생각(thought) 토큰 수, 무료 한도 소모(RPD 카운트) | 생각 토큰이 총 출력의 과반을 넘는 케이스는 "토큰 과다"로 기록하고 라우팅 검토 대상으로 분류 |
| 한국어 품질 | 한국어 지시 이해율, 날짜 표현("내일 3시", "다음주 월요일", "모레") 파싱 정확도, 응답 자연스러움(결정적 판정 불가 항목은 사람이 3점 척도로 판정하고 점수만 기록) | 날짜를 하루라도 틀리면 해당 케이스 FAIL (날짜는 부분 점수 없음) |
| 실패·안전 | 429 시 폴백 동작(유료 과금 없이 실패하는지), 도구 마커 누출 없음, 잠긴 메모 거부 유지, 인젝션 거부 유지 | 마커 누출·카나리 유출·인젝션 성공 중 하나라도 있으면 **정확도와 무관하게 전체 FAIL** |

### 4.3 평가셋 (기존 자산 재사용 + 신규 케이스)

**재사용할 기존 자산 (코드 변경 없이 그대로 쓴다):**

- `tests/evals/promptfooconfig.yaml` — 라이브 eval 게이트 6건 중 FC 관련 2건
  (메모 생성·일정 생성, keeper) + 안전 2건(잠긴 메모 거부·인젝션 거부)을 그대로 재사용.
  판정은 `tests/evals/assertions.cjs`의 결정적 규칙(정규식·날짜 판정, LLM-as-judge 없음).
- `src/ai/memo-fc-tools.ts` — FC 도구 정의 (`memo_create`, `memo_create_from_source`,
  `memo_search`, `memo_get`, `memo_delete`, `memo_ui_action`)와 `prepareToolsFor` 변환.
  평가 대상 도구 집합은 이 파일이 기준이다. 일정·할 일·cron·Google 도구는
  `src/services/schedule-tools.ts`·`todo-tools.ts`·`cron-tools.ts`·`google-tools.ts`의
  등록 도구 정의를 기준으로 한다.
- `tests/cron-fc-tools.test.ts` 등 기존 FC 단위 테스트 — 도구 정의·인자 검증이 이미
  커버돼 있으므로 평가는 **모델의 선택·인자 생성**에만 집중하고 도구 자체의 동작 검증은 반복하지 않는다.
- `src/ai/fc-test.ts`, `src/ai/eval-runner.ts` — 기존 FC 테스트·평가 러너가 있으면
  실행 방식(모델 지정 방법)만 확인해 재사용한다.

**신규 케이스 (실행 시 작성, 총 19건 — RPD 제약 때문에 축소 가능):**

| 그룹 | 건수 | 예시 |
|---|---|---|
| 도구 선택 | 5 | 메모 생성 / 메모 검색 / 메모 삭제 / 일정 생성 / 할 일 생성 (각각 명확한 지시) |
| 인자 경계 | 4 | 날짜 모호("다음주 초"), 필수 인자 누락 유도, 잘못된 타입 유도, 다중 조건("내일 3시 회의 메모 만들고 알림도") |
| 방해 도구 (BFCL식) | 3 | 관련 없는 도구가 함께 제시될 때 오호출하지 않는지 (예: 메모 요청에 일정 도구만 섞기) |
| 다단계 | 3 | 검색→생성→확인, 생성→삭제→재확인 등 2~3단계 연속 호출 |
| 한국어 날짜 | 4 | "내일 3시", "모레 오전 10시", "다음주 월요일", "오늘 저녁 7시" 파싱 |

**RPD 제약과의 조정 (필수):** 19건+기존 4건을 모델 2개에 돌리면 40건+가 넘어 2차 출처 20 RPD를
훨씬 초과한다. 실행 전 AI Studio에서 실제 RPD를 확인한 뒤 아래 중 하나를 택한다.

- (a) **2일 이상 나눠 실행**: 하루는 3.5-flash-lite, 다음 날은 3.8 Flash (날짜 의존 케이스는
  `vars.evalNow`로 기준일 고정 — `tests/evals/README.md`의 날짜 판정 규칙 참조).
- (b) **프로젝트 분산**: 키 4개가 서로 다른 프로젝트면 프로젝트별로 나눠 실행
  (프로젝트당 한도 별도 적용 — 공식 규칙. 단, 각 프로젝트의 실제 한도를 먼저 확인할 것).
- (c) **케이스 축소**: 15건 이하로 줄이되, 카나리아 3건(잠긴 메모·인젝션·마커 누출)은 절대 빼지 않는다.

어느 방식을 택하든 **양쪽 모델에 동일 케이스·동일 순서**로 실행해 비교 공정성을 유지한다.

### 4.4 실행 전제 조건 (실행 승인 전 체크리스트 — 전부 충족해야 실행)

1. **AI Studio 콘솔에서 3.8 Flash 무료 티어 여부·RPM/RPD/TPM 직접 확인** (2.3절의 2차 수치를
   확정한다. 이 확인 없이는 평가 규모를 정할 수 없다).
2. **실행 방식 결정**: 일회용 스크래치 Worker(검증 후 삭제) vs 로컬 miniflare vs 운영 직접.
   운영 D1을 건드리지 않는 방식을 우선한다. 운영 D1 `ai_settings` 변경이 필요하면 별도 승인·백업·복원 계획이 전제된다.
3. **모델 전환 방식 확정**: 평가 중 모델을 바꾸는 방법(D1 설정 변경 vs 요청 시 모델 오버라이드)이
   코드 변경 없이 가능한지 확인한다. 코드 변경이 필요하면 그 변경 자체가 별도 트랙이다.
4. **429 가드 확인**: 무료 한도 초과 시 유료 과금 없이 실패(429)하는지, 결제 계정 미연결 상태를
   유지하는지 확인한다.
5. **평가 데이터**: 가상 메모·가상 일정만 사용. 잠긴 메모·실제 개인정보 제외.
   쓰기 케이스가 만드는 `[EVAL]` 메모·일정은 실행 후 삭제해 정리한다
   (`tests/evals/README.md`의 알려진 한계 참조).
6. **thinking_level**: 기본 medium + 비교군 low. `minimal` 사용 금지(오류).
7. **결과 기록**: promptfoo 결과 JSON(`tests/evals/results/`, gitignore 대상) + 비교표 문서.
   승자만 `model.*`에 반영하고 패자는 기록만 남긴다. 2027-01-01 가격 인상 전에 재평가 일정을 잡는다
   (무료 범위 내 사용이면 가격과 무관하나, 유료 전환을 검토하게 되면 인상 후 단가가 기준이 된다).

### 4.5 실행하지 않은 것 (본 트랙 범위)

- 라이브 API 호출 없음. AI Studio 콘솔 확인 없음 (로그인·OTP 금지).
- 평가 실행 없음. promptfoo 실행·모델 전환·D1 변경 없음.
- 코드 변경 없음. 본 문서는 `docs/gemini-38-flash-20261028.md` 한 파일이다.

---

## 5. 출처 (전부 2026-10-28 열람)

**공식 문서 (직접 열람):**

- 가격표 — https://ai.google.dev/gemini-api/docs/pricing
  (3.8 Flash Standard/Priority 무료, Batch/Flex 무료 미제공, Grounding 무료 미제공,
  $0.75/$3.75 → 2027-01-01 $1.50/$7.50)
- What's new in Gemini 3.8 Flash — https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.8
  (모델 ID `gemini-3.8-flash`, 도입가·인상일, Antigravity 기본 모델, thinking level)
- 모델 페이지 — https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash
  (1M/64K 토큰, Function calling 지원, thinking low/medium/high, minimal 미지원)
- 모델 목록 — https://ai.google.dev/gemini-api/docs/models
  (3.8 Flash Stable, 3.6 Flash 이전 세대, 3.5-flash-lite 현행)
- Rate limits — https://ai.google.dev/gemini-api/docs/rate-limits
  (한도 수치 미게재·AI Studio 참조, 프로젝트 단위 한도, RPD 태평양 자정 리셋,
  Free tier 자격 "Active project", "Specified rate limits are not guaranteed")
- Available regions — https://ai.google.dev/gemini-api/docs/available-regions
  (South Korea 포함)
- Deprecations — https://ai.google.dev/gemini-api/docs/deprecations
  (3.8 Flash 출시 2026-09-02·종료일 미발표, 3.1-flash-lite 종료 2027-05-07)

**공식 채널 인용 (직접 열람한 페이지의 본문에는 없으나 공식 답변·릴리스 노트로 확인):**

- 2.5 모델 접근 제한 + 신규 프로젝트는 3.5 Flash-Lite/3.8 Flash — Google 직원 공식 포럼 답변:
  https://discuss.ai.google.dev/t/gemini-developer-api-counttokens-returns-404-although-models-get-and-models-list-succeed/190567
  (릴리스 노트 2026-09-18 인용 포함. deprecations 페이지 본문 직접 열람본에는 해당 문장 미노출 — 2.4절 참조)

**2차 출처 (무료 한도 수치만 — 공식 미게재라 별도 표기):**

- 5 RPM / 250,000 TPM / 20 RPD — https://www.scriptbyai.com/gemini-api-free-tier-limits/
  (AI Studio Rate Limits 인용 표기)
- 20 RPD 교차 확인 — https://discuss.ai.google.dev/t/gemini-3-8-flash-free-tier-20-rpd-is-too-limited-for-practical-evaluation/180609
