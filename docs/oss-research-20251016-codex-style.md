# Codex 스타일 오픈소스 프로젝트 비교 분석
날짜: 2026-10-16 | 조사: Muse (subagent) | 목적: MyHub AI 스튜디오 아키텍처 개선

> 스타 수는 2026-10-16 기준 스냅샷이며 근사치.

## 비교표

| 항목 | openai/codex | luseptem/codex-webui | OpenHands (Agent Canvas) | Aider-AI/aider | continuedev/continue |
|---|---|---|---|---|---|
| GitHub | https://github.com/openai/codex | https://github.com/luseptem/codex-webui | https://github.com/OpenHands/OpenHands | https://github.com/Aider-AI/aider | https://github.com/continuedev/continue |
| 스타 | ~129,394 | 5 | ~90,999 | ~49,568 | ~33,400 (⚠️ 저장소 archived, read-only) |
| 라이선스 | Apache-2.0 | MIT | MIT | Apache-2.0 | Apache-2.0 |
| 언어/형태 | Rust 코어(codex-rs) + TS SDK + CLI | Next.js 15 웹 UI (로컬 전용) | TS 프론트 + Agent Server(REST) | Python CLI | TS IDE 확장(VS Code/JetBrains) + CLI |
| 에이전트↔UI 통신 | SDK가 `codex` CLI를 서브프로세스로 실행, **stdin/stdout JSONL 이벤트** 교환. app-server는 **stdio JSON-RPC**. TS SDK: `runStreamed()`가 `item.completed` / `turn.completed` 등 구조화 이벤트 async generator 반환 | Next.js route handler가 `codex app-server` 실행 → `thread/start` 또는 `thread/resume` + `turn/start` → **알림을 SSE로 매핑** → React `useReducer` 타임라인에 주입. **라이브 스트림과 리플레이가 같은 reducer**를 공유 | **Agent Server REST API**(호스트/포트별, 다중 서버 접속 가능) + 브라우저용 **TypeScript 클라이언트**. 에이전트 백엔드는 **ACP(Agent-Client Protocol)** 로 교체 가능(Claude Code, Codex, Gemini, Pi, OpenCode) | UI 서버 없음. **인프로세스 CLI**: LLM 채팅 API → repo-map 컨텍스트 → SEARCH/REPLACE diff 블록 → 파일 직접 적용 → 자동 git commit. 린트/테스트 후크 | IDE 확장 ↔ LLM 프로바이더(설정 JSON 기반). **Continue Hub**(api.continue.dev)가 assistants/blocks/models/rules/prompts/docs/**MCP 서버**를 제공하는 레지스트리. MCP로 외부 도구 주입 |
| 핵심 데이터 모델 | **Thread / Turn / Item**: `codex.startThread()` → `thread.run(prompt)` → Turn(`finalResponse`, `items`). 같은 Thread에 `run()` 반복 = 대화 계속. `resumeThread(id)`로 복원 | 세션 = Codex 스레드. `~/.codex/sessions/` + `~/.codex/archived_sessions/`의 **rollout `.jsonl[.zst]`를 직접 읽어 리플레이** — "백엔드가 세션을 저장하지 않고 codex 자체 rollout 파일을 읽으므로 단일 진실 공급원(single source of truth)" | **Conversation** = 에이전트 실행 + 워크스페이스 상태. 대화별 Docker 컨테이너 격리 가능(`OH_CONVERSATION_RUNTIME=docker`). 하나의 UI에서 여러 백엔드 전환 | **git 저장소 = 프로젝트 상태**. 변경마다 자동 커밋(의미 있는 메시지와 함께). `.aider.chat.history.md`에 대화 기록. 버전 관리는 git에 위임 | 워크스페이스별 설정(`.continue/config.json` — config-as-code). Hub에서 공유 assistants/blocks/rules. 세션 = IDE 채팅 패널 상태 |
| 세션 저장 위치 | `~/.codex/sessions` (활성), `~/.codex/archived_sessions` (7일 보관) | 세션 목록은 디렉토리 스캔. 세션별 설정(model/reasoning/sandbox/approval/workdir)은 `localStorage`(`codex-webui-prefs-v3`) | Agent Server별 영속 상태(컨테이너 교체 후에도 워크스페이스 파일 + 대화 기록 유지). UI는 백엔드 선택만 | 로컬 git + 히스토리 md. 서버 없음 | 로컬 IDE + Hub |
| 작업 단위/버전 | Turn 경계(`turn.completed`). 파일 변경은 item 이벤트 | `file_change` 아이템 → **전체화면 unified-diff 다이얼로그**(추가/삭제/컨텍스트 색상, 줄번호, 구문 강조, 패치 복사) | Conversation + Automation(스케줄/웹훅 트리거). 상태머신 기반 | git commit = 버전. `diff`/`undo`는 친숙한 git 도구로 | Edit/Chat/Agent 모드. `.continue/checks/`의 AI 체크가 CI에서 GitHub status check로 실행 |
| 진행 상태 표시 | 스트리밍 이벤트: agent message, **reasoning**, command execution, **file changes**, MCP tool calls, web search, plan updates, turn boundaries | 연속 이벤트(reasoning/command/file/search/mcp/plan)를 **하나의 접이식(collapsible) 블록**으로 병합 + 요약 프리뷰. 좌측 **도트 레일**(사용자 메시지별, hover 미리보기, 클릭 점프). 가상 스크롤 | 실시간 conversation 스트림. **Abort** = fetch 중단 + 자식 프로세스 kill, 부분 rollout은 디스크에 남겨 resume 가능 | 터미널에 실시간 diff 출력 → 적용 전 확인. `/undo` 로 직전 커밋 되돌리기 | 인라인 diff + 채팅 스트리밍 |
| 중단/재개 | SDK 레벨에서 스트림 중단 가능 | 중단 버튼/탭 닫기 → fetch abort + 프로세스 kill → 부분 rollout 유지 → 같은 세션에서 새 프롬프트로 **Resume** | Abort + resume. Automation은 스케줄/이벤트 기반 재실행 | `/undo`, `/commit` 수동 제어. 언제든 중단 가능 | IDE 내에서 수동 |

## 아키텍처 심층 노트

### 1. openai/codex (공식)
- **엔진과 UI의 분리**: Rust 코어(`codex-rs`)가 실행 엔진, TS/Python SDK가 래퍼. UI는 SDK 위에서 동작. MyHub로 치면 "NovaWorkflow/에이전트 = 엔진", "agent.html = UI" 구조와 동일 — 다만 MyHub는 에이전트 이벤트를 UI에 스트리밍하지 않음.
- **Thread/Turn/Item 3계층**: MyHub의 `artifact_chats`(평면 메시지) vs Codex의 계층 구조. Turn 안에 여러 Item(추론, 도구 호출, 파일 변경, 최종 응답)이 들어감. MyHub의 "작업 중..." 단일 상태를 대체할 모델.
- **이벤트 스트리밍이 1급**: `runStreamed()`의 async generator. UI는 이벤트를 받아 카드로 렌더링(AgentMessageCard, FileChangeCard, PlanUpdateCard).
- **세션 = 파일**: `~/.codex/sessions`의 JSONL rollout. DB 스키마 변경 없이 파일 추가로 세션 영속. MyHub의 D1 `artifact_job_events` 테이블 구상과 대응.

### 2. luseptem/codex-webui (가장 직접적인 UI 레퍼런스)
- **핵심 패턴 — "라이브와 리플레이가 같은 reducer"**: 실시간 SSE와 저장된 rollout 리플레이가 동일한 렌더링 파이프라인을 통과. MyHub에 적용 시: `artifact_job_events`에 이벤트를 저장하면, (a) 실시간 SSE로 UI 업데이트, (b) 새로고침 시 같은 이벤트를 리플레이 → 렌더링 코드 1벌로 통일.
- **메시지 중복 제거**: `event_msg`와 `response_item`의 중복 표시를 `normalizeText`로 제거 — MyHub의 중복 "v1 완료" 문제와 동일한 클래스.
- **단일 진실 공급원**: 백엔드가 세션을 별도 저장하지 않고 Codex rollout 파일을 직접 읽음. MyHub는 이미 D1을 진실 공급원으로 쓰므로, "UI 상태는 항상 서버 조회로 복원" 원칙으로 대응 가능.
- **세션별 설정 localStorage 영속**: 모델/reasoning/sandbox/approval/workdir를 세션 단위로 저장. MyHub의 Job별 `{provider, model}` 고정과 동일한 방향.

### 3. OpenHands Agent Canvas
- **Agent Server 패턴**: 에이전트 실행을 REST API 서버로 분리. 프론트는 여러 서버(로컬/Docker/VM/클라우드)를 오가며 접속. MyHub는 Cloudflare Workers 단일 실행이지만, "에이전트 실행(Job) ↔ UI"를 REST+폴링/SSE로 분리한 구조는 동일하게 적용 가능.
- **Conversation ↔ Workspace 바인딩**: 1 대화 = 1 격리 워크스페이스. MyHub의 "프로젝트별 독립 폴더/파일/채팅/DB" 요구사항과 정확히 일치하는 모델. Docker-per-conversation은 MyHub의 "앱별 DB 네임스페이스" 아이디어의 상위 호환.
- **ACP(Agent-Client Protocol)**: 에이전트 백엔드 교체 가능. MyHub의 provider(gemini/groq/nvidia) 전환과 유사한 추상화 계층.

### 4. Aider
- **git = 버전 관리**: 별도 버전 테이블 없이 git 커밋이 곧 버전. MyHub는 D1 `artifact_versions`를 쓰므로 직접 이식은 불가하지만, "변경마다 자동 커밋 + 의미 있는 change_note" 패턴은 `change_note` 품질 개선에 참고.
- **repo-map**: PageRank 가중 tree-sitter 기반 코드베이스 맵. MyHub의 멀티파일 프로젝트가 커질 때, 전체 파일을 매번 프롬프트에 넣는 대신 "변경 관련 파일만" 선별하는 기법으로 참고.
- **적용 전 diff 확인**: 터미널에 diff를 보여주고 적용. MyHub의 "변경 사항" 탭 + Codex식 DiffViewer와 같은 UX 목표.

### 5. Continue (참고용 — archived)
- **config-as-code**: `.continue/config.json`을 저장소에 커밋해 팀 전체가 같은 모델/프롬프트/컨텍스트 공유. MyHub의 "DB 필요 앱" 문제에 대한 힌트: 앱별 선언 파일(필요 DB 스키마, 권한)을 프로젝트에 포함시키는 방식.
- **MCP 서버**: 외부 도구를 채팅 컨텍스트에 주입. MyHub가 앱별 DB 브리지를 제공할 때의 capability 모델 참고.
- ⚠️ **2026년 기준 저장소 archived(read-only), 최종 2.0.0** — 아키텍처 참고용으로만 활용.

## MyHub AI 스튜디오 적용 우선순위

| 순위 | 패턴 (출처) | MyHub 적용 방안 |
|---|---|---|
| P0 | Thread/Turn/Item + 이벤트 스트리밍 (codex, codex-webui) | `artifact_job_events` 테이블에 `job.started`/`tool.started`/`file.changed`/`version.committed` 이벤트 저장 → SSE(또는 폴링)로 UI에 실시간 반영. "노바가 작업 중..."을 실제 단계 표시로 교체 |
| P0 | 라이브/리플레이 동일 렌더러 (codex-webui) | 저장된 이벤트를 새로고침 시 리플레이 → 진행 중 작업 복원 + 중복 메시지 원천 차단 |
| P0 | Conversation↔Workspace 바인딩 (OpenHands) | 1 프로젝트 = 1 파일 네임스페이스 + 1 채팅 세션 + 1 DB 네임스페이스를 강제. 세션 키는 프로젝트별 고유 ID (이미 도입한 `new-<ts>` 방향을 artifact 생성 시점으로 확장) |
| P1 | file_change → DiffViewer (codex-webui) | v1→v2 diff를 unified diff(빨강/초록)로 표시. 백엔드 Diff API는 이미 추가됨 — 프론트 렌더러 필요 |
| P1 | 세션별 설정 영속 (codex-webui) | Job별 `{provider, model}` 고정은 이미 있음. UI에 모델 선택기를 세션 단위로 유지 |
| P1 | 변경마다 의미 있는 커밋 메시지 (Aider) | `change_note`를 "v1 생성" 같은 고정 문자열이 아니라 실제 변경 요약으로 생성 |
| P2 | repo-map (Aider) | 프로젝트 파일이 많아질 때 전체가 아닌 관련 파일만 에이전트 컨텍스트에 포함 |
| P2 | config-as-code (Continue) | 앱별 DB/권한 선언을 프로젝트 메타데이터로 포함 |

## 참고: 함께 언급되는 프로젝트 (간략)
- **cline/cline** (~69.6k★): VS Code 기반 코딩 에이전트 (IDE/CLI/SDK). 명령어 승인(command approval) 명시화가 특징 — MyHub의 "작업 중단" UX 참고.
- **Ruflo** (~74k★): Claude Code/Codex용 멀티에이전트 오케스트레이션 (queen-led swarm). MyHub 규모에는 과함.
- **Moyai** (LiteLLM, 2026-10-07 공개): 셀프호스티드 클라우드 코딩 에이전트 (Slack/브라우저에서 작업 할당, 격리 클라우드 워크스페이스, PR 생성). MyHub의 "브라우저에서 에이전트 실행" 모델과 유사.
