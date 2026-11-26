import type { Env } from '../../types'
import { secretsEqual } from '../../services/channel-gateway'

export type ProbeAuthResult = 'ok' | 'disabled' | 'unauthorized'

/**
 * 프로브 전용 토큰 인증 (3기둥 합성 프로브, 2026-11-26).
 *
 * - 크론 프로브는 세션 쿠키를 보낼 수 없어 (HttpOnly 쿠키 추출 불가,
 *   PIN·쿠키 파일 전부 부재 — 2026-11-08부터 73회 연속 ANOMALY) 별도
 *   Bearer 자격 증명을 둔다. Worker 시크릿 PROBE_TOKEN에 저장한다.
 * - 허용 범위: POST /api/ai/chat 딱 하나. 다른 경로·메서드에는 무효다.
 *   프로브가 부르는 것은 비서 실호출(Privacy Engine·Clef 검증)뿐이다.
 * - Authorization: Bearer <PROBE_TOKEN>, 상수 시간 비교
 *   (relayAuth·verifyWebhookSecret과 같은 패턴).
 * - PROBE_TOKEN 미설정 시 'disabled' — 비활성화, fail-closed.
 * - 'unauthorized'일 때는 호출자가 세션 검사를 그대로 받는다
 *   (미들웨어가 fall-through한다). 토큰이 틀려도 유효한 세션은
 *   정상 로그인으로 동작한다 — 정상 경로 무변경.
 */
export function probeAuth(
  env: Env,
  method: string,
  path: string,
  authHeader: string | null | undefined,
): ProbeAuthResult {
  const configured = env.PROBE_TOKEN
  if (!configured) return 'disabled'
  if (method !== 'POST' || path !== '/api/ai/chat') return 'unauthorized'
  const m = /^Bearer\s+(.+)$/i.exec(authHeader ?? '')
  if (!m) return 'unauthorized'
  return secretsEqual(m[1].trim(), configured) ? 'ok' : 'unauthorized'
}
