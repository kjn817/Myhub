# 민감 데이터 접근 경로 검증 — 트랙 B (AI·외부 경로)

- 일시: 2026-10-30 (KST)
- 기준: 브랜치 `fix/unlock-block-remove-ciphertext`, 운영 라이브 d568a5b8 @100%
- 정책 (검증 기준): 잠긴 메모는 **모든** 외부 AI 전송 경로에서 제외 — AI 채팅 컨텍스트 주입, AI 도구(memo_get·memo_search 등), MCP 도구, 검색 인덱스, 요약, 디버그 로그.
- 방법: ① 코드 전수 대조 (AI 도달 가능 `FROM memos` 쿼리 전수) ② miniflare 런타임 시나리오 (`tests/runtime/injection-scenarios.test.ts` 시나리오 3 기존 + 시나리오 6 신규 5건) ③ 라이브 카나리아 스모크 (`.scratch/trackb_live_qa.py`).
- 사용자 기존 잠긴 메모(id 133·134·200·201)는 어떤 경로로도 열람하지 않았다 — 라이브에서 만든 일회용 메모만 사용했고 종료 시 삭제했다 (운영 메모 총수 28건 복귀 확인).

## 경로별 결과

| # | 경로 | 기대 정책 | 실증 방법 | 결과 |
|---|------|-----------|-----------|------|
| 1 | AI 채팅 서버 사전검색 주입 (`assistant-call.ts` memoDataMessage, keeper v2) | 잠긴·민감도≥2 메모가 모델 컨텍스트에 들어가지 않음 | 코드: `searchAccessibleMemos`(ai-access) 경유 — SQL `is_locked=0 AND sensitivity<=1` + `isMemoAccessibleForAI` 코드 재검사 + 샌드박스. 런타임: injection 1b·3a. 라이브: keeper에 카나리아 검색 유도 → "찾을 수 없습니다" 결정적 응답, 본문 구절 비노출 | PASS |
| 2 | AI 채팅 장기 기억 주입 — 레거시 (`ai_memory` fact) | 잠긴 메모 유래 사실이 주입되지 않음 | 코드: 메모→사실 진입점은 `captureFactsFromMemo`뿐이며 잠긴 메모는 본문을 읽기 전에 `locked` 거부 (6e로 실증). 레거시 주입 자체는 플래그 `memory.legacy_enabled` 기본 OFF | PASS |
| 3 | AI 채팅 장기 기억 주입 — v2 (`getRelatedFacts`/`getRelevantMemories` → `formatMemoryContext`) | 동의 없는 기억·잠긴 메모 유래 사실 비주입 | 코드: FTS·LIKE·그래프 확장 전 경로 `is_active=1 AND allow_ai_use=1 AND allow_provider_send=1`. 캡처된 사실은 기본 `allow_*=0`이라 사용자 명시 허용 전에는 주입 불가. v2 플래그 게이트 포함 | PASS (코드 대조 + 기존 memory 테스트군. 카나리아 종단 주입은 NOT TESTED — 아래 참조) |
| 4 | AI 도구 — 마커 엔진 (`memo-tools` MEMO_SEARCH/MEMO_GET, `processToolMarkers`) | 잠긴 메모 빈 결과/존재 숨김 | 런타임: injection 3b·3c (기존) | PASS |
| 5 | AI 도구 — FC 엔진 `search_memo` (`ai/tools/search-memo.ts`) | 동일 | **신규 6a**: 직접 검색 빈 결과 + "방금 만든" 상대 참조가 최신 잠긴 메모를 건너뛰고 공개 메모를 반환 (ID 조회 `is_locked=0` → `getAccessibleMemo` 이중 경계) | PASS (신규 실증) |
| 6 | AI 도구 — FC 디스패처 (`memo-tool-dispatcher` memo_get/memo_search) | 동일 | **신규 6b**: memo_get(잠긴 id) `success=false`, 응답 전문에 카나리아 없음. memo_search도 동일 | PASS (신규 실증) |
| 7 | MCP `memo.search` 1차 (ai-access 재사용) | 동일 | 런타임: injection 3b (기존). 라이브: 토큰으로 카나리아 질의 → 비노출 | PASS |
| 8 | MCP `memo.search` 2차 trigram (`memos_fts_tri`) | 토큰 내부 부분 문자열로도 잠긴 메모 비노출 | **신규 6c**: 부분 문자열 `LOCKCANARY` → 0건. 대조군 공개 메모는 부분 문자열 `OPENCANARY`로 trigram 경로에서 실제로 찾힘 (경로 동작 자체를 증명) | PASS (신규 실증) |
| 9 | MCP `briefing.generate` + 브리핑 서비스 (`buildTodayBriefing`) / PPTX export (`briefing-export`) | 최신 잠긴 메모가 브리핑 재료에 없음 | **신규 6d**: 두 함수 모두 카나리아 부재. 라이브: briefing.generate 토큰 호출 비노출. **카나리아 검증**: briefing 쿼리에서 `is_locked=0`을 일시 제거하면 6d가 실패함을 확인 후 복원 (diff 없음) | PASS (신규 실증) |
| 10 | 검색 인덱스 자체 (memos_fts / memos_fts_tri) | 잠긴·민감도≥2 메모는 인덱싱 자체가 안 됨 | 마이그레이션 0030·0059 트리거 `WHEN new.is_locked=0 AND new.sensitivity<2` + 기존 `memo-search-fts.test.ts` 85번 케이스가 직접 실증 (중복 추가 안 함) | PASS (기존 실증 인용) |
| 11 | 통합검색 (`unified-search`, /api/search 계열) | 잠긴 메모 제외 | 런타임: injection 3b (기존). FTS·LIKE 양쪽 `is_locked=0 AND sensitivity<2` | PASS |
| 12 | 요약 경로 | 잠긴 메모 요약 불가 | 요약은 별도 조회가 아니라 memo_get/memo_search 결과를 모델이 서술하는 구조 — 도구 경계(4~6번)가 유일한 진입점. `fact-graph` 캡처도 잠금 거부(6e). 전용 요약 엔드포인트 없음 (코드 전수 확인) | PASS |
| 13 | 사실 캡처 (`captureFactsFromMemo` → ai_memory_v2) | 잠긴 메모는 추출 자체 거부, 흔적 없음 | **신규 6e**: `{ok:false, error:'locked'}` + ai_memory_v2에 카나리아 행 0건 유지. LLM 추출기를 주입받지 않는 결정적 경로 (운영 플래그 `memory.llm_extract_enabled` OFF와 무관하게 이 호출은 LLM 미사용) | PASS (신규 실증) |
| 14 | 디버그·관측 로그 | 잠긴 메모 본문이 로그에 기록되지 않음 | 코드 전수: `ai_error_log`는 provider 오류 메시지 500자만 (요청 본문 미기록). ai_usage/ai_runs/ai_tool_runs는 메타데이터 전용 스키마 (본문 컬럼 없음). FC 디스패처 console 로그는 인자 **타입만** (`argTypes`), `[echo.tool_execution]`은 도구명·길이만, `[echo.response]`는 길이만 기록. 값·본문을 찍는 로그 없음 | PASS (코드 대조 — 로그 실물 대조는 NOT TESTED) |
| 15 | 상대 참조 해석 (`memo-target-resolver`, routes.ts "방금 만든" 선처리) | 잠긴 메모를 대상으로 확정하지 않음 | 코드: 문맥 폴백 쿼리 `is_locked=0` + 확정 후 `is_locked` 재검사에서 `MEMO_LOCKED` 거부. 6a의 상대 참조 케이스가 같은 성질을 FC 경로에서 실증 | PASS |
| 16 | 승인 미리보기 (`sandbox.ts` MEMO_DELETE/UPDATE 프리뷰) | 잠긴 메모 본문 대신 라벨 표시 | 코드: `memoHidden(row)`이면 본문 대신 `LOCKED_LABEL`/`HIDDEN_LABEL` (AI가 아닌 소유자 승인 UI 경로이나 본문 비노출 확인) | PASS (코드 대조) |

## 라이브 카나리아 실증 (운영 d568a5b8)

스크립트: `.scratch/trackb_live_qa.py` (OTP 로그인 → 일회용 메모 생성·잠금 → 유도 질문 → MCP → 정리)

- 카나리아: 토큰 `TRACKBCANARY7XQ2` + 본문 전용 구절 `자정너머고양이합창단` (질문에 넣지 않음 — 채팅 응답의 토큰 반향과 실제 본문 누출을 구분하기 위함).
- 잠금 후 D1 메타데이터만으로 확인: `is_locked=1`, 본문 prefix `ENC:` (본문 열람 안 함).
- 채팅 유도 4건 전부 PASS: keeper "카나리아 메모 찾아서 그대로 알려줘" → 서버 결정적 "찾을 수 없습니다" (memoDataMessage 0건 경로), keeper "메모 ID로 알려줘" → 찾을 수 없음, keeper "요약해줘" → 찾을 수 없음, concierge 검색 → 결과 없음. 응답 text·toolResults 어디에도 본문 구절 없음.
- MCP: 일회용 토큰 발급 → `memo.search`(토큰 전문·부분 문자열) 200·비노출, `briefing.generate` 200·비노출 → **토큰 폐기 후 재호출 401 확인**. 토큰 값은 출력·기록하지 않음.
- 정리: 일회용 메모 D1 단건 DELETE (changes=1), 운영 메모 총수 28건 복귀, trackb 토큰 2개(재시도 포함) 모두 revoked 확인.
- 1차 실행에서 MCP 406이 났던 것은 서버 결함이 아니라 스크립트가 `Accept: application/json, text/event-stream` 헤더를 빠뜨린 것 (레거시 MCP 경계의 정상 동작 — runtime 테스트 643번 케이스와 동일). 헤더 추가 후 200.

## 발견·수정한 결함

- **제품 결함: 없음.** 전 경로에서 잠긴 메모 본문이 AI·외부로 나가는 사례를 찾지 못했다. 따라서 이 트랙에서 수정한 제품 코드는 없다.
- 검증 스크립트 결함 2건은 그 자리에서 수정: ① 메모 API 경로 오기(`/api/memos` → 실제 `/api/memo`) ② MCP Accept 헤더 누락 + 채팅 누출 판정 기준을 "토큰 반향"에서 "본문 전용 구절"로 정정 (1차 판정은 사용자 질문에 포함된 토큰이 응답에 반향된 것을 누출로 오판했음).

## 추가한 테스트

`tests/runtime/injection-scenarios.test.ts`에 **시나리오 6 (6a~6e, 5건)** 추가 — 기존 시나리오 3과 겹치지 않는 경로만:
FC `search_memo`(직접+상대 참조), FC 디스패처 memo_get/memo_search, MCP trigram 부분 검색(잠긴 0건 + 공개 대조군 히트로 경로 동작 증명), 브리핑 2종, 사실 캡처 거부·무흔적.

- 실행: injection-scenarios 17/17 PASS (기존 12 + 신규 5). 관련 스위트 회귀: mcp-server + memo-search-fts 포함 3파일 59/59 PASS.
- 카나리아(뮤테이션) 확인: `briefing/service.ts`의 `is_locked=0` 조건을 일시 제거 → 6d 실패 확인 → 원복 (git diff 없음).

## NOT TESTED (정직 표기)

- v2 장기 기억의 카나리아 종단 주입: 잠긴 메모에서 유래한 사실이 `allow_*=1`로 **사용자가 직접 허용한 뒤** 채팅에 주입되는 경로는, 캡처 단계에서 잠긴 메모가 원천 거부되므로 만들 수 없는 상태가 정상이다. "만들 수 없음" 자체는 6e + 코드 대조로 확인했으나, 실모델 응답까지의 종단 실증은 하지 않았다.
- 실모델이 도구 결과를 받아 서술하는 최종 응답의 누출 여부: 라이브 keeper/concierge 4턴으로 실증한 범위가 한계 (전 비서·전 프롬프트 버전 조합은 아님). 캘리(scheduler)의 FC 파일럿 `search_memo`는 실행기 단위로는 6a가 실증했지만 라이브 턴으로는 돌리지 않았고, 노바(builder)는 메모 도구가 없어 범위 밖.
- 로그 실물(운영 `ai_error_log` 행·Worker 실시간 로그)에 카나리아가 없는지의 실물 대조: 코드상 기록 지점이 본문을 받지 않음을 확인한 것으로 갈음. 운영 로그 전수 검색은 하지 않았다.
- MCP `memory.search`: 메모가 아닌 기억 전용 도구라 잠금 정책의 직접 대상이 아니다 (동의 게이트는 3번 행 참조).

## 비고

- 작업 중 형제 트랙이 `src/modules/memo/routes.ts`에서 카나리아 뮤테이션을 수행·복원하는 것을 관찰했다 (이 트랙은 해당 파일을 건드리지 않음).
- 커밋·배포는 하지 않았다 (코디네이터 통합 몫). 이 트랙의 변경 파일: `tests/runtime/injection-scenarios.test.ts`, 본 문서, `.scratch/trackb_live_qa.py`(스크래치).
