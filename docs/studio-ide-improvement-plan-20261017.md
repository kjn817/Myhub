# AI 스튜디오 IDE 개선 계획 (2026-10-17)

목표: "브라우저 IDE에 AI가 붙은 에이전트" — bolt.diy / vibesdk / ACP 분석 결과를 우리 시스템(Workers+Hono+D1+Queue)에 적용.

## 레퍼런스 분석 요약

### bolt.diy (★2만, MIT) — 브라우저 AI 빌더의 직접 청사진
- XML 태그 스트리밍 파서로 파일 생성 실시간 표시 (`onActionStream` + 100ms 디바운스)
- `userSelectedView`: 사용자 탭 선택을 에이전트 자동 전환이 덮어쓰지 않음
- diff가 파일보다 길면 diff 대신 전체 파일 (토큰 최적화)
- 파일 잠금 (사용자↔에이전트 충돌 방지)
- 가져오면 안 되는 것: WebContainers (Workers 불가), 전체 파일 덮어쓰기 전략, nanostores/React, 다크 테마

### vibesdk (★5천) — Cloudflare 네이티브라 직접 이식 가능
- `ask_questions` 도구: 에이전트가 모호할 때 사용자에게 구조화 질문 (human-in-the-loop)
- `get_browser_console_logs`: 헤드리스 브라우저로 미리보기 콘솔 에러 캡처 → 자동 repair
- 컨텍스트 셀렉터: 첫 메시지+최근 5개+특수 도구쌍 보존, 나머지 tool-call 제거
- `frontend-design` 스킬: "AI slop 금지" 디자인 품질 기준을 참조용으로 주입
- 에이전트 주도 `commit`: 의미 단위 체크포인트
- 우리가 앞선 점: D1 즉시 영속, Queue+lease, 소유권 검증 12곳, 3033 테스트

### ACP (Zed) — 에이전트↔에디터 통신의 구조 원칙
- 핵심: **에디터가 파일의 주인, 에이전트는 스냅샷을 읽고 diff를 내놓는다**
- JSON-RPC 원형은 우리 Queue 구조와 안 맞음 → 턴 기반 스냅샷 프로토콜로 변형
- 충돌은 해결이 아니라 "버전 분기"로 처리 (우리 versions 테이블과 궁합이 맞음)

## Phase A (이번 턴) — 에이전트 품질 + 가시성

### A1. `ask_question` 도구 (human-in-the-loop)
- `studio-tools.ts`에 도구 추가: questions[{id, question, options[], allowCustom}]
- 에이전트가 호출하면 `AWAITING_INPUT` 시그널 → job `awaiting_input` 상태로 멈춤
- `POST /jobs/:id/answer`로 답변 → job `queued`로 복귀 + Queue 재전송
- 프론트: 폴링 감지 → 팝업 → 답변 제출
- 마이그레이션: `artifact_jobs`에 `pending_question TEXT` 컬럼 추가

### A2. 컨텍스트 디스틸레이션 (studio-agent.ts)
- 시스템 + 첫 사용자 메시지 + 최근 N턴 전체 보존, 오래된 턴은 텍스트만 (tool-call 파트 제거)
- 토큰 절감 + maxTurns 7 제한의 근본적 완화

### A3. 디자인 스킬 (studio-skills.ts)
- `design` 스킬 추가: 흰/회/검+파스텔 블루, Lucide SVG, 타이포그래피 중심, AI slop 금지
- 참조용 주입 (노바 제약이 아님)

### A4. modify 스킬에 검증 게이트 내장
- "apply_patch 후 반드시 read_file로 결과 확인"을 워크플로우 단계로 추가

### A5. Unified diff (변경 사항 탭)
- `src/lib/text-diff.ts`: pure-JS unified diff (의존성 없음)
- job-processor에서 파일 변경 시 diff 계산 → `file.changed` 이벤트에 `diff` 필드 추가
- 프론트 변경 사항 탭에 diff 렌더링

### A6. userSelectedView (프론트 1줄)
- 사용자가 탭을 명시 선택하면 에이전트 자동 전환이 덮어쓰지 않음

## Phase B (후속) — 양방향 IDE → 2026-10-17 구현 완료

- B1. `POST /jobs`에 파일 스냅샷+해시 포함 (브라우저가 파일 소유자로) ✅
  - modify 작업 생성 시 `artifact_jobs.base_version_id` + `base_snapshot` (path→sha256 JSON) 저장
  - 마이그레이션: `0041_artifact_jobs_base_snapshot.sql`
- B2. 파일 내용 라이브 스트리밍 (`file.stream` 이벤트) ✅
  - `StudioWorkspace.onMutation` → `runStudioAgent`의 `onFileWrite` → `logJobEvent(file.stream)`
  - 프론트: 작업 타임라인에 "파일 작성 중" 표시 + 미리보기/편집기 실시간 반영 (디바운스)
- B3. CodeMirror 편집+dirty 추적 정식화 ✅
  - 코드 탭에 파일 선택 드롭다운, 파일별 dirty 추적(●), 확장자별 모드
  - `POST /:id/versions/files` — artifact_files 갱신 + 미리보기 HTML 재조합 (소유권 검증 포함)
  - 부수 수정: `POST /:id/versions`에 소유권 체크 추가 (보안 구멍이었음)
- B4. 파일 잠금 (사용자↔에이전트 충돌 방지) ✅ — 소프트 잠금으로 구현
  - `GET /:id/active-job` — 진행 중 작업 조회
  - 코드 탭에 "🔒 노바 작업 중" 배너 (저장은 막지 않고 경고, B5가 실제 충돌 처리)
- B5. 충돌 시 버전 분기 (baseHash 비교) ✅
  - `saveJobResult`가 파일 단위로 병합 (현재 파일 + 에이전트 수정, 에이전트가 안 건드린 파일은 사용자 최신 유지)
  - 같은 파일 양쪽 수정 시 `version.branch` 이벤트 + `parent_version_id`에 분기 기준점 기록 (작업 실패가 아니라 분기)
  - B1 스냅샷 없는 구버전 Job은 기존 관문 43 CONCURRENT_MODIFY throw 유지
- B6. `validate_preview` 도구 ✅ — BROWSER 바인딩 없이 클라이언트에서 구현 (추가 비용 없음)
  - 작업 완료 후 숨은 iframe에 미리보기 로드 → 콘솔 에러 4초 수집
  - 오류 발견 시 "자동 수정" 바 → modify 작업으로 자동 repair
- B7. WebSocket 푸시 — 이번에 제외 (폴링이 정상 동작 중, 아키텍처 공사 대비 효용 낮음)

## 하지 않는 것
- WebContainers, 터미널, JSON-RPC 스택 통째, MCP/slash commands, 다크 테마
- istanbul ignore 같은 커버리지 꼼수 (원칙 유지)
- 데드코드는 제거 (원칙 유지)
