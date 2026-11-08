/**
 * 아티팩트 잡 라우트 — 잡 생성·조회·답변·이벤트와 관리자성 후처리
 * (읽음 표시·모델 설정·취소).
 */

import type { Hono } from 'hono'
import type { Env } from '../../types'
import { MODELS } from '../../services/ai'
import { validateModelProviderPair } from '../../services/ai-models'
import type { ProviderId } from '../../services/provider-registry'
import { sha256 } from './artifact-utils'

export function registerJobRoutes(app: Hono<{ Bindings: Env }>): void {
app.post('/jobs', async (c) => {
  try {
    const { kind, artifact_id, prompt, base_html, client_request_id, provider, model } = await c.req.json()
    if (!prompt) return c.json({ ok: false, error: 'prompt 필요' }, 400)
    // 관문 25: 프롬프트 길이 제한 (10000자)
    if (prompt.length > 10000) {
      return c.json({ ok: false, error: 'prompt가 너무 깁니다 (10000자 제한)' }, 400)
    }
    // 관문 76: provider 검증
    // 2026-10-30: NVIDIA 운영 제외 — 유효 provider에서 제거 (NVIDIA를
    // 지정한 잡 생성은 400). 기존 잡 행의 처리는 job-processor가드가 담당.
    const validProviders: ProviderId[] = ['gemini', 'groq']
    if (provider && !validProviders.includes(provider)) {
      return c.json({ ok: false, error: `provider는 ${validProviders.join('/')} 중 하나여야 합니다` }, 400)
    }
    // 관문 77: base_html 크기 제한 (2MB)
    if (base_html && base_html.length > 2 * 1024 * 1024) {
      return c.json({ ok: false, error: 'base_html이 너무 큽니다 (2MB 제한)' }, 400)
    }
    // 관문 78: model 길이 제한
    if (model && String(model).length > 100) {
      return c.json({ ok: false, error: 'model이 너무 깁니다 (100자 제한)' }, 400)
    }
    // 관문 82: model 실재·활성·provider 일치 검증 (2026-10-30 잠재 경로 하드닝)
    // job-processor는 job.model을 그대로 runStudioAgent에 넘기므로, 레지스트리에
    // 없는 문자열이 저장되면 처리 시점에 가서야 실패한다 — 생성 시점에 거부한다.
    if (model) {
      const v = validateModelProviderPair(String(model), provider, { allowedProviders: validProviders })
      if (!v.ok) {
        if (v.code === 'MODEL_NOT_REGISTERED') {
          return c.json({ ok: false, error: 'unknown model' }, 400)
        }
        if (v.code === 'MODEL_NOT_ACTIVE') {
          return c.json({ ok: false, error: `model not active: ${v.status}` }, 400)
        }
        return c.json({ ok: false, error: 'model/provider mismatch' }, 400)
      }
    }
    // 관문 20: kind 검증
    const validKinds = ['create', 'modify']
    const jobKind = kind || 'create'
    if (!validKinds.includes(jobKind)) {
      return c.json({ ok: false, error: `kind는 ${validKinds.join('/')} 중 하나여야 합니다` }, 400)
    }
    const ownerEmail = (c as any).get('userEmail') as string

    // 관문 79 (백로그 트랙 A-1): artifact_id가 있으면 소유권 확인 — 관문 68(POST /chats)과
    // 동일 패턴(fail-closed). modify 잡은 job-processor가 그 artifact의 draft를 읽고
    // 새 버전을 쓰므로, 타인 artifact_id로 잡을 만들면 타인 프로젝트가 변형된다.
    // 정상 UI(agent.html callAiJob)는 artifact_id로 현재 선택한 자기 프로젝트(curId)만
    // 보내므로, 이 확인이 깨는 정상 경로는 없다. 멱등성 조회보다 먼저 확인해
    // 타인 artifact_id를 담은 요청은 어떤 경우에도 403으로 끝낸다.
    if (artifact_id) {
      const ownerCheck: any = await c.env.DB.prepare(
        'SELECT id FROM artifacts WHERE id = ? AND owner_email = ?'
      ).bind(artifact_id, ownerEmail).first()
      if (!ownerCheck) {
        return c.json({ ok: false, error: '권한 없음' }, 403)
      }
    }

    // 멱등성: 같은 client_request_id면 기존 jobId 반환
    if (client_request_id) {
      const existing: any = await c.env.DB.prepare(
        'SELECT id, status FROM artifact_jobs WHERE owner_email=? AND client_request_id=?'
      ).bind(ownerEmail, client_request_id).first()
      if (existing) {
        return c.json({ ok: true, data: { jobId: existing.id, deduped: true } }, 202)
      }
    }
    {
      const dupe: any = await c.env.DB.prepare(
        `SELECT id, status FROM artifact_jobs
         WHERE owner_email=? AND kind=? AND prompt=? AND artifact_id IS ?
           AND status IN ('pending','running','awaiting_input')
           AND created_at > datetime('now', '-60 seconds')
         ORDER BY id DESC LIMIT 1`
      ).bind(ownerEmail, jobKind, prompt, artifact_id || null).first()
      if (dupe) {
        return c.json({ ok: true, data: { jobId: dupe.id, deduped: true } }, 202)
      }
    }

    const result = await c.env.DB.prepare(
      `INSERT INTO artifact_jobs (kind, artifact_id, prompt, base_html, status, owner_email, client_request_id, provider, model) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
    ).bind(jobKind, artifact_id || null, prompt, base_html || null, ownerEmail, client_request_id || null, provider || null, model || null).run()
    const jobId = Number(result.meta.last_row_id)

    // 프로젝트=대화: 새 대화면 artifact(프로젝트)를 즉시 생성 (앱 성공 여부와 무관)
    let finalArtifactId = artifact_id || null
    if (!finalArtifactId) {
      const title = prompt.slice(0, 30).replace(/( 만들어줘| 만들어주세요| 해줘| 해주세요| 부탁해).*$/, '') || '새 대화'
      const artResult = await c.env.DB.prepare(
        `INSERT INTO artifacts (title, type, status, description, row_revision, html_content, owner_email) VALUES (?, 'chat', 'draft', ?, 1, '', ?)`
      ).bind(title, prompt.slice(0, 100), ownerEmail).run()
      finalArtifactId = Number(artResult.meta.last_row_id)
      // job에 artifact_id 연결
      await c.env.DB.prepare(`UPDATE artifact_jobs SET artifact_id=? WHERE id=?`).bind(finalArtifactId, jobId).run()
      // 사용자 메시지를 채팅에 저장 (관문 4: 중복 방지 — 10초 내 동일 메시지 있으면 스킵)
      // 관문 9: session_key를 p${artifactId}로 직접 저장 (프론트 이관 불필요)
      const dupMsg = await c.env.DB.prepare(
        `SELECT id FROM artifact_chats WHERE artifact_id=? AND who='user' AND content=? AND created_at > datetime('now', '-10 seconds') LIMIT 1`
      ).bind(finalArtifactId, prompt.slice(0, 5000)).first() as any
      if (!dupMsg) {
        await c.env.DB.prepare(
          `INSERT INTO artifact_chats (artifact_id, session_key, who, content) VALUES (?, ?, 'user', ?)`
        ).bind(finalArtifactId, `p${finalArtifactId}`, prompt.slice(0, 5000)).run()
      }
    }

    // B1: modify 작업은 시작 시점의 파일 스냅샷+해시를 저장 (B5 충돌 감지/버전 분기의 기준점)
    // ACP 원칙: 브라우저(에디터)가 파일의 주인, 에이전트는 스냅샷을 읽고 diff를 내놓는다
    if (jobKind === 'modify' && finalArtifactId) {
      try {
        const dart: any = await c.env.DB.prepare(
          'SELECT draft_version_id FROM artifacts WHERE id=?'
        ).bind(finalArtifactId).first()
        if (dart?.draft_version_id) {
          const { results: snapFiles } = await c.env.DB.prepare(
            'SELECT file_path, content FROM artifact_files WHERE version_id=?'
          ).bind(dart.draft_version_id).all()
          const snap: Record<string, string> = {}
          for (const r of (snapFiles || []) as any[]) {
            snap[r.file_path] = await sha256(String(r.content || ''))
          }
          await c.env.DB.prepare(
            'UPDATE artifact_jobs SET base_version_id=?, base_snapshot=? WHERE id=?'
          ).bind(dart.draft_version_id, JSON.stringify(snap), jobId).run()
        }
      } catch (e) { /* 스냅샷 실패는 작업 생성을 막지 않음 */ }
    }

    // Queue 기반 비동기 처리 (v2 'Failed to fetch' 수정 — 2026-10-16)
    // 직접 모드(잡 프로세서를 HTTP 핸들러에서 await)는 응답이 에이전트 완료까지 블로킹되어
    // Queue 기반 비동기 처리 (v2 'Failed to fetch' 수정 — 2026-10-16)
    // 직접 모드(잡 프로세서를 HTTP 핸들러에서 await)는 응답이 에이전트 완료까지 블로킹되어
    // 수 분간 유휴 상태가 되면 브라우저가 연결을 끊고 fetch()가 TypeError: Failed to fetch를 throw.
    // Queue Consumer(src/index.ts, 15분 예산)가 잡을 처리하므로 즉시 202 반환.
    // 관문 29: Workflow 제거됨 — Queue가 정답 (waitUntil 30초 제한으로 장시간 작업 불가)
    try {
      await (c.env as any).ARTIFACT_QUEUE.send({ jobId })
    } catch (e: any) {
      await c.env.DB.prepare(
        `UPDATE artifact_jobs SET status='failed', error=?, seen=0 WHERE id=?`
      ).bind('큐 전송 실패: ' + (e.message || 'unknown').slice(0, 200), jobId).run()
      return c.json({ ok: false, jobId, error: '큐 전송 실패' }, 500)
    }
    return c.json({ ok: true, data: { jobId } }, 202)
  } catch (e) {
    return c.json({ ok: false, error: '작업 생성 실패' }, 500)
  }
})

// 작업 상태 조회
app.get('/jobs/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const ownerEmail = (c as any).get('userEmail') as string
    const job = await c.env.DB.prepare('SELECT * FROM artifact_jobs WHERE id = ? AND owner_email = ?').bind(id, ownerEmail).first()
    if (!job) return c.json({ ok: false, error: '작업 없음' }, 404)
    return c.json({ ok: true, data: job })
  } catch (e) {
    return c.json({ ok: false, error: '작업 상태 조회 실패' }, 500)
  }
})

// A1: ask_question 답변 제출 → 작업 재개
app.post('/jobs/:id/answer', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const ownerEmail = (c as any).get('userEmail') as string
    const body = await c.req.json().catch(() => ({}))
    const answers = body.answers
    if (!Array.isArray(answers) || answers.length === 0) {
      return c.json({ ok: false, error: 'answers가 필요합니다' }, 400)
    }
    // 답변 형식 검증: [{id, answer}]
    for (const a of answers) {
      if (!a || typeof a.id !== 'string' || typeof a.answer !== 'string') {
        return c.json({ ok: false, error: 'answer 형식이 잘못됐습니다' }, 400)
      }
      if (a.answer.length > 2000) {
        return c.json({ ok: false, error: '답변이 너무 깁니다 (2000자 제한)' }, 400)
      }
    }
    const job: any = await c.env.DB.prepare(
      'SELECT * FROM artifact_jobs WHERE id = ? AND owner_email = ?'
    ).bind(id, ownerEmail).first()
    if (!job) return c.json({ ok: false, error: '작업 없음' }, 404)
    if (job.status !== 'awaiting_input') {
      return c.json({ ok: false, error: '입력 대기 중인 작업이 아닙니다' }, 400)
    }
    let ps: any = {}
    try { ps = JSON.parse(job.pending_state || '{}') } catch {}
    // 질문 ID와 매칭되는 답변만 허용
    const questionIds = new Set((ps.questions || []).map((q: any) => q.id))
    const validAnswers = answers.filter((a: any) => questionIds.has(a.id))
    if (validAnswers.length === 0) {
      return c.json({ ok: false, error: '유효한 답변이 없습니다' }, 400)
    }
    ps.answers = validAnswers
    await c.env.DB.prepare(
      `UPDATE artifact_jobs SET status='pending', pending_state=?, updated_at=datetime('now') WHERE id=?`
    ).bind(JSON.stringify(ps), id).run()
    // Queue로 재개 (claim이 pending을 획득)
    try {
      await (c.env as any).ARTIFACT_QUEUE.send({ jobId: id })
    } catch (e: any) {
      await c.env.DB.prepare(
        `UPDATE artifact_jobs SET status='failed', error=? WHERE id=?`
      ).bind('큐 전송 실패: ' + (e.message || 'unknown').slice(0, 200), id).run()
      return c.json({ ok: false, error: '큐 전송 실패' }, 500)
    }
    return c.json({ ok: true, data: { jobId: id } }, 202)
  } catch (e) {
    return c.json({ ok: false, error: '답변 제출 실패' }, 500)
  }
})

// Job 이벤트 스트림 조회 (Codex 스타일)
app.get('/jobs/:id/events', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const ownerEmail = (c as any).get('userEmail') as string
    const since = Number(c.req.query('since') || 0)
    // 관문 65: 소유권 확인
    const ownerCheck: any = await c.env.DB.prepare(
      'SELECT id FROM artifact_jobs WHERE id = ? AND owner_email = ?'
    ).bind(id, ownerEmail).first()
    if (!ownerCheck) {
      return c.json({ ok: false, error: '권한 없음' }, 403)
    }
    const { results } = await c.env.DB.prepare(
      'SELECT id, event_type, payload, created_at FROM artifact_job_events WHERE job_id=? AND id>? ORDER BY id ASC LIMIT 100'
    ).bind(id, since).all()
    return c.json({ ok: true, data: results || [] })
  } catch (e) {
    return c.json({ ok: false, error: '작업 이벤트 조회 실패' }, 500)
  }
})

// 진행 중인 작업 + 미확인 완료 작업 목록
app.get('/jobs', async (c) => {
  try {
    const ownerEmail = (c as any).get('userEmail') as string
    // 멈춘 잡 정리 (목록 조회 시점에 만료된 잡을 실패로 확정한다)
    try {
      const { reapStaleJobs } = await import('./job-processor')
      await reapStaleJobs(c.env)
    } catch (e) { /* 정리 실패는 목록 조회를 막지 않음 */ }
    const { results } = await c.env.DB.prepare(
      `SELECT j.*, a.title as artifact_title FROM artifact_jobs j
       LEFT JOIN artifacts a ON a.id = j.artifact_id
       WHERE j.owner_email = ? AND (j.status IN ('pending','running') OR (j.status IN ('done','failed') AND j.seen = 0))
       ORDER BY j.created_at DESC LIMIT 20`
    ).bind(ownerEmail).all()
    return c.json({ ok: true, data: results || [] })
  } catch (e) {
    return c.json({ ok: false, error: '내 작업 목록 조회 실패' }, 500)
  }
})

}

export function registerJobAdminRoutes(app: Hono<{ Bindings: Env }>): void {
app.post('/jobs/:id/seen', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const ownerEmail = (c as any).get('userEmail') as string
    await c.env.DB.prepare(`UPDATE artifact_jobs SET seen=1 WHERE id=? AND owner_email=?`).bind(id, ownerEmail).run()
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ ok: false, error: '처리 실패' }, 500)
  }
})

// AI 모델 변경 (레지스트리 활성 모델만 허용)
// 2026-10-30: 이전에는 NVIDIA 모델만 허용하던 엔드포인트였다 — NVIDIA 운영
// 제외로 정반대가 됐다. 하드코딩 목록 대신 MODELS 레지스트리로 검증한다:
// 미등록 모델은 400, 비활성 모델(NVIDIA 전부 포함)도 400. 중복 id
// (openai/gpt-oss-20b: groq active·nvidia deprecated)는 활성 후보가 하나라도
// 있으면 허용한다 (POST /jobs 관문 82와 같은 판정 방식).
app.post('/model', async (c) => {
  try {
    const { model } = await c.req.json()
    const candidates = MODELS.filter((m) => m.id === model)
    if (candidates.length === 0) {
      return c.json({ ok: false, error: '허용되지 않은 모델' }, 400)
    }
    if (!candidates.some((m) => m.status === 'active')) {
      return c.json({ ok: false, error: `model not active: ${candidates[0].status}` }, 400)
    }
    await c.env.DB.prepare(
      "UPDATE ai_settings SET value=? WHERE key='model.code'"
    ).bind(model).run()
    return c.json({ ok: true, model })
  } catch (e) {
    return c.json({ ok: false, error: '변경 실패' }, 500)
  }
})

// 작업 취소 (소유자만, pending/running/awaiting_input 상태에서만)
// 관문 81 (백로그 트랙 A-3): awaiting_input도 실제로 취소할 수 있게 한다.
// 이전에는 UPDATE 대상이 pending/running뿐이라 awaiting_input 잡은 0건 변경인데도
// {ok:true}를 반환하는 거짓 성공이었다. 질문 대기 중인 잡을 버릴 방법이 답변뿐이면
// 사용자는 원하지 않는 작업을 강제 재개해야 하므로, 취소 가능 쪽이 옳다:
// - 클라이언트: pollJob이 awaiting_input를 감지해 질문 팝업을 띄우는 동안에도
//   working 행의 취소 버튼(currentJobId)이 그대로 노출·호출된다 (agent.html).
// - 안전성: 큐 claim(job-processor)은 pending/만료된 running만 집으므로
//   failed로 전이된 잡이 다시 실행되지 않고, /answer는 awaiting_input가 아니면
//   400이라 취소 후 답변 재개도 불가능하다.
// 응답-상태 일치: UPDATE 변경이 0건이면 (조회 후 상태가 바뀐 경합) 성공으로
// 보고하지 않고 400을 반환한다.
app.post('/jobs/:id/cancel', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const ownerEmail = (c as any).get('userEmail') as string

    // 소유권 + 상태 확인
    const job: any = await c.env.DB.prepare(
      'SELECT status FROM artifact_jobs WHERE id=? AND owner_email=?'
    ).bind(id, ownerEmail).first()
    if (!job) return c.json({ ok: false, error: '작업 없음' }, 404)
    if (job.status === 'done' || job.status === 'failed') {
      return c.json({ ok: false, error: '이미 완료된 작업' }, 400)
    }

    // 취소 상태로 변경 (lease 무효화, 질문 대기 상태는 폐기)
    const result = await c.env.DB.prepare(
      `UPDATE artifact_jobs SET status='failed', error='사용자 취소', seen=0, lease_token=NULL, pending_state=NULL, updated_at=datetime('now')
       WHERE id=? AND owner_email=? AND status IN ('pending','running','awaiting_input')`
    ).bind(id, ownerEmail).run()
    if ((result.meta?.changes ?? 0) === 0) {
      return c.json({ ok: false, error: '이미 완료된 작업' }, 400)
    }

    return c.json({ ok: true })
  } catch (e) {
    return c.json({ ok: false, error: '취소 실패' }, 500)
  }
})

// 고아 채팅 정리 (관문 24)
}
