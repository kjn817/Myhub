/**
 * 파인더 전역 검색 — 보관함 전체에서 폴더·파일 이름으로 찾는다.
 * 삭제된 폴더 아래 항목은 숨기고, 각 결과에 소속 폴더 경로를 붙인다.
 */

import type { Env } from '../../types'

export const DRIVE_SEARCH_MAX_LIMIT = 50
export const DRIVE_SEARCH_DEFAULT_LIMIT = 30

export interface DriveFolderRow {
  id: number
  name: string
  parent_id: number | null
  created_at: string
  deleted_at: string | null
}

export interface DrivePathSegment {
  id: number
  name: string
}

export interface DriveFolderHit {
  id: number
  name: string
  parent_id: number | null
  created_at: string
  path: DrivePathSegment[]
}

export interface DriveFileHit {
  id: number
  folder_id: number | null
  filename: string
  mime: string | null
  size: number
  url: string | null
  created_at: string
  version: string | null
  folder_name: string | null
  path: DrivePathSegment[]
}

export interface DriveSearchResult {
  query: string
  folders: DriveFolderHit[]
  files: DriveFileHit[]
  total: number
  truncated: boolean
}

function escapeLikePattern(q: string): string {
  return q.replace(/[\\%_]/g, (ch) => '\\' + ch)
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DRIVE_SEARCH_DEFAULT_LIMIT
  const n = Math.floor(raw)
  if (n < 1) return 1
  return Math.min(n, DRIVE_SEARCH_MAX_LIMIT)
}

function buildFolderIndex(folders: DriveFolderRow[]) {
  const byId = new Map<number, DriveFolderRow>()
  for (const f of folders) byId.set(f.id, f)
  const visibleCache = new Map<number, boolean>()
  const isVisible = (id: number): boolean => {
    const cached = visibleCache.get(id)
    if (cached !== undefined) return cached
    let cur: DriveFolderRow | undefined = byId.get(id)
    let ok = true
    const seen = new Set<number>()
    while (cur) {
      if (cur.deleted_at || seen.has(cur.id)) {
        ok = false
        break
      }
      seen.add(cur.id)
      if (cur.parent_id === null) break
      cur = byId.get(cur.parent_id)
      if (!cur) break
    }
    visibleCache.set(id, ok)
    return ok
  }
  const pathOf = (id: number | null): DrivePathSegment[] => {
    const chain: DrivePathSegment[] = []
    let cur: DriveFolderRow | undefined = id === null ? undefined : byId.get(id)
    const seen = new Set<number>()
    while (cur && !seen.has(cur.id) && chain.length < 100) {
      seen.add(cur.id)
      chain.unshift({ id: cur.id, name: cur.name })
      if (cur.parent_id === null) break
      cur = byId.get(cur.parent_id)
    }
    return chain
  }
  return { byId, isVisible, pathOf }
}

export async function searchDriveItems(db: D1Database, rawQuery: unknown, rawLimit?: number): Promise<DriveSearchResult> {
  const query = String(rawQuery || '').trim()
  const limit = clampLimit(rawLimit)
  const empty: DriveSearchResult = { query, folders: [], files: [], total: 0, truncated: false }
  if (!query) return empty
  const { results: folderRows } = await db.prepare('SELECT id, name, parent_id, created_at, deleted_at FROM drive_folders').all<DriveFolderRow>()
  const index = buildFolderIndex(folderRows)
  const needle = query.toLowerCase()
  const folderHits: DriveFolderHit[] = folderRows
    .filter((f) => !f.deleted_at && index.isVisible(f.id) && f.name.toLowerCase().includes(needle))
    .sort((a, b) => b.id - a.id)
    .map((f) => ({
      id: f.id,
      name: f.name,
      parent_id: f.parent_id,
      created_at: f.created_at,
      path: index.pathOf(f.parent_id),
    }))
  const pattern = '%' + escapeLikePattern(query) + '%'
  const { results: fileRows } = await db.prepare(
    `SELECT id, folder_id, storage_key, filename, mime, size, url, created_at
       FROM drive_files
       WHERE deleted_at IS NULL AND filename LIKE ? ESCAPE '\\'
       ORDER BY id DESC`
  ).bind(pattern).all<Record<string, any>>()
  const fileHits: DriveFileHit[] = fileRows
    .filter((f) => f.folder_id === null || index.isVisible(f.folder_id))
    .map((f) => ({
      id: f.id,
      folder_id: f.folder_id,
      filename: f.filename,
      mime: f.mime,
      size: f.size,
      url: f.url,
      created_at: f.created_at,
      version: f.storage_key,
      folder_name: f.folder_id === null ? null : index.byId.get(f.folder_id)?.name ?? null,
      path: index.pathOf(f.folder_id),
    }))
  const total = folderHits.length + fileHits.length
  const merged: Array<{ id: number; folder?: DriveFolderHit; file?: DriveFileHit }> = [
    ...folderHits.map((h) => ({ id: h.id, folder: h })),
    ...fileHits.map((h) => ({ id: h.id, file: h })),
  ].sort((a, b) => b.id - a.id)
  const kept = merged.slice(0, limit)
  const folders = kept.filter((k) => k.folder).map((k) => k.folder!)
  const files = kept.filter((k) => k.file).map((k) => k.file!)
  return {
    query,
    folders,
    files,
    total,
    truncated: total > folders.length + files.length,
  }
}

export async function executeFileSearch(
  env: Env,
  query: unknown
): Promise<{ success: true; data: DriveSearchResult } | { success: false; error: string }> {
  const q = String(query || '').trim()
  if (!q) return { success: false, error: '검색어가 비어 있습니다' }
  try {
    const data = await searchDriveItems(env.DB, q)
    return { success: true, data }
  } catch (e) {
    return { success: false, error: String(e).slice(0, 200) }
  }
}
