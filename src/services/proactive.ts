/**
 * Proactive 비서
 * Cron으로 실행되어 일정 요약, 리마인드 등을 처리
 */

interface Env {
  DB: D1Database;
}

/**
 * 오늘의 일정 조회
 */
export async function getTodaySchedules(env: Env): Promise<any[]> {
  const today = new Date().toISOString().split('T')[0];
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, title, description, location, start_at, end_at
       FROM schedules
       WHERE date(start_at) = date(?)
       ORDER BY start_at ASC`
    ).bind(today).all();
    return results || [];
  } catch {
    return [];
  }
}

/**
 * 아침 요약 생성 (규칙 기반, AI 없이)
 */
export async function generateMorningSummary(env: Env): Promise<string> {
  const schedules = await getTodaySchedules(env);

  if (schedules.length === 0) {
    return '오늘 일정이 없습니다. 여유로운 하루 보내세요.';
  }

  const lines = schedules.map((s: any, i: number) => {
    const time = s.start_at ? new Date(s.start_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';
    return `${i + 1}. ${time} ${s.title}`;
  });

  return `오늘 일정 ${schedules.length}개가 있습니다:\n${lines.join('\n')}`;
}
