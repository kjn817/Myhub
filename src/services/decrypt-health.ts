import { decryptContent, isEncrypted } from './crypto'
import { computeRotationCensus } from './key-rotation'

export const DECRYPT_HEALTH_KEY = 'decrypt.health.v1'
export const DECRYPT_HEALTH_MARKER_KEY = 'decrypt_health.last_date'

export interface DecryptHealthEnv {
  DB: D1Database
  MEMO_ENCRYPTION_KEY?: string
  [key: string]: unknown
}

export interface DecryptHealthBucket {
  total: number
  ok: number
  failed: number
}

export interface DecryptHealthReport {
  at: string
  ok: boolean
  memoText: DecryptHealthBucket
  memoBlock: DecryptHealthBucket
  googleAccess: DecryptHealthBucket
  googleRefresh: DecryptHealthBucket
  lockedFiles: { total: number; checked: boolean }
  totalChecked: number
  totalFailed: number
}

async function tryDecrypt(env: DecryptHealthEnv, ciphertext: string, acc: DecryptHealthBucket): Promise<void> {
  acc.total++
  try {
    await decryptContent(env, ciphertext)
    acc.ok++
  } catch {
    acc.failed++
  }
}

export async function runDecryptHealthCheck(env: DecryptHealthEnv, now: Date = new Date()): Promise<DecryptHealthReport> {
  const memoText: DecryptHealthBucket = { total: 0, ok: 0, failed: 0 }
  const memoBlock: DecryptHealthBucket = { total: 0, ok: 0, failed: 0 }
  const googleAccess: DecryptHealthBucket = { total: 0, ok: 0, failed: 0 }
  const googleRefresh: DecryptHealthBucket = { total: 0, ok: 0, failed: 0 }
  const memoRows = (
    await env.DB.prepare(
      "SELECT text, locked_blocks FROM memos WHERE text LIKE 'ENC%' OR locked_blocks LIKE '%ENC%'",
    ).all<{ text: string; locked_blocks: string | null }>()
  ).results ?? []
  for (const row of memoRows) {
    if (isEncrypted(row.text)) await tryDecrypt(env, row.text, memoText)
    try {
      const parsed = JSON.parse(row.locked_blocks || '[]')
      if (Array.isArray(parsed)) {
        for (const b of parsed) {
          if (b && typeof b.encrypted === 'string' && isEncrypted(b.encrypted)) {
            await tryDecrypt(env, b.encrypted, memoBlock)
          }
        }
      }
    } catch {
      memoBlock.total++
      memoBlock.failed++
    }
  }
  const googleRows = (await env.DB.prepare(
    'SELECT access_token, refresh_token FROM google_integrations'
  ).all<{
    access_token: string
    refresh_token: string
  }>()).results ?? []
  for (const row of googleRows) {
    if (row.access_token && isEncrypted(row.access_token)) {
      await tryDecrypt(env, row.access_token, googleAccess)
    }
    if (row.refresh_token && isEncrypted(row.refresh_token)) {
      await tryDecrypt(env, row.refresh_token, googleRefresh)
    }
  }
  const census = await computeRotationCensus(env)
  const totalChecked = memoText.total + memoBlock.total + googleAccess.total + googleRefresh.total
  const totalFailed = memoText.failed + memoBlock.failed + googleAccess.failed + googleRefresh.failed
  return {
    at: now.toISOString(),
    ok: totalFailed === 0,
    memoText,
    memoBlock,
    googleAccess,
    googleRefresh,
    lockedFiles: { total: census.locked_file, checked: false },
    totalChecked,
    totalFailed,
  }
}

export async function recordDecryptHealth(env: DecryptHealthEnv, report: DecryptHealthReport): Promise<void> {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO ai_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
  )
    .bind(DECRYPT_HEALTH_KEY, JSON.stringify(report))
    .run()
}

export async function getLastDecryptHealthDate(env: DecryptHealthEnv): Promise<string | null> {
  try {
    const row = await env.DB.prepare('SELECT value FROM ai_settings WHERE key = ?')
      .bind(DECRYPT_HEALTH_MARKER_KEY)
      .first<{ value: string }>()
    return row?.value ?? null
  } catch {
    return null
  }
}

export async function markDecryptHealthRun(env: DecryptHealthEnv, kstDate: string): Promise<void> {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO ai_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
  )
    .bind(DECRYPT_HEALTH_MARKER_KEY, kstDate)
    .run()
}
