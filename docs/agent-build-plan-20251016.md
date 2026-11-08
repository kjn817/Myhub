# 진짜 에이전트 구축 계획서 (2026-10-16)

## 1. 현재 상태 정직한 평가

### 있는 것
- 에이전트 루프: `runStudioAgent` (maxTurns: 10, 5분 예산)
- 도구 5개: `create_file`, `edit_file`, `read_file`, `list_files`, `delete_file`
- Queue 기반 비동기 처리 (브라우저 타임아웃 해결)
- Job 이벤트 시스템 (`job.started`, `file.changed`, `version.committed` 등)
- 버전 관리 (draft/published, v1, v2...)
- 프로젝트별 대화 이력 DB (`artifact_chats`)

### 없는 것 / 깨진 것
- **v2 수정 플로우 깨짐** (P0): E2E에서 'Failed to fetch'로 실패. Queue 수정 후 미검증
- **대화 컨텍스트 미전달** (P0): 수정 요청 시 노바에게 가는 건 `prompt(1개) + base_html`뿐. 이전 대화를 모름
- **컨텍스트 압축 없음** (P1): 길어지면 그냥 잘림. OpenCode식 구조화 요약 없음
- **`ask_user` 도구 없음** (P1): "이 버튼" 같은 모호한 지시에 되물을 수 없음
- **자기 검증 없음** (P1): 생성된 코드의 문법 체크, 렌더링 확인 안 함
- **부분 수정 미활용**: `edit_file` 도구는 있는데 프롬프트가 전체 재생성을 유도하는지 확인 필요
- **Item 단위 기록 없음** (P2): "노바가 뭘 했는지" 타임라인 표시 불가

---

## 2. P0: v2 수정 플로우 복구

### 현재 문제
- 2026-10-15 E2E: v2 수정 시 'Failed to fetch', 버전 이력에 v2 없음
- 2026-10-16 Queue 기반 수정 적용됨 (즉시 202 반환)
- **미검증 상태**

### 할 일
1. [ ] 운영에서 실제 v2 수정 E2E 테스트
   - v1 있는 프로젝트 선택 → "버튼 색상 바꿔줘" → v2 생성 확인
   - 버전 이력에 v2 표시 확인
   - 미리보기에 v2 반영 확인
2. [ ] 실패 시 원인 파악 (Queue consumer 로그, job-processor 에러)
3. [ ] `saveJobResult`에서 v2 버전 원자적 저장 확인

### 검증 기준
- 브라우저에서 v2 수정 → 버전 목록에 v2 표시 → 미리보기 v2 반영
- 콘솔 에러 없음

---

## 3. P0: 대화 컨텍스트 전달

### 현재 문제
`job-processor.ts` 88-90줄:
```typescript
const sysCtx = job.kind === 'modify' && job.base_html
  ? `다음 HTML 앱을 수정해줘.\n\n요청: ${job.prompt}\n\n현재 코드:\n\`\`\`html\n${String(job.base_html).slice(0, 15000)}\n\`\`\``
  : `"${job.prompt}" — 완성된 HTML 앱으로 만들어줘...`
```

`job.prompt`는 사용자의 **마지막 메시지 1개**뿐이다.
"이 버튼이 잘 안 눌려" → 노바는 "이 버튼"이 뭔지 모른다.

### 설계

**프롬프트 구조** (Codex/OpenCode 패턴):
```
[시스템] STUDIO_AGENT_SYSTEM (기존 유지)

[프로젝트 컨텍스트]
- 프로젝트: {제목}
- 현재 버전: v{version_no}
- 이전 작업 요약: {압축 요약} (대화가 길 때만)

[최근 대화]
사용자: {메시지1}
노바: {응답1}
사용자: {메시지2}
노바: {응답2}
... (최근 5-10개)

[현재 코드]
```html
{base_html 전체}
```

[요청]
{job.prompt}
```

### 할 일
1. [ ] `artifact_chats`에서 해당 프로젝트의 최근 N개 메시지 조회
   - `SELECT * FROM artifact_chats WHERE artifact_id=? ORDER BY created_at DESC LIMIT 10`
2. [ ] 시스템 컨텍스트에 대화 이력 주입
3. [ ] `base_html` 잘라내기 제거 (15000자 제한 → 전체 전달)
   - 토큰 계산: `글자수 / 4` 휴리스틱
   - 50KB HTML = 약 12.5K 토큰. Gemini 1M 컨텍스트에 문제없음

### DB 스키마 확인 필요
- `artifact_chats` 테이블 구조 확인
- `artifact_id` 컬럼 존재 여부 확인

---

## 4. P1: 컨텍스트 압축

### OpenCode 실제 구현 참조
`packages/core/src/session/compaction.ts`에서 확인한 강제 템플릿:

```markdown
## Objective
- 사용자가 달성하려는 것 (1-2문장)

## Requirements
- 제약, 선호, 범위 경계

## Decisions
- 이미 내린 결정과 이유

## Work State
### Completed / Active / Blocked

## Next Move
1. 다음 할 일 순서대로

## Relevant Files
- 최대 15개

## Important Context
- 다음 에이전트가 꼭 알아야 할 사실
```

### 우리에게 적용

**트리거**: 대화 토큰이 30K 초과 시 (추정: `총 글자수 / 4`)

**압축 프로세스**:
1. 오래된 대화 → LLM에게 위 템플릿으로 요약 요청
2. 요약문을 DB에 저장 (`artifact_summaries` 테이블 신설 또는 `artifacts`에 컬럼 추가)
3. 다음 요청부터: `[압축 요약] + [최근 10개 원문] + [현재 코드] + [새 요청]`

**보존 규칙** (OpenCode 참조):
- 사용자 메시지는 절대 요약하지 않음 → 최근 N개는 원문 유지
- 현재 코드는 압축 대상 아님 → 항상 전체
- 정확한 파일명, 에러 메시지, 결정 사항은 요약에 보존

### 할 일
1. [ ] 압축 트리거 임계값 결정 (30K 토큰 제안)
2. [ ] 요약 생성 프롬프트 작성 (OpenCode 템플릿 변형)
3. [ ] 요약 저장 스키마 설계
4. [ ] 점진적 압축: 기존 요약 + 새 대화를 합쳐서 새 요약 생성

---

## 5. P1: `ask_user` 도구

### 필요성
"이 버튼이 잘 안 눌리고 색상을 좀 바꿨으면 좋겠고"
→ 어떤 버튼? 뭐가 "잘 안 눌"린다는 거지? (반응 없음? 작음? 위치?)

지금은 노바가 추측해서 고친다. 틀리면 사용자는 다시 설명해야 한다.

### OpenCode의 `question` 도구 참조
```typescript
{
  name: "question",
  input: {
    questions: [{
      question: "어떤 버튼을 말씀하시는 건가요?",
      options: [
        { label: "시작 버튼", description: "스톱워치 시작/정지" },
        { label: "리셋 버튼", description: "시간 초기화" },
        { label: "랩 버튼", description: "구간 기록" }
      ]
    }]
  }
}
```

### 우리에게 적용

**문제**: 현재 Queue 워커는 사용자와 실시간 상호작용 불가.
**해결**: `ask_user` 호출 시 job을 `waiting_input` 상태로 변경 → 프론트에 질문 표시 → 사용자 답변 → job 재개

### 할 일
1. [ ] `artifact_jobs`에 `waiting_input` 상태 추가
2. [ ] `ask_user` 도구 정의 (STUDIO_TOOLS에 추가)
3. [ ] 워커에서 `ask_user` 호출 시 job 일시정지 + 질문 저장
4. [ ] 프론트에서 질문 UI 표시 (선택지 버튼)
5. [ ] 답변 시 job 재개 (Queue에 다시 전송)

### 복잡도: 높음
당장 P0 다음으로 하기엔 무거움. Phase 2로 미뤄도 됨.

---

## 6. P1: 자기 검증

### 현재 문제
노바가 HTML을 뱉으면 그대로 저장. 문법 오류가 있어도 모름.

### 할 일
1. [ ] `validate_html`: HTML 파싱 검증 (Worker에서 DOMParser 사용 가능)
2. [ ] `validate_js`: `<script>` 내용 추출 → 문법 체크 (esbuild transform으로 검증)
3. [ ] 검증 실패 시 에이전트 루프 안에서 자동 수정
   - `runStudioAgent`의 턴 안에서 `edit_file`로 고치게 프롬프트 유도

### 예상 효과
- "버튼이 안 눌려" 같은 문제의 50%는 생성 단계에서 잡힘
- 사용자에게 깨진 앱이 전달되는 경우 감소

---

## 7. P2: Item 단위 기록 (에이전트 타임라인)

### Codex의 Thread → Turn → Item 모델
- Thread: 전체 대화 (= 우리의 프로젝트)
- Turn: 한 번의 요청-응답 사이클
- Item: Turn 안의 개별 단위 (LLM 생각, 도구 호출, 도구 결과, 최종 응답)

### 현재
`artifact_chats`에 사용자와 AI 메시지만 저장. 중간 과정 없음.

### 할 일
1. [ ] `artifact_turns` 테이블: turn 단위 기록
2. [ ] `artifact_items` 테이블: 각 도구 호출/결과 기록
3. [ ] 프론트에 Codex식 타임라인 UI ("노바가 파일 3개를 수정했습니다" 같은 표시)
4. [ ] 기존 `artifact_job_events`와 통합 검토

---

## 8. 실행 순서

### Phase 1 (이번 주)
1. v2 수정 E2E 검증 + 수정 (P0)
2. 대화 컨텍스트 전달 구현 (P0)

### Phase 2 (다음)
3. 컨텍스트 압축 구현 (P1)
4. 자기 검증 도구 (P1)

### Phase 3 (후순위)
5. `ask_user` 도구 (P1, 복잡도 높음)
6. Item 단위 기록 + 타임라인 UI (P2)

---

## 9. 검증 계획

각 Phase마다:
1. TypeScript 컴파일 (`npx tsc --noEmit`)
2. 기존 테스트 실행
3. 브라우저 E2E:
   - v1 생성 → "버튼 색상 바꿔줘" → v2 생성 확인
   - 버전 이력에 v1, v2 표시
   - 미리보기에 v2 반영
   - 콘솔 에러 없음
4. 운영 배포 후 재검증

---

## 참고 자료

- `docs/agent-deep-analysis-20251016.md` — 오픈소스 심층 분석
- OpenCode 소스: `/tmp/agent-research/opencode/packages/core/src/session/`
- 현재 에이전트: `src/services/studio-agent.ts` (549줄)
- 현재 도구: `src/services/studio-tools.ts` (5개 도구)
- 현재 워커: `src/modules/artifact/job-processor.ts` (466줄)
