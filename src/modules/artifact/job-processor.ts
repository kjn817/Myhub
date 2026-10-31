import type { Env } from '../../types'
import { generateArtifactHtml } from './generate-html'

// Codex 스타일 이벤트 로깅 (P0)
export async function logJobEvent(env: Env, jobId: number, eventType: string, payload: any = {}) {
  try {
    await env.DB.prepare(
      `INSERT INTO artifact_job_events (job_id, event_type, payload) VALUES (?, ?, ?)`
    ).bind(jobId, eventType, JSON.stringify(payload)).run()
  } catch (e) { /* 이벤트 로깅 실패는 무시 */ }
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export type JobOutcome = 'done' | 'failed' | 'notfound' | 'busy' | 'awaiting_input'

/**
 * Artifact 작업 처리 (Queue Consumer에서 호출)
 * - 원자적 claim으로 중복 실행 방지
 * - AI 호출 타임아웃 적용
 * - 결과 저장의 멱등성 보장
 */
export async function processArtifactJob(env: Env, jobId: number): Promise<JobOutcome> {
  // 1. Lease 기반 원자적 claim
  // - pending이거나 lease가 만료된 running 작업만 획득 가능
  // - 실행 토큰으로 소유권 증명
  const leaseToken = crypto.randomUUID()
  const leaseExpires = new Date(Date.now() + 14 * 60 * 1000).toISOString() // 14분 (Queue 15분 제한보다 짧게)
  const claim = await env.DB.prepare(
    `UPDATE artifact_jobs
     SET status='running', attempts=attempts+1, lease_token=?, lease_expires=?, updated_at=datetime('now')
     WHERE id=? AND (status='pending' OR (status='running' AND (lease_expires IS NULL OR lease_expires < datetime('now'))))`
  ).bind(leaseToken, leaseExpires, jobId).run()

  if ((claim.meta?.changes ?? 0) === 0) {
    const existing = await env.DB.prepare('SELECT status FROM artifact_jobs WHERE id=?').bind(jobId).first() as any
    if (!existing) return 'notfound'
    if (existing.status === 'done' || existing.status === 'failed') return 'done'
    return 'busy'
  }

  const job: any = await env.DB.prepare('SELECT * FROM artifact_jobs WHERE id=?').bind(jobId).first()
  if (!job) return 'notfound'

  // A1: ask_question 답변으로 재개된 작업 — pending_state에서 Q&A와 부분 파일을 복원
  let resumeContext = ''
  let resumeFiles: Record<string, string> | undefined
  if (job.pending_state) {
    try {
      const ps = JSON.parse(job.pending_state)
      if (ps.answers && ps.answers.length > 0) {
        const qa = ps.answers.map((a: any) => {
          const q = (ps.questions || []).find((qq: any) => qq.id === a.id)
          return `Q: ${q?.question || a.id}\nA: ${a.answer}`
        }).join('\n')
        resumeContext = `\n\n[사용자 답변 도착 — 이전에 당신이 ask_question으로 물었던 것에 대한 답입니다. 이 답변을 반영해서 작업을 이어서 진행하세요.]\n${qa}`
        resumeFiles = ps.files || undefined
        await logJobEvent(env, jobId, 'job.resumed', { answers: ps.answers.length })
      }
      // 재개 시 pending_state 정리 (재시도 시 중복 주입 방지)
      await env.DB.prepare('UPDATE artifact_jobs SET pending_state=NULL WHERE id=?').bind(jobId).run()
    } catch (e) { /* 파싱 실패 시 무시 */ }
  }

  // Codex 스타일: job.started 이벤트
  await logJobEvent(env, jobId, 'job.started', { kind: job.kind, prompt: job.prompt?.slice(0, 100) })

  const { getSkillForKind, STUDIO_SKILLS } = await import('../../services/studio-skills')
  const skill = getSkillForKind(job.kind)
  const skillRef = skill ? `\n\n참고용 스킬 (강제가 아니라 참고):\n${skill.content}` : ''
  // 관문 19: review 스킬은 모든 작업에 추가 (완료 전 체크리스트)
  // plan 스킬은 계획 요청 시 추가
  const reviewRef = `\n\n완료 전 체크 (참고용):\n${STUDIO_SKILLS.review.content}`
  // A3: design 스킬은 화면 작업에 추가 (사용자 디자인 취향 참조)
  const designRef = `\n\n디자인 참고:\n${STUDIO_SKILLS.design.content}`
  const isPlanRequest = /계획|plan\.md|설계/i.test(job.prompt)
  const planRef = isPlanRequest ? `\n\n계획 작성 참고:\n${STUDIO_SKILLS.plan.content}` : ''

  // GPT 자문: modify 시 기존 파일 목록을 프롬프트에 포함 (에이전트가 뭘 읽어야 할지 알 수 있게)
  // v2 수정 실패 근본 원인: 파일 목록 없이 "버튼을 파란색으로 바꿔줘"만 전달되어 에이전트가 파일을 찾지 못함
  let modifyFileList = ''
  let preloadedFiles: Record<string, string> | undefined
  if (job.kind === 'modify' && job.artifact_id) {
    try {
      const art: any = await env.DB.prepare('SELECT draft_version_id FROM artifacts WHERE id=?').bind(job.artifact_id).first()
      if (art?.draft_version_id) {
        const { results } = await env.DB.prepare(
          'SELECT file_path, content FROM artifact_files WHERE version_id=?'
        ).bind(art.draft_version_id).all()
        if (results && results.length > 0) {
          preloadedFiles = {}
          const fileNames: string[] = []
          for (const r of results as any[]) {
            preloadedFiles[r.file_path] = r.content
            fileNames.push(r.file_path)
          }
          modifyFileList = `\n\n현재 프로젝트 파일 목록:\n${fileNames.map(f => `- ${f}`).join('\n')}\n\n먼저 read_file로 파일 내용을 확인한 후 수정하세요.`
        }
      }
    } catch (e) { /* 파일 로드 실패 시 무시 */ }
  }

  const sysCtx = job.kind === 'modify' && job.base_html
    ? `기존 프로젝트 수정: ${job.prompt}${modifyFileList}${skillRef}${reviewRef}${designRef}${planRef}${resumeContext}`
    : `"${job.prompt}" — 완성된 HTML 앱으로 만들어줘.${skillRef}${reviewRef}${designRef}${planRef}${resumeContext}`

  // 2. AI 에이전트 실행 (도구 기반, 멀티턴)
  // Codex/VSCode Copilot급: AI가 create_file 등의 도구로 점진적 생성
  // 관문 40: 모델 폴백 — 1차 실패 시 2차 모델로 재시도
  let lastErr = '', html = '', title = ''
  const maxTries = 2
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      const { runStudioAgent } = await import('../../services/studio-agent')
      // Job에 저장된 모델 사용 (없으면 전역 설정 폴백)
      let modelId = (job as any).model
      let provider = (job as any).provider as 'gemini' | 'groq' | 'nvidia' | undefined
      if (!modelId) {
        const setting = await env.DB.prepare(
          "SELECT value FROM ai_settings WHERE key='model.code'"
        ).bind().first() as any
        modelId = setting?.value || 'gemini-3.5-flash-lite'
      }
      // 관문 40: 2차 시도에서는 폴백 모델 사용
      if (attempt === 2) {
        const fallbackModel = 'gemini-3.5-flash-lite'
        if (modelId !== fallbackModel) {
          await logJobEvent(env, jobId, 'model.fallback', { from: modelId, to: fallbackModel, reason: lastErr.slice(0, 200) })
          modelId = fallbackModel
          provider = 'gemini'
        } else {
          // 이미 폴백 모델인데 실패 → 더 이상 시도 안 함
          break
        }
      }
      // 모델 ID에서 프로바이더 추론 (Job에 없을 때)
      if (!provider) {
        provider = 'gemini'
        if (modelId.startsWith('openai/') && modelId.includes('gpt-oss')) {
          provider = 'groq'
        } else if (modelId.startsWith('nvidia/') || modelId.startsWith('meta/') || modelId.startsWith('google/')) {
          provider = 'nvidia'
        }
      }
      // NVIDIA 운영 제외 가드 (2026-10-30): 제외 전에 저장된 잡 행이나
      // model.code 설정이 NVIDIA를 가리키면, 스튜디오 에이전트로 넘기지 않고
      // 2차 시도의 폴백과 같은 gemini lite로 전환한다 (fail-soft — 잡 자체는
      // 살리고 NVIDIA 호출만 원천 차단). 신규 잡 생성은 routes 관문 76·82가
      // 이미 막으므로, 이 가드는 레거시 행 전용이다.
      if (provider === 'nvidia') {
        await logJobEvent(env, jobId, 'model.fallback', { from: modelId, to: 'gemini-3.5-flash-lite', reason: 'nvidia_provider_disabled' })
        modelId = 'gemini-3.5-flash-lite'
        provider = 'gemini'
      }
      // modify 시 기존 파일 전달 (위에서 미리 로드됨) + A1 재개 시 부분 파일 병합
      const mergedFiles = { ...(preloadedFiles || {}), ...(resumeFiles || {}) }
      const initialFiles = Object.keys(mergedFiles).length > 0 ? mergedFiles : undefined
      // B2: 파일 쓰기 스트리밍 — 도구 실행 직후 file.stream 이벤트 발행 (프론트 실시간 표시)
      const onFileWrite = (path: string, content: string | null) => {
        logJobEvent(env, jobId, 'file.stream', {
          file_path: path,
          content: content === null ? null : content.slice(0, 200000),
          truncated: content !== null && content.length > 200000,
        }).catch(() => {})
      }
      const agentResult = await runStudioAgent(env, sysCtx, {
        maxTurns: 7, // 관문 48: 7*120s=14분, Lease(14분) 내 완료 보장
        provider,
        model: modelId,
        jobId,
        initialFiles,
        onFileWrite,
      })
      // 계약 검증 (fail-closed): AgentLoopResult.files는 필수(Record<string,string>)이며
      // runStudioAgent의 모든 반환 경로는 {} 또는 workspace.getFiles()를 반환한다.
      // '파일 없음'의 정상 표현은 undefined가 아니라 {}다 (대화 모드 반환이 그 증거).
      // 따라서 files 누락/비객체는 계약 위반 신호 — || {}로 정규화하면 위반이
      // 대화 모드(done)로 포장되거나 awaiting_input 재개용 파일이 무음으로 소실된다.
      const filesValid =
        agentResult.files !== null &&
        typeof agentResult.files === 'object' &&
        !Array.isArray(agentResult.files)
      if (!filesValid && ((agentResult as any).awaitingInput || agentResult.ok)) {
        lastErr = 'AGENT_CONTRACT_VIOLATION: runStudioAgent가 files 없이 반환함 (ok/awaitingInput인데 files 누락)'
        break
      }
      // GPT 지침: 폴백 제거 - 실패 원인을 명확히 관찰
      // A1: ask_question → 사용자 입력 대기 상태로 저장하고 종료 (재개는 /answer가 트리거)
      if ((agentResult as any).awaitingInput) {
        const pendingState = JSON.stringify({
          questions: (agentResult as any).pendingQuestions || [],
          answers: [],
          files: agentResult.files,
        })
        await env.DB.prepare(
          `UPDATE artifact_jobs SET status='awaiting_input', pending_state=?, seen=0, lease_token=<redacted>, updated_at=datetime('now')
           WHERE id=? AND lease_token=?`
        ).bind(pendingState, jobId, leaseToken).run()
        await logJobEvent(env, jobId, 'job.awaiting_input', {
          questions: (agentResult as any).pendingQuestions || [],
        })
        return 'awaiting_input'
      }
      if (!agentResult.ok) {
        lastErr = agentResult.error || '에이전트 실행 실패'
        break
      }
      // 에이전트 성공: 생성된 파일들에서 미리보기 HTML 추출
      const { StudioWorkspace } = await import('../../services/studio-workspace')
      const ws = new StudioWorkspace(agentResult.files)
      // Codex 스타일: file.changed 이벤트 (각 파일별)
      // A5: modify 시 old→new unified diff를 이벤트에 포함 (변경 사항 탭에서 표시)
      const { unifiedDiff } = await import('../../lib/text-diff')
      for (const [filePath, newContent] of Object.entries(agentResult.files)) {
        const payload: any = { file_path: filePath }
        const oldContent = preloadedFiles?.[filePath]
        if (typeof oldContent === 'string' && oldContent !== newContent) {
          const diff = unifiedDiff(oldContent, newContent as string, filePath)
          if (diff) payload.diff = diff.slice(0, 20000) // 이벤트 페이로드 크기 제한
        }
        await logJobEvent(env, jobId, 'file.changed', payload)
      }
      // 관문 28: 도구 호출 히스토리를 이벤트로 기록 (관측성)
      const toolCalls = (agentResult as any).toolCalls as string[] | undefined
      if (toolCalls && toolCalls.length > 0) {
        await logJobEvent(env, jobId, 'agent.tool_calls', { calls: toolCalls })
      }
      html = ws.getPreviewHtml()
      if (!html) {
        const files = agentResult.files
        const htmlFiles = Object.keys(files).filter(k => k.endsWith('.html'))
        if (htmlFiles.length > 0) html = files[htmlFiles[0]]
      }
      // 대화 모드: 파일 없이 텍스트 응답만 있는 경우 (사용자가 의견/피드백 요청)
      if (!html && agentResult.summary && Object.keys(agentResult.files).length === 0) {
        // 대화 모드로 성공 처리 - 버전 생성 없이 텍스트 응답만 저장
        await env.DB.prepare(
          `UPDATE artifact_jobs SET status='done', result_html=NULL, error=NULL, artifact_id=?, seen=0, lease_token=NULL, updated_at=datetime('now')
           WHERE id=? AND status='running' AND lease_token=?`
        ).bind(job.artifact_id || null, jobId, leaseToken).run()
        // 채팅에 에이전트 응답 저장 (artifact_chats)
        // 관문 9: p${artifactId}로 직접 저장 (프론트 이관 불필요)
        if (job.artifact_id) {
          await env.DB.prepare(
            `INSERT INTO artifact_chats (artifact_id, session_key, who, content) VALUES (?, ?, 'nova', ?)`
          ).bind(job.artifact_id, `p${job.artifact_id}`, agentResult.summary.slice(0, 5000)).run()
        }
        return 'done'
      }
      // 관문 11: Markdown 전용 작업 — HTML 없이 파일만 있어도 성공
      // (예: "계획을 md파일로 만들어줘" → plan.md만 생성)
      {
        const agentFiles = agentResult.files
        const hasFiles = Object.keys(agentFiles).length > 0
        if (!html && hasFiles) {
          // HTML은 없지만 파일이 있음 → 파일 저장 경로로 진행
          html = `<!-- non-html artifact: ${Object.keys(agentFiles).join(', ')} -->`
        }
      }
      if (!html) {
        lastErr = `ARTIFACT_VALIDATION_FAILED: ${agentResult.error || 'HTML 없음'}`
        break
      }
      // 관문 38: HTML 크기 제한 (2MB)
      const htmlSize = new TextEncoder().encode(html).length
      if (htmlSize > 2 * 1024 * 1024) {
        lastErr = `ARTIFACT_VALIDATION_FAILED: HTML이 너무 큼 (${Math.round(htmlSize/1024/1024)}MB, 2MB 제한)`
        html = '' // 저장 방지: 초과 시 html을 비워서 아래 if (html) 블록을 건너뛰게 함
        break
      }
      // 제목은 사용자 프롬프트에서 생성 (AI 응답이 아닌)
      // "계산기 앱 만들어줘" -> "계산기 앱"
      let promptTitle = job.prompt.slice(0, 50)
      // 불필요한 접미사 제거
      promptTitle = promptTitle.replace(/( 만들어줘| 만들어주세요| 해줘| 해주세요| 부탁해).*$/, '')
      title = promptTitle || '새 프로젝트'
      ;(job as any)._agentFiles = agentResult.files
      break
    } catch (e: any) {
      const msg = e.message || '호출 오류'
      const code = e.code || 0
      // 오류 분류
      if (e?.name === 'AbortError' || msg.includes('AI_TIMEOUT')) {
        lastErr = 'AI 타임아웃 (180초)'
      } else if (code === 429) {
        lastErr = 'rate_limited (429)'
        // 429는 Queue 재시도에 맡김 (내부에서는 즉시 중단)
        break
      } else if (code === 401 || code === 403 || /unknown_persona|empty|too_long/.test(msg)) {
        lastErr = `영구 오류: ${msg.slice(0, 100)}`
        break // 재시도해도 소용없음
      } else if (code >= 500) {
        lastErr = `서버 오류 (${code}): ${msg.slice(0, 100)}`
        // 5xx는 재시도
      } else {
        lastErr = msg.slice(0, 200)
      }
    }
    if (attempt < maxTries && !html) {
      await new Promise(r => setTimeout(r, 2000 * attempt))
    }
  }

  // 3. 결과 저장 (멱등성: 이미 done이면 스킵)
  if (html) {
    try {
      // 중복 생성 방지: 같은 jobId로 이미 생성된 아티팩트가 있는지 확인
      const dup = await env.DB.prepare('SELECT artifact_id FROM artifact_jobs WHERE id=? AND artifact_id IS NOT NULL').bind(jobId).first() as any
      let resultArtifactId: number | null = dup?.artifact_id || job.artifact_id || null

      if (!resultArtifactId) {
          const atitle = title || job.prompt.slice(0, 30)
          const hash = await sha256(html)
          const size = new TextEncoder().encode(html).length
          const ar = await env.DB.prepare(
            `INSERT INTO artifacts (title, type, status, description, row_revision, html_content, owner_email) VALUES (?, 'html', 'draft', ?, 1, ?, ?)`
          ).bind(atitle, job.prompt.slice(0, 200), html, (job as any).owner_email ?? null).run()
          resultArtifactId = Number(ar.meta.last_row_id)
          const vr = await env.DB.prepare(
            `INSERT INTO artifact_versions (artifact_id, version_no, html_content, content_sha256, change_note, source_type) VALUES (?, 1, ?, ?, 'v1 생성', 'nova')`
          ).bind(resultArtifactId, html, hash).run()
          await env.DB.prepare(`UPDATE artifacts SET draft_version_id=? WHERE id=?`).bind(vr.meta.last_row_id, resultArtifactId).run()
          // 에이전트가 생성한 다중 파일 저장
          const agentFiles = (job as any)._agentFiles as Record<string, string> | undefined
          if (agentFiles && Object.keys(agentFiles).length > 0) {
            const { saveWorkspaceToD1 } = await import('../../services/studio-workspace')
            await saveWorkspaceToD1(env.DB, Number(vr.meta.last_row_id), agentFiles)
            // 멀티 파일 프로젝트로 표시
            try {
              await env.DB.prepare(`UPDATE artifacts SET project_type='multi' WHERE id=?`).bind(resultArtifactId).run()
            } catch {}
          }
      } else if (job.kind === 'modify' && resultArtifactId) {
        // modify: 새 버전 생성 (B5: 파일 단위 병합 + 충돌 시 버전 분기)
        const agentFiles = (job as any)._agentFiles as Record<string, string> | undefined
        const saveRes = await saveJobResult(env, jobId, html, title, 'modify', job.prompt, resultArtifactId, { agentFiles })
        resultArtifactId = saveRes.artifactId ?? resultArtifactId
        // B5: 병합된 HTML/파일로 결과 업데이트 (사용자 최신 편집이 보존됨)
        if (saveRes.mergedHtml) html = saveRes.mergedHtml
        // 에이전트가 생성한 다중 파일 저장 (새 버전에)
        // 버전 자체는 이미 생성됨 — 워크스페이스 저장 실패가 작업을 실패시키면 안 됨
        try {
          const mergedFiles = saveRes.mergedFiles
          if (saveRes.versionCreated && mergedFiles && Object.keys(mergedFiles).length > 0) {
            const art: any = await env.DB.prepare('SELECT draft_version_id FROM artifacts WHERE id=?').bind(resultArtifactId).first()
            if (art?.draft_version_id) {
              const { saveWorkspaceToD1 } = await import('../../services/studio-workspace')
              await saveWorkspaceToD1(env.DB, Number(art.draft_version_id), mergedFiles)
              // 멀티 파일 프로젝트로 표시
              try {
                await env.DB.prepare(`UPDATE artifacts SET project_type='multi' WHERE id=?`).bind(resultArtifactId).run()
              } catch {}
            }
          }
        } catch (e) { /* 워크스페이스 저장 실패는 무시 (버전은 이미 생성됨) */ }
      }

      const doneUpdate = await env.DB.prepare(
        `UPDATE artifact_jobs SET status='done', result_html=?, error=NULL, artifact_id=?, seen=0, lease_token=NULL, updated_at=datetime('now')
         WHERE id=? AND status='running' AND lease_token=?`
      ).bind(html, resultArtifactId, jobId, leaseToken).run()
      if ((doneUpdate.meta?.changes ?? 0) === 0) {
        // lease를 잃음 (다른 worker가 가져감) - 결과 버림
        return 'busy'
      }
      // Codex 스타일: job.completed 이벤트
      await logJobEvent(env, jobId, 'job.completed', { artifact_id: resultArtifactId })
      return 'done'
    } catch (e: any) {
      lastErr = '결과 저장 실패: ' + (e.message || '')
    }
  }

  // 4. 실패 기록 (lease 보유 시에만)
  await env.DB.prepare(
    `UPDATE artifact_jobs SET status='failed', error=?, seen=0, lease_token=NULL, updated_at=datetime('now')
     WHERE id=? AND status='running' AND lease_token=?`
  ).bind(`AI 호출 실패 (${maxTries}회): ${lastErr}`.slice(0, 500), jobId, leaseToken).run()
  // Codex 스타일: job.failed 이벤트
  await logJobEvent(env, jobId, 'job.failed', { error: lastErr?.slice(0, 200) })
  return 'failed'
}

// ===== Workflow 단계별 함수들 =====

export type ClaimResult =
  | { status: 'claimed'; leaseToken: string }
  | { status: 'busy' }
  | { status: 'notfound' }

export async function claimJob(env: Env, jobId: number): Promise<ClaimResult> {
  const leaseToken = crypto.randomUUID()
  // unixepoch 기반 만료 시각 (초 단위, 문자열 형식 문제 회피)
  const leaseExpiresEpoch = Math.floor(Date.now() / 1000) + 14 * 60
  const claim = await env.DB.prepare(
    `UPDATE artifact_jobs
     SET status='running', attempts=attempts+1, lease_token=?, lease_expires=?,
         updated_at=datetime('now')
     WHERE id=? AND (
       status='pending'
       OR (status='running' AND lease_expires IS NOT NULL
           AND CAST(lease_expires AS INTEGER) <= unixepoch('now'))
     )`
  ).bind(leaseToken, String(leaseExpiresEpoch), jobId).run()

  if ((claim.meta?.changes ?? 0) === 0) {
    const existing = await env.DB.prepare('SELECT status FROM artifact_jobs WHERE id=?').bind(jobId).first() as any
    if (!existing) return { status: 'notfound' }
    if (existing.status === 'done' || existing.status === 'failed') return { status: 'notfound' }
    return { status: 'busy' }
  }
  // lease 토큰을 job에 저장 (후속 단계에서 사용)
  await env.DB.prepare(`UPDATE artifact_jobs SET lease_token=? WHERE id=?`).bind(leaseToken, jobId).run()
  return { status: 'claimed', leaseToken }
}

export async function generateHtml(env: Env, sysCtx: string, jobId: number, leaseToken: string, workflowInstanceId: string): Promise<{ html: string; title: string; error?: string }> {
  // P0-1: 필수 파라미터 검증
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    throw new Error('INVALID_JOB_ID')
  }
  if (!leaseToken) {
    throw new Error('MISSING_JOB_LEASE')
  }
  if (!workflowInstanceId) {
    throw new Error('MISSING_WORKFLOW_ID')
  }
  let lastErr = '', html = '', title = ''
  const maxTries = 1
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('AI_TIMEOUT')), 180_000)
    try {
      // GPT 94차: 정책 시스템을 통한 정상 호출 (우회 금지)
      // selectModel의 진단 로그가 실패 원인을 기록함
      const { callSingleAssistant } = await import('../ai/routes')
      // P0-2: 전용 HTML 생성 경로 (채팅 파이프라인 우회)
      // P1-1: system/user 프롬프트 분리 (중복 제거)
      const systemPrompt = "너는 HTML 앱 제작 비서이다. 사용자의 요구사항을 완전한 HTML 문서로만 출력한다. 설명, 인사, 마크다운 없이 HTML 코드만 출력한다. <!DOCTYPE html>로 시작한다."
      const genResult = await generateArtifactHtml(env, jobId, leaseToken, workflowInstanceId, systemPrompt, sysCtx, controller.signal)
      const text = genResult.html || ''
      const m = text.match(/\[ARTIFACT_CREATE\]([\s\S]*?)\[\/ARTIFACT_CREATE\]/) || text.match(/```html\n([\s\S]*?)```/)
      if (m) {
        try { const j = JSON.parse(m[1].trim()); html = j.html || m[1]; title = j.title || '' } catch { html = m[1] }
      } else if (text.includes('<html')) {
        html = text
      }
      if (html) break
      lastErr = 'HTML 추출 실패'
    } catch (e: any) {
      const msg = e.message || '호출 오류'
      const code = e.code || 0
      if (e?.name === 'AbortError' || msg.includes('AI_TIMEOUT')) {
        lastErr = 'AI 타임아웃 (180초)'
      } else if (code === 429) {
        lastErr = 'rate_limited (429)'
        break
      } else if (code === 401 || code === 403 || /unknown_persona|empty|too_long/.test(msg)) {
        lastErr = `영구 오류: ${msg.slice(0, 100)}`
        break
      } else {
        lastErr = msg.slice(0, 200)
      }
    } finally {
      clearTimeout(timer)
    }
  }
  return { html, title, error: html ? undefined : lastErr }
}

export async function saveJobResult(
  env: Env, jobId: number, html: string, title: string,
  kind: string, prompt: string, artifactId?: number,
  opts?: { agentFiles?: Record<string, string> }
): Promise<{ artifactId: number | null; versionCreated: boolean; noChange?: boolean; mergedFiles?: Record<string, string>; mergedHtml?: string; conflicts?: string[]; branched?: boolean }> {
  // HTML이 비어있으면 저장 불가 - 명확한 오류
  if (!html || html.trim().length === 0) {
    throw new Error('생성된 HTML이 비어있습니다. AI 응답에서 HTML을 추출하지 못했습니다.');
  }
  const job: any = await env.DB.prepare('SELECT * FROM artifact_jobs WHERE id=?').bind(jobId).first()
  if (!job) {
    throw new Error(`JOB_NOT_FOUND: job ${jobId} 없음`)
  }
  const leaseToken = job?.lease_token
  let resultArtifactId: number | null = job?.artifact_id || artifactId || null

  // GPT 자문: modify는 항상 새 버전 생성, create만 중복 체크
  if (kind === 'modify') {
    const aid = job?.artifact_id || artifactId
    if (!aid) throw new Error('MODIFY_ARTIFACT_ID_REQUIRED')
    resultArtifactId = aid

    // B1/B5: base 스냅샷 (작업 시작 시점의 파일 해시) — 충돌 감지의 기준점
    let baseSnapshot: Record<string, string> | null = null
    const baseVersionId: number | null = (job as any).base_version_id || null
    try {
      if ((job as any).base_snapshot) baseSnapshot = JSON.parse((job as any).base_snapshot)
    } catch { /* 스냅샷 파싱 실패 시 파일 단위 감지 생략 */ }

    // 현재 draft 버전의 파일들 (에이전트 작업 중 사용자가 저장한 최신 상태)
    const art: any = await env.DB.prepare('SELECT draft_version_id, row_revision FROM artifacts WHERE id=?').bind(aid).first()
    let currentFiles: Record<string, string> = {}
    let currentVersionId: number | null = art?.draft_version_id || null
    if (currentVersionId) {
      const { results } = await env.DB.prepare(
        'SELECT file_path, content FROM artifact_files WHERE version_id=?'
      ).bind(currentVersionId).all()
      for (const r of (results || []) as any[]) currentFiles[r.file_path] = r.content
      // 파일 행이 없으면 html_content에서 합성 (구버전/수동 편집 버전)
      if (Object.keys(currentFiles).length === 0) {
        const cv: any = await env.DB.prepare('SELECT html_content FROM artifact_versions WHERE id=?').bind(currentVersionId).first()
        if (cv?.html_content) currentFiles = { 'index.html': cv.html_content }
      }
    }

    const agentFiles = opts?.agentFiles || {}
    // B5: 파일 단위 충돌 감지 — base 이후 사용자가 바꾼 파일을 에이전트도 다르게 바꿨으면 충돌
    const conflicts: string[] = []
    if (baseSnapshot) {
      for (const [path, agentContent] of Object.entries(agentFiles)) {
        const baseHash = baseSnapshot[path]
        const curContent = currentFiles[path]
        if (baseHash && curContent !== undefined) {
          const curHash = await sha256(curContent)
          if (curHash !== baseHash && agentContent !== curContent) {
            conflicts.push(path)
          }
        }
      }
    } else {
      // B1 스냅샷이 없는 구버전 Job — 기존 관문 43 낙관적 락킹 유지 (보수적 실패)
      const jobStart = job.created_at
      if (jobStart) {
        const concurrent: any = await env.DB.prepare(
          'SELECT id FROM artifact_versions WHERE artifact_id=? AND created_at > ? LIMIT 1'
        ).bind(aid, jobStart).first()
        if (concurrent) {
          throw new Error('CONCURRENT_MODIFY: 다른 수정이 먼저 완료되었습니다. 다시 시도하세요.')
        }
      }
    }

    // 병합: 현재 파일 위에 에이전트 수정 덮기 (에이전트가 안 건드린 파일은 사용자 최신 유지)
    const mergedFiles: Record<string, string> = { ...currentFiles }
    for (const [path, content] of Object.entries(agentFiles)) {
      mergedFiles[path] = content
    }
    // 에이전트가 삭제한 파일: base에는 있고 agentFiles에 없음 → 제거
    if (baseSnapshot) {
      for (const path of Object.keys(baseSnapshot)) {
        if (!(path in agentFiles) && path in mergedFiles) {
          delete mergedFiles[path]
        }
      }
    }

    // 미리보기 HTML 재조합 (병합된 파일 기준)
    const { StudioWorkspace } = await import('../../services/studio-workspace')
    const mws = new StudioWorkspace(mergedFiles)
    let mergedHtml = mws.getPreviewHtml()
    if (!mergedHtml) mergedHtml = html // 폴백: 에이전트 원본

    const rev = (art?.row_revision || 0) + 1
    const hash = await sha256(mergedHtml)
    const { results: vmax } = await env.DB.prepare('SELECT MAX(version_no) as m FROM artifact_versions WHERE artifact_id=?').bind(aid).all()
    const vno = ((vmax?.[0] as any)?.m || 0) + 1
    // 같은 내용의 버전이 이미 있으면 건너뜀 (중복 방지)
    const existingVer = await env.DB.prepare('SELECT id FROM artifact_versions WHERE artifact_id=? AND content_sha256=?').bind(aid, hash).first()
    if (!existingVer) {
      // B5: parent_version_id에 분기 기준점 기록 (에이전트가 작업한 base 버전)
      const parentId = baseVersionId || currentVersionId || null
      const vr = await env.DB.prepare(
        `INSERT INTO artifact_versions (artifact_id, version_no, parent_version_id, html_content, content_sha256, change_note, source_type) VALUES (?, ?, ?, ?, ?, ?, 'nova')`
      ).bind(aid, vno, parentId, mergedHtml, hash, prompt.slice(0, 100)).run()
      const newVersionId = Number(vr.meta.last_row_id)
      await env.DB.prepare(`UPDATE artifacts SET draft_version_id=?, row_revision=?, updated_at=datetime('now') WHERE id=?`)
        .bind(newVersionId, rev, aid).run()
      // 관문 72: 오래된 버전 정리 (50개 초과 시, published 제외)
      try {
        const artInfo: any = await env.DB.prepare('SELECT published_version_id FROM artifacts WHERE id=?').bind(aid).first()
        const pubId = artInfo?.published_version_id || 0
        // parent_version_id는 ON DELETE RESTRICT라, 정리 대상을 부모로 가리키는 링크를 먼저 끊어야 한다
        // (안 그러면 버전 체인이 있는 경우 정리 자체가 FOREIGN KEY 오류로 실패한다 — 2026-10-27 발견).
        await env.DB.prepare(
          `UPDATE artifact_versions SET parent_version_id = NULL
           WHERE artifact_id = ? AND parent_version_id IN (
             SELECT id FROM artifact_versions WHERE artifact_id = ? AND id NOT IN (
               SELECT id FROM artifact_versions WHERE artifact_id = ? ORDER BY version_no DESC LIMIT 50
             ) AND id != ?
           )`
        ).bind(aid, aid, aid, pubId).run()
        await env.DB.prepare(
          `DELETE FROM artifact_versions WHERE artifact_id=? AND id NOT IN (
             SELECT id FROM artifact_versions WHERE artifact_id=? ORDER BY version_no DESC LIMIT 50
           ) AND id != ?`
        ).bind(aid, aid, pubId).run()
      } catch {}
      // Codex 스타일: version.committed 이벤트
      await logJobEvent(env, jobId, 'version.committed', { artifact_id: aid, version_no: vno, version_id: newVersionId })
      // B5: 충돌이 있었으면 버전 분기로 명시적 기록 (실패가 아니라 분기 — 양쪽 작업물 모두 보존)
      const branched = conflicts.length > 0
      if (branched) {
        await logJobEvent(env, jobId, 'version.branch', {
          artifact_id: aid, version_no: vno, version_id: newVersionId,
          base_version_id: baseVersionId, conflicts,
          note: '에이전트 작업 중 사용자가 같은 파일을 편집함 — 에이전트 결과를 새 버전으로 분기 저장',
        })
      }
      return { artifactId: resultArtifactId, versionCreated: true, mergedFiles, mergedHtml, conflicts, branched }
    } else {
      // 내용이 동일하면 버전 생성하지 않음 — 검증 게이트: 정직하게 기록
      console.log(`[saveJobResult] modify skipped: identical content for artifact ${aid}`)
      await logJobEvent(env, jobId, 'version.skipped', { artifact_id: aid, reason: 'identical_content', prompt: prompt.slice(0, 100) })
      // 버전 없이 done으로 끝내지 않고, 호출자에게 noChange를 알림
      return { artifactId: resultArtifactId, versionCreated: false, noChange: true }
    }
  } else {
    // create: 버전 존재 여부로 중복 체크 (관문 1 수정)
    // d2bd861부터 job에 artifact_id가 사전 연결되므로, job 기준 체크는 항상 조기 반환함.
    // artifact에 버전이 이미 있으면 중복, 없으면 생성.
    if (resultArtifactId) {
      const verExists = await env.DB.prepare(
        'SELECT id FROM artifact_versions WHERE artifact_id=? LIMIT 1'
      ).bind(resultArtifactId).first() as any
      if (verExists) {
        return { artifactId: resultArtifactId, versionCreated: false }
      }
      // 버전 없음 → 아래에서 새로 생성 (artifact는 이미 있음)
    }
    if (!resultArtifactId) {
      const atitle = title || prompt.slice(0, 30)
      // D1 batch 트랜잭션으로 원자적 생성
      // artifacts INSERT → versions INSERT → draft 포인터 업데이트를 한 트랜잭션으로
      try {
        const ar = await env.DB.prepare(
          `INSERT INTO artifacts (title, type, status, description, row_revision, source_job_id, html_content, owner_email) VALUES (?, 'html', 'draft', ?, 1, ?, ?, ?)`
        ).bind(atitle, prompt.slice(0, 200), jobId, html, (job as any).owner_email ?? null).run()
        resultArtifactId = Number(ar.meta.last_row_id)
      } catch (e: any) {
        // UNIQUE 제약 위반 = 다른 worker가 이미 생성함
        if (e.message?.includes('UNIQUE') || e.message?.includes('unique')) {
          const existing = await env.DB.prepare('SELECT id FROM artifacts WHERE source_job_id=?').bind(jobId).first() as any
          if (existing) {
            resultArtifactId = existing.id
          } else {
            throw e
          }
        } else {
          throw e
        }
      }
    }

    // 버전 생성 (아티팩트 ID 확정 후) — 관문 1: 사전 연결된 artifact도 버전 없으면 생성
    {
      const hash = await sha256(html)
      const vr = await env.DB.prepare(
        `INSERT INTO artifact_versions (artifact_id, version_no, html_content, content_sha256, change_note, source_type) VALUES (?, 1, ?, ?, 'v1 생성', 'nova')`
      ).bind(resultArtifactId, html, hash).run()
      await env.DB.prepare(`UPDATE artifacts SET draft_version_id=? WHERE id=?`).bind(vr.meta.last_row_id, resultArtifactId).run()
    }
  }

  // lease 검증 후 artifact_id 업데이트
  await env.DB.prepare(
    `UPDATE artifact_jobs SET artifact_id=?, result_html=? WHERE id=? AND lease_token=?`
  ).bind(resultArtifactId, html, jobId, leaseToken).run()

  return { artifactId: resultArtifactId, versionCreated: true }
}

export async function markJobDone(env: Env, jobId: number, artifactId: number | null): Promise<void> {
  const job: any = await env.DB.prepare('SELECT lease_token FROM artifact_jobs WHERE id=?').bind(jobId).first()
  await env.DB.prepare(
    `UPDATE artifact_jobs SET status='done', artifact_id=?, seen=0, lease_token=NULL, updated_at=datetime('now')
     WHERE id=? AND status='running' AND lease_token=?`
  ).bind(artifactId, jobId, job?.lease_token).run()
}

export async function markJobFailed(env: Env, jobId: number, error: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE artifact_jobs SET status='failed', error=?, seen=0, lease_token=NULL, updated_at=datetime('now') WHERE id=?`
  ).bind(error.slice(0, 500), jobId).run()
}

