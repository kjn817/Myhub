/// <reference types="jest" />
/**
 * 5-9 S5-4 상수 중앙화 테스트.
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - 중앙 상수의 값이 기존 리터럴과 동일하다 (KST·기본 모델·8000·10MB·뷰포트·경로).
 * - 소비처에 리터럴이 남아 있지 않다 (주석 제외 — 소스 스캔).
 * - SQL 바인드 순서가 컬럼 순서와 맞는다 (cron-jobs·schedule-tools).
 * - 설정 기반 타임존 경로가 우선한다 (prompt-integration 폴백만 중앙화).
 * - 프론트 상수 파일이 모든 소비처 페이지보다 먼저 로드된다.
 * - 메모 번들이 소스와 동기화돼 있다 (재빌드 누락 시 실패).
 * - 상수가 없으면 소비처가 로드 시점에 명확히 실패한다 (guard-throw).
 * - 의도적으로 중앙화하지 않은 것(백엔드 10MB 2종·drop-upload MAX_SIZE·
 *   검증 기록 모델)이 그대로 남아 있다.
 */
import * as fs from 'fs'
import * as path from 'path'

import { KST_TIME_ZONE } from '../../src/lib/kst'
import { DEFAULT_MODEL_ID, MODELS } from '../../src/services/ai-models'
import { DEFAULT_BUDGET, DEFAULT_MAX_TOTAL_INPUT_TOKENS } from '../../src/ai/types'
import { MAX_USER_TEXT_LENGTH, MAX_TRUNCATED_USER_TEXT_CHARS } from '../../src/lib/limits'
import { createServerTimeContext } from '../../src/ai/time-context'
import { createRequestTimeContext } from '../../src/ai/prompt-integration'
import { parseNlCron } from '../../src/services/nl-cron'
import { createCronJob } from '../../src/services/cron-jobs'
import { executeScheduleCreate } from '../../src/services/schedule-tools'
import { validateDelegation } from '../../src/services/subagent-orchestrator'
import { NEWS_ITEM_FORMAT_INSTRUCTION } from '../../src/lib/news-source-links'
import { SOURCE_MAX_AGE_DAYS } from '../../src/lib/news-core'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const frontConstants = require('../../public/js/common/constants.js')

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

/** 주석 제거 (리터럴 잔존 스캔용 — 주석 속 언급은 카운트하지 않는다). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walkTs(full, out)
    else if (e.name.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('중앙 상수 값', () => {
  test('KST_TIME_ZONE은 Asia/Seoul이다', () => {
    expect(KST_TIME_ZONE).toBe('Asia/Seoul')
  })

  test('프론트 KST 상수가 백엔드와 같은 값이다', () => {
    expect(frontConstants.KST_TIME_ZONE).toBe(KST_TIME_ZONE)
  })

  test('DEFAULT_MODEL_ID는 gemini-3.5-flash-lite이고 레지스트리 1순위와 같다', () => {
    expect(DEFAULT_MODEL_ID).toBe('gemini-3.5-flash-lite')
    expect(MODELS[0].id).toBe(DEFAULT_MODEL_ID)
    expect(MODELS[0].provider).toBe('gemini')
    expect(MODELS[0].status).toBe('active')
  })

  test('DEFAULT_MAX_TOTAL_INPUT_TOKENS는 8000이고 DEFAULT_BUDGET과 같다', () => {
    expect(DEFAULT_MAX_TOTAL_INPUT_TOKENS).toBe(8000)
    expect(DEFAULT_BUDGET.maxTotalInputTokens).toBe(DEFAULT_MAX_TOTAL_INPUT_TOKENS)
  })

  test('텍스트 상한 2종은 값은 같지만 별개 상수다', () => {
    expect(MAX_USER_TEXT_LENGTH).toBe(8000)
    expect(MAX_TRUNCATED_USER_TEXT_CHARS).toBe(8000)
    // 소비처가 의미별로 나눠 참조한다
    expect(read('src/modules/ai/routes.ts')).toMatch(/MAX_USER_TEXT_LENGTH/)
    expect(read('src/modules/ai/assistant-call.ts')).toMatch(/MAX_USER_TEXT_LENGTH/)
    expect(read('src/services/channel-gateway.ts')).toMatch(/MAX_TRUNCATED_USER_TEXT_CHARS/)
    expect(read('src/services/fc-approval-gate.ts')).toMatch(/MAX_TRUNCATED_USER_TEXT_CHARS/)
    expect(read('src/ai/fallback-controller.ts')).toMatch(/DEFAULT_MAX_TOTAL_INPUT_TOKENS/)
  })

  test('프론트 상수 값이 기존 리터럴과 동일하다', () => {
    expect(frontConstants.MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024)
    expect(frontConstants.DEFAULT_VIEWPORT).toEqual({ w: 1024, h: 768 })
    expect(frontConstants.DRIVE_FILES_API).toBe('/api/drive/files')
  })

  test('뉴스 프롬프트의 30일이 상수 보간 결과와 같다', () => {
    expect(SOURCE_MAX_AGE_DAYS).toBe(30)
    expect(NEWS_ITEM_FORMAT_INSTRUCTION).toContain('30일 이상 지난 결과는 인용하지 말 것')
    expect(stripComments(read('src/lib/news-source-links.ts'))).toMatch(
      /\$\{SOURCE_MAX_AGE_DAYS\}일 이상/,
    )
  })
})

describe('KST 동작', () => {
  test('잘못된 시간대는 KST로 폴백한다', () => {
    expect(createServerTimeContext('Invalid/Zone').timezone).toBe('Asia/Seoul')
    expect(createServerTimeContext().timezone).toBe('Asia/Seoul')
  })

  test('설정된 타임존이 기본값보다 우선한다 (설정 경로 무결성)', async () => {
    const dbFor = (value: string | null) => ({
      prepare: () => ({
        bind: () => ({ first: async () => (value ? { value } : null) }),
      }),
    })
    const configured = await createRequestTimeContext(dbFor('America/New_York') as any)
    expect(configured.timezone).toBe('America/New_York')
    const unset = await createRequestTimeContext(dbFor(null) as any)
    expect(unset.timezone).toBe('Asia/Seoul')
  })

  test('nl-cron 파싱 결과 타임존이 KST이다', () => {
    const parsed = parseNlCron('매일 아침 8시에 브리핑해줘')
    expect(parsed).not.toBeNull()
    expect(parsed!.schedule.timezone).toBe('Asia/Seoul')
    expect(parsed!.schedule.timezone).toBe(KST_TIME_ZONE)
  })
})

describe('SQL 바인드 순서', () => {
  test('cron-jobs INSERT의 4번째 바인드가 KST이다', async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = []
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            calls.push({ sql, args })
            return { meta: { last_row_id: 7 } }
          },
          first: async () => ({ id: 7, timezone: 'Asia/Seoul' }),
        }),
      }),
    }
    const job = await createCronJob(db as any, '매일 아침 8시에 브리핑해줘')
    expect(job).not.toBeNull()
    const insert = calls.find((c) => c.sql.includes('INSERT INTO user_cron_jobs'))
    expect(insert).toBeDefined()
    // 컬럼 순서: action, nl_text, cron_kst, timezone, next_run_at
    expect((insert!.sql.match(/\?/g) || []).length).toBe(5)
    expect(insert!.args[3]).toBe('Asia/Seoul')
    expect(insert!.args).toHaveLength(5)
  })

  test('schedule-tools INSERT의 6번째 바인드가 KST이다', async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = []
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            run: async () => {
              calls.push({ sql, args })
              return { meta: { last_row_id: 42 } }
            },
            first: async () => null,
          }),
        }),
      },
    }
    // pushCreatedOrUpdated(구글 동기화)가 모의 env에서 실패해도 INSERT는
    // 이미 기록돼 있다 — 반환값이 아니라 바인드 인자를 단언한다.
    await executeScheduleCreate(env as any, {
      title: '바인드 순서 테스트',
      start_at: '2030-01-01T10:00:00+09:00',
      create_todo: false,
    })
    const insert = calls.find((c) => c.sql.includes('INSERT INTO schedules'))
    expect(insert).toBeDefined()
    // 컬럼 순서: title, description, location, start_at, end_at, timezone
    expect((insert!.sql.match(/\?/g) || []).length).toBe(6)
    expect(insert!.args[5]).toBe('Asia/Seoul')
    expect(insert!.args).toHaveLength(6)
  })
})

describe('8000 상한 동작', () => {
  test('위임 매니페스트 토큰 상한 위반 문구가 상수와 동기화된다', () => {
    const base = {
      objective: '열 자가 넘는 명확한 목표 문장이다',
      constraints: [],
      allowedTools: [],
      context: {},
      parentRequestId: 't1',
    }
    expect(validateDelegation({ ...base, maxTokens: 8001 })).toEqual([
      '토큰 예산 과다 (8000 초과)',
    ])
    expect(validateDelegation({ ...base, maxTokens: 8000 })).toEqual([])
  })
})

describe('리터럴 잔존 금지 (주석 제외)', () => {
  test("src/에 'Asia/Seoul' 리터럴이 kst.ts 정의 외에 없다", () => {
    const offenders: string[] = []
    for (const f of walkTs(path.join(ROOT, 'src'))) {
      if (f.endsWith('lib/kst.ts')) continue
      if (stripComments(fs.readFileSync(f, 'utf-8')).includes("'Asia/Seoul'")) {
        offenders.push(path.relative(ROOT, f))
      }
    }
    expect(offenders).toEqual([])
  })

  test('기본 모델 리터럴은 정의·역사 기록 외에 없다', () => {
    const allowed = new Set([
      'src/services/ai-models.ts', // 정의처
      'src/ai/verified-models.ts', // 2026-10-10 검증 당시 역사 기록
      // nova-subagents.ts는 D2 결정(2026-11-14)으로 삭제됨 — 허용 목록에서 제외
    ])
    const offenders: string[] = []
    for (const f of walkTs(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, f)
      if (allowed.has(rel)) continue
      if (stripComments(fs.readFileSync(f, 'utf-8')).includes("'gemini-3.5-flash-lite'")) {
        offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
    // 정의처에는 정확히 1회 (DEFAULT_MODEL_ID 정의)
    const def = stripComments(read('src/services/ai-models.ts'))
    expect((def.match(/'gemini-3\.5-flash-lite'/g) || []).length).toBe(1)
  })

  test('8e3 표기가 src/에 남아 있지 않다', () => {
    const offenders: string[] = []
    for (const f of walkTs(path.join(ROOT, 'src'))) {
      if (stripComments(fs.readFileSync(f, 'utf-8')).includes('8e3')) {
        offenders.push(path.relative(ROOT, f))
      }
    }
    expect(offenders).toEqual([])
  })

  test("프론트 소비처에 '/api/drive/files' 리터럴이 없다", () => {
    const consumers = [
      'public/js/common/drive-io.js',
      'public/js/desktop/drop-upload.js',
      'public/js/desktop/windows.js',
      'public/js/finder.js',
      'public/js/finder-viewer.js',
      'public/js/office.js',
      'public/js/office-assistant.js',
      'public/js/finder-format-pdf.js',
      'public/js/finder-deckcraft.js',
      'public/js/sheet-gridcraft.js',
      'public/js/fonts.js',
    ]
    for (const f of consumers) {
      const code = stripComments(read(f))
      expect(code).not.toContain("'/api/drive/files")
      expect(code).toContain('DRIVE_FILES_API')
    }
  })

  test('프론트 소비처에 뷰포트·KST 리터럴이 없다', () => {
    for (const f of ['public/js/desktop/main.js', 'public/js/desktop/windows.js']) {
      const code = stripComments(read(f))
      expect(code).not.toMatch(/window\.innerWidth \|\| 1024/)
      expect(code).toContain('DEFAULT_VIEWPORT')
    }
    expect(stripComments(read('public/js/memo/calendar.js'))).not.toContain("'Asia/Seoul'")
    expect(stripComments(read('public/js/memo/calendar.js'))).toContain('KST_TIME_ZONE')
  })

  test('HWP 재시도 스케줄 리터럴이 1곳(정의)으로 줄었다', () => {
    const code = stripComments(read('public/js/finder-format-hwp.js'))
    expect(code).toContain('var HWP_RETRY_SCHEDULE_MS = [300, 900, 2000, 4500];')
    expect(code).not.toContain('[300, 900, 2000, 4500].forEach')
    expect((code.match(/HWP_RETRY_SCHEDULE_MS\.forEach/g) || []).length).toBe(2)
  })
})

describe('의도적 미중앙화 (핀)', () => {
  test('백엔드 10MB 2종은 도메인이 달라 각자 로컬 상수로 남는다', () => {
    expect(read('src/modules/backup/routes.ts')).toMatch(/MAX_BACKUP_SIZE = 10 \* 1024 \* 1024/)
    expect(read('src/modules/memo/routes-files.ts')).toMatch(/MAX_SIZE = 10 \* 1024 \* 1024/)
  })

  test('drop-upload의 MAX_SIZE는 Drive 상한이라 로컬로 남는다', () => {
    const code = stripComments(read('public/js/desktop/drop-upload.js'))
    expect(code).toContain('var MAX_SIZE = 10 * 1024 * 1024;')
    expect(code).not.toContain('MAX_UPLOAD_BYTES')
  })

  test('메모 첨부 2곳은 공용 상수를 쓴다', () => {
    for (const f of ['public/js/memo/composer.js', 'public/js/memo/editor-core.js']) {
      const code = stripComments(read(f))
      expect(code).not.toContain('10 * 1024 * 1024')
      expect(code).toContain('MAX_UPLOAD_BYTES')
    }
  })
})

describe('프론트 상수 로딩', () => {
  const PAGES: Array<{ html: string; firstConsumer: string }> = [
    { html: 'public/desktop.html', firstConsumer: '/js/desktop/windows.js' },
    { html: 'public/finder.html', firstConsumer: '/js/common/drive-io.js' },
    { html: 'public/office.html', firstConsumer: '/js/common/drive-io.js' },
    { html: 'public/sheet.html', firstConsumer: '/js/fonts.js' },
    { html: 'public/sheet-fortune.html', firstConsumer: '/js/fonts.js' },
    { html: 'public/memo.html', firstConsumer: '/js/memo-bundle.js' },
  ]

  test('6개 페이지 모두 constants.js를 첫 소비처보다 먼저 로드한다', () => {
    for (const { html, firstConsumer } of PAGES) {
      const text = read(html)
      const constIdx = text.indexOf('/js/common/constants.js')
      const consumerIdx = text.indexOf(firstConsumer)
      expect(constIdx).toBeGreaterThan(-1)
      expect(consumerIdx).toBeGreaterThan(-1)
      expect(constIdx).toBeLessThan(consumerIdx)
    }
  })

  test('매니페스트에 constants.js가 등록돼 있다', () => {
    const manifest = JSON.parse(read('scripts/static-assets.json'))
    expect(manifest.files).toContain('/js/common/constants.js')
  })

  test('상수가 없으면 소비처가 로드 시점에 명확히 실패한다', () => {
    jest.resetModules()
    delete (globalThis as any).MyHubConstants
    expect(() => require('../../public/js/fonts.js')).toThrow(
      'constants.js가 먼저 로드되어야 합니다',
    )
    // 이후 테스트를 위해 상수 복원
    require('../../public/js/common/constants.js')
    expect(() => require('../../public/js/fonts.js')).not.toThrow()
  })
})

describe('메모 번들 동기화', () => {
  test('번들이 소스 15개 파일의 cat 결과와 바이트 동일하다', () => {
    const order = [
      'public/js/memo/utils.js',
      'public/js/memo/header.js',
      'public/js/memo/editor-toolbar.js',
      'public/js/memo/md.js',
      'public/js/memo/composer.js',
      'public/js/memo/filter.js',
      'public/js/memo/tags.js',
      'public/js/memo/calendar.js',
      'public/js/memo/list.js',
      'public/js/memo/imgtools.js',
      'public/js/memo/lightbox.js',
      'public/js/memo/editor-core.js',
      'public/js/memo/toolbar.js',
      'public/js/memo/pane.js',
      'public/js/memo/init.js',
    ]
    const expected = order.map((f) => read(f) + '\n').join('')
    expect(read('public/js/memo-bundle.js')).toBe(expected)
  })

  test('번들에 중앙화된 상수 참조가 들어 있다', () => {
    const bundle = read('public/js/memo-bundle.js')
    expect(bundle).toContain('timeZone: KST_TIME_ZONE')
    expect(bundle).toContain('f.size > MAX_UPLOAD_BYTES')
    expect(stripComments(bundle)).not.toContain("'Asia/Seoul'")
  })
})
