/**
 * 백업 상태 기록 — 발급 이력을 ai_settings에 남기고 최신성(stale)을 판정한다.
 * 정기 백업만 복원 가능으로 세며, 드릴·테스트 백업은 제외한다.
 */

import type { Env } from '../../types'

export type BackupKind = 'regular' | 'drill' | 'test'

export interface BackupRecord {
  createdAt: string
  kind: BackupKind
  totalRows: number
  tableCount: number
  attachmentsIncluded: boolean
}

export interface BackupStatus {
  exists: boolean
  latestAt: string | null
  ageDays: number | null
  stale: boolean
  regularCount: number
  excludedCount: number
  totalRecords: number
}

export interface BackupFreshnessCheck {
  checkedAt: string
  exists: boolean
  stale: boolean
  ageDays: number | null
  latestAt: string | null
  regularCount: number
  latestAttachmentsIncluded: boolean | null
}

const BACKUP_RECORDS_KEY = 'backup.records.v1'
const MAX_RECORDS = 50
const BACKUP_STALE_DAYS = 35

export function normalizeBackupKind(kind: unknown): BackupKind {
  return kind === 'drill' || kind === 'test' ? kind : 'regular'
}

function isValidRecord(r: any): r is BackupRecord {
  return !!r && typeof r === 'object' && typeof r.createdAt === 'string' && !Number.isNaN(Date.parse(r.createdAt)) && (r.kind === 'regular' || r.kind === 'drill' || r.kind === 'test') && typeof r.totalRows === 'number' && typeof r.tableCount === 'number' && typeof r.attachmentsIncluded === 'boolean'
}

export function summarizeBackupStatus(records: BackupRecord[], now: Date = new Date()): BackupStatus {
  const regular = records.filter((r) => r.kind === 'regular')
  let latest: BackupRecord | null = null
  for (const r of regular) {
    if (!latest || r.createdAt > latest.createdAt) latest = r
  }
  const ageDays = latest ? Math.max(0, Math.floor((now.getTime() - Date.parse(latest.createdAt)) / 86400000)) : null
  return {
    exists: latest !== null,
    latestAt: latest ? latest.createdAt : null,
    ageDays,
    stale: latest === null || (ageDays !== null && ageDays > BACKUP_STALE_DAYS),
    regularCount: regular.length,
    excludedCount: records.length - regular.length,
    totalRecords: records.length,
  }
}

export function buildBackupReminderText(status: BackupStatus): string {
  if (!status.exists) {
    return `백업 확인 결과: 복원 가능한 정기 백업이 아직 없습니다. (백업 발급 기록 ${status.totalRecords}건 중 정기 백업 0건 — 드릴·테스트 백업은 복원용으로 세지 않습니다.) 이번 달 정기 백업을 만들어 주세요: MyHub 백업 페이지에서 본인 암호로 암호화 백업을 생성해 파일을 안전하게 보관해 주세요.`
  }
  if (status.stale) {
    return `백업 확인 결과: 마지막 정기 백업이 ${status.ageDays}일 전(${status.latestAt})이라 오래됐습니다. 새 정기 백업을 만들어 주세요: MyHub 백업 페이지에서 본인 암호로 암호화 백업을 생성해 파일을 안전하게 보관해 주세요.`
  }
  return `백업 확인 결과: 정기 백업이 ${status.ageDays}일 전(${status.latestAt})에 있어 최신 상태입니다.`
}

export async function listBackupRecords(env: Env): Promise<BackupRecord[]> {
  try {
    const row = await env.DB.prepare('SELECT value FROM ai_settings WHERE key = ?').bind(BACKUP_RECORDS_KEY).first<{ value: string }>()
    if (!row?.value) return []
    const parsed = JSON.parse(row.value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidRecord)
  } catch {
    return []
  }
}

export async function recordBackupCreation(
  env: Env,
  input: { createdAt?: string; kind?: unknown; totalRows: number; tableCount: number; attachmentsIncluded: boolean }
): Promise<boolean> {
  try {
    const records = await listBackupRecords(env)
    records.push({
      createdAt: input.createdAt ?? new Date().toISOString(),
      kind: normalizeBackupKind(input.kind),
      totalRows: input.totalRows,
      tableCount: input.tableCount,
      attachmentsIncluded: input.attachmentsIncluded,
    })
    const trimmed = records.slice(-MAX_RECORDS)
    await env.DB.prepare(
      "INSERT OR REPLACE INTO ai_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    ).bind(BACKUP_RECORDS_KEY, JSON.stringify(trimmed)).run()
    return true
  } catch {
    return false
  }
}

export async function getBackupStatus(env: Env, now: Date = new Date()): Promise<{ status: BackupStatus; records: BackupRecord[] }> {
  const records = await listBackupRecords(env)
  return { status: summarizeBackupStatus(records, now), records }
}

const BACKUP_FRESHNESS_KEY = 'backup.freshness.v1'

export function buildFreshnessCheck(records: BackupRecord[], now: Date = new Date()): BackupFreshnessCheck {
  const status = summarizeBackupStatus(records, now)
  let latest: BackupRecord | null = null
  for (const r of records) {
    if (r.kind !== 'regular') continue
    if (!latest || r.createdAt > latest.createdAt) latest = r
  }
  return {
    checkedAt: now.toISOString(),
    exists: status.exists,
    stale: status.stale,
    ageDays: status.ageDays,
    latestAt: status.latestAt,
    regularCount: status.regularCount,
    latestAttachmentsIncluded: latest ? latest.attachmentsIncluded : null,
  }
}

export async function recordBackupFreshnessCheck(env: Env, now: Date = new Date()): Promise<BackupFreshnessCheck> {
  const records = await listBackupRecords(env)
  const check = buildFreshnessCheck(records, now)
  await env.DB.prepare(
    "INSERT OR REPLACE INTO ai_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
  ).bind(BACKUP_FRESHNESS_KEY, JSON.stringify(check)).run()
  return check
}

export async function getBackupFreshnessCheck(env: Env): Promise<BackupFreshnessCheck | null> {
  try {
    const row = await env.DB.prepare('SELECT value FROM ai_settings WHERE key = ?').bind(BACKUP_FRESHNESS_KEY).first<{ value: string }>()
    if (!row?.value) return null
    const parsed = JSON.parse(row.value)
    if (!parsed || typeof parsed !== 'object' || typeof parsed.checkedAt !== 'string') return null
    return parsed as BackupFreshnessCheck
  } catch {
    return null
  }
}
