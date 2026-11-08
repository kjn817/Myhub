# 연극 테스트 전수 정리 기록 (2026-10-27)

상시 원칙 (사용자 지시, AGENTS.md): 테스트는 항상 의미 있는 테스트여야 한다.
커버리지 높이기 위한 테스트 금지. 테스트가 검증하는 성질이 깨지면 테스트가
실패해야 한다 (카나리아). `expect(true)` 연극, 하드코딩 배열끼리 비교,
mock 호출만 확인하는 단언은 테스트가 아니다. "알려진 결함" 핀으로 실패를
기대하게 만들지 않는다. 테스트하면서 발견한 결함은 고치고, 사용하지 않는
코드는 함께 정리한다.

## 0. 실태 (감사, 2026-10-27)

- 전체 Jest 271 스위트 / 4926 테스트, 커버리지 Statements 99.41%였으나
  gate-* 약 65개 파일이 `expect(true).toBe(true)` 연극, gate-18은 하드코딩
  배열끼리 비교, mock 사용 1815건·mock 호출만 확인하는 단언 427건.
- 가장 심각했던 것: runtime d1-migrations 테스트가 0039 결함을 '알려진
  결함' 핀으로 박아두고 실패를 기대하고 있었음 (커밋 7d58ce5에서 제거·회귀
  테스트로 교체, 카나리아 9건 확인).

## 1. 처리 결과 요약

| 배치 | 커밋 | 다시 씀 | 삭제 (covered) | 삭제 (성질 없음) |
|---|---|---|---|---|
| S (보안) | 4e3f1f8 | 13개 파일·61건 | gate-71 | — |
| D (데이터·동시성) | fadb501 | 14개 파일·45건 | gate-24 | — |
| W1 | 020be89 | 5개 파일·25건 | gate-40, 49, 51, 58 | gate-21, 27, 31, 73 |
| W2 (74~100) | 9dc4d98 | 5개 파일·23건 | — | gate-79~100 (22개) |
| U (미사용 코드) | cd6b7bf | expect(true) 2건 교체 | — | — |
| 통합 수정 | 93b78f0 | 실패 21건 수정 (아래 5절) | — | — |

다시 쓴 테스트는 전부 실제 DB(better-sqlite3 + 실제 마이그레이션 파일) 또는
실제 라우트(esbuild 컴파일 + Hono app.request()) 검증이다. mock 호출만
확인하는 단언은 새로 만들지 않았다 (gate-70의 console.error 단언은 에러
보고 동작 자체를 검증하는 것이며 mock-only 테스트가 아니다).

## 2. 삭제 — 이미 다른 실제 테스트에 covered되는 파일

| 파일 | cover하는 실제 테스트 |
|---|---|
| gate-71-session | gate-64의 "추측한 `p{id}` 키로 남의 채팅 조회 → 403" |
| gate-40-model-fallback | `tests/unit/job-processor.test.ts` 관문 40 실검증 3건 (5xx→`model.fallback` 이벤트, 폴백 실패 시 break, 429→`rate_limited` 재시도 없음) |
| gate-49-validate | `tests/studio-workspace.real.test.ts`의 `validate_files` 실검증 4건 (CSS 중괄호·HTML DOCTYPE·JS 문법) |
| gate-51-index | `tests/gate-18-indexes.test.js` (7d58ce5에서 마이그레이션 SQL 파싱 실검증으로 재작성) + `tests/runtime/d1-migrations.test.ts` |
| gate-58-logging | `tests/unit/job-processor.test.ts`의 `artifact_job_events` INSERT 단언 5곳 ("console.log 분리"는 검증 가능한 동작이 아닌 설계 서술이라 별도 테스트 없음) |
| gate-24-chat-cleanup | gate-69와 동일 엔드포인트(POST /chats/cleanup)·동일 정책 |

## 3. 삭제 — 검증할 성질 자체가 없는 파일

| 파일 | 사유 |
|---|---|
| gate-21-unused-vars | `doneUpdate`는 src 전체에 1건만 있고 사용 중. 미사용 변수 자체가 없고, 리포에 oxlint/eslint 설정·게이트가 없어 린트 영역이다 |
| gate-27-unused-param | POST /jobs에 `direct` 파라미터 잔재가 없다 (artifact 모듈 전체 grep 확인). 제거 완료 상태라 테스트할 성질이 없다 |
| gate-31-coverage | 커버리지 숫자 자체를 검증하는 파일이라 원칙상 연극 |
| gate-73-summary | "72개 스위트, 141개 테스트" 같은 스냅샷 요약 — 검증 가능한 성질이 아니다 (숫자도 이미 구식) |
| gate-79~100-final (22개) | 주석에 "검증 완료"만 있고 `src/`·`docs/` 어디에도 관문 79~100에 해당하는 성질·참조가 없음. 단일 벌크 커밋 `028e0c0`에서 생성된 플레이스홀더 |

## 4. 테스트하면서 발견해 고친 결함

1. **POST `/`·POST `/jobs`의 artifacts INSERT가 `html_content` 누락** (W1): 새 DB에서 작업 생성 500 (`NOT NULL constraint failed: artifacts.html_content`). job 행은 `pending` 고아로 남음. 수정: `POST /`는 요청의 `html_content`를, `POST /jobs`는 `''`를 INSERT에 추가 (`src/modules/artifact/routes.ts`).
2. **POST `/` 버전 INSERT가 없는 컬럼 `content_hash`/`content_size` 사용** (S): 새 DB·운영 모두 500. 운영 `artifact_versions`에는 `content_sha256`만 존재. 스키마대로 수정.
3. **어떤 생성 경로도 `owner_email`을 기록하지 않음** (S): 컬럼이 있어도 생성자가 자기 아티팩트에 403/404. `POST /`·`POST /jobs`·job-processor 2곳 INSERT에 `owner_email` 추가.
4. **`GET /:id/versions/:versionNo` 소유권 확인 없음** (S): 남의 초안 HTML을 버전 번호만 알면 읽을 수 있었음. 히스토리와 동일한 확인 추가.
5. **`GET /drafts` 소유자 필터 없음** (S): 전원 초안 노출. 필터 추가 (NULL 소유자 레거시 행은 백필 전까지 허용, 코드 주석 기록).
6. **`GET /search` 소유자 필터 없음** (S): 남의 초안 제목·채팅 스니펫 노출. 필터 추가 (고아 채팅은 소유자 개념이 없어 기존대로 반환, 주석 기록).
7. **`GET /chats` 필터 없이 호출 시 전체 채팅 100건 노출** (S): 필터 강제(400). 프론트는 항상 session_key를 넘김 확인.
8. **아티팩트 삭제·버전 정리가 FK 오류로 실패, 조용히 삼켜짐** (D, P0급): FK 강제 DB에서 버전 체인이 있는 아티팩트 삭제 시 `FOREIGN KEY constraint failed`. `artifact_versions.parent_version_id`가 `ON DELETE RESTRICT`인데 삭제 batch가 부모 링크를 먼저 끊지 않음. job-processor의 `catch {}`가 삼켜서 정리 정책이 실제 아티팩트에 대해 단 한 번도 동작하지 않았음. 수정: 삭제 batch 첫 문장에 부모 링크 해제 UPDATE 추가, 정리 2곳에도 동일 처리.
9. **수동 버전 생성 경로에 50개 초과 정리 없음** (D): `pruneOldVersions`가 없던 POST `/:id/versions`·`/:id/versions/files`에 동일 정책 추가.
10. **프론트엔드 조용한 실패 48곳** (D): `public/` 전체에서 본문 빈/주석뿐인 catch 48건 (agent.html 8 + memo/*.js 13 + chat.js 6 + 기타). 전부 `console.warn` 기록으로 수정, `scripts/build-memo-bundle.sh`로 번들 재생성, `node --check` + HTML 인라인 스크립트 문법 검증 통과. 스캐너 재실행 0건.
11. **미사용 코드 제거** (U): 미사용 export 7건 (`PASSWORD_MIN_LEN`, `PASSWORD_MAX_LEN`, `PIN_LENGTH`, `GOOGLE_SCOPE_CALENDAR_EVENTS`, `DEFAULT_SKILL_MAX_CHARS`, `MAX_CHECKPOINT_TEXT_LENGTH` re-export, `SESSION_ALLOWANCE_TTL_MS` re-export) + 미사용 export 타입 4건 (`TimeContext`, `ComposeOptions`, `TeamProgress`, `StepVerify` — 전부 re-export만 제거, 원본 유지). 제거 후 `npm run lint:deadcode`의 Unused exports / Unused exported types 섹션 소멸 (0건). 잔존 findings는 범위 외 5건만 (Unlisted dependencies 2, Unresolved imports 2, Configuration hint 1).

## 5. 배치 간 충돌 21건 수정 (통합, 커밋 93b78f0)

배치들이 각자 파일만 실행해서 몰랐던 교차 충돌. 전체 Jest에서 21건 실패로 발견됨.

- **POST /jobs 500, 15건** (gate-26, 46, 53, 76, 77, 78): S가 INSERT에 `owner_email` 기록을 추가했는데 W1/W2 테스트 셋업의 실제 마이그레이션에는 `artifacts.owner_email` 컬럼이 없음. 수정: 6개 파일의 `beforeAll`에 S와 동일한 의도된 스키마 재현 (`ALTER TABLE artifacts ADD COLUMN owner_email TEXT` + 사유 주석). 프로덕션에서 owner_email 기록을 빼는 우회는 하지 않음.
- **artifact-routes.test.ts 6건**: DELETE batch 문장 수 7→8 (D의 부모 링크 해제 UPDATE, 정당한 변경 — 기대값 8로 변경 + 사유 주석), `GET /chats` 필터 없음 → 400 계약 변경 (기존 전체 조회 단언은 취약한 동작을 고정하던 것 — 새 계약에 맞게 교체), DB 에러 500 경로·results null 경로는 `?session_key=abc` 요청으로 검증. mock 큐 누락 2건은 소유권 행을 먼저 push하도록 수정. 신규 테스트 1건 추가 ('버전은 있는데 소유권 없음 → 403').

### 404/403 순서 판단 (코디네이터 지시와 다르게 처리 — 근거 있음)

통합 수정자는 당초 지시(존재 확인 우선 → 없으면 404)대로 바꿨다가 기존 통과
테스트 gate-61 1건이 실패하는 것을 보고 소유권-우선을 유지하기로 했다.
근거: gate-61 실DB 테스트가 명시 고정 — 타인(BOB)이 타인 초안의 **없는
버전 99**를 조회해도 **403** (존재 여부 노출 방지). 소유자(ALICE)의 없는
버전은 404. 코드베이스 전체가 동일 패턴 (POST `/:id/versions`, gate-65,
히스토리·파일·diff 핸들러 모두 소유권 우선). 존재 확인 우선으로 바꾸려면
gate-61의 보안 단언을 404로 느슨하게 만들어야 하므로, 코디네이터도
소유권-우선 유지를 승인한다. routes.ts 해당 핸들러에 의도를 주석으로 명시함.

## 6. 카나리아 검증 (전부 실패 확인 후 복원)

- S: `GET /:id/versions/:versionNo` 소유권 확인 제거 → gate-61 1건 실패 (`Expected: 403, Received: 200`, BOB이 초안 HTML을 읽음).
- D: DELETE batch 부모 링크 해제 UPDATE 제거 → gate-35·36 각 1건 실패 (DELETE 500, FK 오류). POST `/:id/versions`에서 prune 호출 제거 → gate-72 수동 경로 실패 (56개 버전 잔존).
- W1: POST /jobs INSERT에서 `html_content` 제거 → gate-26 5건 중 2건 실패 (500). 취소 UPDATE의 `lease_token=NULL`을 `lease_token=lease_token`으로 변경 → gate-55 6건 중 2건 실패.
- W2: agent.html sandbox에 `allow-same-origin` 추가 → gate-74 2건 실패. `validProviders`에서 `nvidia` 제거 → gate-76 2건 실패.
- U: `tools-builtin.ts` 상한 10→20 변경 → 새 테스트 실패. `memory/routes.ts`의 `DELETE FROM ai_memory_v2` 제거 → 새 테스트 197행 단언 실패.
- 통합: 셋업 ALTER 제거 → gate-76 성공 경로 4건 500 실패. 순서 뒤집기(존재 확인 우선) → 순서에 민감한 테스트 3건 실패 (소유권-우선 계약 고정 증명).
- 이전 (7d58ce5): 옛 0039로 되돌리면 새 테스트 9건 전부 실패 (Jest 7건 + runtime 2건).

## 7. 미해결·결정 대기 (배포 전 필수 포함)

1. **마이그레이션 0058 결정 대기 (배포 전 필수, P0)**: `artifacts.owner_email`을 만드는 마이그레이션이 없다. 운영 D1 읽기 전용 확인: 운영 `artifacts`에도 없음 (컬럼: id, title, type, html_content, created_at, updated_at, status, draft_version_id, published_version_id, description, icon_key, row_revision, source_job_id, …). 배포된 코드(94a7a06, 라이브 4dc64078)의 routes.ts는 `owner_email`을 25곳에서 참조하고, 현 HEAD는 33곳에서 참조한다. 즉 **운영에서 소유권 참조 엔드포인트(상세·PATCH·게시·버전·채팅 등)는 지금 500**이다. routes.ts POST /jobs도 새 대화 시 `artifacts`에 owner_email을 INSERT하므로 컬럼 없이 배포하면 운영에서도 500. 0058 생성 여부와 운영 D1 단독 적용 방식을 배포 전에 결정해야 한다. 이번 프로그램에서는 만들지 않았다 (지침상 마이그레이션 생성 금지).
2. **같은 부류의 스키마 드리프트**: `artifacts.source_job_id`는 운영에는 있으나 마이그레이션에는 없다. `artifact_versions.content_hash/content_size`도 같은 드리프트였으나 코드는 `content_sha256` 사용으로 이미 고쳐짐.
3. **POST /jobs에 `artifact_id`를 주면 그 아티팩트 소유권을 확인하지 않는다** (modify job으로 남의 아티팩트 수정 가능). gate-26 영역 — 정책 결정 필요.
4. **`POST /chats/migrate`는 출발 세션(`from_session`) 소유권을 확인하지 않는다.** 고아 세션 소유자 개념이 없어 정책 결정 필요.
5. **job-processor 정리 실패 `catch {}`**는 그대로 (D 범위 밖). 정리 실패가 다시 조용히 묻힐 수 있다.
6. **`awaiting_input` 상태 작업 취소 시 응답 `ok:true`이나 DB는 불변** (W1 관찰). 400으로 바꿀지 별도 판단 필요.
7. **gate-45의 pollJob 본체(DOM·타이머·AbortController)는 Node 단위 테스트로 실행하지 못했다.** 서버 계약(events `since` 증분·상태 전이)만 실검증. 클라이언트 측 중복 방지·중단은 실기기/브라우저 테스트 필요.
8. **gate-34는 하드코딩 배열 비교가 남아 있다** (expect(true)는 없음). 성질(artifact_job_events 삭제)은 gate-36의 7개 테이블 전수 삭제 테스트가 cover하므로 파일 자체는 후속 정리 대상.

## 8. 이번 범위 외 (손대지 않음)

- 순환 참조 7건 (`ai.ts` 5건 등장, 모듈 간 직접 import는 0건으로 헌법 경계 유지), 복붙 94건/908줄(2.64%), 500줄 초과 파일 12건 — 목록만 유지 (`docs/deadcode-20261026.md`).
- `lint:deadcode`/`lint:circular`는 findings가 있어 여전히 exit 1 (report-only). 정리 전에는 배포 게이트에 연결하지 말 것.
- mock 호출 단언(`toHaveBeenCalled`) 431줄이 구형 스위트에 남아 있다. 이번 프로그램에서 새로 만든 것은 없다 (gate-70의 console.error 단언은 에러 보고 동작 검증). 구형 스위트의 mock 단언 정리는 후속 과제.
- promptfoo 라이브 게이트는 아직 실행하지 않았다 (운영 D1에 [EVAL] 데이터 생성 — 사용자 승인 필요).

## 9. 최종 수치 (코디네이터 직접 재실행)

- 전체 Jest: **5004/5004 통과** — 단, 코디네이터 1차 재실행에서는 1건 실패
  (5003 통과, 실패 테스트 미식별 — `tail`로 요약만 남김). 이후 2회 전수
  재실행은 모두 5004/5004 exit 0. 2026-10-26에도 동일 패턴의 flaky
  테스트 1건이 기록돼 있다 (첫 실행 실패 후 재실행 전수 통과, 원인
  미특정). 이번 flaky의 정체는 잡지 못했으므로 후속 과제로 남긴다
  (실패 시 전체 로그를 파일로 남겨 테스트명을 확보할 것).
- `npm run test:runtime`: 22/22 통과
- `npx tsc --noEmit`: 클린
- `npm run lint:deadcode`: Unused exports / Unused exported types 0건 (잔존: Unlisted dependencies 2, Unresolved imports 2, Configuration hint 1 — 범위 외)
