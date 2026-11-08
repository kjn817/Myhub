# 민감 데이터 접근 경로 검증 — 트랙 D: 첨부·블록 잠금 + UI-003 (2026-10-30)

- 담당: 트랙 D 워커 (첨부·블록 전용 경로 + 클라이언트 `public/`)
- 기준: 브랜치 `fix/unlock-block-remove-ciphertext` 작업 트리 / 운영 라이브 `d568a5b8` @100%
- 범위 경계: 서버 측 메모 라우트의 편집·해제 로직(트랙 C)은 건드리지 않았다. 수정은 전부 `public/js/memo/*` + 번들 + 신규 테스트다. 커밋·배포하지 않았다 (코디네이터 통합).
- 라이브 방법: `.scratch/trackd_live.py` — OTP 로그인 → 일회용 메모 2건(id 221 블록용, 222 첨부용 + 파일 id 98) 생성·잠금·검증 → 종료 시 DELETE로 정리, D1에서 삭제 확인 완료. 사용자의 기존 잠긴 메모(133·134·200·201)는 열람하지 않았다.
- 라이브 해제의 성공 케이스는 사용자 PIN을 알 수 없어(추측·추출 금지) **미실행**이다. 대신 PIN 없음 → 403을 라이브로, 맞는 PIN → 성공을 런타임(테스트 PIN)으로 실증했다.

## 1. 첨부 잠금 — 경로별 결과

| # | 경로 | 기대 정책 | 실증 방법 | 결과 |
|---|------|-----------|-----------|------|
| D-A1 | `POST /api/memo/files/:fileId/lock {locked:true}` 저장 형태 | 원본 바이트가 AES-GCM 암호문으로 교체 저장 | 라이브: 잠금 후 D1 `is_locked=1`, url·storage_key 변경, Cloudinary 암호문 바이트 길이 73 (평문 45와 다름·평문 미포함). 런타임 신규 테스트도 동일 성질 PASS | **PASS** |
| D-A2 | `GET /api/memo/files/:fileId/content` (소유자 읽기) | 잠긴 파일은 복호화해서 서빙 | 라이브: 200 + 원본 평문과 바이트 일치. 런타임 신규 테스트 PASS | **PASS** |
| D-A3 | 잠금 시 원본 평문 객체 처리 | 잠그는 순간 원본 평문은 스토리지에서 사라져야 함 | 라이브: **잠금 후에도 구 URL이 평문을 그대로 서빙** (서버 lock 핸들러가 구 `storage_key`를 `storageDestroy` 하지 않음). 잠금 전에 파일 목록·`data-full` 등으로 구 URL을 본 사람은 영구 접근 가능. 메모 삭제 시에도 현재(암호문) 키만 파괴되므로 구 평문 객체는 고아로 잔류 | **FAIL — 결함 D-1 (서버, 코디네이터/C 영역)** |
| D-A4 | `GET /api/memo/files/:fileId` (다운로드 리다이렉트) | 잠긴 파일 다운로드는 복호화된 원본이어야 함 | 라이브: 302 → 암호문 `.enc` Cloudinary URL. 즉 이 경로로 받으면 암호문 파일이 내려간다 (평문 누출은 아니나 `/content`와 동작 불일치) | **FAIL(동작 불일치) — 결함 D-2 (서버)** |
| D-A5 | 클라이언트 다운로드 (pane·list의 비이미지 파일 칩) | 잠긴 파일은 `/content`로 받아야 원본이 내려감 | 코드: 수정 전 pane.js·list.js 모두 `fetch(f.url)` — 잠긴 파일은 암호문 URL을 직접 받아 암호문 파일을 다운로드했음. **수정 완료**: `f.is_locked ? '/api/memo/files/'+id+'/content' : f.url` (pane·list 양쪽) | **FAIL → 수정 완료 (클라이언트)** |
| D-A6 | 클라이언트 이미지 표시 (md·list·pane 그리드) | 잠긴 이미지는 `/content`로 표시 (썸네일·원본 URL은 암호문이라 깨짐) | 코드: pane 그리드는 기존에 `/content` 사용 (PASS). 그러나 md.js `renderBodyHtml`/`mdToEditable`과 list.js 그리드는 `f.thumb \|\| f.url`을 써서 잠긴 인라인 이미지가 깨진 이미지로 표시됐음. **수정 완료**: `fileDisplayUrl`/`fileFullUrl` 헬퍼로 통일 | **부분 FAIL → 수정 완료 (클라이언트)** |
| D-A7 | `GET /api/memo/:id/files` 응답 | (메타데이터) 잠긴 파일의 암호문 URL 노출 자체는 평문 누출 아님 | 라이브: `is_locked:true` + 암호문 `.enc` URL 반환 확인. filename·mime·size는 평문 메타데이터로 남음 (파일명 검색으로 메모 존재·파일명은 확인 가능 — D-A8) | **PASS(암호문 위치만) / 메타데이터 잔여 기록** |
| D-A8 | 검색 경로에서 잠긴 첨부 | 파일 내용은 암호문이라 검색 불가. 단 파일명은 평문 | 라이브: 파일명 `trackd.txt`로 소유자 검색 시 해당 메모 반환 확인. 본문·파일 내용은 노출 없음 | **PASS(내용) / 파일명 메타데이터는 설계상 평문** |
| D-A9 | AI 경로에서 잠긴 첨부 | AI는 파일 내용을 읽지 못해야 함 | 코드: AI 메모 접근(ai-access)은 `memos.text`만 다루고 files 본문을 읽는 경로는 없음. 잠긴 파일이 첨부된 메모 본문 자체의 AI 접근은 메모 잠금 여부(트랙 B 소관)를 따름 | **PASS (코드)** |
| D-A10 | 첨부 해제 step-up `POST /files/:fileId/lock {locked:false}` | PIN 없으면 403 + 상태 불변, 맞는 PIN이면 해제 | 라이브: PIN 없음 → `403 {code:'PIN_REQUIRED'}`, D1 `is_locked=1` 유지 확인. 맞는 PIN 성공 케이스는 런타임 기존 테스트(트랙 C 신규 15·16 포함)로 실증 — 라이브 성공 케이스는 **NOT TESTED** (사용자 PIN 미보유) | **PASS (403·불변) / 라이브 성공 NOT TESTED** |
| D-A11 | 첨부 잠금 자체 (보호를 거는 행위) | PIN 없이 성공 (비대칭 정책) | 라이브: PIN 없이 200 `{is_locked:1}` | **PASS** |

## 2. 블록 잠금 — 경로별 결과

| # | 경로 | 기대 정책 | 실증 방법 | 결과 |
|---|------|-----------|-----------|------|
| D-B1 | `POST /api/memo/:id/lock-block` 저장 형태 | 비밀은 암호문으로만 존재해야 함 | 라이브: `locked_blocks`에는 `ENC:` 암호문만 저장됨(평문 없음)은 PASS. **그러나 `memos.text`에 비밀 평문이 그대로 남음** — 서버 핸들러가 암호문 사본만 추가하고 본문에서는 제거하지 않음 | **FAIL — 결함 D-3 (서버 설계)** |
| D-B2 | 소유자 검색 `GET /api/memo?q=<비밀>` | 잠긴 블록 비밀은 검색으로 나오지 않아야 함 | 라이브: 비밀 문자열 검색 시 메모 본문에 비밀이 포함돼 반환됨 (D-B1의 직접 consequence — FTS·trigram·LIKE 모두 text 기반) | **FAIL (D-B1 종속)** |
| D-B3 | AI 단건 `getAccessibleMemo` | 잠긴 블록 비밀은 AI에 전달 금지 | 런타임 일회용 특성화 테스트(실 D1+실 crypto, 종료 후 삭제): lock-block만 한 메모에서 `getAccessibleMemo`가 비밀을 포함한 본문을 그대로 반환. 원인: `sanitizeForAI(content, lockedBlocksJson)`가 **두 번째 인자를 전혀 사용하지 않음** (소스 확인 + 기존 단위 테스트 `svc2-ai-access`가 "lockedBlocksJson 인자 무시됨"을 성질로 고정하고 있음). `searchAccessibleMemos`도 동일하게 비밀 스니펫 반환을 확인 | **FAIL (D-B1 종속 + ai-access 미사용 인자)** |
| D-B4 | 소유자 읽기·편집 시 블록 복원 | 저장 후 다시 열어도 잠긴 블록이 플레이스홀더로 보이고 해제 가능해야 함 | 코드+라이브: `GET /api/memo/:id`·목록 응답에 `locked_blocks` 필드 자체가 없음 (라이브 확인). 클라이언트에도 locked_blocks 렌더링 코드가 전무 — 구 클라이언트는 잠금 직후 DOM에만 플레이스홀더를 만들었고, 저장하면 직렬화에서 blockId가 사라졌음. **클라이언트 수정 완료** (§3: 마커 방식) — 단 서버가 locked_blocks를 내려주지 않으므로 마커가 본문에 남는 방식이 유일한 복원 경로 | **FAIL → 클라이언트 수정 완료 / 서버 API에 locked_blocks 미포함은 잔여** |
| D-B5 | 블록 해제 step-up `POST /:id/unlock-block/:blockId` | PIN 없으면 403 + 블록 보존, 맞는 PIN이면 html 반환 + 제거 | 라이브: PIN 없음 → `403 PIN_REQUIRED`, D1에 블록 유지 확인. 런타임: 기존 테스트 11 (PIN 3종) + 신규 composed-flow 테스트의 해제( PIN 미설정 면제 포함) PASS | **PASS (403·보존·런타임 성공) / 라이브 성공 NOT TESTED** |
| D-B6 | 블록 잠금 fail-closed | 암호화 실패·없는 메모·빈 html은 거부 + DB 불변 | 런타임 기존 단위 테스트(lock-block 9건) + 신규 런타임(빈 html 400·없는 메모 404) PASS. 트랙 C 신규 18 (키 없음)도 동일 방향 | **PASS** |
| D-B7 | 수정된 클라이언트 흐름 종단 (잠금→마커 저장→검색·AI→해제) | 본문·검색·AI 어디에도 비밀 평문이 없어야 함 | 런타임 신규 `memo-block-flow.test.ts`: 실제 흐름(lock-block → 본문을 `[LOCKED_BLOCK:<id>]`로 PUT) 이후 raw text·소유자 검색·`getAccessibleMemo`·`searchAccessibleMemos` 전부에서 비밀 부재 + 해제 시 원문 반환·블록 제거 확인 | **PASS (런타임)** / 라이브 UI 흐름은 **NOT TESTED** (수정 클라이언트 미배포 — 배포 후 브라우저 QA 필요) |
| D-B8 | `unlock_pending` 폴백의 클라이언트 처리 (트랙 C 관찰 1 연계) | 부분 성공(복호문 수신·암호문 DB 잔류)을 무경고 성공으로 처리하면 안 됨 | §4 참조 — 수정 전 클라이언트 전 경로가 warning을 무시했음 (결함). **클라이언트 수정 완료** | **FAIL → 수정 완료 (클라이언트)** |

### 결함 D-3의 구조와 클라이언트 완화의 한계
- 서버 `lock-block`은 "암호화해 따로 보관"만 하고 본문 치환은 클라이언트에 맡긴 설계인데, 구 클라이언트는 치환을 저장하지 않았고 저장해도 blockId가 소실됐다. 즉 **어느 경로로도 블록 잠금이 실제로 성립한 적이 없다** (운영에 잠긴 블록 인스턴스 0건인 것과 무관하게, 시도했어도 평문이 남았을 것).
- 이번 클라이언트 수정(마커 방식)은 UI 흐름에서는 D-B1·B2·B3를 닫는다: 비밀이 본문에서 마커로 교체·즉시 저장되고, 이후 검색·AI는 마커만 본다.
- 그러나 **API를 직접 호출하는 경로는 여전히 fail-open**이다: lock-block만 호출하면 평문이 text에 남고, `sanitizeForAI`는 locked_blocks를 복호화해 대조할 수단이(동기 함수·키 없음) 구조적으로 없다. 근본 수정은 서버 영역(코디네이터 판단): ① lock-block이 본문 내 해당 문자열을 마커로 원자적으로 치환하거나, ② `getAccessibleMemo`/`searchAccessibleMemos`가 locked_blocks를 복호화해 본문에서 제거. 권고는 ① (저장 시점에 평문을 없애는 것이 모든 하위 경로를 한 번에 닫는다).

## 3. UI-003 — 원인 확정과 수정

### 원인 (확정)
"선택한 블록 잠금 (오류로 비활성화됨)" 버튼은 활성화 조건이 깨진 게 아니라 **코드에서 상시 비활성화로 하드코딩**돼 있었다 (`public/js/memo/toolbar.js`):
- 커밋 `daf9acb` (2026-10-12) "MEMO-001 긴급: 렌더러 정지 방지를 위해 블록 잠금 버튼 비활성화 (근본 원인 미해결)" — 버튼 핸들러를 alert 전용 스텁으로 교체하고 원본 핸들러 전체를 블록 주석으로 보존.
- 커밋 `ad01376` — `lockBlockBtn.disabled = true; opacity 0.5; cursor not-allowed`를 추가해 클릭 자체를 차단.
- 이후 근본 원인 규명 없이 방치돼 브라우저 QA(2026-10-30)에서 "상시 비활성 버튼"으로 재발견됨.

### 렌더러 정지 원인에 대한 판정
과거 기록(GPT_REVIEW_55~57)상 정지 원인은 **끝내 확정되지 않았고 가설만 있다** (A: `restoreSel`의 stale Range `addRange`, B: TRACE 진단 패널 부작용, C: Range 연산 hang). 브라우저 콘솔 접근 불가로 검증이 불가능했던 사안이라, 이번에도 "정지가 이 패턴 때문이었다"고 단정하지 않는다. 대신 구 핸들러에서 확인 가능한 위험 패턴을 전부 제거하고, 추가로 **기능 자체의 설계 결함**(D-B1·B4)이 비활성화와 무관하게 존재했음을 확인해 함께 고쳤다. 정지 재발 여부는 배포 후 브라우저 QA로만 확정할 수 있다 (**NOT TESTED** 항목).

### 수정 내용 (전부 클라이언트)
| 파일 | 수정 |
|------|------|
| `public/js/memo/toolbar.js` | 스텁+주석 원본 제거, 실핸들러 구현: 실시간 selection 우선·savedRange 폴백은 clone만 사용, 선택 검증(에디터 소속·연결성), lock-block 호출(10s 타임아웃 유지), 플레이스홀더는 `<div>`→ **인라인 `<span contenteditable="false">`** (div-in-p DOM 재구성 회피), 대기 중 첨부 없을 시 **즉시 PUT으로 본문에 마커 반영**, 해제 공용 헬퍼 `requestUnlockBlock`/`unlockLockedBlockEl` 신설 (step-up `fetchLockWithPin` 경유 + §4 unlock_pending 처리) |
| `public/js/memo/editor-core.js` | `restoreSel` 하드닝: 저장 Range를 그대로 `addRange`하지 않고 **clone + `isConnected` + 에디터 소속 검증** 후 복원 (가설 A 경로를 전 버튼 공통으로 차단) |
| `public/js/memo/md.js` | 직렬화: `.locked-block` 요소(span·div) → `[LOCKED_BLOCK:<id>]` 마커 (표시 텍스트 누출 차단). 렌더링: 마커(이스케이프형 `\[…\]` 포함) → `data-block-id` 플레이스홀더 복원. 잠긴 이미지 URL을 `/content`로 (`fileDisplayUrl`/`fileFullUrl`) |
| `public/js/memo/pane.js` | 보기 모드 플레이스홀더 클릭 → step-up 해제 → 본문 마커를 복호문으로 교체·PUT·재렌더. 편집 모드 로드된 플레이스홀더에도 해제 클릭 연결. 비이미지 파일 다운로드 잠금 시 `/content` 사용 |
| `public/js/memo/list.js` | 비이미지 다운로드·그리드 이미지 잠금 시 `/content` 사용 |
| `public/js/memo-bundle.js` | `scripts/build-memo-bundle.sh`로 재생성 (빌드 PASS, 소스-번들 정합성 재빌드 diff로 확인) |

## 4. unlock_pending 클라이언트 처리 (트랙 C 관찰 1에 대한 답)

**확인 결과 (수정 전)**: 클라이언트 어디에서도 `warning`/`unlock_pending`을 참조하지 않았다 (public/js/memo 전수 grep 0건).
- 구 주석 속 원본 핸들러: `udata.ok && udata.html`만 확인 — 부분 성공을 완전 성공으로 표시.
- 이번에 새로 쓴 두 경로(툴바 `unlockLockedBlockEl`, 페인 보기 모드)도 동일하게 `data.ok`만 봤다 — 그대로 두면 플레이스홀더/마커가 평문으로 교체·저장돼 blockId가 UI에서 사라지고, **암호문 블록만 DB에 영구 잔류(고아 암호문)** 하며 재시도 수단도 없어진다. 클라이언트 결함으로 판정하고 수정했다.

**수정 (클라이언트 범위)**:
- `requestUnlockBlock`: `warning:'unlock_pending'`이면 **1회 자동 재시도**. 재시도에서 블록이 이미 제거돼 404면 첫 응답의 html로 완전 성공 간주. 그래도 warning이 남으면 호출자에게 그대로 전달.
- `unlockLockedBlockEl`(편집)·페인 보기 모드: warning이 남으면 **플레이스홀더/마커를 교체하지 않고** "해제를 보류했어요, 다시 시도해주세요"를 알린다 — 재클릭으로 재시도 가능.
- 서버 폴백 자체(응답과 DB 상태의 불일치 허용 여부)는 C·코디네이터 영역이라 변경하지 않았다. 클라이언트 수정으로 사용자 오인·고아화는 막았지만, 제거 UPDATE가 반복 실패하면 암호문은 계속 남는다 — 서버 측에서 제거 실패를 오류로 승격할지는 코디네이터 판단 사항으로 남긴다.

## 5. 발견·수정한 결함 요약

| ID | 결함 | 심각도 | 처리 |
|----|------|--------|------|
| D-1 | 첨부 잠금 시 원본 평문 Cloudinary 객체 미삭제 — 구 URL로 평문 영구 접근 가능 | **높음 (보안)** | 서버 영역 — **미수정, 코디네이터 보고**. 권고: lock/unlock 양방향에서 교체 전 `storageDestroy(구 키)` 수행 |
| D-2 | `GET /files/:fileId`가 잠긴 파일도 암호문 URL로 리다이렉트 (다운로드 시 암호문 파일) | 중간 (동작) | 서버 영역 — 미수정, 보고. 권고: 잠긴 파일은 `/content`로 리다이렉트 |
| D-3 | 블록 잠금: 서버가 본문에서 평문을 제거하지 않음 + `sanitizeForAI`가 locked_blocks 미사용 → 검색·AI 평문 노출 | **높음 (보안)** | UI 흐름은 클라이언트 마커 방식으로 완화(수정 완료). API 직접 경로는 서버 근본 수정 필요 — 미수정, 보고 (§2 권고 참조) |
| D-4 | UI-003: 블록 잠금 버튼 하드코딩 비활성화 + 구 핸들러의 저장 누락·blockId 소실·PIN 미연동 | 높음 (기능) | **수정 완료** (§3) |
| D-5 | 잠긴 첨부의 클라이언트 다운로드·이미지 표시가 암호문 URL 사용 (암호문 다운로드·깨진 이미지) | 중간 | **수정 완료** (D-A5·D-A6) |
| D-6 | `unlock_pending`를 클라이언트가 무경고 성공 처리 → 고아 암호문 위험 | 중간 | **수정 완료** (§4) |
| D-7 | 이스케이프된 마커 `\[LOCKED_BLOCK:…\]`의 닫는 괄호를 렌더링 정규식이 놓침 (신규 테스트가 적발) | 낮음 | **수정 완료** (md.js 정규식에 `\\?\]` 허용) |

> **2026-10-30 코디네이터 통합 수정 (§8)**: 위 표의 D-1·D-2·D-3 상태가 갱신됐다 — **D-1 수정 완료, D-2 수정 완료, D-3 수정 완료(서버 근본 수정 채택)**. 상세·테스트·카나리아 결과는 §8 참조. 라이브 재검증은 배포 후 코디네이터가 수행한다.

부수 관찰: ① `window.currentEditingMemoId`는 페인 편집에서만 설정되므로, 컴포저(새 메모)에서 블록 잠금을 누르면 직전 편집 메모 id가 남아 있을 경우 엉뚱한 메모에 잠금이 걸릴 여지가 있다 (구 핸들러부터 있던 전제 — 이번 범위에서는 페인 흐름만 보장, 컴포저에서는 memoId와 현재 에디터 소속 일치를 추가 검증하는 후속 권고). ② 라이브 검증으로 만든 암호문 파일은 메모 삭제로 정리됐지만, D-1 때문에 잠금 전 평문 객체 1건(합성 테스트 문자열 `TRACKD-ATTACH-PLAINTEXT-9c2e…`)이 Cloudinary에 고아로 남았다 — 내용은 무해한 테스트 문자열이며, D-1 수정 시 함께 정리 대상이다.

## 6. 추가한 테스트와 결과

| 테스트 | 내용 | 결과 |
|--------|------|------|
| `tests/memo-block-ui003.test.js` (신규, Jest 12건) | 버튼 비활성화 부재, lock-block 호출, span 플레이스홀더, step-up 헬퍼, unlock_pending 처리 순서, md.js 실함수 실행(마커 직렬화·복원·잠긴 파일 URL), restoreSel 하드닝 | **12/12 PASS** |
| 카나리아 1 | md.js 마커 직렬화를 `return inner`로 깨뜨림 → 해당 테스트 FAIL 확인 후 복원 | 카나리아 동작 확인 |
| 카나리아 2 | toolbar의 `unlock_pending` 비교를 오타로 깨뜨림 → unlock_pending 테스트 FAIL 확인 후 복원 (파일 백업본으로 복원, 번들 재빌드) | 카나리아 동작 확인 |
| `tests/runtime/memo-block-flow.test.ts` (신규, vitest 3건) | composed 흐름 종단(잠금→마커 PUT→검색·AI 무노출→해제), lock-block fail-closed(400/404), 첨부 잠금 왕복(암호문 업로드·`/content` 복호화, fetch는 Cloudinary 경계만 스텁·암호화/D1은 실물) | **3/3 PASS** |
| 기존 관련 스위트 | `tests/unit/memo-routes.test.ts` + `tests/unit/svc2-ai-access.test.ts` | **149/149 PASS** (회귀 없음) |
| 번들 정합성 | `build-memo-bundle.sh` 2회 연속 빌드 diff 없음 + esbuild 문법 검증 | PASS |

전수 스위트는 병렬 부하 방지를 위해 실행하지 않았다 (관련 스위트만 실행 — 과제 지시).

## 7. NOT TESTED (정직하게 남김)

- 라이브에서 맞는 PIN으로 첨부·블록 해제 성공: 사용자 PIN을 모르며 추측·추출하지 않았다. 런타임(테스트 PIN)으로는 성공 실증 완료.
- 수정된 클라이언트의 실제 브라우저 동작 (UI-003 버튼 클릭, 렌더러 정지 재발 여부, 플레이스홀더 클릭 해제, PIN 모달 연동): 수정 클라이언트가 미배포라 라이브 검증 불가. 배포 후 브라우저 QA 필수 — 특히 MEMO-001 정지 재발 여부는 이 QA에서만 확정 가능.
- 잠긴 **이미지** 첨부의 라이브 왕복: 라이브에서는 텍스트 파일로 검증했다. 이미지 경로는 코드(pane 그리드 기존 `/content` + 이번 md/list 수정)와 런타임(텍스트 바이트 왕복)으로만 확인.
- AI 채팅 실모델이 블록 잠금 메모를 인용하는 종단 시나리오: AI 접근 계층 함수 단위로는 실증했으나(D-B3·D-B7), 실모델 채팅 호출로는 미실행 (트랙 B 소관 경로와 중복).

## 8. 코디네이터 통합 수정 완료 (2026-10-30, 서버 근본 수정 워커)

§5 표의 D-1·D-2·D-3에 대한 서버 근본 수정이 같은 작업 트리에서 완료됐다 (커밋·배포는 코디네이터 통합 단계에서 수행 — 이 절은 코드·테스트 완료 기록이며, 라이브 재검증은 배포 후 몫이다).

| ID | 상태 갱신 | 수정 내용 |
|----|-----------|-----------|
| D-1 | 미수정 → **수정 완료** | `POST /files/:fileId/lock` (`src/modules/memo/routes.ts`): 잠금·해제 양방향 모두 DB 업데이트 성공 후 교체 전 `storage_key`를 `storageDestroy(c.env, oldKey, file.resource_type)`로 파괴한다. DB 교체 전에는 파괴하지 않는다(실패한 잠금·해제에서 현행 객체를 잃지 않기 위해). 파괴 실패는 침묵하지 않는다: `console.error` + 응답 `{warning:'storage_cleanup_failed'}`로 표면화하고 잠금/해제 자체의 성공 의미는 바꾸지 않는다 (unlock_pending과 동일 철학). 이를 위해 `src/services/storage.ts`의 `storageDestroy`가 throw 없이 성공 여부를 `Promise<boolean>`으로 반환하도록 했고, HTTP 실패·네트워크 오류도 `console.error`로 남긴다 (메모 삭제 등 정리 경로는 반환값을 무시하므로 기존 내성 유지). |
| D-2 | 미수정 → **수정 완료** | `GET /files/:fileId`: SELECT에 `is_locked`를 포함하고, 잠긴 파일은 Cloudinary(암호문) URL이 아니라 복호화 서빙 경로 `/api/memo/files/:fileId/content`로 302 리다이렉트한다. 상대 URL은 `Response.redirect`로 만들 수 없어 Location 헤더로 직접 응답한다. 잠기지 않은 파일은 기존 동작 유지. |
| D-3 | 미수정 → **수정 완료 (권고 ① 채택)** | `POST /:id/lock-block`: 단일 UPDATE가 `locked_blocks` json_insert와 `text = replace(text, ?, ?)`(전 출현 → `[LOCKED_BLOCK:<blockId>]` 마커)를 함께 적용하고, `WHERE … AND instr(text, ?) > 0` 원자 가드로 경합 시에도 평문이 남는 잠금이 적용되지 않게 했다. text UPDATE는 FTS 트리거를 타므로 검색 인덱스에서도 비밀이 사라진다. 요청 html이 저장된 본문에 없으면 암호화만 마친 뒤 **409 `{error:'block_not_in_text'}`** 로 fail-closed — locked_blocks·text 모두 불변. 클라이언트 순서도 맞췄다: `public/js/memo/toolbar.js` 블록 잠금 핸들러가 **저장(PUT) → 잠금(lock-block) → 마커 반영(PUT)** 순서로 동작한다. 미저장 편집을 먼저 저장해 서버 본문과 일치시키고, 대기 중 첨부가 있으면 단순 PUT으로 파일이 유실될 수 있어 "먼저 저장" 안내 후 중단한다. 번들은 `scripts/build-memo-bundle.sh`로 재생성(BUILD PASS). |

### 테스트 (전부 실행 증거 있음, 전수 스위트는 지시대로 미실행)

| 테스트 | 결과 |
|--------|------|
| `tests/runtime/memo-block-flow.test.ts` (vitest, 실 D1+실 crypto): composed 흐름을 실제 클라이언트 순서(저장 PUT → lock-block → 마커 PUT)로 재작성 — lock-block 직후(클라이언트 PUT 전) 이미 원시 text에 마커만 있고 비밀 없음 + `memos_fts` MATCH 0건 + 소유자 검색·`getAccessibleMemo`·`searchAccessibleMemos` 비밀 없음 + 해제 왕복. D-3 신규: 본문에 없는 html → 409 + DB 불변, 중복 출현 전부 치환. D-1 신규: Cloudinary 경계 스텁에서 잠금 시 구 평문 키 destroy·해제 시 .enc 키 destroy 단언 (+warning 없음). D-2 신규: 잠긴 파일 GET → `/content` 302, 열린 파일 GET → 원본 URL 302 | **파일 전체 28/28 PASS** (`memo-lock-encryption` 포함 합산) |
| 카나리아 D-1: 핸들러의 destroy 조건을 무력화 → D-1 런타임 테스트 FAIL 확인 후 복원 | 카나리아 동작 확인 |
| 카나리아 D-3: 치환 바인드를 무력화(마커→원문) → 전부-치환 테스트 + composed 흐름 테스트 FAIL 확인 후 복원 | 카나리아 동작 확인 |
| `tests/unit/memo-routes.test.ts`: lock-block fixture에 본문 포함 조건 반영 + 신규(D-3 409·치환 SQL 단언, D-1 잠금/해제 destroy·destroy 실패/ false 시 warning, D-2 잠긴 파일 302). `tests/unit/svc2-storage.test.ts`: `storageDestroy` boolean 반환으로 단언 갱신 (+HTTP 실패 케이스). `tests/memo-block-ui003.test.js`: 저장→잠금 순서 단언 추가 (13건) | **180/180 PASS** (`svc2-ai-access` 포함 4개 스위트 합산) |
| `tests/runtime/memo-lock-encryption.test.ts`: 기존 11·17번 테스트의 메모 본문에 대상 html을 포함하도록 fixture만 조정 (D-3 fail-closed 계약 반영, 검증 성질은 유지) | **PASS** |
| `npx tsc --noEmit` | **PASS** |

### 라이브 재검증 프로브 (배포 후 코디네이터용)

- D-1: 일회용 메모에 텍스트 파일 첨부 → 파일 잠금 → 잠금 전 Cloudinary URL을 직접 GET하면 평문이 **오면 안 된다** (destroy됨). 해제 후에는 .enc URL도 동일. 잠금 응답에 `warning`이 없어야 한다.
- D-2: 잠긴 파일로 `GET /api/memo/files/<id>` → 302 Location이 `/api/memo/files/<id>/content`여야 하고, 열린 파일은 원본 Cloudinary URL이어야 한다.
- D-3: 비밀 문장을 포함한 메모에서 UI로 블록 잠금 → D1 원시 `text`에 마커만 있고 비밀 없음, `locked_blocks`는 `ENC:`만, 소유자 검색·AI 단건 조회에서 비밀 미노출. API로 본문에 없는 html을 lock-block 하면 409 + DB 불변.
- §5 부수 관찰 ②의 고아 평문 객체 1건(`TRACKD-ATTACH-PLAINTEXT-9c2e…`)은 코드 수정으로 자동 삭제되지 않는다 — Cloudinary에서 해당 객체를 별도 정리해야 한다.

### 8.1 후속 수정 — storageDestroy의 CDN 무효화·본문 판정 (2026-10-30, storageDestroy 후속 수정 워커)

**사유**: D-1 수정(커밋 c518208) 배포 후 코디네이터 라이브 재검증에서, destroy 호출이 성공 판정됐는데도 잠금 직후 구 URL이 평문을 계속 서빙하는 현상이 확인됐다. 원인을 코드로 확정한 두 가지: ① `storageDestroy`가 destroy 폼에 `invalidate`를 넣지 않아 자산이 삭제돼도 CDN 캐시(잠금 전 조회로 적재됨)가 계속 서빙할 수 있었다. ② HTTP 200이면 응답 본문을 보지 않고 `true`를 반환해, resource_type 불일치 등에서 오는 `{"result":"not found"}` 같은 실패성 응답도 성공으로 오인했다 — 그래서 잠금 핸들러의 warning 표면화도 발동하지 않았다.

**수정** (`src/services/storage.ts`, `storageDestroy`만, 시그니처 `(env, public_id, resource_type) => Promise<boolean>` 불변):
- destroy 폼에 `invalidate=true`를 포함하고, 서명 대상 파라미터(`cloudSign` 입력)에도 `invalidate: 'true'`를 넣어 서명을 유효하게 했다.
- 응답 JSON을 파싱해 `result === 'ok'`일 때만 `true`를 반환한다. 그 외(`not found` 포함, 본문 파싱 실패 포함)는 `console.error`에 result를 남기고 `false`를 반환한다. HTTP 비200·네트워크 오류의 기존 `false` 처리는 유지. 반환값을 무시하는 기존 호출자(메모 삭제 등 정리 경로)의 동작은 그대로다.

**테스트** (전수 스위트 미실행, 관련 스위트만):
- `tests/unit/svc2-storage.test.ts`: ① result `ok` → `true` + 폼에 `invalidate=true` 포함 단언 ② HTTP 200 + result `not found` → `false` 신규 ③ HTTP 오류 → `false` 기존 유지. `video resource_type` 스텁도 `{"result":"ok"}` 본문으로 맞춤.
- 타 스위트 스텁 점검: `tests/runtime/memo-block-flow.test.ts`의 Cloudinary 경계 스텁은 이미 `{"result":"ok"}`를 반환해 조정 불요. `tests/unit/memo-routes.test.ts`·`coverage-final-cov`는 `storageDestroy`를 모듈 레벨에서 mock하므로 본문 가정에 의존하지 않음. `tests/runtime/memo-lock-encryption.test.ts`는 destroy 무관.
- 실행 결과: `npx tsc --noEmit` PASS / Jest `svc2-storage`+`memo-routes` **144/144 PASS** / 런타임 vitest `memo-block-flow`+`memo-lock-encryption` **28/28 PASS**.
- 카나리아: 폼의 `invalidate` append 제거 시 ① 테스트 FAIL 확인 후 복원 / result 검사 무력화(`if (false)`) 시 ② 테스트 FAIL 확인 후 복원. 복원 후 `svc2-storage` 13/13 PASS 재확인.

**한계**: 라이브 검증은 하지 않았다 (코디네이터가 재배포 후 수행). `invalidate`는 Cloudinary CDN 무효화 요청일 뿐 전파에 시간이 걸릴 수 있어, 재배포 후 라이브 프로브에서 "잠금 직후 구 URL 평문 미서빙"이 실제로 성립하는지는 코디네이터 재검증으로 확정해야 한다.
