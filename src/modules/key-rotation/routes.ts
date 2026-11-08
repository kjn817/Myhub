/**
 * 키 로테이션 관리 엔드포인트 (트랙 4, 2026-10-31)
 *
 * POST /api/key-rotation/rotate   { newKey, newKeyConfirm, dryRun?, expectedCensus? }
 * POST /api/key-rotation/rollback { rotatedKey, dryRun?, expectedCensus? }
 *
 * 접근 제어:
 * - 전역 인증 미들웨어(세션) 뒤에 마운트된다. 추가로 userEmail이 없으면 401.
 * - 보호 메모 게이트(트랙 2)와 같은 step-up 집행점(requireProtectedAccess)을
 *   그대로 쓰되, 로테이션은 발급 2분 이내의 신선한 step-up만 허용한다.
 * - ENVIRONMENT가 staging/production이 아니면 403 (fail-closed, 백업과 동일).
 *
 * 키 취급: 새 키는 요청 본문으로만 받고, 응답·로그·DB 어디에도 남기지
 * 않는다. rotate는 확인 입력(newKeyConfirm)이 같은 값이어야 진행한다.
 * 응답은 건수 보고뿐이다. 실제 운영 로테이션 실행은 키 외부 보관 확인 후
 * 별도 절차로만 한다 (docs/backup-restore.md §6.1).
 */
import { Hono } from 'hono'
import type { Env } from '../../types'
import { hasConfiguredPin, requireProtectedAccess } from '../memo/routes'
import { STEP_UP_TTL_MS } from '../auth/routes'
import { stringifyForLog } from '../../lib/redact'
import { rotateEncryptionKey, type RotationCounts } from '../../services/key-rotation'

export const keyRotationApp = new Hono<{ Bindings: Env }>()

const MIN_NEW_KEY_LENGTH = 16
const ROTATION_STEP_UP_MAX_AGE_MS = 2 * 60 * 1000

type StepUpGate =
  | { ok: true }
  | { ok: false; status: number; body: { ok: false; error: string; code: string } }

/** 로테이션용 step-up — 보호 게이트 + 발급 2분 이내 신선도 요구. */
async function requireRotationStepUp(c: any, now: number = Date.now()): Promise<StepUpGate> {
  const gate = await requireProtectedAccess(c)
  if (!gate.ok) return gate
  if (!(await hasConfiguredPin(c))) return { ok: true }
  const until = typeof c.get === 'function' ? c.get('stepUpUntil') : undefined
  if (typeof until !== 'number' || !Number.isFinite(until) || until <= 0) {
    return {
      ok: false,
      status: 403,
      body: { ok: false, error: 'step_up_fresh_required', code: 'STEP_UP_REQUIRED' },
    }
  }
  const ageMs = now - (until - STEP_UP_TTL_MS)
  if (ageMs > ROTATION_STEP_UP_MAX_AGE_MS) {
    return {
      ok: false,
      status: 403,
      body: { ok: false, error: 'step_up_fresh_required', code: 'STEP_UP_REQUIRED' },
    }
  }
  return { ok: true }
}

/** 클라이언트가 보낸 사전 센서스를 검증 가능한 형태만 통과시킨다. */
function sanitizeCensus(v: any): RotationCounts | undefined {
  if (!v || typeof v !== 'object') return undefined
  const keys = ['memo_text', 'memo_block', 'google_token_row', 'locked_file'] as const
  for (const k of keys) {
    if (!Number.isInteger(v[k]) || v[k] < 0) return undefined
  }
  return {
    memo_text: v.memo_text,
    memo_block: v.memo_block,
    google_token_row: v.google_token_row,
    locked_file: v.locked_file,
  }
}

async function handle(c: any, mode: 'rotate' | 'rollback') {
  const env = c.env as Env
  if (env.ENVIRONMENT !== 'staging' && env.ENVIRONMENT !== 'production') {
    return c.json({ error: '키 로테이션을 사용할 수 없는 환경입니다' }, 403)
  }
  const userEmail = c.get('userEmail')
  if (!userEmail) {
    return c.json({ error: '인증 필요' }, 401)
  }
  const gate = await requireRotationStepUp(c)
  if (!gate.ok) return c.json(gate.body, gate.status)

  let body: any = {}
  try {
    body = await c.req.json()
  } catch {
    // JSON 파싱 실패 → 아래 키 검증에서 400
  }
  const keyField = mode === 'rotate' ? 'newKey' : 'rotatedKey'
  const keyMaterial = body?.[keyField]
  if (typeof keyMaterial !== 'string' || keyMaterial.length < MIN_NEW_KEY_LENGTH) {
    return c.json({ error: `${keyField}가 필요합니다 (최소 ${MIN_NEW_KEY_LENGTH}자)` }, 400)
  }
  const confirmMaterial = mode === 'rotate' ? body?.newKeyConfirm : undefined
  if (mode === 'rotate') {
    if (typeof confirmMaterial !== 'string' || confirmMaterial.length === 0) {
      return c.json(
        { ok: false, error: '새 키 확인 입력이 필요합니다 (같은 값을 다시 입력하세요)', code: 'KEY_CONFIRMATION_REQUIRED' },
        400
      )
    }
    if (confirmMaterial !== keyMaterial) {
      return c.json(
        { ok: false, error: '새 키와 확인 입력이 일치하지 않습니다', code: 'KEY_CONFIRMATION_MISMATCH' },
        400
      )
    }
  }
  const dryRun = body?.dryRun === true
  const expectedCensus = sanitizeCensus(body?.expectedCensus)

  const report = await rotateEncryptionKey(
    env,
    mode === 'rotate'
      ? { mode, targetKeyMaterial: keyMaterial, dryRun, expectedCensus }
      : { mode, sourceKeyMaterial: keyMaterial, dryRun, expectedCensus },
  )
  console.log(
    '[KeyRotation] ' +
      stringifyForLog(
        report.ok
          ? { mode, dryRun, ok: true, rotated: report.rotated }
          : { mode, dryRun, ok: false, stage: report.stage, error: report.error },
        // 확인 입력도 비밀 값으로 취급한다 (일치 시 새 키와 같은 값이다)
        typeof confirmMaterial === 'string' ? [keyMaterial, confirmMaterial] : [keyMaterial]
      )
  )
  return c.json(report, report.ok ? 200 : 409)
}

keyRotationApp.post('/rotate', (c) => handle(c, 'rotate'))
keyRotationApp.post('/rollback', (c) => handle(c, 'rollback'))

export default keyRotationApp
