# AI 코딩 에이전트 심층 분석 (2026-10-16)

실제 오픈소스 소스코드를 직접 분석한 결과. 추정 아님.

## 분석 대상

1. **OpenCode** (sst/opencode) — 소스코드 직접 분석
   - `packages/core/src/session/compaction.ts` (전체 800줄)
   - `packages/core/src/session/runner/step.ts` (에이전트 루프, 321줄)
   - `packages/core/src/tool/plugin/` (도구 정의)
2. **OpenAI Codex** — 공식 블로그 "Unrolling the Codex agent loop" + `openai/codex` 소스 분석 문서
3. **Claude Code** — `/compact` 메커니즘 문서 + 도구 인벤토리

---

## 1. 에이전트 루프: 진짜 vs 가짜

### 진짜 에이전트 루프 (OpenCode `step.ts`에서 확인)

```
for (;;) {
  1. LLM에 스트리밍 요청
  2. 이벤트 수신:
     - text_delta → UI에 스트리밍 표시
     - tool_call → 도구 실행 (fiber로 병렬 실행 가능)
     - tool 결과를 publisher에 기록
  3. 도구 호출이 더 없으면 → 종료 (Outcome.Completed)
  4. 컨텍스트 오버플로우 → 압축 후 재시도 (Outcome.Compacted)
  5. 도구 실행 중 에러 → 재시도 정책 적용
  6. 사용자가 도구 거부 → 중단
}
```

핵심: **하나의 사용자 요청에 대해 LLM을 여러 번 호출**한다.
모델이 "도구 호출"을 멈출 때까지 반복. 이게 에이전트다.

### 우리 노바 (현재)

```
사용자 입력 → LLM 1번 호출 → HTML 통째로 반환 → 버전 저장 → 끝
```

도구 호출 없음. 반복 없음. 검증 없음.
**에이전트가 아니라 단일 샷 코드 생성기다.**

---

## 2. 도구 시스템

### OpenCode의 도구 정의 방식

각 도구는 이 구조를 가진다:
```typescript
{
  name: "read",           // 도구 이름
  description: "...",     // 모델에게 보여주는 설명
  input: Schema,          // 입력 스키마 (Zod-like)
  output: Schema,         // 출력 스키마
  execute: (input) => Effect  // 실제 실행 로직
}
```

도구 목록 (OpenCode):
- `read` — 파일/디렉토리 읽기 (offset/limit 페이징)
- `edit` — 정확한 문자열 교체
- `write` — 파일 쓰기/덮어쓰기
- `glob` — 파일명 패턴 검색
- `grep` — 내용 검색 (ripgrep 기반)
- `shell` — 셸 명령 실행
- `patch` — diff 형식 패치 적용
- `question` — 사용자에게 질문 (선택지 제공)
- `webfetch` / `websearch` — 웹 접근

### Codex의 도구 철학

Codex는 정반대 접근:
- **단 2개**: `shell` + `apply_patch`
- 파일 읽기/검색도 `shell`로 (cat, ls, rg 등)
- 모든 파일 수정은 `apply_patch`로 (Lark 문법의 패치 형식)
- 이유: 도구가 적을수록 프롬프트가 짧아지고, 셸이면 뭐든 할 수 있음

### 우리에게 필요한 최소 도구

웹 기반 + 단일 HTML 앱이라는 특성을 고려하면:

| 도구 | 용도 | 우선순위 |
|------|------|----------|
| `read_code` | 현재 코드 읽기 (이미 있음, `curHtml`) | - |
| `edit_code` | 부분 수정 (문자열 교체, diff 방식) | P0 |
| `validate_html` | HTML 파싱 검증 | P1 |
| `validate_js` | JS 문법 체크 | P1 |
| `preview_screenshot` | 미리보기 렌더링 확인 | P2 |
| `ask_user` | 모호할 때 되묻기 | P1 |

지금은 `edit_code`조차 없어서 매번 전체 HTML을 재생성한다.
"버튼 색상만 바꿔줘"인데 50KB HTML 전체를 다시 뱉는 구조다.

---

## 3. 컨텍스트 압축: 실제 구현

### OpenCode의 압축 (소스코드에서 확인)

**트리거**: 컨텍스트가 모델 한계의 90% 도달 시 (10% 버퍼 유지)

**요약 템플릿** (강제 형식):
```markdown
## Objective
- 사용자가 달성하려는 것 (1-2문장)

## Requirements
- 제약, 선호, 범위 경계

## Decisions
- 이미 내린 결정과 이유

## Work State
### Completed
- 완료된 목표
### Active
- 진행 중인 목표
### Blocked
- 막힌 것 + 이유

## Next Move
1. 다음 할 일 순서대로

## Relevant Files
- 최대 15개, 중요한 순서대로
- [경로]: 왜 중요한지

## Important Context
- 다음 에이전트가 계속하려면 꼭 필요한 사실
```

**규칙** (SUMMARY_RULES에서 확인):
- 간결하게. 장문 금지, 중첩 리스트 금지
- 정확한 파일 경로, 심볼, 명령어, 에러 문자열, URL, 식별자는 보존
- 답변된 질문은 반복하지 않음. 미해결만 이월
- "압축됐다"는 언급 금지

**보존 정책**:
- 최근 15,000 토큰은 원문 유지 (`keep: 15_000`)
- 사용자 메시지는 절대 요약하지 않음 (원문 유지)
- 이전 압축 결과가 있으면 새 요약에 통합 (점진적 압축)

**오버플로우 시 축소 단계**: 70% → 50% → 35%

### Codex의 압축

- 3단계: (1) 개별 도구 출력 자르기 → (2) 가장 오래된 히스토리 삭제 → (3) LLM 요약
- 요약 시 "progress, decisions, constraints, next steps" 형식의 핸드오프 요약
- 최근 20K 토큰의 사용자 메시지 보존
- `/responses/compact` API로 서버 측 압축도 지원

### 우리에게 적용

```
[시스템] 노바 시스템 프롬프트
[압축 요약] OpenCode식 구조화 요약 (대화가 길어질 때만)
[최근 대화] 최근 5-10개 메시지 원문
[현재 코드] 전체 HTML (압축 대상 아님, 항상 전체)
[사용자] 새 요청
```

토큰 계산은 `글자수 / 4` 휴리스틱으로 충분 (OpenCode, Codex 둘 다 사용).

---

## 4. Thread → Turn → Item 모델

Codex의 데이터 모델 (소스에서 확인):

- **Thread**: 전체 대화 (우리의 "프로젝트"에 해당)
- **Turn**: 한 번의 사용자 입력 → 에이전트 응답 완료까지
- **Item**: Turn 안의 개별 단위 (메시지, 도구 호출, 도구 결과, 추론 과정)

우리의 현재 모델:
- `artifact_chats`: 사용자 메시지와 AI 메시지만 저장
- 중간 과정 (도구 호출, 생각 과정) 저장 안 됨

에이전트 루프를 도입하면 Item 단위 저장이 필요해진다.
"노바가 뭘 했는지" UI에 보여주려면 (Codex식 타임라인) 이 구조가 필수.

---

## 5. 프롬프트 캐싱

Codex가 강조하는 성능 최적화:

- **정확한 prefix 매칭**일 때만 캐시 히트
- 정적 콘텐츠(지시사항, 도구 정의)는 앞에, 가변 콘텐츠(사용자 메시지)는 뒤에
- 도구 목록이 중간에 바뀌면 캐시 미스 → 비싸짐

우리에게 시사점:
- 시스템 프롬프트 + 도구 정의는 매번 동일하게 (앞에 고정)
- 대화 히스토리 + 현재 코드는 뒤에
- 이렇게 하면 같은 프로젝트에서 연속 수정 시 캐시 효율 극대화

---

## 6. 우리 노바의 로드맵

### Phase 1: 대화 컨텍스트 전달 (지금 가능)
- 수정 요청 시 해당 프로젝트의 최근 대화 N개를 프롬프트에 포함
- 현재: `prompt(1개) + base_html` → 변경: `요약 + 최근대화(N개) + base_html + prompt`

### Phase 2: 부분 수정 도구 (P0)
- 전체 재생성 → `edit_code(old_string, new_string)` 방식
- "버튼 색상만 바꿔"가 50KB 재생성이 아니라 수십 바이트 수정이 됨
- 토큰 비용 1/100 이하로 감소

### Phase 3: 에이전트 루프 (구조 변경)
- Queue 워커를 `for(;;)` 루프로 개조
- LLM → 도구 호출 → 실행 → 결과 피드백 → 반복
- 중단/재시도/에러 처리 (OpenCode `step.ts` 참조)

### Phase 4: 자기 검증
- `validate_html`, `validate_js` 도구로 생성 코드 검증
- 실패하면 스스로 고치고 다시 검증 (루프 안에서)

### Phase 5: 계획 + 되묻기
- 복잡한 요청에 `update_plan`식 단계 계획
- 모호한 지시에 `ask_user`로 확인

---

## 7. 핵심 차이 요약

| 항목 | 진짜 에이전트 | 우리 노바 (현재) |
|------|---------------|------------------|
| LLM 호출 횟수/요청 | 수십 번 (도구 호출마다) | 1번 |
| 도구 | 10개 이상 | 0개 |
| 부분 수정 | diff/patch 방식 | 전체 재생성 |
| 자기 검증 | 루프 안에서 자동 | 없음 |
| 대화 기억 | 압축 + 원문 혼합 | 1개 메시지만 |
| 중간 과정 표시 | Item 단위 타임라인 | 없음 |
| 모호한 지시 | 되묻기 도구 | 추측 |

---

## 참고 소스

- OpenCode: `/tmp/agent-research/opencode/packages/core/src/session/compaction.ts`
- OpenCode: `/tmp/agent-research/opencode/packages/core/src/session/runner/step.ts`
- OpenCode: `/tmp/agent-research/opencode/packages/core/src/tool/plugin/`
- OpenAI: https://openai.com/index/unrolling-the-codex-agent-loop/
- Hermes Agent: 클론 실패 (네트워크 타임아웃), 웹 리서치로만 확인
  - Nous Research, MIT 라이선스, Python+TypeScript
  - 특징: 스킬 기반 자기 개선, 영속 메모리, 멀티 플랫폼 게이트웨이
