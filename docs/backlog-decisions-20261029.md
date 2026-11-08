# 백로그 결정 기록 (2026-10-29)

오래 미뤄진 정책 결정 6건을 코드 실측 후 결정·적용한 기록이다. 결정 권한은
사용자가 2026-10-29에 위임했다 ("사소한 결정은 묻지 말고 판단해서 진행").
각 항목: 결정 / 근거(코드 위치·실측) / 적용 결과. "현상 유지"도 근거가 있으면
정당한 결정으로 기록한다.

---

## 1. POST /jobs artifact_id 소유권 확인 — **적용 (fail-closed)**

- **결정**: `artifact_id`가 지정된 잡 생성은 소유권 확인을 통과해야 한다.
  아니면 403. (관문 79)
- **근거**:
  - 수정 전 `src/modules/artifact/routes.ts` POST /jobs는 artifact_id 무확인.
    같은 파일의 POST /chats(관문 68)·publish(관문 59)·active-job은 전부 확인하는
    일관성 결여였다.
  - modify 잡은 `job-processor.ts:86~88`이 대상 아티팩트의 draft를 읽고
    `saveJobResult`가 새 버전을 쓰므로, 타인 artifact_id는 읽기+쓰기 침해 경로였다.
  - UI 호출자는 `public/agent.html` `callAiJob()` 하나뿐이며 `curId`(사이드바에서
    선택한 자기 프로젝트)만 보낸다 — 정상 사용의 동작 변화는 없다.
- **적용**: 멱등성 조회보다 먼저 `SELECT id FROM artifacts WHERE id=? AND
  owner_email=?` (관문 68과 동일 패턴).
- **테스트**: 단위(타인/없는 artifact_id → 403 & INSERT·큐 없음) + 실DB
  (`tests/gate-track-a-artifact.test.js`). 카나리아: 가드 제거 시 5건 실패.

## 2. POST /chats/migrate from_session 소유권 — **부분 적용 (이관 범위 축소)**

- **결정**: from_session 자체의 소유권 검증은 도입하지 않는다 (아래 근거).
  대신 이관 UPDATE에 `AND artifact_id IS NULL`을 더해, 이미 아티팩트에 붙은
  채팅은 어떤 경우에도 이관되지 않게 한다. (관문 80)
- **근거**:
  - 수정 전 UPDATE는 `WHERE session_key=?`뿐이었고, 프로젝트 채팅의
    session_key는 `p${artifactId}`로 **결정적**이라 `from_session='p<타인 id>'`로
    타인 아티팩트의 채팅 전부를 빼낼 수 있었다 — 실제 결함.
  - session_key 생성 경로 전수: 프론트 새 채팅은 `'new-'+Date.now()`에
    artifact_id=null(고아), 프로젝트 채팅은 생성 시점부터 `p<id>`+artifact_id가
    함께 저장된다. 즉 정당한 이관 대상은 고아 행뿐이다.
  - 고아 세션 행에는 소유자를 기록하는 컬럼이 없어 (migrations/0036)
    from_session 소유권을 검증할 수단이 스키마에 없다. 세션 키는 클라이언트가
    생성한 무작위성 키(`new-<timestamp>`는 약하지만, 이관先 소유권 확인(관문 67)이
    쓰기 대상을 지키고, 이동 범위를 고아로 한정한 뒤에는 빼낼 수 있는 대상이
    "아직 어떤 프로젝트에도 속하지 않은 채팅"뿐이라 잔여 위험을 수용한다.
- **적용**: UPDATE 조건 추가 + 코드 주석에 전제 명시.
- **테스트**: 실DB — 고아 이관 성공 / `p<타인id>` 행 불변 / 자기 아티팩트 채팅도
  불변 / 타인 to_artifact 403 유지. 카나리아: 조건 제거 시 3건 실패.

## 3. job-processor `agentResult.files || {}` 정규화 — **미적용 (fail-closed가 정답)**

- **결정**: 정규화하지 않는다. 대신 기존의 "우연한 TypeError" 의존을 명시적
  계약 위반 가드로 교체했다 — `ok:true`/`awaitingInput:true`인데 files가 객체가
  아니면 `AGENT_CONTRACT_VIOLATION`으로 잡을 failed 처리한다.
- **근거** (반환 계약 전수 실측):
  - `src/services/studio-agent.ts`의 반환 6경로 전부 files를 객체로 보장한다.
    "파일을 안 만든 정상 케이스"는 대화 모드 반환(`studio-agent.ts:564~570`)이
    보여주듯 이미 `{}`로 표현된다. `studio-workspace.ts` `getFiles()`도 항상
    새 객체를 반환한다.
  - 따라서 files===undefined는 정상 케이스가 아니라 **계약 위반 신호**다.
    정규화하면 위반이 summary-only 분기(job-processor.ts:215)를 타고 `done`으로
    포장되고, awaitingInput 경로에서는 pending_state에 files 키가 무음으로
    탈락해 재개 시 부분 파일 소실이 은폐된다 (수정 전 실측: 지점별 무음 통과/
    우연한 TypeError가 혼재).
  - 시스템 목적(정직한 실패 보고)에 맞는 쪽은 명시적 실패다.
- **적용**: `src/modules/artifact/job-processor.ts`에 수신 직후 가드 (+13줄).
  `ok:false` 경로는 files를 쓰지 않아 제외(기존 error 보존).
- **테스트**: `tests/unit/job-processor-branches.test.ts` — 기존 TypeError 전제
  테스트를 명시 위반 전제로 교체 + 신규 3건. 카나리아: 정규화로 되돌리면
  3 케이스 전부 기대와 반대로(done/awaiting_input) 실패.

## 4. awaiting_input 작업 취소 응답 — **400이 아니라 실제 취소로 적용**

- **결정**: (b) 400 전환을 기각하고 (a) awaiting_input도 실제로 취소할 수 있게
  한다. 취소 시 `pending_state=NULL`로 질문 상태를 폐기한다. 더불어 UPDATE
  변경 0건이면 거짓 성공을 금지하고 400을 반환한다. (관문 81)
- **근거**:
  - 수정 전: awaiting_input는 완료/실패 분류에도 없고 UPDATE 대상
    (`pending`,`running`)에도 없어 **0건 변경인데 `{ok:true}`** — 거짓 성공.
  - 클라이언트 실측: `public/agent.html` `pollJob`이 질문 팝업을 띄우는 동안에도
    working 행의 취소 버튼이 노출·호출되고 성공 시 UI가 정리된다. 400으로 막으면
    이 버튼은 영원히 실패만 반환한다.
  - 질문 팝업에는 제출 외 포기 수단이 없어, 취소 불가면 버릴 잡을 강제 답변·
    재개해야 한다.
  - 안전성: 큐 claim(`job-processor.ts:35`, `claimJob:380`)은 pending/만료
    running만 집으므로 failed 전이된 잡은 재실행되지 않고, `/answer`는
    awaiting_input가 아니면 400이라 취소 후 재개도 불가능하다.
  - `GET /:id/active-job`이 awaiting_input를 이미 "진행 중"으로 취급하는 것과도
    일관된다.
  - 미확인 1건: 질문 팝업 오버레이가 떠 있는 동안 취소 버튼의 실제 클릭
    가능 여부(브라우저 영역). 팝업 전/후 경로는 코드로 확인됨.
- **적용**: `src/modules/artifact/routes.ts` POST /jobs/:id/cancel.
  기존 `tests/gate-55-cancel.test.js`의 "awaiting_input는 취소 대상이 아니다"
  테스트는 거짓 성공을 고정한 것이라 계약 변경으로 교체했다.
- **테스트**: 실DB(취소 후 status/error/lease/pending_state + 이후 /answer 400)
  + 단위. 카나리아: 구 형태로 되돌리면 3건 실패.

## 5. Semgrep CI 게이트 — **베이스라인 게이트로 적용 (CI 아님을 명시)**

- **결정**: 신규 검출만 실패시키는 베이스라인 방식을 채택하되, 이 저장소에는
  CI가 없으므로 **로컬/배포 전 게이트 스크립트**로 구현한다. 자동 차단이
  아니라는 한계를 명시한다. 상세는 `docs/semgrep-gate-20261029.md`.
- **근거**:
  - CI 부재 실측: `.github/` 자체가 없고 타 CI 설정 파일도 없다.
  - 근거표 `docs/semgrep-recheck-20261029.md`: 46건 전수 오탐 판정 (진짜 결함 0).
    전면 차단(`--error`)은 상시 실패라 불가. `--baseline-commit`은 직접 배포
    흐름에서 기준이 모호하고 판정 목록이 남지 않는다.
  - 식별자는 `check_id + path + snippet_hash + occurrence` — 줄번호는 제외했다
    (재검증 문서에 157→215행 이동 churn 실증). snippet_hash는 검출 구간 소스
    라인의 정규화 sha256이다.
- **적용**: `scripts/semgrep-gate.sh`(신규), `.semgrep/baseline.json`(46건 고정),
  `package.json`에 `lint:security:gate` 스크립트 추가 (기존 `lint:security` 유지).
- **실증**: 현재 코드 PASS(exit 0) / `eval()` 카나리아 → FAIL(exit 1, 정확히
  1건 지목) / 베이스라인 1건 삭제 → FAIL(숨길 수 없음) / 검출 소실 → 경고만
  PASS / 줄 이동(+1행) → PASS.
- **한계**: CI가 없어 강제력 없음 (사람이 실행할 때만 동작). 검출 구간 자체의
  토큰 편집·파일 rename·규칙 ID 변경은 신규+소실 쌍으로 잡힌다(fail-closed).
  untracked 파일의 스캔 포함 여부는 미확인 — 신규 파일은 stage 후 검사할 것.
- **후속 제안 (미적용)**: deploy_full.py 사전 단계에 게이트 연결 여부 — 배포
  스크립트 변경은 영향 범위가 커서 이번 범위에서 제외하고 제안으로만 남긴다.

## 6. 잠금/해제 step-up 재인증 — **비대칭 적용 (해제만 PIN)**

- **결정**: 잠금에는 PIN을 요구하지 않고, **해제 3경로 전부**에 PIN 재입력을
  요구한다. PIN 미설정 계정(hasPin=false)은 면제한다.
  - `POST /api/memo/:id/lock` — `locked:false`이고 현재 잠긴 메모일 때만
  - `POST /api/memo/:id/unlock-block/:blockId` — 블록이 존재하면 항상
    (복호화된 html을 응답으로 직접 반환하는 가장 직접적인 노출 경로)
  - `POST /api/memo/files/:fileId/lock` — `locked:false`이고 현재 잠긴 첨부일 때만
- **근거**:
  - 위협 모델: 세션 30일 유효. 세션 탈취·공용 기기 방치 시 해제만으로 비밀이
    평문화되고 AI 접근 계층에도 다시 노출된다. 반면 탈취자가 잠금을 거는 행위는
    비밀을 노출하지 않고 소유자는 PIN으로 풀 수 있어, 잠금 step-up은 마찰만
    늘고 이득이 없다 — 비대칭이 비례적이다.
  - PIN 검증은 `src/modules/auth/routes.ts`의 기존 `verifyPin`/`hashPin`/
    `checkRateLimit`를 import 재사용 (auth 모듈 무변경).
  - PIN 미설정 면제 근거: 강제하면 PIN 미설정 계정은 영원히 해제를 못 하는
    lockout이 된다. PIN 설정은 OTP 재인증 → set-pin 경로로 상시 열려 있고,
    설정한 순간부터 자동 강제된다. 운영 사용자는 PIN 설정 완료 상태라
    운영에서는 전면 강제된다.
  - 응답 형식은 기존 auth 형식에 맞춤: PIN 없음 403 `PIN_REQUIRED`, 틀림 403
    `PIN_INVALID`, 과다 시도 429 `PIN_RATE_LIMITED`(전용 전역 제한 10회/시간 —
    pin-login의 계정 잠금 카운터와는 연동하지 않았다: step-up 오답이 로그인을
    잠그는 DoS를 막기 위함), 손상된 PIN 행 500. 검증은 모든 쓰기 전에 수행되어
    실패 시 상태 불변.
- **적용**: `src/modules/memo/routes.ts`(`checkUnlockPin()` 헬퍼),
  `public/js/memo/pane.js`(PIN 입력 모달 — 기존 모달 패턴 재사용, 403 시 1회
  재시도; PIN 미설정 계정은 서버가 허용하므로 모달이 뜨지 않음),
  `public/js/memo-bundle.js`(빌드 스크립트로 재생성).
  블록 해제의 프론트 버튼은 현재 비활성 스텁이라 API 방어만 적용 — 프론트
  연결은 블록 잠금 기능 복구 시 후속.
- **테스트**: Jest 13건 + 런타임 4건 (실제 PBKDF2·AES-GCM·D1). 카나리아:
  거부 반환을 무력화하면 Jest 정확히 5건·런타임 정확히 2건만 실패.
- **남은 한계**: 소유자 읽기 경로(목록·단건 GET 복호화 반환, 잠긴 파일 content
  서빙)는 `<img src>` 등으로 쓰여 PIN을 걸 수 없어 이번 범위 제외 — step-up은
  "읽기 차단"이 아니라 "조용한 영구 해제(→AI 노출) 차단"이다. 첨부 해제는
  Cloudinary 외부 fetch가 필요해 런타임 테스트 미수행 (Jest로 검증).
  계정 단위 잠금 연동은 후속 판단 사항.

---

## 검증·배포 (피니셔 기입, 2026-10-30)

전임 코디네이터가 밤사이 종료돼, 피니셔가 감사부터 다시 확정했다.

- **감사**: 전임의 결정 6건은 전부 작업 트리에만 적용돼 있었고 **커밋은
  0건**이었다 (HEAD f763965). NVIDIA 팩 배포(6bea02f4)가 작업 트리를
  통째로 번들해 라이브에는 이미 반영돼 있었음을 파일 mtime·라이브
  프로브로 확정했다. 전임이 지시한 회귀 수정 2트랙도 반영 확인:
  gate-26·studio-phase-b 픽스처 교정 (대상 스위트 PASS), pane.js 빈
  catch 수정 + memo-bundle.js 재생성 (번들 내용 대조로 동기화 확인).
- **전수 검증 (피니셔 직접 실행)**: tsc 클린 / Jest **267 스위트
  5,423/5,423 PASS** / 런타임 **10파일 127/127 PASS** / Semgrep 게이트
  독립 재실행 PASS (46건 = 베이스라인, 신규 0). 백로그 범위 스위트는
  별도로도 전건 PASS (gate-track-a 9건 포함 343건).
- **커밋**: `d919d0f` (이 결정 팩 19파일) + `16692ce` (게이트 적발
  수정·가드·mistral 등 배포 완료 미커밋분 동기화 36파일). node_modules·
  .scratch·__pycache__는 제외 (기존 관행).
- **배포**: `deploy_full.py production` 1회 정상 완료 — **213e5026
  @100%** (이전 6bea02f4), 시크릿 가드 PASS (30개), Cron `*/5`,
  DEPLOY VERIFY PASS + verify 모드 **4/4 PASS**. 이 배포에는 형제
  mistral 8007 수정(결합 트리 전수 통과 상태)도 함께 실렸다.
- **라이브 QA**: OTP 단회 로그인 200, 비서 3명 실응답 (keeper 오늘자
  뉴스+출처), step-up 라이브 프로브 PASS (신규 메모 잠금 → PIN 없이
  해제 시도 **403 PIN_REQUIRED** + 잠금·암호문 불변 + 삭제 정리,
  서빙 번들의 프론트 배선 확인).
- **추가 배포 (게이트 수정분)**: 커밋 `b0fb802` → **b1b1ccb0 @100%**,
  verify 4/4 PASS. 최종 전수: Jest 269 스위트 5,445/5,445·런타임
  127/127·tsc 클린 (피니셔 독립 재실행으로 확정).

## 7. promptfoo 라이브 게이트 — **실행 (배포 후 게이트로 채택), 최종 6/6 PASS**

- **결정**: 실행한다. GPT가 "미실행"으로 찍은 항목이고, Jest가 못 잡는
  라이브 종단 결함(뉴스 신선도·FC·인젝션)을 결정적 어설션으로 재는
  유일한 장치다. Semgrep 게이트와 마찬가지로 CI가 없어 수동 실행이
  전제 (강제력 없음이 한계).
- **전제 정정 (실측)**: 2026-10-26의 "6/6 PASS"는 라이브가 아니라
  **mock 검증 실행**이었다 (결과 JSON의 프로바이더가 mock-provider,
  픽스처 id 999 등, 구축 커밋 메시지에 "라이브 호출 없음" 명시).
  라이브 실행은 이번이 처음이다.
- **1차 라이브 (6bea02f4)**: 2 PASS / 2 FAIL / 2 ERROR — persona
  'echo'가 400 unknown persona (정규화 누락), keeper 일정 생성 불가
  (일정 스킬·도구 부착 부재 + preflight가 cron까지 Unknown tool로
  거부하던 잠재 결함 + 가드 후속 검사의 과잉 차단), 메모 생성 확인
  문구 소실 (결정적 문구가 마커 경로에만 존재). **어설션은 약화하지
  않고 전부 제품 코드로 수정** (커밋 `16692ce`, 배포 `213e5026`):
  persona 정규화, schedule FC 신설, preflight 구제, FC 완료 시
  결정적 문구 서버 확정.
- **2차 (213e5026)**: 5/6 PASS + 실물 검증에서 잔여 3건 적발 —
  일정이 **2025-08-11**로 오등록 (시간 컨텍스트가 scheduler에게만
  주입돼 keeper가 "오늘"을 학습 데이터 날짜로 오인), 메모 **중복
  생성** 2건 (FC 후속 실패 시 모델 폴백이 처음부터 재실행해 완료된
  쓰기를 반복), 인젝션 **페이로드 에코** (거부하면서 요구 문구를
  그대로 출력).
- **잔여 수정 (커밋 `b0fb802`, 배포 `b1b1ccb0`)**: keeper에도 서버
  확정 날짜 컨텍스트 공급 + AI 도구 경로 한정 **과거 start_at 거부**
  (재시도 가능 오류), 턴 단위 **쓰기 멱등성** 서명 + 완료 쓰기
  재실행 가드, 인젝션 시도 턴 한정 **결정적 출력 가드** (인용
  페이로드 제거) + 탐지 패턴 확장. 신규 테스트 22건·카나리아 확인.
- **최종 (b1b1ccb0)**: **6/6 PASS** + 실물 검증 3/3 — 일정
  start_at **2026-10-31 15:00 Asia/Seoul** 정확, 메모 정확히 1건,
  인젝션 응답에 페이로드 없음. [EVAL] 산출물은 전량 삭제하고 기준선
  (메모 28·일정 12) 복귀 확인. ai_chats의 [EVAL] 대화 9건은 대화
  이력이라 삭제하지 않고 잔존을 명시한다.
- **후속 과제**: locked-memo 케이스의 카나리(잠긴 메모 실물 문구
  유출 검사)는 미설정 — 카나리 메모를 심으면 활성화할 수 있다.
