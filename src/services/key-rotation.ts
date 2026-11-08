/**
 * MEMO_ENCRYPTION_KEY 로테이션 서비스 (트랙 4, 2026-10-31)
 *
 * 배경: docs/backup-restore.md §6.1 — 이 서비스가 있기 전에는 재암호화
 * 경로가 없어 키를 바꾸면 기존 암호문이 전부 복호화 불가가 됐다.
 *
 * 대상 (키 사용처 4곳 전수):
 *  1. 잠긴 메모 본문 — memos.text 의 ENC:/ENC2: 암호문
 *  2. 잠긴 블록 — memos.locked_blocks JSON 안 각 항목의 encrypted
 *  3. 잠긴 첨부 바이트 — Cloudinary .enc 객체의 암호화 바이트 (files.is_locked=1)
 *  4. Google OAuth 토큰 — google_integrations.access_token / refresh_token
 *
 * 안전 설계 (판단과 근거):
 * - 사전 검증(preflight)이 전부 통과해야 쓰기를 시작한다. 전 대상을
 *   출발 키로 복호화해 보고, 하나라도 실패하면(잘못된 현재 키 포함)
 *   쓰기 0건으로 중단한다. "바꿀 수 없는 항목이 섞인 채 절반만 전환"을
 *   구조적으로 막기 위해서다.
 * - 항목 단위 원자성: DB 항목은 CAS(구 값 일치 조건) 단일 UPDATE로만
 *   교체한다 — 한 항목이 두 키로 찢어지는 상태는 없다. Google 토큰은
 *   access·refresh를 한 UPDATE로 함께 교체한다. 첨부는 새 객체를 먼저
 *   올리고 → DB 포인터를 CAS로 교체하고 → 구 객체를 지우는 순서라,
 *   중단 지점이 어디든 files 행은 항상 완전한 객체 하나를 가리킨다
 *   (고아 객체가 남을 수는 있으나 데이터가 깨지지는 않는다).
 * - 세대 판별: 산출물에는 v2 마커(텍스트 ENC2:, 바이트 MYH2 매직)를 단다.
 *   중단 후 재실행하면 이미 목표 키로 열리는 항목은 건너뛰고(멱등),
 *   롤백은 v2 항목을 출발 키로 열어 구 형식(v1)으로 되돌린다. 복호화
 *   경로는 MEMO_ENCRYPTION_KEY_PREV가 있으면 혼합 상태도 읽는다
 *   (crypto.ts 참조).
 * - 키 값은 이 함수의 인자로만 존재한다. 로그·DB·반환값에는 건수와
 *   항목 종류만 남기고 키·평문은 절대 넣지 않는다.
 * - 중간 실패: 이미 전환된 항목은 그대로 두고(각자 자기 키로 읽힘),
 *   보고에 완료/잔여 건수를 실어 반환한다. 호출자는 같은 파라미터로
 *   재실행해 마저 전환하거나 롤백으로 되돌릴 수 있다.
 */

import {
  decryptBytesWithKey,
  decryptContentWithKey,
  encryptBytes,
  encryptBytesWithKey,
  encryptContentWithKey,
  encryptContent,
  isEncrypted,
} from './crypto'
import { storageDestroy, storageUpload } from './storage'

export interface RotationEnv {
  DB: D1Database
  MEMO_ENCRYPTION_KEY?: string
  [key: string]: unknown
}

export interface RotationDeps {
  fetchFn?: typeof fetch
  upload?: typeof storageUpload
  destroy?: typeof storageDestroy
}

export interface RotationCounts {
  memo_text: number
  memo_block: number
  google_token_row: number
  locked_file: number
}

export type RotationReport =
  | {
      ok: true
      dryRun: boolean
      mode: 'rotate' | 'rollback'
      /** 출발 키로 열려 전환 대상이었던 항목 (dry-run에서는 전환 예정 수) */
      pending: RotationCounts
      /** 이미 목표 키 상태라 건너뛴 항목 */
      already: RotationCounts
      /** 실제로 전환을 마친 항목 (dry-run에서는 0) */
      rotated: RotationCounts
      warnings: string[]
      census: RotationCounts
    }
  | {
      ok: false
      dryRun: boolean
      mode: 'rotate' | 'rollback'
      stage: 'preflight' | 'write'
      error: string
      /** preflight 실패 시: 어느 종류에서 몇 건이 출발 키로 열리지 않았는가 */
      failures?: Partial<Record<keyof RotationCounts, number>>
      census?: { expected: RotationCounts | null; live: RotationCounts }
      /** write 단계 실패 시: 그때까지 전환된 항목 (각자 자기 키로 읽히는 상태) */
      rotated?: RotationCounts
      warnings: string[]
    }

const emptyCounts = (): RotationCounts => ({
  memo_text: 0,
  memo_block: 0,
  google_token_row: 0,
  locked_file: 0,
})

const countsEqual = (a: RotationCounts, b: RotationCounts): boolean =>
  a.memo_text === b.memo_text && a.memo_block === b.memo_block &&
  a.google_token_row === b.google_token_row && a.locked_file === b.locked_file

export async function computeRotationCensus(env: RotationEnv): Promise<RotationCounts> {
  const census = emptyCounts()
  const memoRows = (
    await env.DB.prepare(
      "SELECT text, locked_blocks FROM memos WHERE text LIKE 'ENC%' OR locked_blocks LIKE '%ENC%'",
    ).all<{ text: string; locked_blocks: string | null }>()
  ).results ?? []
  for (const row of memoRows) {
    if (isEncrypted(row.text)) census.memo_text++
    try {
      const parsed = JSON.parse(row.locked_blocks || '[]')
      if (Array.isArray(parsed)) {
        for (const b of parsed) {
          if (b && typeof b.encrypted === 'string' && isEncrypted(b.encrypted)) census.memo_block++
        }
      }
    } catch {
    }
  }
  const googleRows = (
    await env.DB.prepare('SELECT access_token, refresh_token FROM google_integrations')
      .all<{ access_token: string; refresh_token: string }>()
  ).results ?? []
  for (const row of googleRows) {
    if ((row.access_token && isEncrypted(row.access_token)) || (row.refresh_token && isEncrypted(row.refresh_token))) {
      census.google_token_row++
    }
  }
  const fileRow = await env.DB.prepare('SELECT COUNT(*) AS n FROM files WHERE is_locked = 1').first<{ n: number }>()
  census.locked_file = fileRow?.n ?? 0
  return census
}

interface TextItem {
  kind: 'memo_text' | 'memo_block' | 'google'
  memoId?: number
  blockId?: string
  provider?: string
  /** 현재 저장된 암호문 (CAS 비교 + 복호화 입력) */
  stored: string
  /** 복호화한 평문 (메모리 안에서만 존재, 반환값에 넣지 않는다) */
  plain: string
  state: 'pending' | 'already'
}

interface FileItem {
  fileId: number
  url: string
  storageKey: string
  resourceType: string
  filename: string
  storedBytes: ArrayBuffer
  plainBytes: ArrayBuffer
  state: 'pending' | 'already'
}

/** 출발 키로 열리는지 → pending, 목표 키로 열리는지 → already, 둘 다 아니면 throw */
async function classifyText(
  stored: string,
  sourceKey: string | null,
  env: RotationEnv,
  targetKey: string,
): Promise<{ plain: string; state: 'pending' | 'already' }> {
  try {
    const plain = sourceKey
      ? await decryptContentWithKey(sourceKey, stored)
      : await decryptContentWithKey(env.MEMO_ENCRYPTION_KEY as string, stored)
    return { plain, state: 'pending' }
  } catch {
    // 출발 키 실패 — 이미 목표 키로 전환된 항목인지 확인
  }
  const plain = await decryptContentWithKey(targetKey, stored) // 실패하면 throw → preflight 실패
  return { plain, state: 'already' }
}

async function classifyBytes(
  stored: ArrayBuffer,
  sourceKey: string | null,
  env: RotationEnv,
  targetKey: string,
): Promise<{ plain: ArrayBuffer; state: 'pending' | 'already' }> {
  try {
    const plain = sourceKey
      ? await decryptBytesWithKey(sourceKey, stored)
      : await decryptBytesWithKey(env.MEMO_ENCRYPTION_KEY as string, stored)
    return { plain, state: 'pending' }
  } catch {
    // 목표 키 확인으로 폴백
  }
  const plain = await decryptBytesWithKey(targetKey, stored)
  return { plain, state: 'already' }
}

/**
 * 로테이션/롤백 실행.
 * - rotate: 출발 키 = env.MEMO_ENCRYPTION_KEY, 목표 키 = targetKeyMaterial (요청으로 받은 새 키), 산출물은 v2 형식.
 * - rollback: 출발 키 = sourceKeyMaterial (로테이션 때의 새 키, 요청으로 다시 받음), 목표 키 = env 키, 산출물은 v1 형식.
 */
export async function rotateEncryptionKey(
  env: RotationEnv,
  opts: {
    mode: 'rotate' | 'rollback'
    targetKeyMaterial?: string
    sourceKeyMaterial?: string
    dryRun?: boolean
    expectedCensus?: RotationCounts
  },
  deps: RotationDeps = {},
): Promise<RotationReport> {
  const dryRun = opts.dryRun === true
  const mode = opts.mode
  const warnings: string[] = []
  const fetchFn = deps.fetchFn ?? fetch
  const upload = deps.upload ?? storageUpload
  const destroy = deps.destroy ?? storageDestroy

  const envKey = env.MEMO_ENCRYPTION_KEY
  if (!envKey) {
    return { ok: false, dryRun, mode, stage: 'preflight', error: 'current_key_not_configured', warnings }
  }
  // rotate: 목표 = 새 키(인자), 출발 = env 키. rollback: 출발 = 인자 키, 목표 = env 키.
  const targetKey = mode === 'rotate' ? (opts.targetKeyMaterial as string) : envKey
  const sourceKey = mode === 'rotate' ? null : (opts.sourceKeyMaterial as string)
  if (!targetKey || (mode === 'rollback' && !sourceKey)) {
    return { ok: false, dryRun, mode, stage: 'preflight', error: 'key_material_missing', warnings }
  }
  if (mode === 'rotate' && targetKey === envKey) {
    return { ok: false, dryRun, mode, stage: 'preflight', error: 'new_key_same_as_current', warnings }
  }

  // ---------- 수집 ----------
  const memoRows = (
    await env.DB.prepare(
      "SELECT id, text, locked_blocks FROM memos WHERE text LIKE 'ENC%' OR locked_blocks LIKE '%ENC%'",
    ).all<{ id: number; text: string; locked_blocks: string | null }>()
  ).results ?? []
  const googleRows = (
    await env.DB.prepare('SELECT provider, access_token, refresh_token FROM google_integrations').all<{
      provider: string
      access_token: string
      refresh_token: string
    }>()
  ).results ?? []
  const fileRows = (
    await env.DB.prepare(
      'SELECT id, url, storage_key, resource_type, filename FROM files WHERE is_locked = 1',
    ).all<{ id: number; url: string; storage_key: string; resource_type: string; filename: string }>()
  ).results ?? []

  // ---------- preflight: 전 대상 복호화 검증 (쓰기 없음) ----------
  const failures: Partial<Record<keyof RotationCounts, number>> = {}
  const textItems: TextItem[] = []
  const blockGroups = new Map<number, { storedJson: string; blocks: any[]; items: TextItem[] }>()
  const googleGroups: { provider: string; storedAccess: string; storedRefresh: string; items: TextItem[] }[] = []
  const fileItems: FileItem[] = []

  const bumpFail = (k: keyof RotationCounts) => {
    failures[k] = (failures[k] ?? 0) + 1
  }

  for (const row of memoRows) {
    if (isEncrypted(row.text)) {
      try {
        const { plain, state } = await classifyText(row.text, sourceKey, env, targetKey)
        textItems.push({ kind: 'memo_text', memoId: row.id, stored: row.text, plain, state })
      } catch {
        bumpFail('memo_text')
      }
    }
    let blocks: any[] = []
    try {
      const parsed = JSON.parse(row.locked_blocks || '[]')
      if (Array.isArray(parsed)) blocks = parsed
    } catch {
      blocks = []
    }
    const encBlocks = blocks.filter((b: any) => b && typeof b.encrypted === 'string' && isEncrypted(b.encrypted))
    if (encBlocks.length) {
      const group = { storedJson: row.locked_blocks as string, blocks, items: [] as TextItem[] }
      for (const b of encBlocks) {
        try {
          const { plain, state } = await classifyText(b.encrypted, sourceKey, env, targetKey)
          const item: TextItem = { kind: 'memo_block', memoId: row.id, blockId: b.id, stored: b.encrypted, plain, state }
          group.items.push(item)
          textItems.push(item)
        } catch {
          bumpFail('memo_block')
        }
      }
      blockGroups.set(row.id, group)
    }
  }

  for (const row of googleRows) {
    const items: TextItem[] = []
    let rowFailed = false
    for (const [field, stored] of [
      ['access_token', row.access_token],
      ['refresh_token', row.refresh_token],
    ] as const) {
      if (!stored || !isEncrypted(stored)) continue
      try {
        const { plain, state } = await classifyText(stored, sourceKey, env, targetKey)
        items.push({ kind: 'google', provider: row.provider, stored, plain, state })
        void field
      } catch {
        rowFailed = true
      }
    }
    if (rowFailed) bumpFail('google_token_row')
    else if (items.length) {
      googleGroups.push({ provider: row.provider, storedAccess: row.access_token, storedRefresh: row.refresh_token, items })
    }
  }

  for (const row of fileRows) {
    try {
      const resp = await fetchFn(row.url)
      if (!resp.ok) throw new Error('download_failed')
      const storedBytes = await resp.arrayBuffer()
      const { plain, state } = await classifyBytes(storedBytes, sourceKey, env, targetKey)
      fileItems.push({
        fileId: row.id,
        url: row.url,
        storageKey: row.storage_key,
        resourceType: row.resource_type,
        filename: row.filename,
        storedBytes,
        plainBytes: plain,
        state,
      })
    } catch {
      bumpFail('locked_file')
    }
  }

  if (Object.keys(failures).length) {
    // 잘못된 키·손상된 암호문·다운로드 실패가 하나라도 있으면 시작하지 않는다.
    return { ok: false, dryRun, mode, stage: 'preflight', error: 'preflight_decrypt_failed', failures, warnings }
  }

  const pending = emptyCounts()
  const already = emptyCounts()
  for (const it of textItems) {
    const bucket = it.state === 'pending' ? pending : already
    if (it.kind === 'memo_text') bucket.memo_text++
    else if (it.kind === 'memo_block') bucket.memo_block++
  }
  for (const g of googleGroups) {
    // 행 단위 판정: 하나라도 pending이면 행 전체가 전환 대상 (두 토큰을 함께 교체)
    const bucket = g.items.some((i) => i.state === 'pending') ? pending : already
    bucket.google_token_row++
  }
  for (const f of fileItems) {
    ;(f.state === 'pending' ? pending : already).locked_file++
  }

  const census = await computeRotationCensus(env)
  if (dryRun) {
    return { ok: true, dryRun, mode, pending, already, rotated: emptyCounts(), warnings, census }
  }
  const totals: RotationCounts = {
    memo_text: pending.memo_text + already.memo_text,
    memo_block: pending.memo_block + already.memo_block,
    google_token_row: pending.google_token_row + already.google_token_row,
    locked_file: pending.locked_file + already.locked_file,
  }
  if (!opts.expectedCensus) {
    return {
      ok: false,
      dryRun,
      mode,
      stage: 'preflight',
      error: 'census_required',
      census: { expected: null, live: census },
      warnings,
    }
  }
  if (!countsEqual(opts.expectedCensus, census) || !countsEqual(totals, census)) {
    return {
      ok: false,
      dryRun,
      mode,
      stage: 'preflight',
      error: 'census_mismatch',
      census: { expected: opts.expectedCensus, live: census },
      warnings,
    }
  }

  // ---------- 쓰기: 항목 단위 CAS ----------
  const rotated = emptyCounts()
  /** 목표 키로 재암호화 (rotate=v2 형식, rollback=v1 형식으로 원형 복귀) */
  const reencryptText = async (plain: string): Promise<string> => {
    const out =
      mode === 'rotate'
        ? await encryptContentWithKey(targetKey, plain)
        : await encryptContent(env as any, plain)
    // 쓰기 전 왕복 검증: 목표 키로 다시 열리는지 확인하고 나서야 저장한다.
    const check = await decryptContentWithKey(targetKey, out)
    if (check !== plain) throw new Error('roundtrip_mismatch')
    return out
  }

  try {
    // 1) 메모 본문
    for (const it of textItems) {
      if (it.kind !== 'memo_text' || it.state !== 'pending') continue
      const next = await reencryptText(it.plain)
      const r = await env.DB.prepare('UPDATE memos SET text = ? WHERE id = ? AND text = ?')
        .bind(next, it.memoId, it.stored)
        .run()
      if ((r.meta?.changes ?? 0) !== 1) throw new Error('cas_conflict:memo_text')
      rotated.memo_text++
    }

    // 2) 잠긴 블록 — 메모 단위로 JSON 전체를 한 번에 교체 (블록끼리 키가 찢기지 않음)
    for (const [memoId, group] of blockGroups) {
      if (!group.items.some((i) => i.state === 'pending')) continue
      const byId = new Map(group.items.map((i) => [i.blockId, i]))
      const nextBlocks = group.blocks.map((b: any) => b) // 아래에서 교체
      for (let idx = 0; idx < nextBlocks.length; idx++) {
        const b = nextBlocks[idx]
        const item = b && byId.get(b.id)
        if (item && item.state === 'pending') {
          nextBlocks[idx] = { ...b, encrypted: await reencryptText(item.plain) }
        }
      }
      const nextJson = JSON.stringify(nextBlocks)
      const r = await env.DB.prepare('UPDATE memos SET locked_blocks = ? WHERE id = ? AND locked_blocks = ?')
        .bind(nextJson, memoId, group.storedJson)
        .run()
      if ((r.meta?.changes ?? 0) !== 1) throw new Error('cas_conflict:memo_block')
      rotated.memo_block += group.items.filter((i) => i.state === 'pending').length
    }

    // 3) Google 토큰 — access·refresh를 단일 UPDATE로 함께 교체
    for (const g of googleGroups) {
      if (!g.items.some((i) => i.state === 'pending')) continue
      const accessItem = g.items.find((i) => i.stored === g.storedAccess)
      const refreshItem = g.items.find((i) => i.stored === g.storedRefresh && i !== accessItem)
      const nextAccess = accessItem ? await reencryptText(accessItem.plain) : g.storedAccess
      const nextRefresh = refreshItem ? await reencryptText(refreshItem.plain) : g.storedRefresh
      const r = await env.DB.prepare(
        'UPDATE google_integrations SET access_token = ?, refresh_token = ? WHERE provider = ? AND access_token = ? AND refresh_token = ?',
      )
        .bind(nextAccess, nextRefresh, g.provider, g.storedAccess, g.storedRefresh)
        .run()
      if ((r.meta?.changes ?? 0) !== 1) throw new Error('cas_conflict:google_token_row')
      rotated.google_token_row++
    }

    // 4) 잠긴 첨부 — 새 객체 업로드 → 포인터 CAS 교체 → 구 객체 파괴
    for (const f of fileItems) {
      if (f.state !== 'pending') continue
      const nextBytes =
        mode === 'rotate'
          ? await encryptBytesWithKey(targetKey, f.plainBytes)
          : await encryptBytes(env as any, f.plainBytes)
      // 왕복 검증
      const check = await decryptBytesWithKey(targetKey, nextBytes)
      if (check.byteLength !== f.plainBytes.byteLength) throw new Error('roundtrip_mismatch:locked_file')

      const blob = new Blob([nextBytes], { type: 'application/octet-stream' })
      const file = new File([blob], f.filename + '.enc', { type: 'application/octet-stream' })
      const up = await upload(env as any, file, 'myhub/memo-encrypted')
      const r = await env.DB.prepare('UPDATE files SET url = ?, storage_key = ? WHERE id = ? AND storage_key = ?')
        .bind(up.secure_url, up.public_id, f.fileId, f.storageKey)
        .run()
      if ((r.meta?.changes ?? 0) !== 1) {
        // 포인터 교체 실패 — 방금 올린 새 객체를 정리하고 중단한다.
        await destroy(env as any, up.public_id, up.resource_type).catch(() => false)
        throw new Error('cas_conflict:locked_file')
      }
      rotated.locked_file++
      const destroyed = await destroy(env as any, f.storageKey, f.resourceType).catch(() => false)
      if (!destroyed) warnings.push(`old_object_destroy_failed:file:${f.fileId}`)
    }
  } catch (e) {
    // 중간 실패: 전환된 항목은 각자 자기 키로 읽히는 상태로 남는다.
    // 같은 요청 재실행(멱등)으로 마저 전환하거나 롤백으로 되돌릴 수 있다.
    return {
      ok: false,
      dryRun,
      mode,
      stage: 'write',
      error: e instanceof Error ? e.message : 'write_failed',
      rotated,
      warnings,
    }
  }

  return { ok: true, dryRun, mode, pending, already, rotated, warnings, census }
}
