# 게이트 정책 동등성 대조 — E1(마커) × E2(운영 FC) × E3(파일럿)

- 작성일: 2026-10-30
- 갱신: 2026-10-31 — D1·D3 해소 반영 (커밋 `fcaee4d`, E2 쓰기 승인 게이트 정렬).
  D2는 잔여로 확정, D4·D5는 현행 유지. (이후 트랙 3에서 D2·D4·D5 모두 해소 — 아래 트랙 3 절 참조)
- 갱신: 2026-10-31 (트랙 1) — 자동화 승인 계약 확정 절 추가 (GPT 6.7 §7.1 대응).
  판정: 문서 정정 (코드 변경 없음). 고정 테스트:
  `tests/automation-scheduled-contract.test.ts` (8건).
- 갱신: 2026-10-31 (트랙 3) — **D2·D4·D5 해소** (FC 공통 실행 계층 통합,
  본문 "트랙 3 통합" 절 참조). 신규 `src/services/fc-tool-policy.ts`가
  FC 판정 단일 원천이 되고, 강제 지점은 디스패처로 모였다.
- 고정 테스트: `tests/gate-policy-equivalence.test.ts` (27건)
- 배경: GPT 지적 "마커 경로와 FC 경로의 정책 동등성 테스트가 없다"
  (`docs/fc-transition-plan-20261029.md` §2.3 — "두 경로의 승인 정책이 완전히
  동등한지는 본 조사에서 확인하지 못했다"). 본 문서는 그 미확인 항목의 실측 결과다.
- 조사 방법: 게이트 코드 직접 독해 + 실제 게이트 함수를 호출하는 테스트로
  케이스별 판정을 고정. 운영 D1 조회·배포·실모델 호출은 하지 않았다.

## 판정 모델 (무엇을 "경로의 판정"으로 셌는가)

| 경로 | 판정 구성 |
|---|---|
| E1 마커 | `processToolMarkers`의 `authorizeTool`(`src/modules/ai/tool-markers.ts:125`)가 경유하는 `decideToolExecution`(`src/services/tool-approval.ts:202`)의 결정(allow/ask/deny) + 승인 통과 시 실제 `execute*`(`src/services/memo-tools.ts`)의 결과 |
| E2 운영 FC | 운영 판정 = `aiChat` FC 루프가 디스패치 직전에 거치는 승인 게이트 `gateFCToolCall`(`src/services/fc-approval-gate.ts`, 2026-10-31 신설)의 판정 + 승인 시 `executeFCApprovalPayload`의 실행 결과. 디스패치 지점에서는 공통 실행 정책 `checkFCDispatchPolicy`(`src/services/fc-tool-policy.ts`, 트랙 3)가 비서별 허용 목록(D5)·출처 게이트(D4)를 강제하므로, `dispatchToolCall` 단독 판정도 같은 결론으로 고정한다 |
| E3 파일럿 | `WriteExecutionGuard.checkBeforeExecute`(`src/ai/tools/write-guard.ts:141`). 운영 도달 불가(§검증 불가능 구간)이므로 참고 대조로만 둔다 |

표기: **허용** = 승인 없이 즉시 실행 / **승인 필요** = 실행 보류 후 사용자 승인·확인 /
**차단** = 실행 불가(데이터 미노출 포함).

---

## 자동화 승인 계약 — 확정 (2026-10-31, 트랙 1 / GPT 6.7 §7.1)

제출본 §4.5 "위험한 자동화는 승인 게이트를 거친다"와 §6.3 "비대화형 출처의
쓰기는 승인 판단 전에 거부된다"가 양립할 수 없다는 지적에 대한 실측 확정이다.
결론: **양쪽 다 같은 실행 경로를 가리키지 않으며, 모순은 문서 서술의 부정확함
에서 왔다. 코드는 의도(읽기+전달 전용 자동화)와 일치하므로 문서로 닫는다.**

### 실행 경로 (origin이 정해지는 지점까지의 추적)

| 단계 | 지점 | origin / 도구 |
|---|---|---|
| 생성 (AI 경유) | 채팅 라우트 `src/modules/ai/routes.ts` (전 진입점 `origin: 'interactive'` 명시) → FC 루프 `src/services/ai.ts` → `cron_create` 디스패치 | interactive. `cron_create`는 `FC_APPROVAL_GATED_TOOLS`에 들어 있고 `CRON_CREATE`는 위험 분류표에서 write, `CRON_DELETE`는 destructive — **생성·삭제는 대화형 승인 게이트를 거친다** |
| 생성 (REST 직접) | `POST /api/cron` (`src/modules/cron/routes.ts`) | AI 도구가 아니다. 세션 인증된 사용자 본인의 직접 행위 자체가 인가다 (승인 게이트는 AI 개시 쓰기를 위한 장치) |
| 저장 스키마 | `user_cron_jobs` (마이그레이션 0047): `action`, `nl_text`, `cron_kst`, `timezone`, `next_run_at`, `enabled`뿐 | 실행할 도구·대상·인자를 담는 필드가 **없다**. 정의에 바인딩되는 것은 자연어 원문과 그 결정적 파싱 결과뿐이다 |
| 액션 집합 | `parseNlCron`/`detectAction` (`src/services/nl-cron.ts`) | 닫힌 4종: `morning-briefing` / `news-summary` / `schedule-reminder` / `generic`. 전부 읽기+전달이다. "메모 삭제해줘" 같은 쓰기 의도 문장도 `generic`(알림 문장 전달)으로 축소된다 — 삭제 액션 자체가 존재하지 않는다 |
| 예약 실행 | `src/index.ts` `scheduled()` → `handleCronJobs` (`src/scheduled.ts`) → `runDueCronJobs` (`src/services/cron-jobs.ts`) | 도구를 제공받지 않는다. 분기는 3개뿐: ① generic → `describeNlCron` 확인 문장 ② news-summary → `generateNewsSummary` ③ 그 외 → `generateMorningSummary` (일정 읽기, 규칙 기반). 전달은 Web Push 콜백 |
| 예약 실행의 유일한 AI 호출 | `summarizeNewsWithModel` (`src/services/news-briefing.ts`) | `aiChat`을 **persona 없이** capability `summarize`로 호출하고 `origin: 'scheduled'`를 명시한다. persona가 없어 FC 도구가 붙지 않으므로 도구 실행 자체가 일어날 수 없다 |
| 그 외 예약 핸들러 | `handleScheduled`(일정 리마인더 푸시), `handleSleepConsolidation`(기억 통합), `handleGoogleSync`(pull 동기화) | AI 도구 호출 없음 |

`agent_runs`/`agent_run_checkpoints`는 자동화의 실행 기록이 **아니다** —
대화형 오케스트레이션(`/api/ai/orchestrate`, 전 단계 `origin: 'interactive'`)의
Plan & Execute 팀 실행 로그다. 제출본 §4.5가 이를 자동화의 실행 기록처럼
이어 붙인 것도 부정확하다. `user_cron_jobs`에는 실행 이력 테이블이 없고
`next_run_at` 선점이 유일한 실행 상태다.

### 계약 (이 문서가 정본)

1. **자동화의 승인은 생성 시점에, 정의 그 자체에 붙는다.** AI 경유 생성은
   승인 게이트(ask → 승인 후 저장)를 거치고, 저장된 정의(`nl_text` + 파싱된
   액션·스케줄)가 곧 승인된 범위다. 실행기는 저장된 정의를 결정적으로
   재파싱해 그 범위 안에서만 동작하며, 새 도구·새 대상을 만들 수 없다.
2. **예약 실행은 쓰기 도구를 수행하지 않는다 — 수행할 수단이 없다.**
   따라서 "승인받은 자동화도 실행 시 전면 deny라 쓰기 불가"는 결함이
   아니다: 쓰기는 애초에 자동화의 기능 정의에 없다. 예약 실행이 하는
   시스템 쓰기는 `next_run_at` 선점과 본인 푸시 전달뿐이며, 이는 정의된
   전달 동작 그 자체다.
3. **§6.3 출처 게이트는 이 계약의 미래 방어선이다.** 예약 경로가 장차
   persona 있는 AI 호출로 확장돼도, `origin !== 'interactive'`인 쓰기는
   E1 `decideToolExecution` · E2 FC 게이트 · E3 `WriteExecutionGuard`
   3층 모두에서 승인 기록·세션 허용 유무와 무관하게 승인 판단 전에
   deny된다. 예약 실행이 새 자동화를 만드는 것(`scheduled` + `cron_create`)
   도 같은 deny다.
4. **쓰기를 수행하는 자동화가 필요해지면 그때가 재설계 시점이다.** 자동화
   정의에 승인된 도구·범위를 바인딩하는 스키마 확장과 실행 시 범위 검사가
   선행돼야 하며, 현행 정의 스키마에 몰래 도구를 태우는 변경은 이 계약
   위반이다. 고정 테스트 ①·②가 그 변경을 실패로 드러낸다.

### 제출본 정정 문안 (다음 제출본에 반영할 것 — 제출 완료본 20261031은 불변)

- §4.5 대체: "자동화(자연어 cron)는 읽기+전달 전용이다: 액션은 브리핑·
  뉴스 요약·일정 알림·일반 알림 4종으로 닫혀 있고, 예약 실행은 도구를
  제공받지 않는다. 승인이 걸리는 지점은 실행이 아니라 생성이다 — AI 경유
  생성·삭제는 대화형 승인 게이트를 거치고, 저장된 정의가 승인된 범위다.
  실행 기록·체크포인트(`agent_runs`)는 자동화가 아니라 대화형 팀 실행의
  로그다."
- §6.3 출처 게이트 문장은 현행 유지 가능하나, "예약 실행·자동화 등"의
  자동화는 위 계약의 의미(미래 방어선)로 읽어야 한다 — 현재 예약 실행은
  게이트에 도달할 쓰기 호출 자체를 만들지 않는다.

### E2E 실증 (2026-10-31, 로컬 FakeD1 — 운영 아님)

`tests/automation-scheduled-contract.test.ts` 8건으로 고정:
생성→due→`runDueCronJobs` 실경로에서 브리핑(일정 읽기 문장)·삭제 의도
generic(알림 문장으로 축소)·뉴스 요약(주입 요약기)이 전달만 되고, 기존
메모가 생성·삭제·수정되지 않으며, 예약 실행이 승인 대기 요청이나 새
자동화를 만들지 않음을 단언한다. 3층 deny 카나리아 포함 — FC 게이트의
origin 분기를 제거하는 변형에서 scheduled-deny 2건이 실패함을 실측했다.
Jest 실행은 이 세션의 쓰기 제한(EPERM)으로 불가해 동일 파일을 vitest
(globals, 러너만 교체)로 실행해 8/8 PASS를 얻었다 — Jest 전수 통과는
NOT TESTED로 남긴다 (보고 참조).

---

## ⚠ 최우선 발견 — D1 해소됨 (2026-10-31, 먼저 읽을 것)

**[해소] 불일치 D1 — E2(운영 FC)의 쓰기에 승인 게이트가 없던 문제.**
2026-10-30 실측 당시 E1은 쓰기 도구 전부 승인(ask)이 기본인데, 에코 FC
경로의 `memo_create`·`memo_create_from_source`·`schedule_create`·
`cron_create` 등은 대화형 출처이기만 하면 승인 절차 없이 즉시 실행됐다
(인젝션이 모델을 통해 쓰기를 유도하면 막을 승인 단계가 없는 상태).

**해소 (2026-10-31, 커밋 `fcaee4d`, 사용자 결정 A안 — 에코도 승인 카드로 정렬):**
- 신규 `src/services/fc-approval-gate.ts` — FC 쓰기 7종을 E1 승인 도구명으로
  정규화해 기존 `tool-approval`/`approval-flow`(대기 요청 저장소·세션 허용·
  승인 문안)를 그대로 재사용한다.
- `ai.ts` FC 루프 — 출처 게이트 직후·디스패치 직전에 대화형 쓰기를 게이트한다.
  승인 대기는 `approval_required`로 모델에 피드백하고 승인 문안을 최종
  응답에 결정적으로 포함한다.
- 승인 페이로드 — `tool_approval_requests.marker_text`에 `FC:{...}` JSON으로
  저장. `routes.ts`가 `isFCPayload`로 분기해 `executeApprovedRequestOnce`
  (executed_at 선점) → `executeFCApprovalPayload` → 디스패처로 실행한다.
- 함께 해소된 D3 — 승인 실행은 디스패처 `approvedDelete` 컨텍스트로 실제
  삭제까지 완주한다. 게이트 없는 직접 호출은 `confirmation_required` 기본값 유지.
- 검증 — `tests/fc-approval-gate.test.ts` (22건), `tests/unit/ai-fc-approval-loop.test.ts`
  (6건), 본 문서의 동등성 스위트 ③·④ 갱신 (게이트 우회 카나리아에서 3건 실패 확인).

---

## 대조표

| # | 케이스 | E1 마커 | E2 운영 FC | E3 참고 | 동등성 | 근거 코드 |
|---|---|---|---|---|---|---|
| ①a | 잠긴 메모 단건 읽기 (MEMO_GET/memo_get) | 읽기 게이트 allow → 실행층이 "찾을 수 없음"으로 숨김 (**차단**) | 정책 가드 통과 → 같은 실행층에서 같은 실패 (**차단**) | search_memo만 있어 해당 없음 | **일치** | E1: `tool-approval.ts:202`, `memo-tools.ts:90` → `ai-access.ts` `getAccessibleMemo`; E2: `memo-tool-dispatcher.ts:105,220` 경유 동일 실행층 |
| ①b | 잠긴·민감 메모 검색 | SQL 필터 + 코드 재검사로 결과에서 제외 (**차단**) | 동일 실행층, 동일하게 제외 (**차단**) | `search-memo.ts`도 같은 `searchAccessibleMemos` 재사용 | **일치** | `ai-access.ts` `searchAccessibleMemos`, `policy-guard.ts` `isMemoAccessibleForAI` |
| ②a | 잠긴 메모 수정 | 승인 필요(ask) → 승인 후에도 실행층 거부 "잠긴 메모는 수정할 수 없습니다" (**차단**) | 도구 자체가 없음 — `Unknown tool` (**차단**) | 쓰기 도구 없음 | 결과 **일치** / 표면 불일치 | E1: `memo-tools.ts:188` (is_locked 검사); E2: `memo-tool-dispatcher.ts:119` validTools에 `memo_update` 부재 (의도적 — UI 직접 처리, `memo-fc-tools.ts` 머리 주석) |
| ②b | 잠긴 메모 삭제 | 승인 필요(ask) → 승인 후에도 실행층 거부 (**차단**) | 확인 단계가 `getAccessibleMemo` 경유라 "찾을 수 없음"으로 실패 (**차단**) | — | **일치** (사유 문구만 다름) | E1: `memo-tools.ts:206`; E2: `memo-tool-dispatcher.ts:400` `executeMemoDeleteConfirm` |
| ②c | **민감도 2 (잠기지 않음) 메모 삭제** | 승인 후에도 실행층이 **차단** ("찾을 수 없음" — 존재 숨김) | 확인 단계에서 **차단** (sensitivity≤1 필터) — 승인 실행 경로에서도 동일 차단 | — | **일치 (D2 해소, 2026-10-31 트랙 3)** | 공유 실행층 `memo-tools.ts` `aiWriteBlockReason` (삭제·수정 공통, sensitivity>1 차단); E2: `memo-tool-dispatcher.ts` `executeMemoDeleteApproved` → `ai-access.ts`; 동등성 테스트 ②c [해소 D2] + `fc-approval-gate.test.ts`의 '[해소 D2]' |
| ③ | 일반 쓰기 (메모 생성 등) | **승인 필요** — 승인·세션 허용 없으면 ask, 실행 안 됨. 대화 ID 없으면 pending도 못 만들어 차단 | **승인 필요** — FC 루프가 디스패치 전 게이트에서 ask, 승인 후 실행 (2026-10-31 정렬). 디스패처 단독에는 승인 검사가 없으나 그 경로는 D4로 별도 고정 | **승인 필요** — 승인 없으면 `APPROVAL_REQUIRED` 거부 | **일치 (D1 해소, 2026-10-31)** | E1: `tool-approval.ts:202` (WRITE_TOOLS), `tool-markers.ts:125`; E2: `fc-approval-gate.ts` `gateFCToolCall` (FC 7종 → E1 도구명 정규화), `ai.ts` FC 루프 디스패치 전 게이트, `routes.ts` FC 페이로드 승인 실행; E3: `write-guard.ts:141` |
| ④ | 잠기지 않은 메모 삭제의 완결 | 승인(단건/세션) 후 **실제 삭제까지 완결** | 승인 게이트 통과 후 **실제 삭제까지 완주** (`approvedDelete`). 게이트 없는 직접 호출은 확인 요청 반환이 기본값 | — | **일치 (D3 해소, 2026-10-31)** | E1: `tool-markers-content.ts` MEMO_DELETE 절 + `memo-tools.ts:206`; E2: `memo-tool-dispatcher.ts` `executeMemoDeleteApproved`, `fc-approval-gate.ts` `executeFCApprovalPayload` |
| ⑤a | 비대화형 origin(scheduled/mcp/channel/미지정) 쓰기 | **차단** `deny(non_interactive_origin)` — 승인·세션 허용으로도 못 뚫음 | **차단** — 디스패처 공통 게이트가 위험 분류 기반으로 강제 (루프는 같은 판정으로 사전 거부해 모델에 피드백) | **차단** `NON_INTERACTIVE_ORIGIN` — 가드 안에서 강제 | **일치 (D4 해소, 2026-10-31 트랙 3)** | E1: `tool-approval.ts` 출처 게이트; E2: `fc-tool-policy.ts` `checkFCDispatchPolicy` (디스패처 `memo-tool-dispatcher.ts`가 실행 전 강제, `ai.ts` 루프는 `isFCWriteTool`로 사전 거부); E3: `write-guard.ts` 출처 게이트 |
| ⑤b | 비대화형 origin 읽기 | **허용** (읽기는 출처 무관) | **허용** (게이트 목록에 읽기 없음) | 읽기 전용이라 해당 없음 | **일치** | E1: `tool-approval.ts` (read는 origin 검사 밖); E2: `ai.ts:1145` 목록 |
| ⑥a | restricted 민감도 요청의 외부 전송 | 전 프로바이더 차단 → `PrivacyBlockedError` (**차단**) | 동일 — 같은 `aiChat`/`selectModel` 공유 (**차단**) | `ModelRouter.canUseProvider`도 전 프로바이더 `allowRestricted=false`로 같은 결론 | **일치** (공유 코드) | `legacy-privacy-guard.ts` `checkProviderAllowed`, `model-router.ts` 기본 정책표, `ai.ts` 선택 시점+호출 직전 재검사 |
| ⑥b | 민감도 2+ 메모 본문의 모델 전송 | 읽기 자체가 원천 차단이라 전송될 본문이 없음 (**차단**) | 동일 실행층이라 동일 (**차단**) | 동일 | **일치** | `policy-guard.ts` `assertMemoAccessibleForAI`, `ai-access.ts` |
| ⑦a | 허용 목록 밖 도구 (예: builder의 MEMO_DELETE, scheduler의 MEMO_GET) | **차단** `deny(tool_not_allowed)`, 모르는 비서는 `unknown_persona` | **차단** — 디스패처가 비서별 허용 집합(스킬 레지스트리 기준)을 실행 전에 강제. 모르는 비서도 같은 deny | `allowedSet` 검사로 차단 (레지스트리+허용 목록) | **일치 (D5 해소, 2026-10-31 트랙 3)** | E1: `tool-approval.ts`, `legacy-privacy-guard.ts` `LEGACY_MARKER_TOOLS`; E2: `fc-tool-policy.ts` `getPersonaFCTools`(SKILLS personas×tools) + `checkFCDispatchPolicy`, 강제 지점은 `memo-tool-dispatcher.ts`. 단 preflight(모델 피드백용 사전 검증)는 여전히 전역 도구표 기준 — 강제는 디스패처가 담당하므로 제공 부분집합 판정은 디스패치에서 확정된다 |
| ⑦b | keeper 일정 등록 | **차단** — keeper 마커 목록에 `SCHEDULE_CREATE` 없음 | **허용** — FC 도구 `schedule_create` 존재 (keeper 전용 스킬). 트랙 3 이후 디스패처가 keeper 아닌 비서의 schedule_create를 deny로 강제 | — | **비대칭 유지 D5-보충** (의도된 확장) | E1: `LEGACY_MARKER_TOOLS.keeper`; E2: `schedule-fc-tools.ts`, `skill-registry.ts` schedule-create 스킬 (배경은 `schedule-fc-tools.ts` 머리 주석 — 마커로 일정 등록이 안 되던 라이브 결함의 해법); 강제: `fc-tool-policy.ts` `getPersonaFCTools` |
| L1 | 잠금/해제 도구 호출 | **차단** `deny(lock_forbidden)` — 유효한 승인이 있어도 불가. 마커 텍스트는 실행 전 정책 문구로 치환 | **차단** — 정책 가드가 이름(정확 일치+lock/unlock 부분 문자열)과 잠금 필드를 거부 | 쓰기 가드 이전에 레지스트리 허용 목록에서 탈락 | **일치** | E1: `tool-approval.ts` `isLockTool`, `policy-guard.ts` `enforceNoLockMarkers`; E2: `policy-guard.ts:74` `assertToolCallAllowed` |
| L2 | 잠금 필드(is_locked 등)를 인자에 섞은 정상 도구 | 게이트는 인자 키를 보지 않음 (읽기 allow). 단 마커 파서가 id/text/query만 추출해 **현행 도달 불가** | **차단** `AI_LOCK_FIELD_FORBIDDEN` | — | 구조 차이 (현행 위험 없음) | E2: `policy-guard.ts` `LOCK_ARG_KEYS`; E1: `memo-tools.ts` `parse*` 함수들의 필드 추출 |
| F1 | 깨진 형식의 호출 | 파서가 버림 — 실행 없음 (**차단**) | preflight가 거부하고 모델에 오류 피드백 (**차단**) | Zod 검증 거부 | **일치** (fail-closed) | E1: `memo-tools.ts` `parseMemoCreateMarkers` 등; E2: `memo-fc-tools.ts:282` `preflightToolCalls` (단 cron/schedule은 `ai.ts:1081` 보정으로 전용 검증기 구제) |

---

## 일치 목록 (테스트로 고정됨)

1. **잠긴 메모 읽기·검색 차단** (①a·①b) — 공유 실행층(`ai-access`) 덕에 완전히 동일.
2. **잠긴 메모 삭제 차단** (②b) — 도달 경로는 다르지만(승인+실행층 vs 존재 숨김) 결과 동일.
3. **잠긴 메모 수정 차단** (②a) — 결과 동일. 단 E2는 도구 부재라는 다른 이유.
4. **비대화형 origin 쓰기 규칙** (⑤a 규칙 자체·⑤b) — `decideToolExecution`과
   `WriteExecutionGuard`가 같은 규칙( interactive만, 미지정 fail-closed)을
   독립 구현으로 공유하고, E2 디스패처 공통 게이트(트랙 3)도 DB 쓰기 도구 범위에서는 같은 결론.
5. **restricted 외부 전송 차단·민감 메모 본문 차단** (⑥) — 공유 프로바이더
   게이트와 공유 접근 계층이라 구조적으로 동일.
6. **잠금/해제 도구 전면 차단** (L1) — 승인으로도 못 뚫는다는 점까지 동일.
   따라서 AI 경로에서는 잠금 해제 step-up(PIN 재입력)에 도달할 수 없고,
   step-up은 사용자 전용 API에서만 산다 (양 경로 공통 "해당 없음").
7. **형식 검증 fail-closed** (F1) — 깨진 호출은 양쪽 모두 실행되지 않는다.
8. **일반 쓰기 승인 필요** (③) — 2026-10-31 D1 해소로 일치에 편입. E2 운영
   판정은 게이트 실물(`gateFCToolCall`)의 ask + 승인 후 실행으로 고정한다.
9. **삭제 완결** (④) — 2026-10-31 D3 해소로 일치에 편입. E2도 승인 실행으로
   실제 삭제까지 완주하고, 직접 호출의 확인 단계는 안전 기본값으로 유지된다.
10. **민감도2 메모 삭제·수정 차단** (②c) — 2026-10-31 트랙 3 D2 해소로
    일치에 편입. 양 엔진이 공유하는 실행층(`memo-tools`)이 잠금+sensitivity를
    함께 검사한다.
11. **비대화형 origin 쓰기 강제 위치** (⑤a) — 2026-10-31 트랙 3 D4 해소로
    일치에 편입. 판정은 `fc-tool-policy` 단일 원천, 강제는 디스패처.
12. **비서별 허용 목록 강제** (⑦a) — 2026-10-31 트랙 3 D5 해소로 일치에
    편입. E2 허용 집합은 스킬 레지스트리에서 도출되고 디스패처가 강제한다.

## 해소된 불일치 (2026-10-31, 커밋 `fcaee4d`)

| ID | 내용 | 해소 근거 |
|---|---|---|
| **D1** | E2 쓰기에 승인 게이트 없음 (③) — E1·E3는 승인 필수, E2만 즉시 실행이었다 | 신규 `fc-approval-gate.ts`가 FC 쓰기 7종을 E1 도구명으로 정규화해 같은 승인 왕복을 재사용하고, `ai.ts` FC 루프가 출처 게이트 직후·디스패치 직전에 게이트한다. 동등성 테스트 ③ [해소 D1] 2건 + `fc-approval-gate.test.ts` 22건 + `ai-fc-approval-loop.test.ts` 6건으로 고정 |
| **D3** | 삭제 완결 방식 (④) — E1은 승인 후 실제 삭제, E2는 확인 요청 반환이 끝이었다 | 승인 실행이 `executeFCApprovalPayload` → 디스패처 `approvedDelete`로 실제 삭제까지 완주 (executed_at 선점 포함). 직접 호출은 `confirmation_required` 유지. 동등성 테스트 ④ [해소 D3]로 양쪽을 함께 고정 |

## 해소된 불일치 (2026-10-31, 트랙 3 — FC 공통 실행 계층 통합)

| ID | 내용 | 해소 근거 |
|---|---|---|
| **D2** | 민감도 2 메모 삭제·수정 (②c) — E1 실행층은 is_locked만 봐서 읽을 수 없는 메모를 승인 하에 지우거나 덮어쓸 수 있었다 | 더 엄격한 E2 쪽으로 통일: 양 엔진이 공유하는 실행층 `memo-tools.ts`에 `aiWriteBlockReason`(잠금 + sensitivity>1 차단, 민감도는 "찾을 수 없음"으로 존재 숨김)을 넣어 삭제·수정을 함께 막았다. 사용자 직접 API(`modules/memo/routes.ts`)는 별도 SQL이라 영향 없음. 동등성 테스트 ②c [해소 D2] + `fc-approval-gate.test.ts` [해소 D2]로 고정, 카나리아(민감도 임계 무력화 시 두 테스트만 실패) 실증 |
| **D4** | E2 출처 게이트의 강제 위치 (⑤a) — 디스패처가 아닌 `ai.ts` FC 루프 인라인 하드코딩 목록(7종)이 유일한 강제 지점이었다 | 신규 공통 계층 `fc-tool-policy.ts`의 `checkFCDispatchPolicy`가 판정 단일 원천이 되고, 디스패처가 실행 전에 강제한다. 도구 집합은 이름 목록이 아니라 위험 분류(`classifyFCToolRisk` = 승인 도구명 매핑 + E1 분류표 공유)에서 도출되며, 미등록 이름은 `unknown`으로 deny-by-default. `ai.ts` 루프의 인라인 목록은 제거했고, 루프는 같은 분류 함수로 사전 거부만 한다 (근거: 판정 확정 호출의 디스패치 왕복 회피 + rejected 채널로 모델에 즉시 피드백 — 코드 주석에도 명시). 동등성 테스트 ⑤ [해소 D4] 2건으로 고정, 카나리아(출처 검사 무력화 시 두 테스트만 실패) 실증 |
| **D5** | 비서별 허용 목록 (⑦a) — E2 디스패처·preflight에 비서 강제가 없었다 | 디스패처가 `checkFCDispatchPolicy`로 비서별 허용 집합을 실행 전에 강제한다. 허용 집합의 단일 원천은 스킬 레지스트리(SKILLS의 personas×tools) — 루프가 모델에게 제공하는 집합과 강제 집합이 같은 정의에서 나온다. 운영 호출자는 전원 persona를 명시한다 (`ai.ts`: `policy.personaId`, 승인 실행: 승인 요청의 personaId). persona 미지정 직접 호출은 FC가 keeper 전용으로 도입된 역사적 기본값으로 keeper 간주 (근거는 `fc-tool-policy.ts` 주석에 명시 — 신규 호출자는 명시 필수). 동등성 테스트 ⑦ [해소 D5]로 고정, 카나리아(허용 목록 검사 무력화 시 D5 테스트 2건만 실패) 실증 |

### 트랙 3 통합이 엔진 단일화(P2)의 전제인 이유

엔진 단일화의 위험은 "엔진을 합치면 정책이 바뀐다"는 것이었다. 트랙 3으로
판정이 앞단(마커 파서/FC 루프)에서 실행 계층으로 내려왔다:
- E1 판정 = `decideToolExecution` (tool-approval) + 공유 실행층(memo-tools)
- E2 판정 = `fc-tool-policy.checkFCDispatchPolicy` + 승인 게이트
  (fc-approval-gate) + 같은 공유 실행층
- 위험 분류표·승인 도구명·실행층 차단은 이미 양쪽이 공유한다.
따라서 P2 단일화에서 남는 작업은 파싱·호출 앞단을 하나로 합치는 것뿐이며,
정책 동등성은 본 문서의 스위트가 계속 고정한다.

## 불일치 목록 (테스트에 [불일치 D*]/[잔여 D*]로 명시 고정)

| ID | 내용 | 위험도 평가 |
|---|---|---|
| D5-보충 | keeper 일정 등록 (⑦b) — E2에만 있는 의도된 확장 | 위험 아님 (문서화된 설계 결정). 단 "동등성" 관점에서는 비대칭으로 기록. 트랙 3 이후 FC 쪽 허용 범위는 keeper로 강제됨 |

그 외 구조 차이 (불일치로 세지 않음):
- **L2 잠금 필드**: E2는 명시 가드, E1은 파서 형태 의존. 현행 도달 불가.
- **이름 공간**: E1은 대문자 마커명, E2는 소문자 FC명. 위험 분류표(`classifyToolRisk`)는
  마커명 기준이라 FC 전용 도구(`memo_ui_action`, `cron_set_enabled`)는 분류 자체가
  `unknown`이다 — 트랙 3에서 `fc-tool-policy`가 FC→승인 도구명 매핑
  (`cron_set_enabled`→`CRON_TOGGLE` 등)과 FC 읽기 목록으로 이 간극을 메웠다.
  단 `classifyToolRisk('MEMO_UI_ACTION')` 자체는 여전히 `unknown`이며,
  FC 쪽 분류는 `classifyFCToolRisk`를 통해서만 한다 (동등성 테스트 ③ 고정).

---

## 구조상 동등성 검증이 불가능한 구간

1. **E3 전체의 운영 동등성** — E3는 `ENVIRONMENT==='staging'` + `ai.engine` +
   `ai.fc_test_approved` + 파일럿 비서(concierge) 4중 게이트
   (`function-calling-route.ts` `shouldUseFunctionCalling`)로 운영 도달 불가다.
   운영에서 E3 판정이 어떻게 될지는 실행 자체가 안 되므로 검증이 아니라
   단위 대조(WriteGuard)까지가 한계다. E3 도구도 `search_memo` 1종(읽기)뿐이라
   쓰기 동등성은 비교 대상이 없다.
2. **ai.ts FC 루프의 잔여 인라인 판정** — 트랙 3으로 출처·비서 판정은
   `fc-tool-policy`로 export돼 단위 테스트가 가능해졌고, 루프의 사전 거부는
   같은 함수를 쓴다. 남은 인라인 판정은 `useFC` 게이트(keeper+workers-ai)
   자체뿐이며, 이는 판정 정책이 아니라 "FC를 켤 것인가"의 경로 선택이다.
   루프 포함 통합 검증은 실모델(또는 모델 목) `aiChat` 전체 호출이
   필요하며 기존 `tests/unit/ai-fc-*` 계열의 영역이다.
3. **프롬프트 문법 의존 구간 (E1)** — E1 게이트는 모델이 마커 문법을 정확히
   출력해 파서에 걸린 뒤에야 동작한다. 모델이 마커를 쓰지 않거나 비표준
   형식을 쓰면(정규화 계층이 일부 흡수) 게이트 도달 자체가 확률적이다.
   "파싱된 이후"의 판정 동등성과 "모델이 실제로 그 경로를 타는가"는 다른 문제다.
4. **E2의 도구 결과 재전송** — FC 경로는 조회한 메모 본문을 tool 메시지로
   모델에 재전송해 후속 응답을 만든다. E1 마커 경로는 서버가 결과를 텍스트로
   치환해 끝낸다(같은 턴 재전송 없음). 따라서 "조회된 일반 메모가 프로바이더로
   나가는가"는 구조부터 다르다 (keeper 핀이 workers-ai인 현행에서는 내부
   처리로 귀결되고, NVIDIA 구간은 `nvidia-memo-guard`가 별도로 차단).
   실전송 여부의 종단 검증은 실모델 호출이 필요해 본 트랙 범위 밖이다.
5. **D3의 후속 턴 완결 — 해소 (2026-10-31)** — 정렬 전에는 E2 삭제 확인 뒤
   사용자가 동의했을 때 무엇이 지우는지가 모델의 다음 행동에 달려 있어
   결정적으로 고정할 수 없었다. 정렬 후 승인 실행은 `routes.ts` 가로채기 →
   `executeApprovedRequestOnce` → `executeFCApprovalPayload`라는 고정 코드
   경로로 완주하며, `tests/fc-approval-gate.test.ts`의 승인 왕복과 동등성
   테스트 ④로 결정적으로 고정된다. (게이트 없는 직접 호출의 확인 단계
   기본값도 ④가 함께 고정한다.)
6. **Google 쓰기(GCAL_CREATE)·아티팩트·할일 등 E1 전용 도구군** — E2 등가물이
   없어(FC 전환 계획 §1.5) 동등성 비교 자체가 성립하지 않는다.
   본 대조표의 범위는 양쪽에 대응물이 있는 메모·자동화·일정 등록으로 한정했다.
7. **운영 설정값 의존 구간** — 비서별 실제 스킬 매칭 결과, `ai_settings`
   오버라이드, 운영 `ENVIRON
...[truncated 1322 chars]