# AI 스튜디오 아키텍처 자문 요청 (상세 코드 포함)
날짜: 2026-10-15
작성: Muse (Meta)

## 1. 시스템 개요

MyHub AI 스튜디오는 사용자가 자연어로 웹앱을 요청하면, 노바(Nova) AI가 Function Calling으로
멀티파일 프로젝트를 생성하는 시스템입니다.

- 프론트엔드: `public/agent.html` (1233줄, Vanilla JS + CodeMirror)
- 백엔드: Cloudflare Workers + Hono + D1 (SQLite)
- AI: Gemini `gemini-3.5-flash-lite` via Function Calling
- 도구: `create_file`, `edit_file`, `list_files`, `read_file`

## 2. 핵심 플로우 코드

### 2.1 프론트엔드: sendChat (public/agent.html)

```javascript
async function sendChat() {
  if (sending) {
    if (currentJobId) cancelJob(currentJobId);
    return;
  }
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  sending = true;
  // ... 버튼을 중단 버튼으로 변경 ...
  addMsg('user', esc(text));

  const isNew = !curId;
  if (isNew) { workingProject = { title: text.slice(0, 20) }; renderSidebar(); }

  try {
    const isModify = !!curId;  // ← curId가 있으면 수정, 없으면 생성
    showWorking('노바가 작업 중...');
    const d = await callAiJob(isModify ? 'modify' : 'create', text, curHtml);
    hideWorking();
    await loadProjects();
    if (d.artifact_id) {
      selectProject(d.artifact_id, true);
    } else if (curId) {
      selectProject(curId);
    }
  } catch (e) {
    addMsg('nova', `<p style="color:#cf222e;">실패: ${esc(e.message)}</p>`);
  } finally {
    // 버튼 복원
    sending = false;
  }
}
```

**문제점**: `curId`가 있으면 무조건 'modify', 없으면 무조건 'create'.
사용자가 "안녕?"이라고 해도 프로젝트가 생성됨.
사용자가 원하는 것: 대화로 아이디어 구체화 → "구현해줘" 할 때 생성.

### 2.2 백엔드: Job 생성 (src/modules/artifact/routes.ts)

```typescript
artifactApp.post('/jobs', async (c) => {
  const { kind, prompt, base_html, artifact_id, provider, model } = await c.req.json();
  // kind: 'create' | 'modify'
  // artifact_id: modify일 때 대상 프로젝트 ID
  const job = await createJob({ kind, prompt, base_html, artifact_id, ... });
  // ... 백그라운드 처리 시작 ...
  return c.json({ ok: true, job_id: job.id });
});
```

### 2.3 백엔드: Job 처리 (src/modules/artifact/job-processor.ts, 412줄)

```typescript
export async function processArtifactJob(env, jobId) {
  const job = await getJob(env, jobId);
  
  if (job.kind === 'create') {
    // 새 프로젝트 생성
    const agentResult = await runStudioAgent({
      prompt: job.prompt,
      provider: job.provider,
      model: job.model,
    });
    // agentResult.files: { 'index.html': '...', 'js/app.js': '...', ... }
    
    const artifactId = await createArtifact({
      title: job.prompt.slice(0, 50).replace(/( 만들어줘| 해줘).*$/, ''),
      html_content: agentResult.files['index.html'] || '',
    });
    const versionId = await createVersion(artifactId, 1, agentResult);
    await saveFiles(versionId, agentResult.files);
    
  } else if (job.kind === 'modify') {
    // 기존 프로젝트 수정 → v2 생성해야 함
    const artifact = await getArtifact(job.artifact_id);
    const currentVersion = await getDraftVersion(job.artifact_id);
    const existingFiles = await getFiles(currentVersion.id);
    
    const agentResult = await runStudioAgent({
      prompt: job.prompt,
      base_html: job.base_html,  // ← 현재 HTML 전달
      initialFiles: existingFiles, // ← 기존 파일들 전달
      provider: job.provider,
      model: job.model,
    });
    
    // 새 버전 생성 (version_no 증가)
    const nextNo = currentVersion.version_no + 1;
    const versionId = await createVersion(artifactId, nextNo, agentResult);
    await saveFiles(versionId, agentResult.files);
    await updateArtifactDraftPointer(artifactId, versionId);
  }
}
```

**현재 버그**: modify 요청 시 v2가 생성되지 않음.
QA 결과: "버튼 색상을 빨간색으로 바꿔줘" → "v1 완료"로 표시, 버전 기록에 v2 없음, 코드 변경 미적용.
원인 미파악.

### 2.4 AI 에이전트 (src/services/studio-agent.ts, 524줄)

```typescript
export async function runStudioAgent(opts: {
  prompt: string;
  base_html?: string;
  initialFiles?: Record<string, string>;
  provider: string;
  model: string;
}): Promise<{ files: Record<string, string>, summary: string }> {
  
  const workspace = new StudioWorkspace();
  if (opts.initialFiles) {
    workspace.loadFiles(opts.initialFiles);  // 수정 시 기존 파일 로드
  } else if (opts.base_html) {
    workspace.setFile('index.html', opts.base_html);
  }
  
  const systemPrompt = `너는 웹앱을 만드는 AI다.
반드시 Function Calling 도구를 사용해 파일을 생성하라.
- create_file: 새 파일 생성 (path, content)
- edit_file: 기존 파일 수정 (path, old_string, new_string)
- list_files: 파일 목록 조회
- read_file: 파일 내용 읽기

모듈식 구조로 만들어라:
- index.html (구조)
- styles/main.css (스타일)
- js/app.js (로직)

HTML만 출력하지 말고 도구를 사용하라.`;
  
  // Gemini Function Calling 루프
  let files = {};
  for (let i = 0; i < 10; i++) {
    const response = await callGeminiWithTools(systemPrompt, opts.prompt, workspace);
    if (response.toolCalls) {
      for (const tc of response.toolCalls) {
        workspace.executeTool(tc);  // create_file, edit_file 등 실행
      }
    } else {
      break;
    }
  }
  
  return { files: workspace.getFiles(), summary: response.text };
}
```

## 3. DB 스키마

```sql
-- 프로젝트
CREATE TABLE artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  type TEXT DEFAULT 'html',
  status TEXT DEFAULT 'draft',  -- draft, published
  description TEXT,
  draft_version_id INTEGER REFERENCES artifact_versions(id),
  published_version_id INTEGER REFERENCES artifact_versions(id),
  row_revision INTEGER DEFAULT 1,
  html_content TEXT,  -- 레거시, 현재는 artifact_files 사용
  created_at TEXT DEFAULT (datetime('now'))
);

-- 버전
CREATE TABLE artifact_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id INTEGER NOT NULL REFERENCES artifacts(id),
  version_no INTEGER NOT NULL,
  html_content TEXT,
  content_sha256 TEXT,
  change_note TEXT,
  source_type TEXT DEFAULT 'nova',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (artifact_id, version_no)
);

-- 파일 (멀티파일)
CREATE TABLE artifact_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES artifact_versions(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,  -- 'index.html', 'js/app.js', 'styles/main.css'
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  file_size INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (version_id, file_path)
);

-- 채팅 기록
CREATE TABLE artifact_chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id INTEGER REFERENCES artifacts(id),
  session_key TEXT NOT NULL DEFAULT 'new',  -- 'new' 또는 'p{artifact_id}'
  who TEXT NOT NULL,  -- 'user', 'nova'
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 작업 큐
CREATE TABLE artifact_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id INTEGER REFERENCES artifacts(id),
  kind TEXT NOT NULL DEFAULT 'create',  -- 'create', 'modify'
  status TEXT DEFAULT 'pending',  -- pending, running, done, failed
  prompt TEXT NOT NULL,
  base_html TEXT,
  result_html TEXT,
  error TEXT,
  provider TEXT,
  model TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

## 4. 현재 UX 문제점

### 4.1 대화형 빌드업 부재 (가장 중요)
- 현재: 메시지 전송 → 즉시 Job 생성 → 프로젝트 생성
- 원하는: Codex처럼 대화로 요구사항 구체화 → "구현해줘" 시점에 생성
- 예: "계산기 만들고 싶어" → "어떤 기능이 필요해?" → "사칙연산이랑 기록" → "구현해줘" → 생성 시작

### 4.2 미리보기 인터랙션 불가
- 우측 미리보기 iframe (sandbox="allow-scripts")에서 앱 내부 버튼 클릭이 동작하지 않음
- 합성 HTML: index.html의 `<link href="styles/main.css">`를 `<style>`로, `<script src="js/app.js">`를 `<script>`로 인라인 변환
- 원인 후보: sandbox 제한 / JS 오류 / 합성 문제 (미확인)

### 4.3 채팅 메시지 중복
- `sendChat`의 `callAiJob` 폴링과 `checkActiveJobs`의 `pollJob`이 중복 실행
- 수정: `pollJob`에서 메시지 추가 제거, `showChangeCard`에 중복 방지 추가
- 아직 완전 해결 안 됨

## 5. 질문

1. **대화형 빌드업 아키텍처**: 
   - "구현" 인텐트를 어떻게 감지할 것인가? (키워드? LLM 판단? 명시적 버튼?)
   - 대화 컨텍스트를 프로젝트 생성 Job에 어떻게 전달할 것인가?
   - 현재 `kind: 'create'|'modify'` 2단계인데, 'chat' 단계를 추가해야 하는가?

2. **v2 수정 실패**: 위 `job-processor.ts`의 modify 브랜치에서 의심스러운 부분은?
   - `initialFiles` 전달이 제대로 되는가?
   - Gemini가 `edit_file`을 호출하지 않고 `create_file`로 덮어쓰는가?
   - 버전 증가 로직에 문제가 있는가?

3. **미리보기 sandbox**: `sandbox="allow-scripts"`에서 버튼 클릭이 안 되는 일반적인 원인은?
   - `allow-same-origin`이 없어서인가?
   - 합성된 인라인 JS에 오류가 있어서인가?

4. **Codex 스타일 UX의 핵심**: Codex Web UI (luseptem/codex-webui 참조)가 에이전트 작업 중
   사용자에게 보여주는 핵심 피드백 요소는 무엇인가?
