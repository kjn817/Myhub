# GPT 자문 요청 — 에코(keeper) Workers AI 뉴런 절약 하이브리드 구조

**작성일:** 2026-10-14
**작성자:** Muse (사용자 요청)

---

## 1. 배경

### 1.1 현재 장애
- 2026-10-14 02:09 UTC부터 Workers AI 무료 할당량(10,000 neurons/일) 소진
- 오류: `4006: you have used up your daily free allocation of 10,000 neurons`
- 에코(keeper) 전체 불능 — 모든 요청이 "죄송해요, 응답을 받지 못했어요" 반환
- D1 `ai_error_log`에서 확인됨

### 1.2 현재 에코 모델 구성
- Provider: `workers-ai` (2026-10-13 사용자 확정, 변경 불가)
- 주 모델: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (70B, D1 `model.summarize`)
- 폴백 체인: 70B → `@cf/meta/llama-3.2-1b-instruct` (1B) → `@cf/mistralai/mistral-small-3.1-24b-instruct` (24B)
- Function Calling: keeper + workers-ai일 때 MEMO_FC_TOOLS 사용

### 1.3 에코의 작업
- 메모 검색/요약/태그
- 민감정보 마스킹
- 잠금 정책 준수
- 메모 생성/열기/닫기/삭제 (도구 호출)

### 1.4 사용자 요구
- 에코는 Workers AI에 유지 (다른 프로바이더로 이동 불가)
- 70B는 뉴런 소모가 너무 많음
- 하이브리드 방식으로 뉴런 절약
- 결정 모델(Clef, Jev)에 관심 있음

---

## 2. 사용 가능한 Workers AI 모델

### 2.1 코드에 등록된 모델 (src/services/ai.ts)

| 모델 ID | 파라미터 | 품질 | 용도 |
|---------|----------|------|------|
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 70B | high | 현재 에코 주 모델 |
| `@cf/mistralai/mistral-small-3.1-24b-instruct` | 24B | balanced | 폴백 |
| `@cf/meta/llama-3.2-1b-instruct` | 1B | fast | 폴백 |

### 2.2 결정 모델 (2026-10 웹서치 확인)

| 모델 ID | 파라미터 | 가격 | 특징 |
|---------|----------|------|------|
| `@cf/cloudflare/clef` | 27B | $0.24/백만 입력 토큰 | 텍스트/JSON/이미지 입력, 확률 반환 |
| `@cf/cloudflare/clef-flash` | 9B | $0.09/백만 입력 토큰 | 더 빠르고 저렴 |
| `typesafe/jev` | 비공개 | $0.042/백만 입력 토큰 | TypeSafe, Workers AI 바인딩 지원 |

결정 모델은 텍스트를 생성하지 않음. `state`와 타입화된 질문(`noul`/`choice`/`score`)을 받아 확률 반환.

---

## 3. 하이브리드 구조 후보

### 후보 A: 단순 다운그레이드
- 주 모델을 70B → 1B로 변경
- D1 `model.summarize` 값만 수정 (코드 변경 없음)
- 폴백 체인 제거 또는 1B 단일화

**장점:** 즉시 적용 가능, 코드 변경 없음
**단점:** 1B의 요약 품질이 70B보다 낮을 수 있음, Function Calling 호환성 미확인

### 후보 B: 2단계 (결정 + 생성)
- 1단계: Clef-flash로 요청 분류
  - "도구 호출 필요한가?" (noul)
  - "어떤 도구인가?" (choice: search/get/create/summarize/none)
- 2단계: 분류 결과에 따라 1B 또는 24B로 텍스트 생성

**장점:** 불필요한 LLM 호출 감소, 결정은 저렴한 모델로
**단점:** 새 코드 작성 필요, 2회 호출의 레이턴시, Clef API 통합 작업

### 후보 C: 3단계 (결정 + 소형 + 대형)
- 1단계: Clef-flash로 복잡도 판단 (score 1-5)
- 2단계: score ≤ 3 → 1B, score ≥ 4 → 24B
- 70B는 완전히 제외

**장점:** 작업 난이도별 최적 모델 선택
**단점:** 복잡도 증가, 3회 호출 가능성, 튜닝 필요

### 후보 D: 현재 유지 + 할당량 관리
- 70B 유지
- 폴백 체인 정리 (할당량 소진 시 재시도 방지)
- 사용량 모니터링 및 알림
- Workers Paid 업그레이드 검토

**장점:** 품질 유지, 코드 변경 최소
**단점:** 근본 해결 아님, 매일 할당량 소진 반복 가능

---

## 4. GPT에게 질문

### 4.1 아키텍처
1. 에코의 작업(메모 요약/검색/태그/도구 호출)에 가장 적합한 하이브리드 구조는? A/B/C/D 중 추천 또는 새로운 조합 제안.
2. 결정 모델(Clef-flash)을 에코 파이프라인에 통합한다면, 구체적으로 어떤 지점에서 어떤 질문을 던져야 하는가? (예: 도구 선택, 민감도 판단, 요약 필요성)
3. 1B 모델이 Function Calling(MEMO_FC_TOOLS 6개)을 정상적으로 처리할 수 있는가? 70B와 비교한 도구 호출 정확도 차이는?

### 4.2 뉴런 효율
4. 70B → 1B 전환 시 예상 뉴런 절감 효과는? (파라미터 비례로 1/70인가, 아니면 다른 비율인가?)
5. Clef-flash의 뉴런 소모는 일반 LLM과 어떻게 다른가? 결정 모델이 정말 저렴한가?
6. 폴백 체인(70B→1B→24B)이 현재 뉴런 낭비의 주요 원인인가? 단일 모델 고정이 나은가?

### 4.3 품질
7. 메모 요약 품질을 유지하면서 뉴런을 절약하려면, 모델 크기 외에 어떤 최적화가 가능한가? (프롬프트 압축, max_tokens 조정, 캐싱 등)
8. 1B 모델로 에코의 민감정보 마스킹/잠금 정책 준수가 안전한가? 작은 모델의 정책 준수 능력은?

### 4.4 구현
9. 후보 B를 구현한다면, 기존 `callWorkersAI()`와 `dispatchToolCalls()` 흐름에 Clef를 어디에 삽입해야 하는가? 구체적인 코드 위치 제안.
10. 결정 모델의 확률 임계값(threshold)은 어떻게 정해야 하는가? (예: 0.9 이상이면 자동 실행, 0.5~0.9면 확인 요청)

### 4.5 운영
11. Workers AI 할당량 모니터링을 어떻게 자동화할 수 있는가? `ai_error_log` 외에 실시간 사용량을 조회하는 API는?
12. 할당량 소진 시 사용자에게 보여줄 메시지와 폴백 동작은? (현재는 "응답을 받지 못했어요"로 가려짐)

---

## 5. 제약

- 에코의 Workers AI 고정은 사용자 확정 정책 (변경 불가)
- 운영 D1 수정은 별도 승인 필요
- 운영 배포는 별도 승인 필요
- 현재 운영: 86차 (83차 코드), 에코 P0 장애 중
- 할당량 리셋: UTC 자정 (KST 오전 9시)

---

## 6. 참고 자료

- `src/services/ai.ts`: `MODELS` 정의 (110-112행), `callWorkersAI()` (361행), `selectModel()` (412행), `aiChat()` (557행)
- `src/modules/ai/routes.ts`: `PERSONA_PROVIDER` (96-101행), `callSingleAssistant()` (565행)
- `src/ai/function-calling-route.ts`: `shouldUseFunctionCalling()` (47행) — 운영에서는 항상 false (Legacy 경로 사용)
- D1 `ai_settings`: `model.summarize` = `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
