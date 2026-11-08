# GPT 자문 요청 — MyHub 에코 메모 기능 안정화 (80차)

**작성일:** 2026-10-14
**작성자:** Muse
**배경:** 69차~79차까지 11차례 수정·배포·브라우저 테스트를 반복했으나, "방금 만든 메모" 상대 참조와 UI 열기가 여전히 불안정함.

---

## 1. 현재 아키텍처

### 도구 (6개)
1. `memo_create` — 요약·생성용
2. `memo_create_from_source` — 직접 받아쓰기 (원문 보존)
3. `memo_search` — 검색
4. `memo_get` — ID로 조회
5. `memo_delete` — 삭제 (확인 절차: 실제 삭제하지 않고 확인 요청 반환)
6. `memo_ui_action` — UI 동작 (open/close/start_edit/start_format)

### 경로 (2개)
- **Legacy 경로:** `src/services/ai.ts` → `dispatchToolCalls` (`src/ai/memo-tool-dispatcher.ts`)
- **FC 경로:** `src/ai/function-calling-route.ts` → `ToolRegistry` (`src/ai/tools/search-memo.ts` 등)
- 에코는 **FC 경로**를 사용함 (feature flag `ai.engine=function_calling`)

### 문맥 저장소
- D1 `memo_conversation_context` 테이블
- `last_created_memo_id`, `last_target_memo_id` 저장
- 위젯은 `conversationId`를 보내지 않음 → 서버에서 최근 2시간 내 메모 활동이 있는 대화를 자동 찾음 (70차, localStorage 제거)

---

## 2. 동작하는 것 (브라우저 테스트 확인)

| 기능 | 상태 | 비고 |
|------|------|------|
| 메모 생성 | ✅ | "메모 생성 78차테스트입니다" → ID 190 생성 |
| 명시적 ID 요약 | ✅ | "메모 ID 189 요약해줘" → 정상 요약 |
| UI 닫기 | ✅ | `window.closePane` 동작, 패널 실제로 닫힘 |
| 삭제 확인 | ✅ | 확인 요청 반환 (미검증) |
| 거짓 성공 방지 | ✅ | 모델이 "요청을 전달했습니다"라고 정직하게 표현 |

---

## 3. 안 되는 것

### 3-1. "방금 만든 메모 요약해줘" 실패

**증상:** `"방금 만든"에 대한 메모를 찾을 수 없습니다.`

**시도한 수정:**
- 71차: `memo-tool-dispatcher.ts`의 `memo_search`에서 "방금 만든" 패턴 감지 → 문맥 ID로 `memo_get` 호출
- 73차: conversationId 없어도 최근 메모로 폴백
- 76차: `concierge`에게도 `[최근 메모 문맥]` 프롬프트 주입 (이전엔 `keeper`만)
- 77차: **FC 경로**의 `executeSearchMemo`(`src/ai/tools/search-memo.ts`)에서 "방금" 포함 시 최근 메모 반환
- 78차: **서버 선처리** — `routes.ts` POST /chat에서 사용자 메시지에 "(메모 ID: N)" 자동 추가

**결과:** 78차 테스트에서 UI 열기는 ID를 인식했으나("메모 ID 190번"), 요약은 여전히 실패. 선처리가 요약 요청에는 동작하지 않음.

**의문점:**
- FC 경로와 Legacy 경로 중 에코가 실제로 어떤 것을 사용하는지 불확실
- `chatWithFunctionCalling`이 `conversationId`를 받지 않아 문맥 조회 불가
- 모델이 도구를 호출하지 않고 직접 실패 메시지를 생성하는 경우도 있음

### 3-2. "방금 만든 메모 열어줘" 실패

**증상:** 모델은 "메모 ID 190번을 열기 위한 요청을 전달했습니다"라고 하나, 패널이 실제로 열리지 않음.

**시도한 수정:**
- 72차: `window.openPane`, `window.closePane`을 전역에 노출 (이전엔 위젯에서 호출 불가)
- 75차: `memo_ui_action`에서 `memo_id` 없이 호출되면 서버가 최근 메모 ID 자동 조회
- 79차: `openPane`이 캐시 미스 시 `/api/memo/:id`로 서버 조회

**결과:** 여전히 패널이 열리지 않음.

**원인 분석:**
- 닫기: DOM에서 패널 제거만 하면 됨 (데이터 불필요) → 동작
- 열기: `memoCache[id]`에서 데이터를 가져와 DOM 생성 필요
- AI로 생성된 메모는 `memoCache`에 없음
- 79차에서 `/api/memo/:id` GET으로 조회 시도했으나, **해당 엔드포인트가 존재하지 않음** (routes.ts에 PUT/DELETE/POST만 있고 GET /:id 없음)

---

## 4. GPT에게 묻고 싶은 것

### Q1. 상대 참조 해석 아키텍처
"방금 만든", "그 메모" 같은 상대 참조를 어디서 어떻게 해석해야 가장 안정적인가?

현재 시도:
- (a) 프롬프트에 `[최근 메모 문맥]` 주입 → 모델이 무시함
- (b) Dispatcher에서 패턴 감지 → FC 경로에서는 동작하지 않음
- (c) 서버에서 사용자 메시지 선처리 → 요약에는 동작하지 않음

두 개의 도구 경로(Legacy/FC)가 있어 수정이 두 곳에 필요하고, 모델이 도구를 호출하지 않는 경우도 있음.

### Q2. 위젯에서 메모 패널 열기
`openPane(id)`가 `memoCache`에 의존하는데, AI로 생성된 메모는 캐시에 없음.

선택지:
- (a) `/api/memo/:id` GET 엔드포인트 신규 생성
- (b) 위젯이 `dataChanged` 시 전체 새로고침 후 열기
- (c) 서버가 `uiAction` 응답에 메모 데이터를 포함
- (d) 다른 접근법?

### Q3. 전체 기능 안정화 전략
사용자 요구: 생성·삭제·수정·편집·꾸미기·해당 메모 요약이 모두 완벽히 동작

현재 11차례 수정으로도 "방금 만든" 패턴이 안정화되지 않음. 아키텍처를 근본적으로 바꿔야 하는가? 예를 들어:
- 위젯이 항상 `conversationId`를 명시적으로 관리 (서버 자동 찾기 폐기)
- 상대 참조를 클라이언트에서 해석
- 또는 다른 구조?

---

## 5. 제약 조건

- 잠긴 메모는 모든 경로에서 제외 (검색·조회·요약·문맥)
- AI는 잠금/해제 불가
- `localStorage` 사용 금지 (사용자 요구)
- 운영 배포는 검증 후 100% 트래픽
- 테스트 메모는 사용자 승인 없이 삭제 금지 (이번 테스트용 ID 183~190은 정리 필요)

---

## 6. 관련 파일

- `src/modules/ai/routes.ts` — POST /chat, conversationId 자동 찾기(70차), 메시지 선처리(78차)
- `src/ai/memo-tool-dispatcher.ts` — Legacy 경로 Dispatcher, 상대참조 해석(71/73차), memo_ui_action 자동 ID(75차)
- `src/ai/function-calling-route.ts` — FC 경로 (에코가 사용)
- `src/ai/tools/search-memo.ts` — FC 경로 검색 도구, 상대참조 처리(77차)
- `src/services/ai.ts` — 프롬프트, follow-up 규칙 (거짓 성공 방지)
- `public/assistant-widget.js` — 위젯, `handleUiActions`
- `public/js/memo/pane.js` — `openPane` (79차: 캐시 미스 시 서버 조회 시도)
- `public/js/memo/list.js` — `closePane`
