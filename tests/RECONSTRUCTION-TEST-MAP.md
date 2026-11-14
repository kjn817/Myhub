# 재구축 테스트 지도 — 소실 스위트 목록과 재작성 현황

작성: 2026-11-07 테스트 재작성 슬라이스
기준: 복원 베이스라인(d45dad9, 2026-11-01 04:47) **294스위트/5,782건** → 최종 상태(0ebc522c, 2026-11-07) **482스위트/8,593건 전건 PASS**.
차이 **188스위트/2,811건**이 11-01~11-07 사이에 추가됐다가 소실됐다. 배포 번들에는 테스트가 없어, 아래 목록은 일일 로그(`~/memory/2026-11-01.md`~`2026-11-07.md`)와 `RECONSTRUCTION-DELTA.md`의 기록만으로 복원한 것이다.

## 수치 궤적 (게이트 기록 기준)

| 시점 | 스위트 | 테스트 | 근거 |
|---|---|---|---|
| 11-01 04:47 (베이스라인 스냅샷) | 294 | 5,782 | 복원 게이트 실측 |
| 11-01 밤 | 308 | 5,964 | 설정 모달·asset-version·음성 버튼·데스크톱 개조 |
| 11-02 | 314→332 | 6,047→6,472 | Finder·메뉴·오피스 모듈·백업 픽스처 수리 |
| 11-03 | 332 | 6,496 | 타일·크롬 (신규 소수) |
| 11-04 | 347→352 | 6,754→6,853 | browse-cdp·browser 재작성·GridCraft 프리페치 |
| 11-05 | 352→(미기록) | 6,886→7,197 | 메모 재구축·provider-data-policy·Privacy Engine 1차 |
| 11-06 밤 | 479 | 8,557 | 3기둥 마감(보안엔진·Clef·프로바이더 구조) |
| 11-07 새벽 | 482 | 8,593 | office-ops 38·게이트웨이 회귀 15·일정 동기화 |

## A. 파일명이 기록에 명시된 소실 스위트

| 파일 | 근거 | 기록된 단언·성질 | 재작성 |
|---|---|---|---|
| tests/asset-version.test.ts | 11-01 로그·AGENTS.md | createVersioner가 static-assets.json 전체 집합 기준으로 ?v= 부착. 새 에셋은 manifest 등록만으로 자동 포함 | 미착수 (대상 scripts/asset-version 별도 슬라이스) |
| tests/browser.test.ts | 11-04 로그 | Safari형 단일 브라우저 셸 — 프록시·리더 모드 폐지 표면, 시작 페이지 타일, 알약 주소창 | 미착수 |
| tests/chat-p3-fallback-routing.test.ts | 11-05 로그 | P3 폴백 라우팅 | 미착수 |
| tests/finder.test.ts | 11-02 로그 | Finder 탐색기 동작 (신규 당시) | 미착수 |
| tests/memo-md.test.js | 로그 언급 | 메모 마크다운 | 미착수 |
| tests/menu.test.ts | 11-02 로그 | 설정 메뉴 그룹·플라이아웃 (신규 3건) | 미착수 |
| tests/office-ops.test.ts | 11-07 로그 | **38건 전건 PASS 기록**. 파서 관용 11변형+진단+flavor 대조, 연산 검증 | **재작성 완료·대기** (대상 모듈 미재구성) |
| tests/schedule-views.test.js | 로그 언급 | 일정 뷰 | 미착수 |
| tests/settings-ui.test.ts | 11-01 로그 | 설정 버튼+모달: 마운트·모달 항목·열고 닫기·모달 내 로그아웃 배선·중복 클릭 가드·상단바 직접 마운트 금지 회귀 가드. 3스위트 46건 중 하나 | 미착수 |
| tests/todo-p3.test.js | 로그 언급 | 할 일 P3 | 미착수 |
| tests/voice-ui.test.ts | 11-01 로그 | 음성 버튼이 복사 버튼 옆 액션 행에 붙는 배치 회귀 | 미착수 |
| tests/xlsx-vendor-security.test.ts | 11-02 로그 | SheetJS 교체 CVE PoC 카나리아 양방향 (3건) | 미착수 |
| tests/integration/ai-access-search-real.test.ts | 로그 언급 | AI 접근 검색 실연동 | 미착수 |
| tests/unit/agent-modules.test.ts | 로그 언급 | 에이전트 모듈 표 | 미착수 |
| tests/unit/browse-cdp.test.ts | 11-04 로그 | Oracle CDP 접속·초기 이동 (신설) | 미착수 |
| tests/unit/desktop-dock.test.ts | 11-02 로그 | 독 구성·순서·우클릭 (desktop-state 등과 함께 언급) | 미착수 |
| tests/unit/desktop-icons.test.ts | 11-01 로그 | 동적 타일 글리프 갱신(refreshIcons) 회귀 — 가짜 lucide 주입 | 미착수 |
| tests/unit/desktop-widgets.test.ts | 11-02 로그 | 위젯 드래그 순서·positions v2 저장 모델 | 미착수 |
| tests/unit/echo-serving-consistency.test.ts | 로그 언급 | 에코 서빙 일관성 | 미착수 |
| tests/unit/finder-hwp-replace-cells.test.ts | 로그 언급 | Finder 한글 셀 교체 | 미착수 |
| tests/unit/finder-office-modules.test.ts | 11-02 로그 | 오피스 모듈 표 (신규 10건) | 미착수 |
| tests/unit/finder-pdfcraft.test.ts | 11-04 로그 | PdfCraft 언어 시드 — 기존 키 보존+en→ko 되돌림, 카나리아(시드 끄면 FAIL) | 미착수 |
| tests/unit/finder-viewer.test.ts | 11-02 로그 | 뷰어 26건·68건 언급, 상태 오버레이·409 충돌 유지 | 미착수 |
| tests/unit/gridcraft-prefetch-autoboot.test.ts | 11-04 로그 | GridCraft 프리페치 자동 부팅 (전역 이름 충돌 사고의 당사자) | 미착수 |
| tests/unit/gridcraft-prefetch.test.ts | 로그 언급 | GridCraft 프리페치 | 미착수 |
| tests/unit/gridcraft-vendor.test.ts | 로그 언급 | GridCraft 벤더 무결성 | 미착수 |
| tests/unit/office-assistant.test.ts | 로그 언급 | office-assistant.js 결과 합성 — 실패 우선 표시+사전 작성 고지 (11-07 수정분 포함) | 미착수 |
| tests/unit/office-prefetch-gate.test.ts | 로그 언급 | 오피스 프리페치 게이트 | 미착수 |
| tests/unit/pdfcraft-vendor.test.ts | 로그 언급 | PdfCraft 벤더 무결성 | 미착수 |
| tests/unit/provider-data-policy.test.ts | 11-05 로그 | **8건, 카나리아 확인済**. 데이터 정책 정렬 키(dataUseRank) | **재작성 완료·실행 PASS** |
| tests/unit/studio-verify.test.ts | 로그 언급 | 스튜디오 검증기 | 미착수 |

## B. 건수·성질만 기록된 스위트 (파일명 미상)

| 묶음 | 근거 | 기록된 성질 | 재작성 |
|---|---|---|---|
| 게이트웨이 후보 상한 회귀 **15건** | 11-07 로그 (커밋 6ca15777) | 집행 경로(결정적 채점+비시스템 메시지) 상한 512로 전부 판정·토큰화, 시스템·Clef 경로는 8 유지, 512 초과 병리 밀도는 fail-closed. **카나리아: 상한 8로 되돌리면 2건 실패 실증** | **재작성 완료·실행 PASS 18/18** (카나리아 A·B 포함) → tests/unit/privacy-gateway.test.ts (신규 도출 파일명, 18건으로 재작성 — 원본 15개 성질 전부 + 픽스처 전제 2 + 안내 분기 1) |
| 일정 Google 동기화 관련 **6스위트 143건** | 11-07 로그 (커밋 a9aeda07) | 비서 경로 UI 동일 계약(생성·수정 push, 삭제 구글 먼저·실패 시 로컬 보존+한국어 고지), 생성 본문 iCalUID 제거, 구글 오류를 동기화 로그에 기록. 카나리아 실증 | **부분 재작성·대기** → tests/unit/schedule-google-sync.test.ts (신규 도출 9건 — 동기화 모듈 단위 성질만; 비서 도구 경유 6스위트 쪽은 기존 스위트 갱신분으로 추정). 모듈은 착지했으나 **src 컴파일 오류 3건이 선행 조건**: schedule-google-events.ts:1 extractGoogleApiMessage 미export(TS2459), :83·:132 CalendarApiResult 제네릭 불일치(TS2322). toMarkedEventBody·sanitizeScheduleForGoogleSync·toEventInput이 비export라 본문 성질은 요청 캡처로 흡수, 정제 성질은 단위 검증 불가로 제외 |
| office-ai 스위트 | 11-07 로그 | malformed 시 구조 진단(본문 없는 메타데이터)을 validationErrors·응답 opsDiag·Worker 로그 office_ops_parse_failed 3곳에 기록. **소실 시점에 실행 미완**이었음 | 미착수 (진단 무본문 테스트 1건은 office-ops.test.ts가 아니라 이 스위트 몫 — 통합 단계에서 분리 작성) |
| browse-routes 19건 | 11-02 로그 | 브라우저 라우트 (D-20에서 폐지 표면 테스트로 재작성됨) | 미착수 |
| browse-page-marker 3건 | 11-05 로그 | [PAGE] 단일형·쌍 태그형 동일 읽기 경로, 상한 2·권한 게이트·실패 문구 | 미착수 |
| fortune-locale 10건·office-picker 4건·office-fetch-memory 8건 | 11-02 로그 | Phase B 신규 — 로케일 패리티, 피커 Promise 행 수정, fetch 메모리 | 미착수 |
| redact 카나리아 9건 | 11-01 로그 | src/lib/redact.ts 이중 마스킹 | 미착수 |
| 일정 구글 쓰기-스루 라우트 계약 | 11-04 로그 | 감사 패스에서 추가 (파일명 미상) | 미착수 |
| app-menubar-defs·finder-format-slide·dw4 L-06 | 11-05/07 로그 | 플레이크·타임아웃 언급으로만 존재 확인 | 미착수 |
| 데스크톱 핀 4건 (7스위트 200건 중) | 11-02 로그 | 최대화 영속화 등 핀 | 미착수 |

## C. 최종 src 모듈 구성으로 추정되는 영역 (기록에 테스트 언급 없음)

최종 번들(`.recovery/live-bundle`)에만 있고 베이스라인에 없는 src 모듈들 — 대응 테스트가 있었을 개연성이 높지만 이름·건수 기록이 없다. 재작성 시 **신규 도출**로 명시한다.

- services/privacy-engine·privacy-gateway·privacy-korean·privacy-korean-clef·privacy-korean-mode·privacy-mask (게이트웨이 15건 외 잔여 — 패턴 탐지 16/16·오탐 0, 한국어 캐스케이드 v4 평가셋 600건은 jest가 아닌 평가 하네스 기록)
- services/clef-engine·clef-g6 (G5 게이트·G6 섀도 판정) → **재작성·대기**: tests/unit/clef-g5-gate.test.ts (신규 도출 15건 — G5 게이트·임계값·멘션·라우터 모드. clef-engine 착지·타입 정합 확인, lockedPersona는 페르소나 id 문자열로 정정. 단 src/services/clef-usage.ts:33 TS2352가 의존 그래프 컴파일을 막아 실행 대기). G6 스위트는 미착수
- services/mission-* (Mission Control 서비스층)
- modules/browse·desktop·backup, auth/routes-pin
- services/office-docgen, modules/ai/office-routes

## D. 기존 파일 갱신분 (베이스라인에 있으나 최종 상태에서 변경)

- tests/test_deploy_full_flow.py — 시크릿 가드 케이스는 베이스라인에 이미 있음. **단일 실행 잠금(b1fcf5cc) 동시 실행 시뮬레이션 테스트가 소실분** → tests/test_deploy_lock.py로 **재작성 완료·실행 PASS 6/6** (3회 연속). 복원된 deploy_full.py 실물: acquire_deploy_lock/release_deploy_lock, 잠금 파일 JSON {pid,cmdline,started_at}, 보유자 판정은 실프로세스 /proc cmdline에 deploy_full 포함 여부 — 경합 테스트는 별도 프로세스를 보유자로 세워 검증
- tests/unit/backup-routes·backup-stepup-gate·backup-attachments — TABLE_COUNT 31 하드코딩 → BACKUP_TABLES.length 도출로 갱신 (11-02, 3스위트 40건)
- tests/logout-ui·google-connect-ui·unit/trace — deploy_full 구 고정목록 단언 → createVersioner 실거동 검증으로 갱신 (11-01)
- tests/unit/csp-inventory — 벤더 면제 2파일 추가 (11-02)
- tests/desktop-ui·desktop-state — 설정 모달 경유·모듈 표 7종 등으로 갱신 (11-01/02)
- tests/unit/svc4-ai·ai-model-router — 프로바이더 재배정 반영 갱신 (11-05)

## E. 이번 재작성 현황 요약

- **완료·실행 PASS (3파일 32건)**:
  - tests/unit/provider-data-policy.test.ts (8건 — PASS 8/8)
  - tests/unit/privacy-gateway.test.ts (18건 — PASS 18/18, 카나리아 A·B 포함 — 게이트웨이 상한 회귀 15성질 + 픽스처 전제·안내 3)
  - tests/test_deploy_lock.py (6건 — PASS 6/6, 3회 연속)
- **완료·대기 (3파일 62건 — 테스트 자체는 실물 타입과 정합, 선행 조건은 대상 src 쪽)**:
  - tests/office-ops.test.ts (38건 — 파서 관용·연산 검증. office-ops·office-ops-slide 착지·타입 정합 확인, **office-ops-parse.ts만 미착지** — TS2307 1건이 유일한 실패)
  - tests/unit/schedule-google-sync.test.ts (9건 — 동기화 모듈 성질, 신규 도출. 대상 src 컴파일 오류 3건이 선행 조건 — B표 참조)
  - tests/unit/clef-g5-gate.test.ts (15건 — G5 게이트·모드, 신규 도출. src/services/clef-usage.ts:33 TS2352가 선행 조건)
- **재작성 합계: 6파일 94건 중 실행 PASS 32건, 대기 62건.**
- **미착수**: A표 28개 파일, B표 8개 묶음, C표 영역 — 기록만으로 성질 복원이 가능한 것부터 후속 슬라이스에서 계속.
- **신규 도출 스위트** (기록에 파일명이 없어 대상 코드의 실제 동작에서 성질을 도출): schedule-google-sync, clef-g5-gate, privacy-gateway(파일명만 도출 — 성질은 기록 기반).
