/**
 * 메모 검색 FTS5 전환 실런타임 테스트 (P-2, perf-audit-20261028 §3.1·§6 #2).
 *
 * Mock D1으로는 검증하지 못하는 것 — 실제 workerd SQLite에서의 동작:
 * - 마이그레이션 0059의 trigram FTS 테이블 생성 + 트리거 인덱싱
 * - 한국어 부분 검색이 실제로 FTS 경로(trigram)로 찾아지는지
 * - 기존 LIKE 폴백 결과와 새 경로 결과의 집합 동등성 (회귀 방지)
 * - EXPLAIN QUERY PLAN으로 FTS 인덱스 사용 확인 (본문 전수 스캔 아님)
 * - fileCount가 LEFT JOIN 집계 1회로 동작하는지
 *
 * 운영 DB·운영 배포·OTP 라이브 호출 없음. D1은 테스트 파일마다 격리된
 * 로컬 SQLite이다 (vitest.config.ts).
 */
import { env } from 'cloudflare:workers'
import { Hono } from 'hono'
import { beforeAll, describe, expect, it } from 'vitest'
import { memoApp } from '../../src/modules/memo/routes'
import { applyAllMigrations, testDb } from './helpers/apply-migrations'

const testEnv = env as unknown as { DB: D1Database; KV: KVNamespace; CLOUDINARY_CLOUD_NAME: string }

const app = new Hono()
app.route('/a', memoApp)

async function search(q: string, extra = ''): Promise<any[]> {
  const res = await app.request(`/a?q=${encodeURIComponent(q)}${extra}`, { method: 'GET' }, testEnv)
  expect(res.status).toBe(200)
  return (await res.json()) as any[]
}

const ids = (rows: any[]) => [...new Set(rows.map((r) => r.id))].sort((a, b) => a - b)

/** 구(舊) LIKE 폴백 의미 그대로의 기대 집합 (직접 SQL — 라우트와 무관하게 계산). */
async function likeExpected(q: string): Promise<number[]> {
  const db = testDb()
  const nospace = q.replace(/\s+/g, '')
  const { results } = await db
    .prepare(
      `SELECT m.id FROM memos m WHERE m.is_locked = 0 AND m.sensitivity < 2
       AND (m.text LIKE ? OR REPLACE(m.text, ' ', '') LIKE ?
         OR EXISTS (SELECT 1 FROM files f WHERE f.memo_id = m.id AND f.filename LIKE ?))`,
    )
    .bind(`%${q}%`, `%${nospace}%`, `%${q}%`)
    .all<{ id: number }>()
  return ids(results || [])
}

describe('memo search FTS (miniflare)', () => {
  beforeAll(async () => {
    const result = await applyAllMigrations()
    expect(result.failed).toHaveLength(0)

    const db = testDb()
    // 시드 메모 (INSERT가 트리거를 태워 memos_fts + memos_fts_tri를 채운다)
    const memos: [string, number, number][] = [
      ['대한민국 서울 여행 계획', 0, 0], // 1
      ['한국어 공부를 시작하다', 0, 0], // 2
      ['오늘 점심은 김치찌개', 0, 0], // 3
      ['회의록: 프로젝트 킥오프', 0, 0], // 4
      ['MyHub 개발 메모입니다', 0, 0], // 5
      ['서울 김치찌개 맛집', 0, 0], // 6
      ['ENC:deadbeefcafebabe', 1, 0], // 7 잠긴 메모 (암호문) — 인덱싱 제외
      ['기밀 메모 대외비', 0, 2], // 8 기밀 — 인덱싱 제외
    ]
    for (const [text, locked, sens] of memos) {
      await db
        .prepare('INSERT INTO memos (text, is_locked, sensitivity) VALUES (?, ?, ?)')
        .bind(text, locked, sens)
        .run()
    }
    // 파일: 메모 1에 2개, 메모 3에 1개 (fileCount 검증 + 파일명 검색)
    await db
      .prepare("INSERT INTO files (memo_id, storage_key, filename) VALUES (1, 'k1', '여행계획서.pdf')")
      .run()
    await db
      .prepare("INSERT INTO files (memo_id, storage_key, filename) VALUES (1, 'k2', 'budget.xlsx')")
      .run()
    await db
      .prepare("INSERT INTO files (memo_id, storage_key, filename) VALUES (3, 'k3', 'kimchi.jpg')")
      .run()
    // 태그: 메모 1에만 work
    await db.prepare("INSERT INTO memo_tags (memo_id, tag) VALUES (1, 'work')").run()
  })

  it('0059: memos_fts_tri가 있고 잠금·기밀 메모는 인덱싱되지 않는다', async () => {
    const db = testDb()
    const { results } = await db
      .prepare('SELECT rowid FROM memos_fts_tri ORDER BY rowid')
      .all<{ rowid: number }>()
    expect(ids((results || []).map((r) => ({ id: r.rowid })))).toEqual([1, 2, 3, 4, 5, 6])
    // 잠긴 메모의 trigram 인덱스 부재 (FTS 경계)
    const locked = await db
      .prepare('SELECT COUNT(*) AS n FROM memos_fts_tri WHERE rowid = 7')
      .first<{ n: number }>()
    expect(locked?.n).toBe(0)
    const secret = await db
      .prepare('SELECT COUNT(*) AS n FROM memos_fts_tri WHERE rowid = 8')
      .first<{ n: number }>()
    expect(secret?.n).toBe(0)
  })

  it('토큰 정확 검색: FTS 1차 경로', async () => {
    expect(ids(await search('대한민국'))).toEqual([1])
    expect(ids(await search('서울'))).toEqual([1, 6])
    expect(ids(await search('MyHub'))).toEqual([5])
  })

  it('한국어 부분 검색 (3글자 이상): trigram이 LIKE와 같은 결과를 낸다', async () => {
    // 토큰 중간 부분 ('김치찌' → '김치찌개')
    expect(ids(await search('김치찌'))).toEqual([3, 6])
    // 공백을 가로지르는 부분 ('민국서' → '대한민국 서울'의 공백 제거형)
    expect(ids(await search('민국서'))).toEqual([1])
    // 접미사 부분 ('오프' 아님 — 2글자는 아래 LIKE 테스트에서 다룬다)
    expect(ids(await search('킥오프'))).toEqual([4])
  })

  it('공백 없는 검색어: 공백 제거 컬럼으로 찾는다', async () => {
    expect(ids(await search('여행계획'))).toEqual([1])
    expect(ids(await search('서울김치찌개'))).toEqual([6])
  })

  it('구 검색: 공백 포함 구도 찾는다', async () => {
    expect(ids(await search('서울 여행'))).toEqual([1])
  })

  it('2글자 검색어: LIKE 폴백이 이전과 같은 결과를 낸다', async () => {
    // '한국' → '한국어'만 찾는다. '대한민국'에는 '한국'이 연속 부분 문자열로
    // 없다 (대한+민국) — LIKE 기대와 일치하는지 동등성 테스트가 따로 검증한다.
    expect(ids(await search('한국'))).toEqual([2])
    // '민국' → '대한민국' 안의 중간 부분 (FTS prefix/trigram으로는 못 찾음)
    expect(ids(await search('민국'))).toEqual([1])
    // '공부' → '공부를' 안의 앞부분
    expect(ids(await search('공부'))).toEqual([2])
    // '오프' → '킥오프' 안의 뒷부분
    expect(ids(await search('오프'))).toEqual([4])
  })

  it('1글자 검색어: LIKE 폴백', async () => {
    expect(ids(await search('한'))).toEqual([1, 2])
  })

  it('파일명 검색: 본문에 없어도 파일명으로 찾는다', async () => {
    // '계획서'는 어떤 메모 본문에도 없다 — 파일 '여행계획서.pdf'만 가짐
    expect(ids(await search('계획서'))).toEqual([1])
  })

  it('태그 필터가 검색 전 단계에 그대로 적용된다', async () => {
    expect(ids(await search('대한민국', '&tag=work'))).toEqual([1])
    expect(ids(await search('김치찌', '&tag=work'))).toEqual([])
  })

  it('fileCount: LEFT JOIN 집계 — 2개·1개·0개가 정확하다', async () => {
    const res = await app.request('/a', { method: 'GET' }, testEnv)
    expect(res.status).toBe(200)
    const rows = (await res.json()) as any[]
    const byId = new Map(rows.map((r) => [r.id, r.file_count]))
    expect(byId.get(1)).toBe(2)
    expect(byId.get(3)).toBe(1)
    expect(byId.get(2)).toBe(0)
    // 검색 결과에도 file_count가 붙는다
    const found = await search('김치찌개')
    expect(found.find((r) => r.id === 3)?.file_count).toBe(1)
  })

  it('잠금·기밀 메모는 검색에 나오지 않는다 (0030 경계가 LIKE 우회를 닫음)', async () => {
    // 기밀 메모 평문 '대외비'는 구 LIKE 폴백이면 나왔을 결과다
    expect(ids(await search('대외비'))).toEqual([])
    expect(ids(await search('기밀'))).toEqual([])
    // 짧은 검색어 LIKE 단계에도 잠금·기밀 필터가 적용된다
    expect(ids(await search('대외'))).toEqual([])
  })

  it('동등성: 임의 질의 집합에서 새 경로 결과 = 구 LIKE 폴백 기대 집합', async () => {
    // FTS 정확 일치 ⊆ LIKE 이므로, 구 전체 흐름의 합집합은 LIKE 기대와 같다.
    // (잠금·기밀 메모는 양쪽 기대에서 제외 — likeExpected도 같은 필터를 쓴다.)
    const queries = [
      '대한민국', '서울', '한국', '민국', '김치', '김치찌', '김치찌개',
      '여행계획', '여행 계획', '서울 김치', '킥오프', '오프', '공부',
      'MyHub', 'Hub', '개발', '메모', '한', '회의록', '프로젝트',
    ]
    for (const q of queries) {
      expect(ids(await search(q))).toEqual(await likeExpected(q))
    }
  })

  it('EXPLAIN QUERY PLAN: FTS·trigram 쿼리가 인덱스를 탄다 (본문 전수 스캔 아님)', async () => {
    const db = testDb()
    const plan = async (sql: string, ...params: unknown[]) => {
      const { results } = await db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...params)
        .all<{ detail: string }>()
      return (results || []).map((r) => r.detail)
    }
    // 'SCAN m'은 memos 테이블 전수 스캔 행이다 ('SCAN memos_fts…'와 구분 —
    // 부분문자열 검사가 아니라 행 단위로 판정한다).
    const scansMemos = (lines: string[]) => lines.some((l) => l === 'SCAN m')
    // 1) FTS 1차 쿼리 (라우트와 같은 FROM/WHERE — fileCount JOIN 포함)
    const ftsPlan = await plan(
      `SELECT m.id, m.text, COALESCE(fc.n, 0) AS file_count
       FROM memos_fts fts JOIN memos m ON m.id = fts.rowid
       LEFT JOIN (SELECT memo_id, COUNT(*) AS n FROM files GROUP BY memo_id) fc ON fc.memo_id = m.id
       WHERE memos_fts MATCH ? ORDER BY rank LIMIT 50`,
      '"대한민국"',
    )
    expect(ftsPlan.join('\n')).toContain('SCAN fts VIRTUAL TABLE INDEX')
    expect(scansMemos(ftsPlan)).toBe(false)
    // 2) trigram 부분 검색 쿼리
    const triPlan = await plan(
      `SELECT m.id, m.text, COALESCE(fc.n, 0) AS file_count
       FROM memos_fts_tri tri JOIN memos m ON m.id = tri.rowid
       LEFT JOIN (SELECT memo_id, COUNT(*) AS n FROM files GROUP BY memo_id) fc ON fc.memo_id = m.id
       WHERE memos_fts_tri MATCH ? ORDER BY m.id DESC LIMIT 50`,
      'text:"김치찌" OR text_nospace:"김치찌"',
    )
    expect(triPlan.join('\n')).toContain('SCAN tri VIRTUAL TABLE INDEX')
    expect(scansMemos(triPlan)).toBe(false)
    // 3) fileCount 집계는 files 1회 스캔으로 구체화된다 (행별 상관 서브쿼리 없음)
    expect(ftsPlan.join('\n')).toContain('MATERIALIZE fc')
    // 4) 짧은 검색어 LIKE 단계는 여전히 memos 스캔이다 — 남는 한계를 증거로 남긴다
    const likePlan = await plan(
      `SELECT m.id FROM memos m
       LEFT JOIN (SELECT memo_id, COUNT(*) AS n FROM files GROUP BY memo_id) fc ON fc.memo_id = m.id
       WHERE m.is_locked = 0 AND m.sensitivity < 2
       AND (m.text LIKE ? OR REPLACE(m.text, ' ', '') LIKE ?) ORDER BY m.id DESC LIMIT 50`,
      '%한국%',
      '%한국%',
    )
    expect(scansMemos(likePlan)).toBe(true)
  })
})
