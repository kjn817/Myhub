/**
 * ai_settings 키-값 조회 헬퍼 — 키 형식을 검증한 뒤에만 쿼리에 넣는다.
 * (키는 코드 내부 상수만 허용한다는 전제의 방어적 검증이다.)
 */

export async function readSettingValue(db: D1Database, key: string): Promise<string | null> {
  if (!/^[a-z0-9._-]+$/.test(key)) throw new Error('invalid setting key')
  const row = await db.prepare(`SELECT value FROM ai_settings WHERE key = '${key}'`).first<{ value: unknown }>()
  return row ? String(row.value ?? '') : null
}

export async function readBooleanSetting(db: D1Database, key: string): Promise<boolean> {
  try {
    return (await readSettingValue(db, key)) === 'true'
  } catch {
    return false
  }
}
