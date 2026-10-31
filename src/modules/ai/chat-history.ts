// (routes.ts 분리, 2026-10-29 — 동작 변경 없는 순수 구조 분리로 이동된 코드)
// 대화 기록 저장 헬퍼 — /chat과 /orchestrate가 공유
import type { Env } from '../../types'

// 대화 기록 저장 헬퍼 — /chat과 /orchestrate가 공유
// Phase 3C: assistant 메시지 ID 반환 (피드백 연결용)
// Phase 3D: promptVersion 저장 (D5)
export async function saveChatHistory(
  env: Env,
  conversationId: number,
  userContent: string,
  assistantRows: Array<{ personaId: string; text: string; model?: string; promptVersion?: string }>,
): Promise<number[]> {
  const messageIds: number[] = []
  try {
    const now = new Date().toISOString()
    const personaId = assistantRows[0]?.personaId || 'concierge'
    // Phase 3F: prompt_version 저장 (실제 사용한 버전만, 불명확하면 NULL)
    const promptVer = (assistantRows[0]?.promptVersion === 'persona-v1' || assistantRows[0]?.promptVersion === 'legacy')
      ? assistantRows[0]?.promptVersion
      : null
    // 원자성: user + assistant INSERT를 batch 트랜잭션으로 처리
    // 중간 실패 시 전체 롤백 (부분 저장 방지)
    const stmts = [
      env.DB.prepare('INSERT INTO ai_chats (conversation_id, persona_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(conversationId, personaId, 'user', userContent, now),
    ]
    for (const r of assistantRows) {
      const pv = (r.promptVersion === 'persona-v1' || r.promptVersion === 'legacy') ? r.promptVersion : null
      stmts.push(
        env.DB.prepare('INSERT INTO ai_chats (conversation_id, persona_id, role, content, model, prompt_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(conversationId, r.personaId, 'assistant', r.text, r.model ?? null, pv, now)
      )
    }
    let results: any[]
    try {
      results = await env.DB.batch(stmts)
    } catch (e: any) {
      // prompt_version 컬럼 누락 시 구형 스키마로 fallback (batch 유지)
      const msg = String(e?.message || e)
      const isMissingColumn = msg.includes('prompt_version') &&
        (msg.includes('has no column named') || msg.includes('no such column'))
      if (!isMissingColumn) throw e
      // 구형 스키마: prompt_version 없이 저장 (원자성 유지를 위해 batch 사용)
      const legacyStmts = [
        env.DB.prepare('INSERT INTO ai_chats (conversation_id, persona_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(conversationId, personaId, 'user', userContent, now),
      ]
      for (const r of assistantRows) {
        legacyStmts.push(
          env.DB.prepare('INSERT INTO ai_chats (conversation_id, persona_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(conversationId, r.personaId, 'assistant', r.text, r.model ?? null, now)
        )
      }
      results = await env.DB.batch(legacyStmts)
    }
    // assistant 메시지 ID 수집 (첫 번째는 user이므로 제외)
    for (let i = 1; i < results.length; i++) {
      const id = results[i]?.meta?.last_row_id
      if (id) messageIds.push(id)
    }
    // 정리 (200개 유지) - 트랜잭션 외부에서 실행 (실패해도 기록은 유지)
    try {
      await env.DB.prepare(`DELETE FROM ai_chats WHERE conversation_id = ? AND id NOT IN (
          SELECT id FROM ai_chats WHERE conversation_id = ? ORDER BY id DESC LIMIT 200)`).bind(conversationId, conversationId).run()
      await env.DB.prepare('UPDATE ai_conversations SET updated_at = ?, title = CASE WHEN title = ? THEN ? ELSE title END WHERE id = ?')
          .bind(now, '새 대화', userContent.slice(0, 30), conversationId).run()
    } catch { /* 정리 실패는 무시 */ }
  } catch (e: any) {
    // 저장 실패가 응답을 막지 않음, 오류 코드만 기록 (민감정보 제외)
    const errMsg = String(e?.message || '')
    const errCode = errMsg.includes('FOREIGN KEY') ? 'FK_VIOLATION'
      : errMsg.includes('prompt_version') && errMsg.includes('no column') ? 'SCHEMA_MISMATCH'
      : errMsg.includes('CONVERSATION') ? 'CONVERSATION_ERROR'
      : 'DB_WRITE_FAILED'
    console.error(`[saveChatHistory] ${errCode} conversationId=${conversationId}`)
  }
  return messageIds
}
