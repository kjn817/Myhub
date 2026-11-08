/// <reference types="jest" />
/**
 * src/modules/drive/search.ts — 파인더 전역 검색 성질 테스트 (C3).
 *
 * 실제 SQLite(local-d1 + 0067 실마이그레이션)로 고정하는 성질:
 * - 삭제된 폴더 아래 항목(하위 폴더·파일)은 결과에서 사라지고, 살아 있는
 *   항목에는 루트부터의 경로(path)와 소속 폴더명이 정확히 붙는다.
 * - LIKE 이스케이프: 검색어의 %, _, \는 와일드카드가 아니라 문자 그대로
 *   매칭된다 (예: 'a_b'는 'axb'를 찾지 않는다).
 * - 상한 계약: limit은 1..50으로 clamp되고(기본 30), 폴더·파일을 id 내림차순
 *   으로 합친 뒤 자르며, total/truncated가 절단을 정직하게 보고한다.
 * - 폴더 부모 순환 같은 깨진 데이터에서도 무한 루프 없이 숨김 처리된다.
 * 카나리아: 이스케이프나 가시성 판정을 깨면 해당 테스트가 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'
import { searchDriveItems, executeFileSearch, DRIVE_SEARCH_MAX_LIMIT } from '../../src/modules/drive/search'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createLocalD1 } = require('../helpers/local-d1.cjs')

const ROOT = path.join(__dirname, '..', '..')
const mig = (n: string) => fs.readFileSync(path.join(ROOT, 'migrations', n), 'utf8')

function makeDb() {
  const db = createLocalD1()
  db.exec(mig('0067_drive_storage.sql'))
  return db
}

async function seedFolder(db: any, name: string, parentId: number | null = null, deleted = false): Promise<number> {
  const r = await db.prepare('INSERT INTO drive_folders (name, parent_id, deleted_at) VALUES (?, ?, ?)')
    .bind(name, parentId, deleted ? '2026-01-01T00:00:00Z' : null).run()
  return Number(r.meta.last_row_id)
}

async function seedFile(db: any, filename: string, folderId: number | null = null, opts: { deleted?: boolean; key?: string } = {}): Promise<number> {
  const r = await db.prepare(
    'INSERT INTO drive_files (folder_id, storage_key, filename, mime, size, url, resource_type, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(folderId, opts.key ?? `key/${filename}`, filename, 'text/plain', 10, `https://files.example/${filename}`, 'raw', opts.deleted ? '2026-01-01T00:00:00Z' : null).run()
  return Number(r.meta.last_row_id)
}

/** 문서(루트) > 프로젝트 구조와 휴지통 폴더를 심는다 */
async function seedTree(db: any) {
  const docs = await seedFolder(db, '문서')
  const proj = await seedFolder(db, '프로젝트', docs)
  const trash = await seedFolder(db, '버린폴더', null, true)
  const hiddenChild = await seedFolder(db, '숨은폴더', trash)
  const reportInProj = await seedFile(db, '보고서.pdf', proj, { key: 'key/report-v1' })
  const reportRoot = await seedFile(db, '보고서 초안.docx', null)
  const hiddenFile = await seedFile(db, '숨은파일.txt', hiddenChild)
  const deletedFile = await seedFile(db, '지운파일.txt', proj, { deleted: true })
  return { docs, proj, trash, hiddenChild, reportInProj, reportRoot, hiddenFile, deletedFile }
}

describe('searchDriveItems — 가시성과 경로', () => {
  test('삭제된 폴더 아래 폴더·파일은 숨고, 살아 있는 파일에는 경로와 폴더명이 붙는다', async () => {
    const db = makeDb()
    const t = await seedTree(db)
    const hidden = await searchDriveItems(db, '숨은')
    expect(hidden.total).toBe(0)
    expect(hidden.folders).toEqual([])
    expect(hidden.files).toEqual([])

    const r = await searchDriveItems(db, '보고서')
    expect(r.total).toBe(2)
    const inProj = r.files.find((f) => f.id === t.reportInProj)!
    expect(inProj.folder_name).toBe('프로젝트')
    expect(inProj.path).toEqual([
      { id: t.docs, name: '문서' },
      { id: t.proj, name: '프로젝트' },
    ])
    expect(inProj.version).toBe('key/report-v1')
    const atRoot = r.files.find((f) => f.id === t.reportRoot)!
    expect(atRoot.folder_name).toBeNull()
    expect(atRoot.path).toEqual([])
  })

  test('삭제된 파일 자체는 검색되지 않는다', async () => {
    const db = makeDb()
    await seedTree(db)
    const r = await searchDriveItems(db, '지운파일')
    expect(r.total).toBe(0)
  })

  test('폴더 히트의 path는 부모 체인(자기 제외)이고 대소문자를 가리지 않는다', async () => {
    const db = makeDb()
    const t = await seedTree(db)
    const r = await searchDriveItems(db, '프로젝트')
    expect(r.folders).toHaveLength(1)
    expect(r.folders[0].id).toBe(t.proj)
    expect(r.folders[0].path).toEqual([{ id: t.docs, name: '문서' }])
    const upper = await searchDriveItems(db, 'PDF')
    expect(upper.files.map((f) => f.filename)).toEqual(['보고서.pdf'])
  })

  test('빈 검색어·공백 검색어는 빈 결과를 돌려주고 DB를 조회하지 않는다', async () => {
    const db = makeDb()
    await seedTree(db)
    for (const q of ['', '   ', null, undefined]) {
      const r = await searchDriveItems(db, q)
      expect(r).toEqual({ query: '', folders: [], files: [], total: 0, truncated: false })
    }
  })

  test('부모 순환이 있어도 무한 루프 없이 순환 폴더를 숨긴다', async () => {
    const db = makeDb()
    const a = await seedFolder(db, '순환에이')
    const b = await seedFolder(db, '순환비', a)
    await db.prepare('UPDATE drive_folders SET parent_id = ? WHERE id = ?').bind(b, a).run()
    await seedFile(db, '순환파일.txt', a)
    const r = await searchDriveItems(db, '순환')
    expect(r.total).toBe(0)
  })
})

describe('searchDriveItems — LIKE 이스케이프', () => {
  test('%와 _는 와일드카드가 아니라 문자 그대로 매칭된다', async () => {
    const db = makeDb()
    await seedFile(db, '100% 할인.txt')
    await seedFile(db, '1000 할인.txt')
    await seedFile(db, 'a_b.txt')
    await seedFile(db, 'axb.txt')
    await seedFile(db, '백슬래시\\.txt')

    const pct = await searchDriveItems(db, '100%')
    expect(pct.files.map((f) => f.filename)).toEqual(['100% 할인.txt'])
    const under = await searchDriveItems(db, 'a_b')
    expect(under.files.map((f) => f.filename)).toEqual(['a_b.txt'])
    const back = await searchDriveItems(db, '\\')
    expect(back.files.map((f) => f.filename)).toEqual(['백슬래시\\.txt'])
  })
})

describe('searchDriveItems — 상한과 병합 순서', () => {
  test('기본 상한 30: total은 전체, truncated=true, 반환은 30건', async () => {
    const db = makeDb()
    for (let i = 0; i < 35; i++) await seedFile(db, `공통파일 ${String(i).padStart(2, '0')}.txt`)
    const r = await searchDriveItems(db, '공통파일')
    expect(r.total).toBe(35)
    expect(r.truncated).toBe(true)
    expect(r.folders.length + r.files.length).toBe(30)
    // id 내림차순이므로 가장 최근 파일이 첫 결과다
    expect(r.files[0].filename).toBe('공통파일 34.txt')
  })

  test('limit clamp: 0 이하→1, 과대→50, NaN→기본 30', async () => {
    const db = makeDb()
    for (let i = 0; i < 55; i++) await seedFile(db, `한도파일 ${i}.txt`)
    const one = await searchDriveItems(db, '한도파일', 0)
    expect(one.files).toHaveLength(1)
    const capped = await searchDriveItems(db, '한도파일', 9999)
    expect(capped.files).toHaveLength(DRIVE_SEARCH_MAX_LIMIT)
    expect(capped.truncated).toBe(true)
    const nan = await searchDriveItems(db, '한도파일', Number.NaN)
    expect(nan.files).toHaveLength(30)
    const exact = await searchDriveItems(db, '한도파일', 55)
    expect(exact.files).toHaveLength(50)
  })

  test('폴더와 파일은 합쳐서 id 내림차순으로 자른다 (버킷별 절단 아님)', async () => {
    const db = makeDb()
    // 폴더·파일은 별도 테이블이라 id 공간이 다르다 — 명시 id로 순서를 고정한다.
    await db.prepare('INSERT INTO drive_folders (id, name, parent_id) VALUES (?, ?, ?)').bind(10, '합병 폴더', null).run()
    await db.prepare('INSERT INTO drive_files (id, folder_id, storage_key, filename, mime, size, url, resource_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(20, null, 'key/mid', '합병 파일.txt', 'text/plain', 1, 'https://f/mid', 'raw').run()
    await db.prepare('INSERT INTO drive_folders (id, name, parent_id) VALUES (?, ?, ?)').bind(30, '합병 새폴더', null).run()
    const r = await searchDriveItems(db, '합병', 1)
    expect(r.total).toBe(3)
    expect(r.truncated).toBe(true)
    // 가장 큰 id는 새 폴더 — 폴더 버킷에만 남는다
    expect(r.folders.map((f) => f.id)).toEqual([30])
    expect(r.files).toEqual([])
    const r2 = await searchDriveItems(db, '합병', 2)
    expect(r2.folders.map((f) => f.id)).toEqual([30])
    expect(r2.files.map((f) => f.id)).toEqual([20])
    const r3 = await searchDriveItems(db, '합병', 3)
    expect(r3.folders.map((f) => f.id)).toEqual([30, 10])
    expect(r3.truncated).toBe(false)
  })
})

describe('executeFileSearch — 비서 도구 계약', () => {
  test('빈 검색어는 success=false와 이유를 돌려준다', async () => {
    const db = makeDb()
    const r = await executeFileSearch({ DB: db } as never, '   ')
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error).toContain('검색어')
  })

  test('정상 검색은 success=true와 결과를 감싸 돌려준다', async () => {
    const db = makeDb()
    await seedTree(db)
    const r = await executeFileSearch({ DB: db } as never, '보고서')
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.total).toBe(2)
  })

  test('DB 오류는 예외가 아니라 success=false로 표면화되고 200자로 잘린다', async () => {
    const broken = {
      prepare: () => { throw new Error('x'.repeat(500)) },
    }
    const r = await executeFileSearch({ DB: broken } as never, '보고서')
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.length).toBeLessThanOrEqual(200)
  })
})
