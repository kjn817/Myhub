/**
 * 아티팩트 잡 실행 본체 — lease 기반 원자적 claim으로 중복 실행을 막고,
 * 스튜디오 에이전트를 실행해 결과를 저장한다. 멈춘 잡은 시작 시 정리한다.
 */

import type { Env } from '../../types'
import { validateModelProviderPair } from '../../services/ai-models'
import { saveJobResult } from './job-generation'
import { logJobEvent } from './job-events'
import { sha256 } from './artifact-utils'

export { logJobEvent } from './job-events'
export { claimJob, generateHtml, saveJobResult, markJobDone, markJobFailed } from './job-generation'

export const STALE_PENDING_MINUTES = 60
export const STALE_RUNNING_MINUTES = 20
export const STALE_JOB_ERROR = 'STALE_JOB_EXPIRED: 장시간 진행이 없어 자동 종료했습니다 (실행이 시작되지 않았거나 중단된 작업입니다. 다시 요청해주세요)'

/** 멈춘 잡(pending 60분·lease 만료 running 20분)을 실패로 정리한다. */
export async function reapStaleJobs(env: Env, opts?: { excludeJobId?: number }): Promise<number> {
  const exclude = opts?.excludeJobId ?? -1
  const stale = await env.DB.prepare(
    `SELECT id FROM artifact_jobs
     WHERE id != ? AND (
       (status='pending' AND updated_at <= datetime('now', '-${STALE_PENDING_MINUTES} minutes'))
       OR (status='running'
           AND (lease_expires IS NULL OR CAST(lease_expires AS INTEGER) <= unixepoch('now'))
           AND updated_at <= datetime('now', '-${STALE_RUNNING_MINUTES} minutes'))
     )`
  ).bind(exclude).all<{ id: number }>()
  const ids = (stale.results || []).map((r) => r.id)
  if (ids.length === 0) return 0
  let reaped = 0
  for (const id of ids) {
    const upd = await env.DB.prepare(
      `UPDATE artifact_jobs
       SET status='failed', error=?, seen=0, lease_token=NULL, pending_state=NULL, updated_at=datetime('now')
       WHERE id=? AND status IN ('pending','running')`
    ).bind(STALE_JOB_ERROR, id).run()
    if ((upd.meta?.changes ?? 0) > 0) {
      reaped++
      await logJobEvent(env, id, 'job.failed', { error: STALE_JOB_ERROR.slice(0, 200), reaped: true })
    }
  }
  return reaped
}

export type JobOutcome = 'done' | 'failed' | 'notfound' | 'busy' | 'awaiting_input'

/**
 * Artifact 작업 처리 (Queue Consumer에서 호출)
 * - 원자적 claim으로 중복 실행 방지
 * - AI 호출 타임아웃 적용
 * - 결과 저장의 멱등성 보장
 */
export async function processArtifactJob(env: Env, jobId: number): Promise<JobOutcome> {
  // 0. 멈춘 잡 정리 (자기 자신은 제외)
  try {
    await reapStaleJobs(env, { excludeJobId: jobId })
  } catch (e) { /* 정리 실패는 본 실행을 막지 않음 */ }

  // 1. Lease 기반 원자적 claim
  // - pending이거나 lease가 만료된 running 작업만 획득 가능
  // - 실행 토큰으로 소유권 증명
  const leaseToken = crypto.randomUUID()
  // lease_expires는 claimJob과 같은 unixepoch(초) 문자열로 통일한다 (트랙 5, 2026-11-01).
  // 이전에는 ISO 문자열('2026-..T..Z')을 저장하고 datetime('now')('2026-.. ..')와
  // 문자열 비교를 했는데, 같은 날짜 안에서는 'T'(84) > ' '(32)라 만료된 lease가
  // 영원히 만료로 판정되지 않아, 실행 중 죽은 잡이 그날 내내 'running'에 갇혔다
  // (큐 재시도는 busy만 받다가 소진되고 잡은 영구 중단 — 실DB 재현으로 확정).
  // CAST(... AS INTEGER)는 기존 ISO 행을 연도 숫자(2026)로 읽어 즉시 만료로
  // 판정하므로, 구형 행도 이관 없이 재획득 대상이 된다.
  const leaseExpires = String(Math.floor(Date.now() / 1000) + 14 * 60) // 14분 (Queue 15분 제한보다 짧게)
  const claim = await env.DB.prepare(
    `UPDATE artifact_jobs
     SET status='running', attempts=attempts+1, lease_token=?, lease_expires=?, updated_at=datetime('now')
     WHERE id=? AND (status='pending' OR (status='running' AND (lease_expires IS NULL OR CAST(lease_expires AS INTEGER) <= unixepoch('now'))))`
  ).bind(leaseToken, leaseExpires, jobId).run()

  if ((claim.meta?.changes ?? 0) === 0) {
    const existing = await env.DB.prepare('SELECT status FROM artifact_jobs WHERE id=?').bind(jobId).first() as any
    if (!existing) return 'notfound'
    if (existing.status === 'done' || existing.status === 'failed') return 'done'
    return 'busy'
  }

  const job: any = await env.DB.prepare('SELECT * FROM artifact_jobs WHERE id=?').bind(jobId).first()
  if (!job) return 'notfound'
  const claimedAt = Date.now()

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
  // 트랙 5: modify 결과가 기존 내용과 동일해 버전이 생성되지 않은 경우의 표시.
  // 가짜 성공(done)으로 끝내면 사용자는 "수정 완료"로 오인하고 버전 이력에는
  // 아무것도 남지 않는다 — §4에서 무변경 사유로 실패 기록한다.
  let modifyNoChange = false
  const maxTries = 2
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      const { runStudioAgent } = await import('../../services/studio-agent')
      // Job에 저장된 모델 사용 (없으면 전역 설정 폴백)
      let modelId = (job as any).model
      let provider = (job as any).provider
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
      const pair = validateModelProviderPair(modelId, provider, { allowedProviders: ['gemini', 'groq'] })
      if (!pair.ok) {
        lastErr = pair.error
        await logJobEvent(env, jobId, 'model.validation_failed', {
          model: modelId,
          provider: provider ?? null,
          error: pair.error.slice(0, 200),
        })
        break
      }
      provider = pair.provider
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
      // 자동 검증 + 1회 수리 (studio-verify): 정적 검사(태그 균형·참조·id 중복)를
      // 통과하지 못하면 실패 항목만 에이전트에게 돌려보내 고치게 한다.
      // 검증 자체의 내부 오류는 잡을 실패시키지 않고 이벤트로만 남긴다.
      if (html && Object.keys(agentResult.files).length > 0) {
        try {
          const { verifyAndMaybeRepair } = await import('../../services/studio-verify')
          const outcome = await verifyAndMaybeRepair(agentResult.files, {
            elapsedMs: Date.now() - claimedAt,
            repair: async (currentFiles, failures) => {
              await logJobEvent(env, jobId, 'job.repairing', {
                failures: failures.slice(0, 5).map((f) => ({ file: f.file || '', detail: f.detail })),
              })
              const failList = failures.map((f) => `- ${f.file ? `${f.file}: ` : ''}${f.detail}`).join('\n')
              const repairCtx = `${sysCtx}\n\n[자동 검증 실패 — 아래 문제만 고쳐서 다시 완성하세요. 지적되지 않은 부분은 건드리지 마세요.]\n${failList}`
              const rr = await runStudioAgent(env, repairCtx, {
                maxTurns: 3,
                provider,
                model: modelId,
                jobId,
                initialFiles: currentFiles,
                wallClockBudgetMs: 4 * 60_000,
                onFileWrite,
              })
              return rr.ok && rr.files && Object.keys(rr.files).length > 0 ? rr.files : null
            },
          })
          await logJobEvent(env, jobId, 'job.verified', {
            score: outcome.report.score,
            passed: outcome.report.passed,
            total: outcome.report.total,
            repaired: outcome.repaired,
            ...(outcome.beforeScore !== undefined ? { beforeScore: outcome.beforeScore } : {}),
            ...(outcome.repairDiscarded ? { repairDiscarded: true } : {}),
            failures: outcome.report.failures.slice(0, 5).map((f) => ({ file: f.file || '', detail: f.detail })),
            limitations: outcome.report.limitations,
          })
          if (outcome.repaired) {
            const beforeFiles = agentResult.files
            agentResult.files = outcome.files
            for (const [filePath, newContent] of Object.entries(outcome.files)) {
              if (beforeFiles[filePath] === newContent) continue
              const payload: any = { file_path: filePath }
              if (typeof beforeFiles[filePath] === 'string') {
                const diff = unifiedDiff(beforeFiles[filePath], newContent, filePath)
                if (diff) payload.diff = diff.slice(0, 20000)
              }
              await logJobEvent(env, jobId, 'file.changed', payload)
            }
            const wsRepaired = new StudioWorkspace(outcome.files)
            html = wsRepaired.getPreviewHtml() || html
          }
        } catch (e) {
          await logJobEvent(env, jobId, 'job.verified', { score: -1, error: 'verify_internal_error' }).catch(() => {})
        }
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
      } else if (job.kind === 'create' && resultArtifactId) {
        // 트랙 5 (2026-11-01): POST /jobs가 프로젝트=대화 모델로 artifact를 먼저
        // 만들고 job에 연결하므로(d2bd861~), 프로덕션 create 잡은 항상 이 분기다.
        // 이전에는 !resultArtifactId 분기와 modify 분기 어디에도 걸리지 않아
        // 버전·파일이 전혀 생성되지 않은 채 잡만 done이 됐다 (실DB 재현으로 확정 —
        // tests/integration/studio-job-save-real.test.ts T1).
        // saveJobResult의 create 분기가 "버전 있으면 중복, 없으면 v1 생성"을
        // 이미 구현하고 있으므로 그쪽에 위임한다 (재시도 멱등성 유지).
        const agentFiles = (job as any)._agentFiles as Record<string, string> | undefined
        const saveRes = await saveJobResult(env, jobId, html, title, 'create', job.prompt, resultArtifactId, { agentFiles })
        resultArtifactId = saveRes.artifactId ?? resultArtifactId
        try {
          if (saveRes.versionCreated && agentFiles && Object.keys(agentFiles).length > 0) {
            const art: any = await env.DB.prepare('SELECT draft_version_id FROM artifacts WHERE id=?').bind(resultArtifactId).first()
            if (art?.draft_version_id) {
              const { saveWorkspaceToD1 } = await import('../../services/studio-workspace')
              await saveWorkspaceToD1(env.DB, Number(art.draft_version_id), agentFiles)
              try {
                await env.DB.prepare(`UPDATE artifacts SET project_type='multi' WHERE id=?`).bind(resultArtifactId).run()
              } catch {}
            }
          }
        } catch (e) { /* 워크스페이스 저장 실패는 무시 (버전은 이미 생성됨) */ }
      } else if (job.kind === 'modify' && resultArtifactId) {
        // modify: 새 버전 생성 (B5: 파일 단위 병합 + 충돌 시 버전 분기)
        const agentFiles = (job as any)._agentFiles as Record<string, string> | undefined
        const saveRes = await saveJobResult(env, jobId, html, title, 'modify', job.prompt, resultArtifactId, { agentFiles })
        resultArtifactId = saveRes.artifactId ?? resultArtifactId
        // 트랙 5: 동일 내용이라 버전이 생략된 경우 — 아래 done 처리를 건너뛰고
        // §4에서 무변경 사유로 실패 기록한다 (version.skipped 이벤트는
        // saveJobResult가 이미 남긴다).
        if (saveRes.noChange) modifyNoChange = true
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

      if (modifyNoChange) {
        // 버전이 없는데 done으로 표시하면 "수정됐는데 이력에 없음"이 된다.
        // done 처리를 하지 않고 §4 실패 기록으로 넘긴다.
        lastErr = '변경 사항이 없어 새 버전을 만들지 않았습니다 (에이전트 결과가 기존 내용과 동일합니다)'
      } else {
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
      }
    } catch (e: any) {
      lastErr = '결과 저장 실패: ' + (e.message || '')
    }
  }

  // 4. 실패 기록 (lease 보유 시에만)
  // 무변경은 AI 호출 실패가 아니므로 접두사 없이 사유 그대로 기록한다.
  const failError = modifyNoChange ? lastErr : `AI 호출 실패 (${maxTries}회): ${lastErr}`
  await env.DB.prepare(
    `UPDATE artifact_jobs SET status='failed', error=?, seen=0, lease_token=NULL, updated_at=datetime('now')
     WHERE id=? AND status='running' AND lease_token=?`
  ).bind(failError.slice(0, 500), jobId, leaseToken).run()
  // Codex 스타일: job.failed 이벤트
  await logJobEvent(env, jobId, 'job.failed', { error: lastErr?.slice(0, 200) })
  return 'failed'
}

// ===== Workflow 단계별 함수들 =====
