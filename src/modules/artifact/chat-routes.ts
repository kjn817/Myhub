/**
 * 아티팩트 채팅 라우트 — 대화 채널·마이그레이션·검색과 채팅 정리.
 */

import type { Hono } from 'hono'
import type { Env } from '../../types'

export function registerChatRoutes(app: Hono<{ Bindings: Env }>): void {
app.post('/chats', async (c) => {
  try {
    const { artifact_id, session_key, who, content } = await c.req.json()
    if (!who || !content) return c.json({ ok: false, error: 'who/content 필요' }, 400)
    const sliced = content.slice(0, 2000)
    // 관문 68: artifact_id가 있으면 소유권 확인
    if (artifact_id) {
      const ownerEmail = (c as any).get('userEmail') as string
      const ownerCheck: any = await c.env.DB.prepare(
        'SELECT id FROM artifacts WHERE id = ? AND owner_email = ?'
      ).bind(artifact_id, ownerEmail).first()
      if (!ownerCheck) {
        return c.json({ ok: false, error: '권한 없음' }, 403)
      }
    }
    // 10초 내 동일 메시지 중복 방지
    const dup = await c.env.DB.prepare(
      `SELECT id FROM artifact_chats WHERE artifact_id IS ? AND session_key=? AND who=? AND content=? AND created_at > datetime('now', '-10 seconds') LIMIT 1`
    ).bind(artifact_id || null, session_key || 'new', who, sliced).first() as any
    if (dup) return c.json({ ok: true, deduped: true })
    await c.env.DB.prepare(
      `INSERT INTO artifact_chats (artifact_id, session_key, who, content) VALUES (?, ?, ?, ?)`
    ).bind(artifact_id || null, session_key || 'new', who, sliced).run()
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ ok: false, error: '저장 실패' }, 500)
  }
})

// 세션 채팅을 프로젝트로 이관 (GPT 자문: 대화 연속성)
app.post('/chats/migrate', async (c) => {
  try {
    const { from_session, to_artifact_id } = await c.req.json()
    if (!from_session || !to_artifact_id) return c.json({ ok: false, error: 'from_session/to_artifact_id 필요' }, 400)
    const ownerEmail = (c as any).get('userEmail') as string
    // 관문 67: 소유권 확인
    const ownerCheck: any = await c.env.DB.prepare(
      'SELECT id FROM artifacts WHERE id = ? AND owner_email = ?'
    ).bind(to_artifact_id, ownerEmail).first()
    if (!ownerCheck) {
      return c.json({ ok: false, error: '권한 없음' }, 403)
    }
    const toKey = 'p' + to_artifact_id
    // 관문 80 (백로그 트랙 A-2): 이관 대상은 artifact_id IS NULL인 고아 세션 채팅뿐이다.
    // 프로젝트 채팅의 session_key는 'p{artifactId}'로 결정적이라, 이 조건이 없으면
    // from_session='p<타인 artifact id>'만으로 타인 프로젝트의 채팅이 통째로 넘어온다.
    // 이미 아티팩트에 붙은 채팅(자기 것 포함)은 이 경로로 절대 이동하지 않는다.
    // from_session 자체의 소유권은 스키마상 검증 수단이 없어, 세션 키를 아는 것을
    // 사실상 보유로 보는 현행 전제를 유지한다 (고아 채팅 한정).
    await c.env.DB.prepare(
      `UPDATE artifact_chats SET artifact_id=?, session_key=? WHERE session_key=? AND artifact_id IS NULL`
    ).bind(to_artifact_id, toKey, from_session).run()
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ ok: false, error: '이관 실패' }, 500)
  }
})

// 대화 기록 조회
app.get('/chats', async (c) => {
  try {
    const sessionKey = c.req.query('session_key')
    const artifactId = c.req.query('artifact_id')
    const ownerEmail = (c as any).get('userEmail') as string
    // 관문 64: 필터 없이 호출하면 전체 채팅이 노출되므로 session_key/artifact_id 중 하나를 강제한다.
    // (프론트는 항상 session_key를 넘긴다 — agent.html restoreChat/syncChatMsg)
    if (!sessionKey && !artifactId) {
      return c.json({ ok: false, error: 'session_key 또는 artifact_id 필요' }, 400)
    }
    // 관문 64: 소유권 확인 - artifact_id가 있으면 소유권 체크
    if (artifactId) {
      const ownerCheck: any = await c.env.DB.prepare(
        'SELECT id FROM artifacts WHERE id = ? AND (owner_email = ? OR status = ?)'
      ).bind(Number(artifactId), ownerEmail, 'published').first()
      if (!ownerCheck) {
        return c.json({ ok: false, error: '권한 없음' }, 403)
      }
    }
    // session_key가 p{artifactId} 형태면 소유권 체크
    if (sessionKey && sessionKey.startsWith('p')) {
      const aid = Number(sessionKey.slice(1))
      if (aid) {
        const ownerCheck: any = await c.env.DB.prepare(
          'SELECT id FROM artifacts WHERE id = ? AND (owner_email = ? OR status = ?)'
        ).bind(aid, ownerEmail, 'published').first()
        if (!ownerCheck) {
          return c.json({ ok: false, error: '권한 없음' }, 403)
        }
      }
    }
    let sql = 'SELECT who, content, created_at FROM artifact_chats WHERE 1=1'
    const params: any[] = []
    if (sessionKey) { sql += ' AND session_key = ?'; params.push(sessionKey) }
    if (artifactId) { sql += ' AND artifact_id = ?'; params.push(Number(artifactId)) }
    sql += ' ORDER BY created_at ASC LIMIT 100'
    const { results } = await c.env.DB.prepare(sql).bind(...params).all()
    return c.json({ ok: true, data: results || [] })
  } catch (e) {
    return c.json({ ok: false, error: '채팅 내역 조회 실패' }, 500)
  }
})

// 대화 내용 검색 (프로젝트명 + 채팅)
app.get('/search', async (c) => {
  try {
    const q = (c.req.query('q') || '').trim()
    if (!q) return c.json({ ok: true, data: { projects: [], chats: [] } })
    const like = `%${q}%`
    const ownerEmail = (c as any).get('userEmail') as string
    // 관문 61: 소유권 필터 — 남의 초안 제목·채팅 스니펫이 검색에 노출되지 않는다.
    // owner_email IS NULL은 소유권 모델 이전 레거시 행(백필 전까지 허용).
    // artifact_id IS NULL인 고아 채팅은 소유자를 알 수 없어 기존 동작대로 반환한다.
    const { results: projects } = await c.env.DB.prepare(
      `SELECT id, title, status FROM artifacts WHERE title LIKE ? AND (owner_email = ? OR status = 'published' OR owner_email IS NULL) ORDER BY updated_at DESC LIMIT 10`
    ).bind(like, ownerEmail).all()
    const { results: chats } = await c.env.DB.prepare(
      `SELECT c.session_key, c.artifact_id, c.who, substr(c.content, 1, 120) as snippet, a.title as artifact_title
       FROM artifact_chats c LEFT JOIN artifacts a ON a.id = c.artifact_id
       WHERE c.content LIKE ? AND (a.owner_email = ? OR a.status = 'published' OR c.artifact_id IS NULL OR a.owner_email IS NULL) ORDER BY c.created_at DESC LIMIT 20`
    ).bind(like, ownerEmail).all()
    return c.json({ ok: true, data: { projects: projects || [], chats: chats || [] } })
  } catch (e) {
    return c.json({ ok: false, error: '검색 실패' }, 500)
  }
})

// 아티팩트 생성 (v1 버전과 함께)
}

export function registerChatCleanup(app: Hono<{ Bindings: Env }>): void {
app.post('/chats/cleanup', async (c) => {
  try {
    const result = await c.env.DB.prepare(
      `DELETE FROM artifact_chats
       WHERE artifact_id IS NULL
       AND created_at < datetime('now', '-30 days')`
    ).run()
    return c.json({ ok: true, data: { deleted: result.meta?.changes || 0 } })
  } catch (e) {
    return c.json({ ok: false, error: '채팅 정리 실패' }, 500)
  }
})

}
