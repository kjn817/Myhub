import { Hono } from 'hono'
import { encryptContent, decryptContent, isEncrypted } from '../../services/crypto'
import { verifyPin, isValidPin, isValidB64, checkRateLimit } from '../auth/routes'
import type { Env } from '../../types'
import { storageUpload, storageDestroy, thumbUrl } from '../../services/storage'
import { emit } from '../../events'
import { kstDayToUtcRange } from '../../lib/kst-date'

// 메모 모듈 v3: 검색(FTS5) + 파일 첨부(Cloudinary)
// 파일 본체는 공용 스토리지 서비스(src/services/storage.ts)에, 메타데이터만 D1에 저장

export const memoApp = new Hono<{ Bindings: Env }>()

interface MemoRow {
  id: number
  text: string
  created_at: string
  file_count: number
  is_locked?: number
  sensitivity?: number
}
interface FileRow {
  id: number
  memo_id: number
  storage_key: string
  filename: string
  mime: string | null
  size: number
  url: string | null
  resource_type: string
  created_at: string
}

// 태그 추출 (#한글 #abc_123) — memos식
function extractTags(text: string): string[] {
  const set = new Set<string>()
  for (const m of text.matchAll(/#([가-힣a-zA-Z0-9_]+)/g)) set.add(m[1])
  return [...set]
}

async function syncTags(db: D1Database, memoId: number, text: string): Promise<void> {
  await db.prepare('DELETE FROM memo_tags WHERE memo_id = ?').bind(memoId).run()
  const tags = extractTags(text)
  if (!tags.length) return
  await db.batch(
    tags.map((t) =>
      db.prepare('INSERT OR IGNORE INTO memo_tags (memo_id, tag) VALUES (?, ?)').bind(memoId, t)
    )
  )
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
type UnlockPinCheck =
  | { ok: true }
  | { ok: false; status: 403 | 429 | 500; body: { ok: false; error: string; code?: string } }

async function checkUnlockPin(c: any, pin: unknown): Promise<UnlockPinCheck> {
  let row: { pin_hash: string; pin_salt: string; iterations: number } | null = null
  try {
    const email = typeof c.get === 'function' ? (c.get('userEmail') as string | undefined) : undefined
    row = email
      ? await c.env.DB.prepare(
          'SELECT pin_hash, pin_salt, iterations FROM auth_pins WHERE email = ?'
        ).bind(email).first()
      : // 단일 사용자 시스템: 미들웨어를 거치지 않는 마운트(테스트 등)에서는 유일 행으로 판정
        await c.env.DB.prepare(
          'SELECT pin_hash, pin_salt, iterations FROM auth_pins LIMIT 1'
        ).first()
  } catch {
    // auth_pins 미적용 환경 — PIN 미설정과 동일 취급 (면제)
    return { ok: true }
  }
  if (!row) return { ok: true } // PIN 미설정 → 면제 (위 정책 참조)

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
  return { ok: true }
}

// FTS5 쿼리용 이스케이프: 토큰을 큰따옴표로 감싸 안전 처리
// 짧은 검색어/특수 케이스는 LIKE 폴백이 담당
function ftsQuery(q: string): string {
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
function isShortQuery(q: string): boolean {
  return q.replace(/"/g, '').replace(/\s+/g, '').length < 3
}

async function saveFiles(
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

// 대시보드 위젯용 통계
memoApp.get('/stats', async (c) => {
  const memos = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM memos').first<{ n: number }>()
  const files = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS s FROM files WHERE url IS NOT NULL"
  ).first<{ n: number; s: number }>()
  const week = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM memos WHERE created_at >= datetime('now', '-7 days')"
  ).first<{ n: number }>()
  return c.json({
    memos: memos?.n ?? 0,
    files: files?.n ?? 0,
    bytes: files?.s ?? 0,
    week: week?.n ?? 0,
  })
})

// 태그 목록 (사용 중인 태그 + 개수)
memoApp.get('/tags', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT tag, COUNT(*) AS n FROM memo_tags GROUP BY tag ORDER BY n DESC, tag'
  ).all<{ tag: string; n: number }>()
  return c.json(results)
})

// 월별 달력 (KST 기준 일자별 메모 수)
memoApp.get('/calendar', async (c) => {
  const now = new Date()
  const y = Number(c.req.query('y')) || now.getFullYear()
  const m = Number(c.req.query('m')) || now.getMonth() + 1
  const mm = String(m).padStart(2, '0')
  const endM = m === 12 ? 1 : m + 1
  const endY = m === 12 ? y + 1 : y
  const start = `${y}-${mm}-01`
  const end = `${endY}-${String(endM).padStart(2, '0')}-01`
  // P-3: datetime(created_at, '+9 hours') 조건은 idx_memos_created_at을
  // 무력화한다. KST 월 경계를 UTC 범위로 미리 계산해 범위 조건으로 변경.
  // SELECT의 date(..., '+9 hours')는 일별 버킷용으로, 필터된 행에만 적용된다.
  const startUtc = kstDayToUtcRange(start)?.[0] ?? start
  const endUtc = kstDayToUtcRange(end)?.[0] ?? end
  const { results } = await c.env.DB.prepare(
    `SELECT date(created_at, '+9 hours') AS day, COUNT(*) AS n FROM memos
     WHERE created_at >= ? AND created_at < ?
     GROUP BY day`
  )
    .bind(startUtc, endUtc)
    .all<{ day: string; n: number }>()
  return c.json(results)
})

// 목록 조회 (검색 + 태그 + 날짜 필터 + 페이지네이션)
// 검색 우선순위: FTS5 본문 검색 → trigram 부분 검색 → 파일명 검색 → 짧은 검색어 LIKE 폴백
// (perf-audit §3.1·§6 #2: LIKE 전수 스캔은 3글자 미만 검색어에만 남긴다)
memoApp.get('/', async (c) => {
  const q = c.req.query('q')?.trim() || ''
  const tag = c.req.query('tag')?.trim() || ''
  const date = c.req.query('date')?.trim() || '' // YYYY-MM-DD (KST)
  const limit = Math.min(Number(c.req.query('limit')) || 50, 200)
  const offset = Number(c.req.query('offset')) || 0
  // fileCount: 행별 상관 서브쿼리 대신 files 1회 집계 LEFT JOIN (perf-audit §3.3)
  const fileCountJoin =
    'LEFT JOIN (SELECT memo_id, COUNT(*) AS n FROM files GROUP BY memo_id) fc ON fc.memo_id = m.id'
  const fileCountSelect = 'COALESCE(fc.n, 0) AS file_count'

  let join = ''
  const conds: string[] = []
  const params: unknown[] = []
  if (tag) {
    join += ' JOIN memo_tags t ON t.memo_id = m.id'
    conds.push('t.tag = ?')
    params.push(tag)
  }
  if (date) {
    // P-3: date(m.created_at, '+9 hours') = ? 는 idx_memos_created_at을
    // 무력화한다. KST 날짜를 UTC 범위로 미리 계산해 범위 조건으로 변경.
    // 무효한 날짜는 구 조건과 동일하게 매치 없음(1 = 0)으로 처리한다.
    const range = kstDayToUtcRange(date)
    if (range) {
      conds.push('m.created_at >= ? AND m.created_at < ?')
      params.push(range[0], range[1])
    } else {
      conds.push('1 = 0')
    }
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''

  if (q) {
    const out: MemoRow[] = []
    const seen = new Set<number>()
    // 소유자 세션 경로: 어느 검색 단계를 거치든 잠긴 메모의 암호문(ENC:)을
    // 원시 그대로 내보내지 않는다 — 복호화해서 내리고, 실패하면 플레이스홀더.
    // (AI 접근 계층의 검색 제외 경계는 ai-access.ts가 따로 담당한다.)
    const pushDecrypted = async (rows: MemoRow[]) => {
      for (const r of rows) {
        if (r.is_locked && isEncrypted(r.text)) {
          try {
            r.text = await decryptContent(c.env, r.text);
          } catch (e) {
            r.text = '[복호화 실패]';
          }
        }
        out.push(r)
        seen.add(r.id)
      }
    }
    const pushRaw = pushDecrypted
    const notIn = () => (seen.size ? ` AND m.id NOT IN (${[...seen].map(() => '?').join(',')})` : '')

    // 1) FTS5 본문 전문검색
    const fq = ftsQuery(q)
    if (fq) {
      try {
        const { results } = await c.env.DB.prepare(
          `SELECT m.id, m.text, m.created_at, m.is_locked, m.sensitivity, ${fileCountSelect}
           FROM memos_fts fts JOIN memos m ON m.id = fts.rowid ${join} ${fileCountJoin}
           WHERE memos_fts MATCH ? ${where ? 'AND ' + conds.join(' AND ') : ''}
           ORDER BY rank LIMIT ? OFFSET ?`
        )
          .bind(fq, ...params, limit, offset)
          .all<MemoRow>()
        await pushDecrypted(results)
      } catch {
        /* 폴백으로 진행 */
      }
    }

    // 2) trigram 부분 검색 (memos_fts_tri): 3글자 이상 부분 문자열은 LIKE와
    // 동일 결과를 인덱스로 찾는다. 테이블이 없는 DB(0059 미적용)에서는
    // throw → catch 후 4)번 LIKE 폴백이 안전망이 된다.
    const tq = trigramQuery(q)
    let trigramOk = false
    if (out.length < limit && tq) {
      try {
        const { results } = await c.env.DB.prepare(
          `SELECT m.id, m.text, m.created_at, m.is_locked, m.sensitivity, ${fileCountSelect}
           FROM memos_fts_tri tri JOIN memos m ON m.id = tri.rowid ${join} ${fileCountJoin}
           WHERE memos_fts_tri MATCH ? ${where ? 'AND ' + conds.join(' AND ') : ''}${notIn()}
           ORDER BY m.id DESC LIMIT ? OFFSET ?`
        )
          .bind(tq, ...params, ...[...seen], limit - out.length, offset)
          .all<MemoRow>()
        trigramOk = true
        await pushRaw(results)
      } catch {
        /* 파일명·LIKE 폴백으로 진행 */
      }
    }

    // 3) 파일명 검색: files만 스캔해 memo_id를 구한 뒤 PK 조회.
    // (기존 EXISTS는 메모 행마다 평가돼 본문 스캔과 묶여 있었다.)
    // 잠금·기밀 메모 제외 (0030과 같은 경계 — FTS/trigram은 애초에 인덱싱하지
    // 않는데, 이 단계는 memos를 직접 조회하므로 필터가 없으면 파일명 일치만으로
    // 잠긴 메모 본문이 복호화되어 검색 결과에 실린다. 4)번 LIKE 단계와 동일.)
    if (out.length < limit) {
      const { results } = await c.env.DB.prepare(
        `SELECT m.id, m.text, m.created_at, m.is_locked, m.sensitivity, ${fileCountSelect}
         FROM memos m ${join} ${fileCountJoin}
         WHERE m.id IN (SELECT memo_id FROM files WHERE filename LIKE ?)
           AND m.is_locked = 0 AND m.sensitivity < 2
           ${where ? 'AND ' + conds.join(' AND ') : ''}${notIn()}
         ORDER BY m.id DESC LIMIT ? OFFSET ?`
      )
        .bind(`%${q}%`, ...params, ...[...seen], limit - out.length, offset)
        .all<MemoRow>()
      await pushRaw(results)
    }

    // 4) 짧은 검색어 LIKE 폴백: trigram은 공백 제거 3글자 미만을 못 찾는다.
    // 3글자 이상은 2)번이 LIKE와 동일 결과를 내므로 이 단계는 다음 경우에만
    // 실행한다 — (a) 짧은 검색어, (b) trigram 단계 실패(0059 미적용 DB).
    if (out.length < limit && (isShortQuery(q) || !trigramOk)) {
      const nospace = q.replace(/\s+/g, '')
      // 잠금·기밀 메모 제외 (0030과 같은 경계 — FTS/trigram은 애초에 인덱싱하지
      // 않는데, 기존 LIKE 폴백은 이 경계를 우회해 sensitivity>=2 평문을 그대로
      // 돌려줬다. 짧은 검색어 단계만 원본 memos를 스캔하므로 여기서만 필터한다.)
      const likeConds = [
        ...conds,
        'm.is_locked = 0',
        'm.sensitivity < 2',
        `(m.text LIKE ? OR REPLACE(m.text, ' ', '') LIKE ?)`,
      ]
      if (seen.size) likeConds.push(`m.id NOT IN (${[...seen].map(() => '?').join(',')})`)
      const { results } = await c.env.DB.prepare(
        `SELECT m.id, m.text, m.created_at, m.is_locked, m.sensitivity, ${fileCountSelect}
         FROM memos m ${join} ${fileCountJoin} WHERE ${likeConds.join(' AND ')}
         ORDER BY m.id DESC LIMIT ? OFFSET ?`
      )
        .bind(...params, `%${q}%`, `%${nospace}%`, ...[...seen], limit - out.length, offset)
        .all<MemoRow>()
      await pushRaw(results)
    }
    return c.json(out)
  }

  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.text, m.created_at, m.is_locked, m.sensitivity, ${fileCountSelect}
     FROM memos m ${join} ${fileCountJoin} ${where} ORDER BY m.id DESC LIMIT ? OFFSET ?`
  )
    .bind(...params, limit, offset)
    .all<MemoRow>()
  // 소유자 세션 경로: 잠긴 메모는 복호화해서 내린다 (원시 ENC: 노출 금지).
  // 복호화 실패 시 암호문 대신 플레이스홀더를 내린다 (FTS 분기와 동일).
  for (const r of results) {
    if (r.is_locked && isEncrypted(r.text)) {
      try {
        r.text = await decryptContent(c.env, r.text)
      } catch {
        r.text = '[복호화 실패]'
      }
    }
  }
  return c.json(results)
})

// 메모 생성 (multipart: text + files, 또는 JSON: {text})
memoApp.post('/', async (c) => {
  const contentType = c.req.header('content-type') || ''
  let text = ''
  let uploadFiles: File[] = []

  if (contentType.includes('multipart/form-data')) {
    const body = await c.req.parseBody()
    text = String(body['text'] ?? '')
    const f = body['files']
    const arr = Array.isArray(f) ? f : f ? [f] : []
    uploadFiles = arr.filter((x): x is File => x instanceof File)
  } else {
    const json = await c.req.json<{ text?: string }>().catch((): { text?: string } => ({}))
    text = json.text ?? ''
  }

  if (!text.trim() && !uploadFiles.length) return c.json({ error: 'empty' }, 400)

  const r = await c.env.DB.prepare('INSERT INTO memos (text) VALUES (?)')
    .bind(text.trim())
    .run()
  const memoId = Number(r.meta.last_row_id)
  await syncTags(c.env.DB, memoId, text.trim())
  const saved = await saveFiles(c.env, memoId, uploadFiles)
  await emit('memo.created', { id: memoId })
  return c.json({ ok: true, id: memoId, files: saved })
})

// 메모 단건 조회 (81차: 위젯 openPane용)
// 잠금·권한 검증 포함
memoApp.get('/:id', async (c) => {
  const idParam = c.req.param('id')
  const id = Number(idParam)
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ ok: false, error: 'INVALID_ID' }, 400)
  }
  try {
    // NOTE: memos에는 updated_at 컬럼이 없다 (마이그레이션 전수 확인).
    // 과거 SELECT가 updated_at를 포함해 실제 D1에서는 항상 "no such
    // column"으로 500(DB_ERROR)이 됐다 — mock 단위 테스트가 숨긴 결함으로,
    // 런타임 테스트(tests/runtime/memo-lock-encryption.test.ts)가 발견했다.
    const memo = await c.env.DB.prepare(
      'SELECT id, text, created_at, is_locked, sensitivity FROM memos WHERE id = ?'
    ).bind(id).first() as any
    if (!memo) {
      return c.json({ ok: false, error: 'NOT_FOUND' }, 404)
    }
    // 소유자 세션 경로 (전역 인증 미들웨어 뒤): 잠긴 메모도 소유자에게는
    // 복호화해서 내린다 — 목록 조회(FTS·무검색 분기)와 같은 소유자 복호화
    // 정책. 원시 ENC: 암호문을 그대로 내보내지 않으며, 복호화 실패 시
    // 플레이스홀더로 대체한다. AI 접근 차단은 ai-access.ts 계층이 별도로
    // 담당하므로 이 변경은 AI 경계에 영향을 주지 않는다.
    let ownerText: string = memo.text
    if (memo.is_locked && isEncrypted(memo.text)) {
      try {
        ownerText = await decryptContent(c.env, memo.text)
      } catch {
        ownerText = '[복호화 실패]'
      }
    }
    return c.json({
      ok: true,
      memo: {
        id: memo.id,
        text: ownerText,
        content: ownerText, // 하위 호환
        is_locked: memo.is_locked ? 1 : 0,
        created_at: memo.created_at,
        updated_at: memo.updated_at ?? null,
      },
    })
  } catch (e) {
    return c.json({ ok: false, error: 'DB_ERROR' }, 500)
  }
})

// 메모 수정 (본문만) — FTS 트리거(memos_fts_au)가 자동 재색인
// 잠긴 메모는 소유자 편집이라도 암호화해서 저장한다 (평문으로 덮으면 lock이
// 저장한 ENC: 암호문이 즉시 소실된다). 암호화 실패 시 500, DB 불변.
memoApp.put('/:id', async (c) => {
  const id = c.req.param('id')
  const json = await c.req.json<{ text?: string }>().catch((): { text?: string } => ({}))
  const text = (json.text ?? '').trim()
  if (!text) return c.json({ error: 'empty' }, 400)
  const existing = (await c.env.DB.prepare('SELECT is_locked FROM memos WHERE id = ?')
    .bind(id)
    .first()) as { is_locked?: number } | null
  let storedText = text
  if (existing?.is_locked) {
    try {
      storedText = await encryptContent(c.env, text)
    } catch (e) {
      console.error('Memo update encryption failed:', e)
      return c.json({ error: 'encrypt_failed' }, 500)
    }
  }
  await c.env.DB.prepare('UPDATE memos SET text = ? WHERE id = ?').bind(storedText, id).run()
  await syncTags(c.env.DB, Number(id), text)
  await emit('memo.updated', { id: Number(id) })
  return c.json({ ok: true })
})

// 메모 잠금 토글
memoApp.post('/:id/lock', async (c) => {
  const id = c.req.param('id')
  const json = await c.req.json<{ locked?: boolean; pin?: string }>().catch(() => ({} as { locked?: boolean; pin?: string }))
  const locked = (json as { locked?: boolean }).locked ? 1 : 0
  const memo = await c.env.DB.prepare('SELECT text, is_locked FROM memos WHERE id = ?').bind(id).first() as any
  if (!memo) return c.json({ error: 'not_found' }, 404)

  // step-up: 현재 잠긴 메모를 해제할 때만 PIN 재입력 (잠금·무동작 해제에는 없음).
  // 검증 실패 시 복호화·UPDATE 없이 거부 → 잠금 상태 불변.
  if (!locked && memo.is_locked) {
    const pinCheck = await checkUnlockPin(c, (json as { pin?: string }).pin)
    if (!pinCheck.ok) return c.json(pinCheck.body, pinCheck.status)
  }
  
  let newText = memo.text
  const wantLocked = locked ? true : false

  // 잠금/해제는 플래그가 아니라 저장된 본문의 형태(평문/암호문)를 기준으로
  // 판단한다 — 그래야 멱등하고, 평문으로 남은 잠긴 메모(구 fail-open 폴백의
  // 잔재)도 재잠금 호출 한 번으로 실제 암호문으로 전환된다.
  // fail-closed: 암호화 실패 시 500을 반환하고 UPDATE를 실행하지 않는다
  // (블록·파일 잠금 경로와 동일 패턴).
  if (wantLocked) {
    // 잠금: 이미 암호문이면 재암호화하지 않는다 (이중 암호화 방지)
    if (!isEncrypted(memo.text)) {
      try {
        newText = await encryptContent(c.env, memo.text)
      } catch (e) {
        console.error('Encryption failed:', e)
        return c.json({ error: 'encrypt_failed' }, 500)
      }
    }
  } else {
    // 해제: 암호문이면 복호화 (실패 시 500·DB 불변). 평문인 잠긴 메모는
    // 복호화할 것이 없으므로 그대로 통과한다 (전환 안전판).
    if (isEncrypted(memo.text)) {
      try {
        newText = await decryptContent(c.env, memo.text)
      } catch (e) {
        return c.json({ error: 'decrypt_failed' }, 500)
      }
    }
  }
  
  await c.env.DB.prepare('UPDATE memos SET is_locked = ?, text = ? WHERE id = ?').bind(locked, newText, id).run()
  return c.json({ ok: true, is_locked: locked })
})

// 메모 민감도 설정
// 블록 잠금: 특정 HTML 블록을 암호화
memoApp.post('/:id/lock-block', async (c) => {
  const id = c.req.param('id')
  const json = await c.req.json<{ html?: string }>().catch(() => ({} as { html?: string }))
  const html = (json as { html?: string }).html || ''
  if (!html) return c.json({ error: 'empty_html' }, 400)
  
  try {
    // 메모 존재 여부 + 현재 본문을 먼저 확인 (암호화 전에 404 반환)
    // D-3 (2026-10-30): 본문(text)도 함께 읽는다 — 잠금은 본문에서 평문을
    // 제거하는 것까지 포함해야 성립한다 (아래 fail-closed·원자 치환 참조).
    let memo: any = null
    try {
      memo = await c.env.DB.prepare('SELECT id, text, locked_blocks FROM memos WHERE id = ?').bind(id).first() as any
      if (!memo) {
        return c.json({ error: 'memo_not_found' }, 404)
      }
    } catch (e) {
      console.error('locked_blocks column missing, migration needed')
      return c.json({ error: 'migration_needed', message: 'D1에서 ALTER TABLE memos ADD COLUMN locked_blocks TEXT DEFAULT \'[]\' 실행 필요' }, 500)
    }

    const { encryptContent } = await import('../../services/crypto')
    const encrypted = await encryptContent(c.env, html)
    const blockId = 'blk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    const marker = `[LOCKED_BLOCK:${blockId}]`

    // D-3 fail-closed: 요청 html이 저장된 본문에 없으면 잠금을 성립시키지
    // 않는다. 암호문 사본만 추가하고 평문이 본문에 남는 잠금은 검색(FTS·
    // trigram·LIKE 전부 text 기반)과 AI 경로로 그대로 노출됐다. 이 경우
    // locked_blocks·text 모두 불변으로 오류를 반환한다.
    if (typeof memo.text !== 'string' || !memo.text.includes(html)) {
      return c.json({ error: 'block_not_in_text' }, 409)
    }

    // API-LOCK-007: 원자적 JSON 배열 추가로 Lost Update 방지
    // D-3: 같은 단일 UPDATE로 본문의 html 모든 출현을 마커로 치환한다
    // (SQLite replace는 전 출현 치환). WHERE의 instr 조건이 경합으로 본문이
    // 바뀐 경우에도 "평문이 남는 잠금"이 적용되지 않게 막는 원자 가드다.
    // text UPDATE는 FTS 트리거가 재색인하므로 검색 인덱스에서도 사라진다.
    const newBlock = JSON.stringify({ id: blockId, encrypted })
    let updateResult
    try {
      updateResult = await c.env.DB.prepare(
        `UPDATE memos
         SET locked_blocks = json_insert(
           COALESCE(NULLIF(locked_blocks, ''), '[]'),
           '$[#]',
           json(?)
         ),
         text = replace(text, ?, ?)
         WHERE id = ? AND instr(text, ?) > 0`
      ).bind(newBlock, html, marker, id, html).run()
    } catch (e) {
      console.error('locked_blocks column missing or json_insert failed:', e)
      return c.json({ error: 'migration_needed', message: 'D1 locked_blocks 컬럼 또는 JSON 함수 확인 필요' }, 500)
    }
    
    // 존재하지 않는 메모 ID에 대한 처리 (D1의 changes로 확인)
    const changes = (updateResult as any).meta?.changes ?? 0
    if (changes === 0) {
      return c.json({ error: 'memo_not_found' }, 404)
    }
    
    return c.json({ ok: true, blockId })
  } catch (e) {
    return c.json({ error: 'encrypt_failed' }, 500)
  }
})

// 블록 잠금 해제
memoApp.post('/:id/unlock-block/:blockId', async (c) => {
  const id = c.req.param('id')
  const blockId = c.req.param('blockId')
  // step-up용 PIN (본문 없는 기존 호출과 하위 호환: 없으면 undefined)
  const json = await c.req.json<{ pin?: string }>().catch(() => ({} as { pin?: string }))

  const memo = await c.env.DB.prepare('SELECT locked_blocks FROM memos WHERE id = ?').bind(id).first() as any
  let blocks: any[] = []
  try {
    const parsed = JSON.parse(memo?.locked_blocks || '[]')
    blocks = Array.isArray(parsed) ? parsed : []
  } catch {}

  const block = blocks.find((b: any) => b && b.id === blockId)
  if (!block) return c.json({ error: 'not_found' }, 404)

  // step-up: 블록 해제는 복호화된 html을 응답으로 직접 돌려주는 가장 직접적인
  // 노출 경로다. 검증 실패 시 복호화·제거 없이 거부 → locked_blocks 불변.
  const pinCheck = await checkUnlockPin(c, (json as { pin?: string }).pin)
  if (!pinCheck.ok) return c.json(pinCheck.body, pinCheck.status)

  let html: string
  try {
    const { decryptContent } = await import('../../services/crypto')
    html = await decryptContent(c.env, block.encrypted)
  } catch (e) {
    // 복호화 실패 시 DB 불변 — 암호문은 남겨두고 재시도 가능
    return c.json({ error: 'decrypt_failed' }, 500)
  }

  // 복호화 성공 후 암호문 항목을 원자적으로 제거 (단일 UPDATE, 동시 lock-block 추가분은 보존)
  try {
    await c.env.DB.prepare(
      `UPDATE memos
       SET locked_blocks = COALESCE((
         SELECT json_group_array(json(value))
         FROM json_each(COALESCE(NULLIF(locked_blocks, ''), '[]'))
         WHERE json_extract(value, '$.id') != ?
       ), '[]')
       WHERE id = ?`
    ).bind(blockId, id).run()
  } catch (e) {
    console.error('unlock-block: locked_blocks 제거 실패', { id, blockId, e })
    return c.json({ ok: true, html, warning: 'unlock_pending' })
  }

  return c.json({ ok: true, html })
})

// 첨부파일 잠금 토글
memoApp.post('/files/:fileId/lock', async (c) => {
  const fileId = c.req.param('fileId')
  const json = await c.req.json<{ locked?: boolean; pin?: string }>().catch(() => ({} as { locked?: boolean; pin?: string }))
  const locked = (json as { locked?: boolean }).locked ? 1 : 0

  // 파일 정보 가져오기
  const file = await c.env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(fileId).first() as any
  if (!file) return c.json({ error: 'not_found' }, 404)

  const currentlyLocked = file.is_locked ? true : false
  const wantLocked = locked ? true : false

  // step-up: 현재 잠긴 첨부를 해제할 때만 PIN 재입력. 검증 실패 시 다운로드·
  // 복호화·재업로드 없이 거부 → 파일 잠금 상태 불변.
  if (!wantLocked && currentlyLocked) {
    const pinCheck = await checkUnlockPin(c, (json as { pin?: string }).pin)
    if (!pinCheck.ok) return c.json(pinCheck.body, pinCheck.status)
  }
  
  // D-1 (2026-10-30): 교체 전 스토리지 객체를 잠금·해제 후 파괴하기 위해
  // 구 키를 미리 잡아둔다. 잠금만 하고 구 평문 객체를 남기면 잠금 전 URL로
  // 평문에 영구 접근 가능했고, 해제도 .enc 객체가 고아로 남았다.
  const oldStorageKey = file.storage_key as string | undefined
  const oldResourceType = file.resource_type as string | undefined
  let replacedWithKey: string | null = null

  if (wantLocked && !currentlyLocked) {
    // 잠금: Cloudinary에서 원본 다운로드 → 암호화 → 재업로드
    try {
      const { encryptBytes } = await import('../../services/crypto')
      const { storageUpload } = await import('../../services/storage')

      // 원본 다운로드
      const resp = await fetch(file.url)
      const originalBytes = await resp.arrayBuffer()
      const encryptedBytes = await encryptBytes(c.env, originalBytes)

      // 암호화된 파일을 Blob으로 만들어 업로드
      const encryptedBlob = new Blob([encryptedBytes], { type: 'application/octet-stream' })
      const encryptedFile = new File([encryptedBlob], file.filename + '.enc', { type: 'application/octet-stream' })
      const up = await storageUpload(c.env, encryptedFile, 'myhub/memo-encrypted')

      // DB 업데이트: 새 URL과 잠금 플래그
      await c.env.DB.prepare(
        'UPDATE files SET is_locked = 1, url = ?, storage_key = ? WHERE id = ?'
      ).bind(up.secure_url, up.public_id, fileId).run()
      replacedWithKey = up.public_id

    } catch (e) {
      console.error('File encryption failed:', e)
      return c.json({ error: 'encrypt_failed' }, 500)
    }
  } else if (!wantLocked && currentlyLocked) {
    // 해제: 암호화된 파일 다운로드 → 복호화 → 재업로드
    try {
      const { decryptBytes } = await import('../../services/crypto')
      const { storageUpload } = await import('../../services/storage')

      const resp = await fetch(file.url)
      const encryptedBytes = await resp.arrayBuffer()
      const decryptedBytes = await decryptBytes(c.env, encryptedBytes)

      const decryptedBlob = new Blob([decryptedBytes], { type: file.mime || 'application/octet-stream' })
      const decryptedFile = new File([decryptedBlob], file.filename, { type: file.mime })
      const up = await storageUpload(c.env, decryptedFile, 'myhub/memo')

      await c.env.DB.prepare(
        'UPDATE files SET is_locked = 0, url = ?, storage_key = ? WHERE id = ?'
      ).bind(up.secure_url, up.public_id, fileId).run()
      replacedWithKey = up.public_id

    } catch (e) {
      console.error('File decryption failed:', e)
      return c.json({ error: 'decrypt_failed' }, 500)
    }
  }

  // D-1: DB 교체가 성공한 경우에만 교체 전 객체를 파괴한다 (실패한 잠금·
  // 해제에서 현행 객체를 지우면 파일 자체를 잃는다). 파괴 실패는 침묵하지
  // 않는다: 잠금/해제 자체의 성공 의미는 바꾸지 않되 console.error +
  // 응답 warning으로 표면화한다 (unlock_pending과 같은 철학).
  let warning: string | undefined
  if (replacedWithKey && oldStorageKey && oldStorageKey !== replacedWithKey) {
    try {
      const destroyed = await storageDestroy(c.env, oldStorageKey, oldResourceType as string)
      if (destroyed === false) {
        console.error('File lock: replaced storage object destroy failed', { fileId, oldStorageKey })
        warning = 'storage_cleanup_failed'
      }
    } catch (e) {
      console.error('File lock: replaced storage object destroy failed', { fileId, oldStorageKey, e })
      warning = 'storage_cleanup_failed'
    }
  }

  return c.json({ ok: true, is_locked: locked, ...(warning ? { warning } : {}) })
})

// 잠긴 파일 서빙 (복호화 후 전달)
memoApp.get('/files/:fileId/content', async (c) => {
  const fileId = c.req.param('fileId')
  const file = await c.env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(fileId).first() as any
  if (!file) return c.json({ error: 'not_found' }, 404)
  
  // 잠긴 파일은 복호화해서 서빙
  if (file.is_locked) {
    try {
      const { decryptBytes } = await import('../../services/crypto')
      const resp = await fetch(file.url)
      const encryptedBytes = await resp.arrayBuffer()
      const decryptedBytes = await decryptBytes(c.env, encryptedBytes)
      
      return new Response(decryptedBytes, {
        headers: {
          'Content-Type': file.mime || 'application/octet-stream',
          'Content-Disposition': `inline; filename="${encodeURIComponent(file.filename)}"`,
        }
      })
    } catch (e) {
      return c.json({ error: 'decrypt_failed' }, 500)
    }
  }
  
  // 잠기지 않은 파일은 Cloudinary로 리다이렉트
  return c.redirect(file.url, 302)
})

memoApp.post('/:id/sensitivity', async (c) => {
  const id = c.req.param('id')
  const json = await c.req.json<{ sensitivity?: number }>().catch(() => ({} as { sensitivity?: number }))
  const s = Math.max(0, Math.min(3, json.sensitivity ?? 1))
  await c.env.DB.prepare('UPDATE memos SET sensitivity = ? WHERE id = ?').bind(s, id).run()
  return c.json({ ok: true, sensitivity: s })
})

// 메모 삭제 (파일도 Cloudinary + D1에서 함께 삭제)
memoApp.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const { results } = await c.env.DB.prepare(
    'SELECT storage_key, resource_type FROM files WHERE memo_id = ? AND url IS NOT NULL'
  )
    .bind(id)
    .all<{ storage_key: string; resource_type: string }>()
  await Promise.all(results.map((r) => storageDestroy(c.env, r.storage_key, r.resource_type)))
  await c.env.DB.prepare('DELETE FROM files WHERE memo_id = ?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM memo_tags WHERE memo_id = ?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM memos WHERE id = ?').bind(id).run()
  await c.env.KV.delete('system:stats').catch(() => {})
  await emit('memo.deleted', { id: Number(id) })
  return c.json({ ok: true })
})

// 메모의 파일 목록 (이미지는 썸네일 URL 포함)
memoApp.get('/:id/files', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, memo_id, storage_key, filename, mime, size, url, resource_type, created_at, is_locked FROM files WHERE memo_id = ? AND url IS NOT NULL ORDER BY id'
  )
    .bind(c.req.param('id'))
    .all<FileRow>()
  return c.json(
    results.map((f: any) => ({
      id: f.id,
      memo_id: f.memo_id,
      filename: f.filename,
      mime: f.mime,
      size: f.size,
      is_locked: !!f.is_locked,
      url: f.url,
      thumb:
        f.mime?.startsWith('image/') && f.url
          ? thumbUrl(c.env.CLOUDINARY_CLOUD_NAME, f.storage_key)
          : null,
      created_at: f.created_at,
    }))
  )
})

// 기존 메모에 파일 추가
memoApp.post('/:id/files', async (c) => {
  const memoId = Number(c.req.param('id'))
  const body = await c.req.parseBody()
  const f = body['files']
  const arr = Array.isArray(f) ? f : f ? [f] : []
  const uploadFiles = arr.filter((x): x is File => x instanceof File)
  if (!uploadFiles.length) return c.json({ error: 'empty' }, 400)
  // Cloudinary 무료 플랜: 파일당 10MB 제한
  const MAX_SIZE = 10 * 1024 * 1024
  for (const uf of uploadFiles) {
    if (uf.size > MAX_SIZE) {
      return c.json({ ok: false, error: `"${uf.name}"은 10MB를 초과해서 업로드할 수 없어요` }, 400)
    }
  }
  try {
    const saved = await saveFiles(c.env, memoId, uploadFiles)
    // 시스템 통계 캐시 무효화 (위젯 즉시 반영)
    await c.env.KV.delete('system:stats').catch(() => {})
    return c.json({ ok: true, files: saved })
  } catch (e) {
    return c.json({ ok: false, error: String(e).slice(0, 200) }, 500)
  }
})

// 파일 다운로드 → Cloudinary CDN URL로 리다이렉트
// D-2 (2026-10-30): 잠긴 파일은 Cloudinary URL이 암호문(.enc)을 가리키므로
// 그대로 리다이렉트하면 암호문 파일이 내려간다. 복호화 서빙 경로
// (/content)로 보내 소유자에게 원본이 전달되게 한다.
memoApp.get('/files/:fileId', async (c) => {
  const fileId = c.req.param('fileId')
  const { results } = await c.env.DB.prepare('SELECT url, is_locked FROM files WHERE id = ?')
    .bind(fileId)
    .all<{ url: string | null; is_locked?: number }>()
  const row = results[0]
  if (!row?.url) return c.json({ error: 'not found' }, 404)
  if (row.is_locked) {
    // 상대 URL은 Response.redirect로 만들 수 없어 Location 헤더로 직접 응답
    return new Response(null, {
      status: 302,
      headers: { Location: `/api/memo/files/${fileId}/content` },
    })
  }
  return Response.redirect(row.url, 302)
})

// 파일 삭제
memoApp.delete('/files/:fileId', async (c) => {
  const fileId = c.req.param('fileId')
  const { results } = await c.env.DB.prepare(
    'SELECT storage_key, resource_type FROM files WHERE id = ? AND url IS NOT NULL'
  )
    .bind(fileId)
    .all<{ storage_key: string; resource_type: string }>()
  const row = results[0]
  if (!row) return c.json({ error: 'not found' }, 404)
  await storageDestroy(c.env, row.storage_key, row.resource_type)
  await c.env.DB.prepare('DELETE FROM files WHERE id = ?').bind(fileId).run()
  await c.env.KV.delete('system:stats').catch(() => {})
  await emit('memo.deleted', { id: Number(fileId) })
  return c.json({ ok: true })
})
