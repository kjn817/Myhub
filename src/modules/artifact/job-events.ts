/**
 * 아티팩트 잡 이벤트 로깅 (Codex 스타일).
 */

import type { Env } from '../../types'

export async function logJobEvent(env: Env, jobId: number, eventType: string, payload: any = {}): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO artifact_job_events (job_id, event_type, payload) VALUES (?, ?, ?)`
    ).bind(jobId, eventType, JSON.stringify(payload)).run()
  } catch (e) { /* 이벤트 로깅 실패는 무시 */ }
}
