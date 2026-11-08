/// <reference types="jest" />

/**
 * 에코 메모 제목 검색 테스트 (2026-11-07 결함 기록 + 번들 계약)
 *
 * 운영 실측 결함: 본문 문구("후생동 강당")로는 찾는데 제목으로는 못 찾는
 * SEARCH_EMPTY. AI 검색 경로(searchAccessibleMemos)는 FTS 정확 토큰 +
 * 원문 그대로 LIKE뿐이라 질의 형태가 조금만 달라도(공백 없음·구분자 없는
 * 전화번호·제로폭 문자) 제목을 놓친다.
 *
 * 번들 계약 (2026-11-08 사용자 결정으로 원본 복귀): 정규화 매칭 단계는
 * 원본에 없으므로, 아래 테스트들은 원본 동작(결함 상태 포함)을 고정한다 —
 * 공백 없는 제목·구분자 없는 전화번호·제로폭 제목 질의는 빈 결과,
 * 조사 '도' 분리로 '강원도'는 '강원' 토큰이 되는 것이 원본 계약이다.
 *
 * Mock D1으로는 FTS5/trigram 의미론을 검증할 수 없어 실DB(better-sqlite3)에
 * 실제 마이그레이션(0001 + 0030 + 0059)을 적용해 검증한다
 * (tests/ai-metrics.test.ts의 실DB 방식과 동일).
 */

import * as fs from 'fs'
import * as path from 'path'
import { searchAccessibleMemos } from '../../src/services/ai-access'
import { extractMemoKeywords } from '../../src/services/memo-target-resolver'
import { detectMemoSearchIntent } from '../../src/modules/ai/prompt-helpers'
import { unifiedSearch } from '../../src/services/unified-search'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createLocalD1 } = require('../helpers/local-d1.cjs')

const ROOT = path.join(__dirname, '..', '..')
const mig = (n: string) => fs.readFileSync(path.join(ROOT, 'migrations', n), 'utf8')
const ZW = '​' // U+200B zero-width space

function makeDb() {
  const db = createLocalD1()
  db.exec(mig('0001_init.sql'))
  // 0013·0015·0069 중 memos 관련 ALTER만 적용 (files ALTER는 검색과 무관)
  db.exec(
    "ALTER TABLE memos ADD COLUMN is_locked INTEGER DEFAULT 0; " +
      "ALTER TABLE memos ADD COLUMN sensitivity INTEGER DEFAULT 1; " +
      "ALTER TABLE memos ADD COLUMN locked_blocks TEXT DEFAULT '[]'; " +
      'ALTER TABLE memos ADD COLUMN title_hint TEXT;'
  )
  db.exec(mig('0030_fts_d1_compat.sql'))
  db.exec(mig('0059_memo_fts_trigram.sql'))
  return db
}

const TARGET_TEXT = [
  '강원도 차량관리팀 033-+249-2336',
  '',
  '후생동 강당 대관 관련 문의 전화. 12월 8일은 예약이 불가하다고 안내받음.',
  '차량 배차 신청은 전날까지 접수.',
].join('\n')

async function seed(db: any): Promise<void> {
  const rows: Array<[string, number, number]> = [
    [TARGET_TEXT, 0, 1], // 1: 대상 메모 (운영 결함 메모와 같은 형태)
    ['서울시 차량관리팀 회의 메모\n내부 회의 일정 정리', 0, 1], // 2: 부분 겹침 방해
    ['잠금전용표제어 모음\n잠긴 본문 내용', 1, 1], // 3: 잠김 — 전 경로 제외
    ['기밀전용표제어 모음\n기밀 본문 내용', 0, 2], // 4: 민감도 2 — 전 경로 제외
    [`홍천${ZW}물류창고 배송 안내\n창고 운영 시간은 평일 9시부터`, 0, 1], // 5: 제목 단어 속 제로폭 문자
  ]
  for (const [text, locked, sens] of rows) {
    await db
      .prepare('INSERT INTO memos (text, is_locked, sensitivity) VALUES (?, ?, ?)')
      .bind(text, locked, sens)
      .run()
  }
}

/** assistant-call의 사전 검색 시도 순서를 그대로 재현 (키워드합 → 의도쿼리 → 개별 키워드). */
async function presearchIds(env: any, utterance: string): Promise<number[]> {
  const intent = detectMemoSearchIntent(utterance)
  const kws = extractMemoKeywords(utterance)
  const keywordQuery = kws.join(' ')
  const attempts: string[] = []
  if (keywordQuery) attempts.push(keywordQuery)
  if (intent.query && !attempts.includes(intent.query)) attempts.push(intent.query)
  for (const kw of kws) if (!attempts.includes(kw)) attempts.push(kw)
  for (const a of attempts) {
    const r = await searchAccessibleMemos(env, a, 5)
    if (r.length) return r.map((x: any) => x.id)
  }
  return []
}

describe('에코 메모 검색 — 제목 검색 회귀 (실DB)', () => {
  let db: any
  let env: any
  beforeAll(async () => {
    db = makeDb()
    await seed(db)
    env = { DB: db }
  })
  afterAll(() => db.close())

  test('제목 질의(사전 검색 경로)로 대상 메모를 찾는다', async () => {
    expect(await presearchIds(env, '강원도 차량관리팀 메모 찾아줘')).toContain(1)
  })

  test('본문 문구 질의 회귀 — 후생동 강당으로 찾는다', async () => {
    expect(await presearchIds(env, '후생동 강당 메모 찾아줘')).toContain(1)
  })

  test('공백 없는 제목 질의는 찾지 못한다 (번들 계약 — 원본 결함)', async () => {
    const r = await searchAccessibleMemos(env, '강원도차량관리팀', 5)
    expect(r).toEqual([])
  })

  test('구분자 없는 전화번호 질의는 찾지 못한다 (번들 계약 — 원본 결함)', async () => {
    const r = await searchAccessibleMemos(env, '0332492336', 5)
    expect(r).toEqual([])
  })

  test('제목+전화가 붙은 연결형 질의는 찾지 못한다 (번들 계약 — 원본 결함)', async () => {
    const r1 = await searchAccessibleMemos(env, '강원도차량관리팀 0332492336', 5)
    expect(r1).toEqual([])
    const r2 = await searchAccessibleMemos(env, '강원도차량관리팀0332492336', 5)
    expect(r2).toEqual([])
  })

  test('제목 단어 속 제로폭 문자가 있으면 찾지 못한다 (번들 계약 — 원본 결함)', async () => {
    const r = await searchAccessibleMemos(env, '홍천물류창고', 5)
    expect(r).toEqual([])
  })

  test("키워드 추출은 끝 조사 '도'를 분리한다 (번들 계약 — 강원도→강원)", () => {
    const kws = extractMemoKeywords('강원도 차량관리팀 메모 찾아줘')
    expect(kws).toContain('강원')
    expect(kws).not.toContain('강원도')
  })

  test('잠긴 메모는 제목 질의에서도 제외된다', async () => {
    expect(await searchAccessibleMemos(env, '잠금전용표제어', 5)).toEqual([])
    expect(await presearchIds(env, '잠금전용표제어 메모 찾아줘')).toEqual([])
  })

  test('민감도 2 메모는 제목 질의에서도 제외된다', async () => {
    expect(await searchAccessibleMemos(env, '기밀전용표제어', 5)).toEqual([])
  })

  test('없는 단어는 빈 결과', async () => {
    expect(await searchAccessibleMemos(env, '존재하지않는표제어', 5)).toEqual([])
  })

  test('통합 검색도 공백 없는 제목 질의는 찾지 못한다 (번들 계약 — 원본 결함)', async () => {
    const r = await unifiedSearch(db, { query: '강원도차량관리팀', types: ['memo'] })
    expect(r.map((x) => x.source_id)).not.toContain(1)
  })
})
