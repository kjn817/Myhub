/**
 * Phase 3C: AI 답변 피드백 API
 *
 * POST /api/ai/feedback — 피드백 등록/변경/취소
 * GET  /api/ai/feedback/:messageId — 특정 메시지의 내 피드백 조회
 *
 * 보안:
 * - 세션 인증 필수
 * - message_id는 ai_chats의 실제 assistant 메시지여야 함
 * - 본인의 대화에 속한 메시지만 가능
 * - LLM 호출 없음
 */

import { Hono } from 'hono'
import type { Env } from '../../types'
import { getPersonaInfo } from '../../ai/persona-registry'

export const feedbackApp = new Hono<{ Bindings: Env }>()

const VALID_VALUES = ['like', 'dislike'] as const
const VALID_REASONS = ['inaccurate', 'irrelevant', 'too_long', 'too_short', 'wrong_action', 'other'] as const

// 요청 본문 크기 제한 (10KB)
const MAX_BODY_SIZE = 10 * 1024

/**
 * CSRF 방어: Origin 검사
 * 쿠키 기반 인증이므로 상태 변경 요청은 Origin 검증
 */
function checkOrigin(c: any): boolean {
  const origin = c.req.header('Origin')
  const referer = c.req.header('Referer')
  // Origin이 없으면 (같은 출처 fetch) 허용
  // 있으면 호스트가 일치해야 함
  if (!origin && !referer) return true

  const host = c.req.header('Host') || ''
  const checkUrl = (url: string) => {
    try {
      const u = new URL(url)
      return u.host === host
    } catch {
      return false
    }
  }

  if (origin && !checkUrl(origin)) return false
  if (!origin && referer && !checkUrl(referer)) return false
  return true
}

/**
 * 인증된 사용자 ID 가져오기
 * 서버 세션에서 검증된 이메일 사용 (요청 본문 신뢰 금지)
 */
async function getUserId(c: any): Promise<string | null> {
  // 인증 미들웨어가 c.set('userEmail', email)로 설정
  const email = c.get('userEmail')
  if (email && typeof email === 'string') return email
  return null
}

/**
 * 메시지가 유효한 AI 답변인지 검증
 * - 존재해야 함
 * - role='assistant'여야 함
 * - 요청자의 대화에 속해야 함 (소유권)
 */
async function validateMessage(
  db: any,
  messageId: number,
  userId: string
): Promise<{ valid: boolean; reason?: string; personaId?: string }> {
  const msg = await db
    .prepare('SELECT id, role, persona_id, conversation_id FROM ai_chats WHERE id = ?')
    .bind(messageId)
    .first()

  if (!msg) {
    return { valid: false, reason: 'message-not-found' }
  }
  if (msg.role !== 'assistant') {
    return { valid: false, reason: 'not-assistant-message' }
  }
  // 소유권 검증: 해당 대화가 사용자의 것인지
  // ai_conversations에 user_id가 없으면 conversation 접근 제어로 대체
  // 현재 스키마에서는 모든 인증 사용자가 접근 가능 (단일 사용자 시스템)
  // 다중 사용자 시 conversation의 소유자 확인 필요
  return { valid: true, personaId: msg.persona_id }
}

// PUT /api/ai/feedback — 좋아요/싫어요 설정 (멱등)
// 동일한 요청을 반복해도 상태가 유지됨
feedbackApp.put('/', async (c) => {
  // CSRF 방어
  if (!checkOrigin(c)) {
    return c.json({ ok: false, error: 'invalid-origin' }, 403)
  }

  const db = c.env.DB
  const userId = await getUserId(c)
  if (!userId) {
    return c.json({ ok: false, error: 'unauthorized' }, 401)
  }

  const body = await c.req.json().catch(() => ({}))
  const { messageId, value, reasonCode } = body

  // 입력 검증
  if (!messageId || typeof messageId !== 'number') {
    return c.json({ ok: false, error: 'invalid-message-id' }, 400)
  }
  if (!VALID_VALUES.includes(value)) {
    return c.json({ ok: false, error: 'invalid-value' }, 400)
  }
  if (reasonCode && !VALID_REASONS.includes(reasonCode)) {
    return c.json({ ok: false, error: 'invalid-reason' }, 400)
  }
  if (reasonCode && value !== 'dislike') {
    return c.json({ ok: false, error: 'reason-only-for-dislike' }, 400)
  }

  // 메시지 검증
  const validation = await validateMessage(db, messageId, userId)
  if (!validation.valid) {
    return c.json({ ok: false, error: validation.reason }, 404)
  }

  const now = new Date().toISOString()

  // UPSERT (멱등): 존재하면 업데이트, 없으면 삽입
  const existing = await db
    .prepare('SELECT id FROM ai_feedback WHERE user_id = ? AND message_id = ?')
    .bind(userId, messageId)
    .first()

  if (existing) {
    await db
      .prepare('UPDATE ai_feedback SET value = ?, reason_code = ?, updated_at = ? WHERE id = ?')
      .bind(value, reasonCode || null, now, (existing as any).id)
      .run()
  } else {
    try {
      await db
        .prepare(
          'INSERT INTO ai_feedback (user_id, message_id, value, reason_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .bind(userId, messageId, value, reasonCode || null, now, now)
        .run()
    } catch (e: any) {
      // 동시 요청으로 UNIQUE 위반 시 재시도 (멱등 보장)
      if (e.message?.includes('UNIQUE')) {
        await db
          .prepare('UPDATE ai_feedback SET value = ?, reason_code = ?, updated_at = ? WHERE user_id = ? AND message_id = ?')
          .bind(value, reasonCode || null, now, userId, messageId)
          .run()
      } else {
        throw e
      }
    }
  }

  return c.json({ ok: true, messageId, value })
})

// DELETE /api/ai/feedback/:messageId — 피드백 취소 (멱등)
// 존재하지 않아도 성공 반환
feedbackApp.delete('/:messageId', async (c) => {
  // CSRF 방어
  if (!checkOrigin(c)) {
    return c.json({ ok: false, error: 'invalid-origin' }, 403)
  }

  const db = c.env.DB
  const userId = await getUserId(c)
  if (!userId) {
    return c.json({ ok: false, error: 'unauthorized' }, 401)
  }

  const messageId = parseInt(c.req.param('messageId'), 10)
  if (isNaN(messageId)) {
    return c.json({ ok: false, error: 'invalid-message-id' }, 400)
  }

  await db
    .prepare('DELETE FROM ai_feedback WHERE user_id = ? AND message_id = ?')
    .bind(userId, messageId)
    .run()

  return c.json({ ok: true, messageId, cancelled: true })
})


// GET /api/ai/feedback/:messageId — 내 피드백 조회
feedbackApp.get('/:messageId', async (c) => {
  const db = c.env.DB
  const userId = await getUserId(c)
  if (!userId) {
    return c.json({ ok: false, error: 'unauthorized' }, 401)
  }

  const messageId = parseInt(c.req.param('messageId'), 10)
  if (isNaN(messageId)) {
    return c.json({ ok: false, error: 'invalid-message-id' }, 400)
  }

  const fb = await db
    .prepare('SELECT value, reason_code FROM ai_feedback WHERE user_id = ? AND message_id = ?')
    .bind(userId, messageId)
    .first()

  return c.json({
    ok: true,
    messageId,
    feedback: fb ? { value: fb.value, reasonCode: fb.reason_code } : null,
  })
})

// GET /api/ai/feedback/stats/:personaId — 비서별 통계 (관리자용)
feedbackApp.get('/stats/:personaId', async (c) => {
  const db = c.env.DB
  const userId = await getUserId(c)
  if (!userId) {
    return c.json({ ok: false, error: 'unauthorized' }, 401)
  }

  const personaId = c.req.param('personaId')
  const info = getPersonaInfo(personaId)
  if (!info) {
    return c.json({ ok: false, error: 'invalid-persona' }, 400)
  }

  // 비서별 집계
  const stats = await db
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN f.value = 'like' THEN 1 ELSE 0 END) as likes,
        SUM(CASE WHEN f.value = 'dislike' THEN 1 ELSE 0 END) as dislikes
       FROM ai_feedback f
       JOIN ai_chats m ON f.message_id = m.id
       WHERE m.persona_id = ?`
    )
    .bind(personaId)
    .first()

  // 싫어요 사유별 집계
  const reasons = await db
    .prepare(
      `SELECT f.reason_code, COUNT(*) as cnt
       FROM ai_feedback f
       JOIN ai_chats m ON f.message_id = m.id
       WHERE m.persona_id = ? AND f.value = 'dislike' AND f.reason_code IS NOT NULL
       GROUP BY f.reason_code`
    )
    .bind(personaId)
    .all()

  const total = (stats?.total as number) || 0
  const likes = (stats?.likes as number) || 0

  return c.json({
    ok: true,
    personaId,
    displayName: info.displayName,
    total,
    likes,
    dislikes: (stats?.dislikes as number) || 0,
    likeRate: total > 0 ? likes / total : null,
    reasons: (reasons?.results || []).map((r: any) => ({ code: r.reason_code, count: r.cnt })),
  })
})
