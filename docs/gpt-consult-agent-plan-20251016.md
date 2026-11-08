# GPT 자문 요청: AI 스튜디오 진짜 에이전트 구축 계획서 검토 (2026-10-16)

## 배경

MyHub AI 스튜디오는 웹 기반 AI 코딩 에이전트다. 사용자가 "시계 앱 만들어줘"라고 하면
AI(노바)가 HTML 앱을 생성하고, "버튼 색상 바꿔줘"라고 하면 수정해서 v2로 버전 관리한다.
Cloudflare Workers + D1 + Queue 기반이다.

현재 UI/성능 기반은 잡혔고, 이제 "진짜 에이전트"로 만들기 위한 계획을 세웠다.
OpenCode(sst/opencode) 소스코드를 직접 분석하고 (compaction.ts 800줄, step.ts 321줄),
OpenAI Codex 공식 블로그 "Unrolling the Codex agent loop"를 정독했다.

아래 계획서를 검토하고, 틀린 부분/빠진 부분/우선순위 문제를 지적해달라.
그리고 검토 의견을 반영한 수정된 계획서를 만들어달라.

---

## 현재 아키텍처 (정확한 상태)

### 있는 것
- 에이전트 루프: `runStudioAgent` (최대 10턴, 5분 전체 예산, 키 로테이션)
- 도구 5개: `create_file`, `edit_file`, `read_file`, `list_files`, `delete_file`
- Queue 기반 비동기 처리 (브라우저 타임아웃 회피용, 즉시 202 반환)
- Job 이벤트 시스템 (`job.started`, `file.changed`, `version.committed` 등)
- 버전 관리 (draft/published 포인터, v1, v2...)
- 프로젝트별 대화 이력 DB (`artifact_chats` 테이블)
- 중앙 Store 패턴 프론트엔드 (메모리 우선, DB 백그라운드 저장)

### 데이터 흐름 (수정 요청 시)
```
사용자 입력 ("버튼 색상 바꿔줘")
  → 프론트: POST /jobs {kind:'modify', prompt:'버튼 색상 바꿔줘', base_html:현재HTML}
  → Queue → 워커: processArtifactJob
  → sysCtx = "다음 HTML 앱을 수정해줘.\n\n요청: {prompt}\n\n현재 코드:\n```html\n{base_html 앞 15000자}\n```"
  → runStudioAgent(env, sysCtx, {maxTurns:10})
  → 도구 호출 반복 (create_file, edit_file 등)
  → 결과 HTML → saveJobResult → v2로 저장
```

### 핵심 문제점
1. **대화 컨텍스트 미전달**: `job.prompt`는 마지막 메시지 1개뿐. 이전 대화를 모름.
   "이 버튼"이 뭔지 노바는 모른다.
2. **v2 수정 깨짐**: 2026-10-15 E2E에서 'Failed to fetch'로 실패. Queue 수정 후 미검증.
3. **base_html 15000자 잘림**: 큰 파일은 뒷부분이 잘려서 노바가 전체 코드를 못 봄.

---

## 제안 계획서

### P0-1: v2 수정 플로우 복구
- 운영에서 실제 v2 수정 E2E 테스트 후 원인 파악
- 검증 기준: 브라우저에서 v2 수정 → 버전 목록에 v2 → 미리보기 v2 반영

### P0-2: 대화 컨텍스트 전달
프롬프트 구조를 이렇게 변경:
```
[시스템] 기존 STUDIO_AGENT_SYSTEM 유지
[프로젝트 컨텍스트] 제목, 현재 버전
[최근 대화] artifact_chats에서 최근 10개 원문
[현재 코드] base_html 전체 (15000자 제한 제거)
[요청] job.prompt
```
- 토큰 계산: 글자수 / 4 휴리스틱 (OpenCode, Codex 동일 방식)
- 50KB HTML = 약 12.5K 토큰. Gemini 1M 컨텍스트에 문제없음

### P1-1: 컨텍스트 압축
OpenCode의 실제 구현을 참조한 구조화 요약 템플릿:
```markdown
## Objective / ## Requirements / ## Decisions
## Work State (### Completed / ### Active / ### Blocked)
## Next Move / ## Relevant Files (최대 15개) / ## Important Context
```
- 트리거: 대화 토큰 30K 초과 시
- 최근 15,000 토큰은 원문 유지, 사용자 메시지는 절대 요약하지 않음
- 현재 코드는 압축 대상 아님 (항상 전체)
- 점진적 압축: 기존 요약 + 새 대화 → 새 요약

### P1-2: 자기 검증
- `validate_html`: HTML 파싱 검증
- `validate_js`: script 내용 문법 체크
- 실패 시 에이전트 루프 안에서 `edit_file`로 자동 수정

### P1-3: `ask_user` 도구 (후순위)
- 모호한 지시에 되묻기. OpenCode의 `question` 도구 참조
- 문제: Queue 워커는 실시간 상호작용 불가
- 해결안: `waiting_input` 상태 → 프론트에 질문 표시 → 답변 → job 재개
- 복잡도 높아서 Phase 3으로 미룸

### P2: Item 단위 기록
- Codex의 Thread → Turn → Item 모델 도입
- "노바가 뭘 했는지" 타임라인 UI용

### 실행 순서
- Phase 1: v2 복구 → 대화 컨텍스트 전달
- Phase 2: 컨텍스트 압축 → 자기 검증
- Phase 3: ask_user → Item 기록 + 타임라인 UI

---

## GPT에게 묻고 싶은 것

1. **우선순위가 맞는가?** v2 복구와 대화 컨텍스트 전달 중 어느 것을 먼저 해야 하는가?
   아니면 둘 다 하기 전에 다른 선행 작업이 있는가?

2. **대화 컨텍스트 전달 방식이 맞는가?**
   - 최근 10개 원문 + base_html 전체를 매번 보내는 방식의 토큰 비용이 합리적인가?
   - 아니면 처음부터 압축 요약을 도입해야 하는가?

3. **15000자 제한 제거가 안전한가?**
   - Gemini 1M 컨텍스트라 문제없다고 판단했는데, 실제 에이전트 루프에서 10턴 돌면
     매턴 12.5K 토큰씩 코드가 포함되어 비용이 폭발하지 않는가?
   - Codex/OpenCode는 이 문제를 어떻게 처리하는가? (매턴 전체 코드를 보내는가?)

4. **`ask_user`를 Phase 3으로 미룬 것이 맞는가?**
   - "이 버튼" 같은 모호한 지시가 자주 나올 텐데, 되묻기 없이 추측해서 고치는 게
     사용자 경험에 치명적이지 않은가?
   - 더 가벼운 대안은 없는가? (예: 확신도 낮으면 여러 후보를 보여주고 선택하게)

5. **빠진 것이 있는가?**
   - 진짜 에이전트가 되기 위해 이 계획서에 없는 필수 요소가 있는가?
   - 특히 보안 관점 (프롬프트 인젝션, 악성 코드 생성 방지)에서 빠진 게 있는가?

6. **수정된 계획서**를 만들어달라.
   - 위 검토 의견을 반영해서 우선순위와 세부 항목을 조정한 버전으로.
   - 각 항목마다 예상 공수와 리스크를 포함해달라.

---

## 참고: 오픈소스 분석 핵심 발견

### OpenCode 에이전트 루프 (step.ts)
```
for (;;) {
  LLM 스트리밍 요청
  → tool_call 이벤트 → 도구 실행 (fiber 병렬 가능)
  → 결과 피드백
  → 도구 호출 없으면 종료
  → 컨텍스트 오버플로우 → 압축 후 재시도
}
```

### OpenCode 압축 규칙 (compaction.ts)
- 강제 요약 템플릿 (위 P1-1 참조)
- "간결하게. 장문 금지. 정확한 경로/심볼/에러문자열 보존"
- "압축됐다는 언급 금지"

### Codex 도구 철학
- `shell` + `apply_patch` 2개로 전부 해결
- 도구가 적을수록 프롬프트가 짧아짐

### 프롬프트 캐싱 (Codex)
- 정확한 prefix 매칭일 때만 캐시 히트
- 정적 콘텐츠(시스템, 도구 정의)는 앞에 고정, 가변 콘텐츠(대화, 코드)는 뒤에
