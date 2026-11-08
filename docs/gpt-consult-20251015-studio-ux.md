# AI 스튜디오 아키텍처 자문 요청 (2026-10-15)

## 현재 상황
MyHub AI 스튜디오 (`/agent.html`)는 노바(Nova) AI가 Function Calling으로 웹앱을 생성하는 시스템입니다.
Gemini `gemini-3.5-flash-lite` 모델을 사용하며, 멀티파일 프로젝트 (index.html, js/, styles/) 생성이 동작합니다.

## 해결된 문제
1. 프로젝트 목록이 비어 보임 → 라우트 순서 문제 (`/:id`가 `/chats`, `/jobs`를 가림) 수정
2. 전송 버튼 → 작업 중 ■ 중단 버튼으로 변경 (Codex 스타일)
3. 프로젝트 우클릭 삭제 메뉴 추가
4. 채팅 중복 메시지 → 폴링 중복 제거, `showCompletion` 플래그로 수정
5. 프로젝트 전환 시 이전 코드 잔류 → `curHtml` 초기화로 수정
6. 채팅 독립성 → `restoreChat` 시 innerHTML 초기화로 수정
7. 시간 표시 (KST 변환)

## 현재 심각한 문제

### 1. 수정(v2) 기능 완전 실패
- "버튼 색상을 빨간색으로 바꿔줘" 요청 시 v2가 생성되지 않음
- "v1 완료"로 표시되고, 버전 기록에 v2 없음, 코드 변경 미적용
- 원인 미파악

### 2. 대화형 빌드업 부재 (가장 중요)
현재: 새 채팅에서 메시지 전송 → 즉시 프로젝트 생성
원하는 것 (Codex 스타일):
- 사용자와 노바가 대화로 아이디어 구체화
- "구현해줘"라고 명시할 때 프로젝트 생성 시작
- 현재 시스템이 너무 단적임

### 3. 미리보기 버튼 동작 불가
- iframe sandbox="allow-scripts"에서 앱 내부 버튼 클릭이 동작하지 않음
- 실제 앱 버그인지, sandbox 제한인지, 합성 HTML 문제인지 미확인

### 4. 프로젝트 독립성 불안정
- 한때 "안녕?" 프로젝트의 대화가 "계산기 앱"에 표시됨
- `restoreChat` 초기화로 수정했으나 완전 검증 안 됨

## 질문
1. 대화형 빌드업 → 구현 전환을 위한 최적의 UX/아키텍처는?
   - 명시적 "구현" 인텐트 감지 방법?
   - 대화 컨텍스트를 프로젝트 생성에 전달하는 방법?

2. 수정(v2) 실패의 가능한 원인은?
   - `kind='modify'` 처리, `base_html` 전달, 버전 증가 로직 중 어디를 의심해야 하는가?

3. 미리보기 iframe에서 앱 인터랙션이 안 되는 일반적인 원인은?

4. Codex 스타일의 에이전트 UX를 위한 핵심 원칙은?

## 기술 스택
- Cloudflare Workers + Hono + D1 (SQLite)
- 프론트엔드: Vanilla JS + CodeMirror
- AI: Gemini Function Calling (create_file, edit_file, list_files, read_file)
- 프로젝트 저장: artifacts → artifact_versions → artifact_files
