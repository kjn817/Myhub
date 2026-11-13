/**
 * 아티팩트 잡 생성·저장 — claim, HTML 생성, 결과 저장(버전 커밋), 완료/실패 표시.
 * job-processor(실행 본체)와 job-routes(수동 claim)가 공유한다.
 */

import type { Env } from '../../types'
import { generateArtifactHtml } from './generate-html'
import { logJobEvent } from './job-events'
import { sha256 } from './artifact-utils'

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
      } catch (e) {
        // 버전 정리 실패 시 오래된 버전이 조용히 잔류한다 — 관측 가능하게 한다.
        const errorType = e instanceof Error ? e.name : 'Unknown'
        const errorMessage = e instanceof Error ? e.message.slice(0, 200) : 'Unknown'
        console.warn('ARTIFACT_VERSION_PRUNE_FAILED', { artifactId: aid, errorType, errorMessage })
      }
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

