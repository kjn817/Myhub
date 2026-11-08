# GPT 자문 요청: AI 스튜디오 도구 호출 후 파일 생성 문제 (3차)

## 현재 상태

Function Calling 자체는 작동하기 시작했습니다.
- Gemini 503 해결 (키 로테이션으로 우회)
- `allowedFunctionNames: ['create_file']` 추가 후 모델이 도구 호출 시작
- 오류가 `AGENT_NO_TOOL_CALL` → D1 NOT NULL로 변경

## 문제

모델이 도구를 호출하지만 `index.html`이 생성되지 않거나, 생성된 파일이 미리보기에 사용되지 않습니다.

오류: `D1_ERROR: NOT NULL constraint failed: artifacts.html_content`

## 코드 흐름

1. `runStudioAgent()` → `workspace.execute(create_file)` → 파일이 `Map`에 저장
2. `workspace.getFiles()` → `{ 'index.html': '...' }` 반환
3. `job-processor.ts`에서 `new StudioWorkspace(agentResult.files)` 생성
4. `ws.getPreviewHtml()` 호출:
   ```typescript
   if (this.files.has('index.html')) return this.files.get('index.html')!
   const htmlFiles = [...this.files.keys()].filter(k => k.endsWith('.html'))
   if (htmlFiles.length === 1) return this.files.get(htmlFiles[0])!
   return ''  // ← 여기가 문제일 수 있음
   ```
5. 빈 문자열이면 D1 저장 실패

## 시스템 프롬프트

```
당신은 노바, AI 스튜디오의 코딩 어시스턴트입니다.

도구를 사용해 점진적으로 앱을 만드세요:
1. 먼저 필요한 파일들을 create_file로 생성
2. 필요하면 edit_file로 수정
3. 완성되면 사용자에게 요약 설명

규칙:
- 한 번에 하나의 작업에 집중
- HTML 파일은 완전한 문서로 (<!DOCTYPE html> 포함)
- CSS/JS는 별도 파일로 분리 가능
- index.html이 진입점이어야 함
- 설명은 간결하게, 코드는 도구로만 생성
```

## 질문

1. 모델이 `create_file`을 호출할 때 `path`를 `index.html`이 아닌 다른 이름으로 지정할 가능성이 있나요?
2. `allowedFunctionNames: ['create_file']`가 첫 호출에만 적용되는데, 이후 턴에서는 모델이 다른 도구를 호출하지 않을까요?
3. 시스템 프롬프트를 더 강력하게 만드는 방법이 있나요? (예: "반드시 index.html이라는 이름으로...")
4. `getPreviewHtml()`의 폴백 로직을 개선해야 하나요? (예: 첫 번째 HTML 파일을 무조건 사용)

## 요청

모델이 올바른 파일명으로 파일을 생성하도록 유도하는 방법을 알려주세요.
