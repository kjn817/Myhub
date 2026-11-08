# AI 스튜디오 완료 결과 표시 — codex-webui 적용 브리프 (2026-10-15)

사용자 요구: "코덱스 구현을 완료했을 때 결과물처럼 나와야지. 깃에서도 검색해줘."
메인 에이전트가 #5(완료 시 파일 목록 + diff 표시)를 시작하기 전 참고용 설계안.

## 1. 출처 (검증 시점: 2026-10-15 ~19:50 KST, 브라우저 직접 조회)

- 저장소: https://github.com/luseptem/codex-webui (공개, MIT 라이선스)
- 커밋: `421f18acdf6928da6e35611d9d1f53443fcb0c34` (default branch master)
- 읽은 파일: `components/events/FileChangeCard.tsx`, `components/diff/DiffViewerDialog.tsx`,
  `components/events/AgentMessageCard.tsx` (Next.js 15 + React + Tailwind — 아래는 MyHub `public/agent.html`
  바닐라 JS 기준으로 재설계한 것. 코드 복사 아님.)

## 2. Codex가 완료 시 보여주는 3요소

### 2a. 변경 파일 행 (FileChangeCard) — 파일당 한 줄
- 변경 타입별 Lucide 아이콘: 생성=FilePlus / 수정=FileEdit / 삭제=FileX / 이름변경=FileOutput
- mono 폰트 경로 (truncate), 이름변경이면 `old ← new` 표시
- unified diff에서 계산한 `+N` / `-M` (헤더 `+++`/`---` 제외하고 `+`/`-`로 시작하는 행 집계)
- 타입 뱃지: 소문자 uppercase (create/edit/delete/rename), 타입 색상의 10% 배경 틴트
- 우측 chevron. patch가 있고 타입이 create/edit일 때만 클릭 가능 → 클릭하면 diff 다이얼로그

### 2b. 통합 diff 다이얼로그 (DiffViewerDialog) — 풀스크린 모달
- 레이아웃: fixed inset-0, z-50, 배경 black/70 + blur, 배경 클릭 또는 ESC로 닫기
- 패널: 85vh × 90vw (max-width 5xl), 헤더 + 스크롤 본문
- 헤더: 파일 아이콘 + mono 경로 + `+N`/`-M` 통계, "패치 복사" 버튼(클릭 후 1.2초 체크 표시),
  X 닫기 버튼
- 본문: unified diff 행 렌더
  - old/new 이중 행번호 거터 (각 12ch 폭, 우측 정렬)
  - `+`/`-`/공백 접두 컬럼, add=녹색·del=빨강 접두 색
  - add/del 행 배경 틴트, hunk 헤더(`@@ ... @@`) 별도 스타일
  - **문법 강조 방식**: diff 텍스트를 직접 강조하지 않고, old 전체(문맥+삭제행)와
    new 전체(문맥+추가행)를 각각 재구성 → 토크나이저로 강조 → 행 단위로 쪼갠 뒤
    diff 행 인덱스로 매핑 (여러 줄 문자열/주석도 정확히 색칠됨)
  - 강조 실패 시 fallback: HTML 이스케이프 후 평문

### 2c. 에이전트 메시지 카드 (AgentMessageCard)
- 턴의 첫 메시지에만 아바타 + 이름 + 타임스탬프. 같은 턴 후속 메시지는 아바타 없이
  본문 들여쓰기에 맞춰 정렬하되 타임스탬프는 유지
- 본문은 Markdown 렌더 (코드 하이라이트 포함)
- 카드 hover 시 우하단에 복사 버튼 등장 → 원문 markdown을 클립보드에 복사, 잠시 체크 표시

### 2d. 타임라인 구조 (아키텍처 참고)
- 스트리밍 이벤트(agent 메시지·reasoning·command·file·search·plan·turn 경계)를
  단일 reducer로 타임라인 아이템에 매핑. 실시간 스트림과 과거 세션 리플레이가
  같은 파이프라인을 공유
- 중간 과정(reasoning/command/file/search/plan)은 하나의 접힘 블록으로 묶고
  "액션 N개" 요약 표시 (펼치면 상세)

## 3. MyHub 적용 설계 (agent.html 기준)

### 3a. 완성 카드 (지금의 "v1 완료" 한 줄을 대체)
완료 시점에 다음을 한 카드로 표시:
1. **요약 한 줄**: `{버전} 완료 — {change_note || 자동 요약}. 우측에서 확인하세요.`
   (미리보기 자동 열기는 유지 — 19:53 배포 반영됨)
2. **변경 파일 행 목록** (2a 형식): v1이면 전 파일 create, v2+면 parent 대비 변경분
3. **액션 행**: [미리보기] [diff 보기] **[다운로드]** [게시하기]
   - 다운로드: 사용자 요구(2026-10-15)이나 미구현 — zip 또는 단일 HTML 다운로드
   - 게시하기: 우클릭 메뉴에 이미 추가됨(19:47). 완성 카드 액션에도 두는 게 일관적
4. 시스템 잡담("프로젝트를 열었습니다" 등)은 저장·표시 모두 금지 (19:58 배포 반영됨)

### 3b. Diff 데이터 생성 (전제 조건 — 중요)
codex-webui는 실행기가 unified diff(patch)를 직접 만든다. MyHub는 patch를 저장하지 않고
**전후 전체 내용**을 저장하므로, diff는 표시 시점에 생성해야 한다:
- 단판 HTML 앱: `artifact_versions`의 `html_content` (N vs `parent_version_id`)
- 다중 파일: `artifact_files` (version_id별) — `migrations/0035_artifact_files.sql`
- v1(부모 없음)이면 전 행을 `+`로 표시 (= FileChangeCard의 create 케이스)
- 경량 unified diff 생성기 필요 (LCS 기반 행 단위 diff면 충분, 라이브러리 없이 구현 가능)
- `+N`/`-M` 통계는 생성된 diff에서 2a 규칙으로 집계

### 3c. 채팅 표시 규칙 (사용자 불만 반영)
- 저장되는 것: 사용자 질문 + 노바의 완료/답변 (19:58 반영됨)
- 저장 안 되는 것: 시스템 메시지 ("열었습니다", "돌아오신 동안…")
- 프로젝트별 세션 격리: 고유 session_key (19:36 반영됨) — 새 프로젝트에 이전 대화가
  보이면 안 됨 (사용자 19:35~19:37 지적)
- 시간 표시 KST (19:04 반영됨). AgentMessageCard처럼 후속 메시지도 타임스탬프 유지

### 3d. 디자인 매핑 (사용자 선호)
- 팔레트: 흰/회/검 + 파스텔 블루 (다크 모드 금지 — 사용자 지시)
- 아이콘: Lucide SVG (이모지 금지)
- 타이포 중심, 행 높이·여백은 codex-webui의 컴팩트 리듬 참고
  (파일 행 py-1.5, mono 12px 경로, 뱃지 10px uppercase)

## 4. 구현 순서 제안 (GPT 자문 8단계와 정합)

GPT 자문(`docs/gpt-consult-20251015-studio-ux-v2.md`)의 1단계(v2 저장 정상화, 커밋 `ee2e03b`)가
선행되어야 diff가 의미 있다. 순서:
1. v2 modify 경로 E2E 확인 (진행 중 — 19:34 시작)
2. 경량 unified diff 생성 유틸 + `+N`/`-M` 집계 (신규)
3. 완성 카드 교체 (요약 + 파일 행 + 액션) (신규)
4. diff 다이얼로그 (신규)
5. 중간 과정 접힘 블록 (신규 — Codex식; 작업 중 ■ 버튼과 병행)
6. 다운로드 구현 (사용자 요구, 미구현)

## 5. E2E 체크리스트 연결 (GPT 자문 §8)

- `"버튼을 빨간색으로 바꿔줘"` → v2 생성 + 완성 카드에 변경 파일 1행 + `+N`/`-M`
- 파일 행 클릭 → diff 다이얼로그에 old/new 거터 + 색상 정상
- 패치 복사 → 클립보드 확인
- 다운로드 → 파일 수신 확인
- 브라우저 새로고침 → 완성 카드·파일 행·대화 복원 (세션 격리 유지)
