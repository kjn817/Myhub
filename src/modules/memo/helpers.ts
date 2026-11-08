/**
 * 메모 모듈 공용 헬퍼 — 태그·제목 추출, 잠금 해제 step-up, 보호 게이트,
 * FTS 검색 쿼리, 첨부 저장. routes·routes-lock·routes-files·routes-ai가 공유한다.
 */

import { verifyPin, isValidPin, isValidB64, checkRateLimit, grantStepUp } from '../auth/routes'
import type { Env } from '../../types'
import { storageUpload } from '../../services/storage'

// 태그 추출 (#한글 #abc_123) — memos식
export function extractTags(text: string): string[] {
  const set = new Set<string>()
  for (const m of text.matchAll(/#([가-힣a-zA-Z0-9_]+)/g)) set.add(m[1])
  return [...set]
}

/**
 * 메모 제목 추출 — 본문 첫 줄을 제목으로 쓸 수 있을 때만(본문이 더 있을 때) 반환한다.
 * 평문 변환: 태그 제거 → 이미지 마커 치환 → 마크다운 이스케이프 해제.
 */
export function extractMemoTitle(text: string): string {
  const plain = String(text || '').replace(/<[^>]*>/g, '').replace(/!\[([^\]]*)\]\((?:file|pending):\d+\)/g, '[이미지]').replace(/\\([!-/:-@\[-`{-~])/g, '$1')
  const lines = plain.split('\n')
  const titleIdx = lines.findIndex((l) => l.trim())
  if (titleIdx < 0) return ''
  const hasBodyBeyond = lines.slice(titleIdx + 1).some((l) => l.trim())
  if (!hasBodyBeyond) return ''
  const line = lines[titleIdx].slice(0, 60)
  return line.replace(/~~([^~]+)~~/g, '$1').replace(/^#{1,6}\s+/, '').replace(/(\*\*|__)([\s\S]*?)\1/g, '$2').replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1$2').replace(/^\s*(?:[-+]|\d+[.)]|>)\s+/, '').trim()
}

export async function syncTags(db: D1Database, memoId: number, text: string): Promise<void> {
  await db.prepare('DELETE FROM memo_tags WHERE memo_id = ?').bind(memoId).run()
  const tags = extractTags(text)
  if (!tags.length) return
  const stmts = tags.map((t) =>
    db.prepare('INSERT OR IGNORE INTO memo_tags (memo_id, tag) VALUES (?, ?)').bind(memoId, t)
  )
  if (typeof db.batch === 'function') {
    await db.batch(stmts)
  } else {
    for (const s of stmts) await s.run()
  }
}

// ---------------- 잠금 해제 step-up 재인증 (PIN) ----------------
// 결정 (2026-10-29, GPT 외부 평가 지적 대응):
// - 비대칭 적용: 잠금(보호를 거는 행위)에는 PIN을 요구하지 않는다 — 세션
//   탈취자가 잠가도 비밀 노출은 없고 마찰만 는다. 해제(보호를 푸는 행위)는
//   본문을 평문으로 되돌리고 AI 접근 계층에도 다시 노출시키므로 step-up이
//   비례적이다. 적용 범위는 평문을 만드는 해제 경로 3종 전부다:
//   메모 해제(POST /:id/lock, locked:false), 블록 해제(unlock-block),
//   첨부 해제(POST /files/:fileId/lock, locked:false).
// - PIN 미설정 계정(auth_pins 행 없음)은 면제한다: 강제하면 PIN을 한 번도
//   설정하지 않은 계정이 영원히 해제를 못 하는 lockout이 된다. PIN 설정은
//   OTP 본인확인 → POST /api/auth/set-pin 경로로 상시 열려 있고, 사용자가
//   PIN을 설정한 순간부터 자동으로 강제된다. auth_pins 테이블 자체가 없는
//   환경도 같은 취급이다 (/api/auth/me 의 hasPin 폴백과 동일 정책).
// - 검증은 기존 auth 함수(verifyPin·isValidPin·isValidB64)를 재사용하고,
//   제출된 PIN 시도는 전역 속도 제한(10회/시간, checkRateLimit 재사용)으로
//   묶는다. 속도 제한 테이블이 없는 환경에서는 제한만 건너뛰고 PIN 검증
//   자체는 그대로 강제한다.
// - 실패 시 호출자는 어떤 DB 쓰기도 하기 전에 거부해야 한다 (상태 불변).
export type UnlockPinCheck =
  | { ok: true }
  | { ok: false; status: 403 | 429 | 500; body: { ok: false; error: string; code?: string } }

export interface PinRow {
  pin_hash: string
  pin_salt: string
  iterations: number
}

/** auth_pins 행 조회 (해제 step-up·보호 게이트 공용).
 *  테이블이 없는 환경·조회 실패는 PIN 미설정과 동일하게 null로 취급한다. */
export async function loadPinRow(c: any): Promise<PinRow | null> {
  try {
    const email = typeof c.get === 'function' ? (c.get('userEmail') as string | undefined) : undefined
    const row = email
      ? await c.env.DB.prepare(
          'SELECT pin_hash, pin_salt, iterations FROM auth_pins WHERE email = ?'
        ).bind(email).first()
      : // 단일 사용자 시스템: 미들웨어를 거치지 않는 마운트(테스트 등)에서는 유일 행으로 판정
        await c.env.DB.prepare(
          'SELECT pin_hash, pin_salt, iterations FROM auth_pins LIMIT 1'
        ).first()
    return (row as PinRow) ?? null
  } catch {
    // auth_pins 미적용 환경 — PIN 미설정과 동일 취급 (면제)
    return null
  }
}

// ---------------- 보호 메모 접근 게이트 (트랙 2, 2026-10-31) ----------------
// 결정 (GPT 6.7 재평가 P0 + 민감 경로 검증 제안 ①):
// - 잠긴 메모의 본문 복호화가 일어나는 모든 소유자 경로는 PIN 재확인
//   (step-up)을 요구한다: 단건 열람, 목록 본문, 덮어쓰기(PUT), 삭제,
//   잠긴 첨부 다운로드·삭제, 잠긴 블록 해제(기존 checkUnlockPin).
//   집행은 이 게이트 한 곳으로 모은다 — 새 경로가 생기면 이 함수를 거치게
//   하고, 거치지 않는 복호화 경로는 만들지 않는다.
// - step-up 성공 시 세션 토큰의 su 클레임으로 5분 창이 발급된다
//   (auth 모듈 grantStepUp·/api/auth/step-up·PIN 로그인이 발급원).
//   해제 step-up(checkUnlockPin)이 PIN으로 통과해도 같은 창이 발급되므로
//   해제 직후 열람·수정에 이중 입력이 생기지 않고, 반대로 읽기 step-up
//   창이 살아 있으면 해제도 PIN 재입력 없이 통과한다.
// - PIN 미설정 계정은 해제 step-up과 같은 규칙으로 면제한다 (lockout 방지).
// - 메타데이터(목록의 id·날짜·태그·파일 수, 제목 등)는 게이트 대상이
//   아니다. 목록에서는 본문만 비우고 body_protected로 표시한다.
/** 세션의 step-up 창이 살아 있는가 (미들웨어가 c.set('stepUpUntil')로 실어 준다). */
export function stepUpWindowActive(c: any, now: number = Date.now()): boolean {
  try {
    const until = typeof c.get === 'function' ? c.get('stepUpUntil') : undefined
    return typeof until === 'number' && until > now
  } catch {
    return false
  }
}

export type ProtectedAccess =
  | { ok: true }
  | { ok: false; status: 403; body: { ok: false; error: string; code: string } }

/** 보호 게이트 판정 — 잠긴 메모 본문에 닿는 모든 경로의 공통 집행 지점. */
export async function requireProtectedAccess(c: any): Promise<ProtectedAccess> {
  const row = await loadPinRow(c)
  if (!row) return { ok: true } // PIN 미설정 → 면제 (해제 step-up과 동일 규칙)
  if (stepUpWindowActive(c)) return { ok: true }
  return {
    ok: false,
    status: 403,
    body: { ok: false, error: 'step_up_required', code: 'STEP_UP_REQUIRED' },
  }
}

/** 목록처럼 403 대신 본문을 비우는 경로용 boolean 판정. */
export async function hasProtectedAccess(c: any): Promise<boolean> {
  return (await requireProtectedAccess(c)).ok
}

/** PIN이 설정돼 있는가 (설정 메뉴 등 표시용). */
export async function hasConfiguredPin(c: any): Promise<boolean> {
  return (await loadPinRow(c)) !== null
}

export async function checkUnlockPin(c: any, pin: unknown): Promise<UnlockPinCheck> {
  const row = await loadPinRow(c)
  if (!row) return { ok: true } // PIN 미설정 → 면제 (위 정책 참조)
  // step-up 창 통합: 읽기 게이트용 창이 살아 있으면 해제도 그대로 통과한다.
  if (stepUpWindowActive(c)) return { ok: true }

  // 손상된 salt/hash/iterations 행은 검증 전에 분리한다 (pin-login과 동일).
  if (
    !isValidB64(row.pin_salt, 16) ||
    !isValidB64(row.pin_hash, 32) ||
    !Number.isInteger(row.iterations) ||
    row.iterations < 1
  ) {
    return { ok: false, status: 500, body: { ok: false, error: 'pin_verify_error' } }
  }
  if (!isValidPin(pin)) {
    return { ok: false, status: 403, body: { ok: false, error: 'pin_required', code: 'PIN_REQUIRED' } }
  }
  try {
    if (await checkRateLimit(c.env.DB, 'unlock-pin:global', 10, 3600)) {
      return { ok: false, status: 429, body: { ok: false, error: 'pin_rate_limited', code: 'PIN_RATE_LIMITED' } }
    }
  } catch {
    // rate_limits 미적용 환경에서는 제한만 건너뛴다 (PIN 검증은 아래에서 강제)
  }
  let okPin = false
  try {
    okPin = await verifyPin(pin, row)
  } catch {
    return { ok: false, status: 500, body: { ok: false, error: 'pin_verify_error' } }
  }
  if (!okPin) {
    return { ok: false, status: 403, body: { ok: false, error: 'pin_invalid', code: 'PIN_INVALID' } }
  }
  // PIN 재확인 성공 → step-up 창(5분)을 세션에 발급한다. 이후 같은 창에서는
  // 보호 메모 열람·수정·삭제와 다른 해제가 재입력 없이 통과한다.
  // 발급 실패(세션 쿠키 없음 등)는 해제 자체를 막지 않는다.
  await grantStepUp(c)
  return { ok: true }
}

// FTS5 쿼리용 이스케이프: 토큰을 큰따옴표로 감싸 안전 처리
// 짧은 검색어/특수 케이스는 LIKE 폴백이 담당
export function ftsQuery(q: string): string {
  const tokens = q
    .replace(/"/g, '')
    .split(/\s+/)
    .filter(Boolean)
  if (!tokens.length) return ''
  return tokens.map((t) => `"${t}"`).join(' ')
}

// trigram 부분 검색용 MATCH 문자열 (memos_fts_tri, 마이그레이션 0059).
// - text 컬럼에 공백 포함 구, text_nospace 컬럼에 공백 제거 구를 OR로 묶는다.
//   trigram 구 매칭은 정확한 부분 문자열 의미와 같다 (실측: 3글자 이상에서
//   LIKE와 동일 결과).
// - FTS5 trigram은 3글자 미만 질의를 매칭하지 못하므로 공백 제거 길이가
//   3 미만이면 ''를 반환한다 — 그 경우는 LIKE 폴백(isShortQuery)이 담당한다.
export function trigramQuery(q: string): string {
  const clean = q.replace(/"/g, '').trim()
  if (!clean) return ''
  const nospace = clean.replace(/\s+/g, '')
  if (nospace.length < 3) return ''
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`
  return `text:${esc(clean)} OR text_nospace:${esc(nospace)}`
}

// trigram이 못 찾는 짧은 검색어인지: 공백 제거 후 3글자 미만.
// (예: '민국' → '대한민국' 안의 '민국'은 토큰 앞부분도 아니고 3글자도
// 안 돼 trigram으로 못 찾는다 — LIKE 폴백만 커버한다.)
export function isShortQuery(q: string): boolean {
  return q.replace(/"/g, '').replace(/\s+/g, '').length < 3
}

export async function saveFiles(
  env: Env,
  memoId: number,
  files: File[]
): Promise<{ id: number; filename: string; size: number }[]> {
  const saved: { id: number; filename: string; size: number }[] = []
  for (const f of files) {
    if (!f.size) continue
    const up = await storageUpload(env, f, 'myhub/memo')
    const r = await env.DB.prepare(
      'INSERT INTO files (memo_id, storage_key, filename, mime, size, url, resource_type) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(memoId, up.public_id, f.name, f.type || null, up.bytes, up.secure_url, up.resource_type)
      .run()
    saved.push({ id: Number(r.meta.last_row_id), filename: f.name, size: up.bytes })
  }
  return saved
}
