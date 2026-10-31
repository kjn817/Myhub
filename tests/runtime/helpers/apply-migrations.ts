/**
 * D1 마이그레이션 적용 헬퍼 — 실런타임 테스트 전용.
 *
 * miniflare D1 바인딩에는 마이그레이션 자동 적용 옵션이 없어, 테스트가
 * `migrations/*.sql`을 직접 읽어 순서대로 적용한다. 운영 DB에는 닿지
 * 않는다 (vitest.config.ts의 D1은 테스트 파일마다 격리된 로컬 SQLite).
 * 마이그레이션 파일은 이 헬퍼가 아니라 wrangler D1 적용 절차의 소유이다.
 */
import { env } from 'cloudflare:workers'

// Vite가 빌드 시점에 SQL 파일을 원문으로 인라인한다 (workerd 안에서는
// 파일시스템을 읽을 수 없으므로 ?raw가 필수이다).
const migrationModules = import.meta.glob('../../../migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const db = (env as unknown as { DB: D1Database }).DB

/**
 * 마이그레이션 SQL을 실행 가능한 문장 단위로 쪼갠다.
 *
 * 실측: miniflare/workerd D1의 `exec()`은 입력을 줄 단위로 쪼개 실행하므로
 * 멀티라인 문장을 그대로 넘기면 "incomplete input"으로 실패한다. 그래서
 * 문장 단위로 나눈 뒤 줄바꿈을 공백으로 접어 한 줄로 만들어 exec한다.
 * - `--` 라인 주석·문자열('...', "...", `...`) 안의 `;`은 구분자가 아니다.
 * - 트리거 본문(`CREATE TRIGGER ... BEGIN ...; ...; END;`) 안의 `;`도
 *   구분자가 아니다 — BEGIN/END 깊이를 센다. `CASE...END`는 현 마이그레이션
 *   집합에 없어 이 규칙과 충돌하지 않는다.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let buf = ''
  let depth = 0
  let word = ''
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  let inLineComment = false
  let inBlockComment = false

  const flushWord = () => {
    const w = word.toUpperCase()
    if (w === 'BEGIN') depth++
    else if (w === 'END') depth = Math.max(0, depth - 1)
    word = ''
  }

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    const next = sql[i + 1] ?? ''

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false
        buf += ' '
      }
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false
        i++
      }
      continue
    }
    if (inSingle) {
      buf += ch
      if (ch === "'") {
        if (next === "'") {
          buf += next
          i++
        } else {
          inSingle = false
        }
      }
      continue
    }
    if (inDouble) {
      buf += ch
      if (ch === '"') {
        if (next === '"') {
          buf += next
          i++
        } else {
          inDouble = false
        }
      }
      continue
    }
    if (inBacktick) {
      buf += ch
      if (ch === '`') inBacktick = false
      continue
    }

    // 평문 상태
    if (ch === '-' && next === '-' && /[\s]/.test(sql[i + 2] ?? ' ')) {
      inLineComment = true
      i++
      continue
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true
      i++
      continue
    }
    if (ch === "'") {
      inSingle = true
      buf += ch
      continue
    }
    if (ch === '"') {
      inDouble = true
      buf += ch
      continue
    }
    if (ch === '`') {
      inBacktick = true
      buf += ch
      continue
    }
    if (ch === '\n' || ch === '\r') {
      flushWord()
      buf += ' '
      continue
    }
    if (/[A-Za-z0-9_]/.test(ch)) {
      word += ch
      buf += ch
      continue
    }
    flushWord()
    if (ch === ';' && depth === 0) {
      const stmt = buf.trim()
      if (stmt) statements.push(stmt)
      buf = ''
      continue
    }
    buf += ch
  }
  flushWord()
  const tail = buf.trim()
  if (tail) statements.push(tail)
  return statements
}

export interface MigrationFailure {
  file: string
  statement: string
  error: string
}

export interface MigrationResult {
  /** 모든 문장이 성공한 파일 */
  applied: string[]
  /** 1개라도 실패한 문장이 있는 파일 (파일 내 나머지 문장은 계속 시도한다) */
  failed: MigrationFailure[]
}

/**
 * 마이그레이션 파일명 목록 (파일명 순서, 0001 → 최신).
 * 테스트가 마지막 마이그레이션을 하드코딩하지 않고 동적으로 기대하게 한다 —
 * 0059가 와도 안 깨진다. applyAllMigrations와 같은 glob이 소유자이다.
 */
export function migrationFileNames(): string[] {
  return Object.keys(migrationModules)
    .map((p) => p.split('/').pop() as string)
    .sort()
}

/**
 * 모든 마이그레이션을 파일명 순서(0001 → 최신)로 적용한다.
 * 문장 실패 시 중단하지 않고 기록한 뒤 계속한다 — 실패는 호출자가
 * 명시적으로 판정한다 (알려진 결함은 테스트에서 핀으로 고정한다).
 */
export async function applyAllMigrations(): Promise<MigrationResult> {
  const names = Object.keys(migrationModules).sort()
  const applied: string[] = []
  const failed: MigrationFailure[] = []
  for (const path of names) {
    const file = path.split('/').pop() as string
    let fileFailed = false
    for (const stmt of splitSqlStatements(migrationModules[path])) {
      try {
        await db.exec(stmt)
      } catch (e) {
        fileFailed = true
        failed.push({ file, statement: stmt.slice(0, 120), error: String((e as Error)?.message || e) })
      }
    }
    if (!fileFailed) applied.push(file)
  }
  return { applied, failed }
}

export function testDb(): D1Database {
  return db
}
