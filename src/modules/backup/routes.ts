// Phase 4D: 일관된 백업을 위한 Worker Batch 엔드포인트
// db.batch()를 사용해 14개 테이블을 하나의 트랜잭션에서 읽기
// 인증 필요, 공개 API 아님

import { Hono } from 'hono'
import type { Env } from '../../types'

const app = new Hono<{ Bindings: Env }>()

// 백업 대상 테이블 (화이트리스트)
const BACKUP_TABLES = [
  'memos',
  'memo_tags',
  'schedules',
  'todos',
  'files',
  'reminders',
  'ai_conversations',
  'ai_chats',
  'ai_feedback',
  'ai_usage',
  'ai_memo_audit',
  'ai_memory',
  'ai_memory_v2',
  'ai_settings',
]

// 일관된 백업: 모든 테이블을 하나의 batch 트랜잭션에서 읽기
// POST /api/backup/consistent (모듈 마운트: /api/backup + '/' = /api/backup/)
// 인증 필요 (기존 미들웨어에서 처리)
app.post('/', async (c) => {
  const env = c.env as any

  // 프로덕션 차단 (fail-closed: staging에서만 허용)
  // wrangler.toml에 ENVIRONMENT가 없어도 차단됨
  if (env.ENVIRONMENT !== 'staging') {
    return c.json({ error: '백업 API는 스테이징에서만 사용할 수 있습니다' }, 403)
  }

  // 인증 확인 (미들웨어에서 userEmail 설정)
  const userEmail = (c as any).get('userEmail')
  if (!userEmail) {
    return c.json({ error: '인증 필요' }, 401)
  }

  try {
    // 14개 테이블을 하나의 batch로 읽기
    // db.batch()는 트랜잭션으로 실행되어 일관된 시점 보장
    // PreparedStatement 배열 사용 (평객체 {sql, params}는 D1_ERROR 발생)
    const statements = BACKUP_TABLES.map(table =>
      env.DB.prepare(`SELECT * FROM ${table}`)
    )

    const startTime = Date.now()
    const results = await env.DB.batch(statements)
    const duration = Date.now() - startTime

    // 결과 구성
    const backup: Record<string, any> = {
      version: 3, // batch 일관성 백업 v3
      created_at: new Date().toISOString(),
      method: 'db.batch-transaction',
      tables: {},
    }

    let totalRows = 0
    for (let i = 0; i < BACKUP_TABLES.length; i++) {
      const table = BACKUP_TABLES[i]
      const result = results[i]
      const rows = result.results || []
      backup.tables[table] = {
        row_count: rows.length,
        rows: rows,
      }
      totalRows += rows.length
    }

    backup.integrity = {
      table_count: BACKUP_TABLES.length,
      total_rows: totalRows,
      duration_ms: duration,
    }

    // 개인정보 원문을 로그에 출력하지 않음
    console.log(`[Backup] Consistent backup completed: ${totalRows} rows, ${duration}ms`)

    // 캐시 방지 헤더
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate')
    c.header('Pragma', 'no-cache')

    return c.json(backup)
  } catch (error) {
    console.error('[Backup] Failed:', error)
    return c.json({ error: '백업 실패' }, 500)
  }
})

export default app
