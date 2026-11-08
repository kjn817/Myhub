/// <reference types="jest" />
/**
 * 그룹 F 커버리지 보강 — 기타 서비스 잔여분
 * - src/services/workflow.ts: 기본 sleep(123), truncateJson/parseJson 경계(139/144/149),
 *   정의 검증(160/163/169), claimRun 경합(236-245)
 * - src/services/memory-service.ts: 각 함수의 db_error catch(450/482/499/516/559/607),
 *   claimHandoff 행 부재(590) — 366은 도달 불가로 기록만 함 (아래 주석 참조)
 * - src/services/nl-cron.ts: 시간 변환 경계(70/72-73/82), 파싱 실패(141/160/203/237),
 *   interval 하한(290), 월간 설명(353-354) — 275는 도달 불가로 기록만 함
 * - src/ai/prompt-integration.ts: 단일 확정 + 일부 미해석 경고(199-201),
 *   해석 결과 없음(208)
 * - src/ai/eval-runner.ts: 합성 예외 시 실패 기록(39-41)
 * - src/services/briefing-export.ts: 브랜치 보강 (hhmm 폴백·우선순위 기본값·
 *   메모 절단·nullish 폴백·주간 완료율 0·요일 차트)
 * - src/services/expert-registry.ts: ID 매핑 + null 폴백 (현행 EXPERTS/getExpert 표면)
 * - src/services/provider-registry.ts: isProviderRegistered(82) + 등록 검증
 * - src/services/ai.ts: 호출 직전 민감도 재검사 차단(750),
 *   메모 생성 실패 알림(957)
 *
 * 도달 불가로 판단한 라인:
 * - memory-service.ts 366 (getRelevantMemories의 superseded catch):
 *   fetchSupersededMatches가 내부에서 모든 예외를 잡아 []를 반환하므로 이 catch는
 *   실행될 수 없다 (방어 코드).
 * - nl-cron.ts 275 (matchesDay 월간 probe): nextRunAfter 루프의 날짜는 실제 달력
 *   날짜만 생성하므로 probe가 실패하는 경우가 없다 (방어 코드).
 * - workflow.ts 136 (truncateJson의 undefined 분기): 호출부가 value ?? null로
 *   감싸므로 JSON.stringify에 undefined가 들어갈 수 없다 (방어 코드).
 * - briefing-export.ts 42 (kstDateStr의 ?? ''): Intl이 연·월·일을 항상 반환하므로
 *   find가 실패할 수 없다 (방어 코드).
 * - expert-registry.ts getBriefingOwner/getReminderOwner의 ?? EXPERTS[0]:
 *   EXPERTS에 소유자가 항상 존재하므로 폴백에 도달할 수 없다.
 * - agent-team.ts 339의 '실행에 실패했습니다' 분기: plan-execute의 skipped 사유는
 *   'approval_required'만 존재한다 (이 파일이 아닌 agent-team 쪽 기록).
 */
import * as fs from 'fs'
import * as path from 'path'

// privacy guard 모킹 (aiChat 민감도 재검사 테스트용 — svc4-ai.test.ts와 동일 패턴)
jest.mock('../../src/ai/legacy-privacy-guard', () => {
  const actual = jest.requireActual('../../src/ai/legacy-privacy-guard')
  return {
    ...actual,
    checkProviderAllowed: jest.fn(),
    checkDataPolicy: jest.fn(),
    resolvePolicySensitivity: jest.fn(),
  }
})

// memo-tool-dispatcher 모킹 (keeper FC 경로 테스트용)
jest.mock('../../src/ai/memo-tool-dispatcher', () => ({
  dispatchToolCalls: jest.fn(),
}))

// 승인 게이트 (D1 정렬, 2026-10-31): 이 파일의 FC 케이스는 "승인된 뒤
// 디스패치가 실패했을 때"의 루프 분기를 본다. 승인 판정 자체는
// fc-approval-gate 전용 스위트(tests/fc-approval-gate.test.ts)가 실제
// 저장소로 검증하므로, 여기서는 게이트를 allow로 고정한다.
jest.mock('../../src/services/fc-approval-gate', () => {
  const actual = jest.requireActual('../../src/services/fc-approval-gate')
  return {
    ...actual,
    gateFCToolCall: jest.fn(async () => ({ action: 'allow', approvalTool: 'MEMO_CREATE' })),
  }
})

import { dispatchToolCalls } from '../../src/ai/memo-tool-dispatcher'
import {
  checkProviderAllowed,
  checkDataPolicy,
  resolvePolicySensitivity,
  PrivacyBlockedError,
} from '../../src/ai/legacy-privacy-guard'
import { aiChat, type TaskPolicy, type ChatMessage } from '../../src/services/ai'
import {
  runWorkflow,
  TRUNCATED_JSON_MARKER,
  type WorkflowDefinition,
} from '../../src/services/workflow'
import {
  buildMemoryPage,
  supersedeMemory,
  restoreMemory,
  markContradiction,
  createHandoff,
  claimHandoff,
} from '../../src/services/memory-service'
import {
  parseNlCron,
  nextRunAfter,
  describeNlCron,
  type NlCronSchedule,
} from '../../src/services/nl-cron'
import { composeV2Prompt, createRequestTimeContext } from '../../src/ai/prompt-integration'
import { runMockEval, summarizeEval } from '../../src/ai/eval-runner'
import {
  kstDateStr,
  addDays,
  weekMonday,
  fetchMorningBriefing,
  morningBriefingDeck,
  fetchWeeklyReport,
  weeklyReportDeck,
} from '../../src/services/briefing-export'
import {
  EXPERTS,
  getExpert,
  getExpertTools,
  getExpertProviderByLegacyId,
  getExpertCapabilityByLegacyId,
} from '../../src/services/expert-registry'
import {
  registerProvider,
  unregisterProvider,
  isProviderRegistered,
  getProvider,
  getProviderModels,
  listProviders,
  resolvePersonaProvider,
  PERSONA_PROVIDER_PIN,
} from '../../src/services/provider-registry'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createLocalD1 } = require('../helpers/local-d1.cjs')

const MIGRATION_0050 = fs.readFileSync(
  path.join(__dirname, '../../migrations/0050_workflow_runs.sql'),
  'utf8',
)

function makeWorkflowDb(): any {
  const d1 = createLocalD1()
  d1.exec(MIGRATION_0050)
  return d1
}

function envWith(db: any): any {
  return { DB: db }
}

function wfDef(over: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'test-wf',
    name: '테스트 워크플로',
    version: 1,
    trigger: { type: 'manual' },
    nodes: [{ id: 'a', name: 'A', run: async () => ({ a: 1 }) }],
    ...over,
  }
}

// ---------------- workflow.ts ----------------

describe('workflow — 기본 sleep + JSON 경계 + 정의 검증', () => {
  test('sleep 미주입 시 실제 setTimeout으로 재시도 대기 (123)', async () => {
    const db = makeWorkflowDb()
    let attempts = 0
    const d = wfDef({
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 10 },
      nodes: [{
        id: 'flaky', name: 'F', run: async () => {
          attempts++
          if (attempts === 1) throw new Error('일시 실패')
          return { ok: true }
        },
      }],
    })
    // sleep을 주입하지 않아 defaultSleep(setTimeout)이 타야 한다
    const r = await runWorkflow(d, { env: envWith(db) })
    expect(r.status).toBe('completed')
    expect(r.output).toEqual({ ok: true })
    expect(r.attempts).toBe(2)
    expect(attempts).toBe(2)
  })

  test('순환 참조 input → truncateJson 실패 시 null로 기록하고 실행은 계속 (139)', async () => {
    const db = makeWorkflowDb()
    const circular: any = { x: 1 }
    circular.self = circular
    const r = await runWorkflow(wfDef(), { env: envWith(db), input: circular, idempotencyKey: 'circ-1' })
    expect(r.status).toBe('completed')
    // input은 상태에 얕게 복사되므로 출력에 그대로 남는다 (기록용 JSON만 null)
    expect(r.output.a).toBe(1)
    expect((r.output as any).x).toBe(1)
    const row = db._db.prepare('SELECT input_json FROM workflow_runs WHERE idempotency_key = ?').get('circ-1') as any
    expect(row.input_json).toBeNull()
  })

  test('output_json null인 완료 실행을 다시 실행하면 duplicate + 빈 출력 (144)', async () => {
    const db = makeWorkflowDb()
    db._db.prepare(
      `INSERT INTO workflow_runs (workflow_id, idempotency_key, trigger_type, status, output_json)
       VALUES (?, ?, 'manual', 'completed', NULL)`,
    ).run('test-wf', 'null-out-1')
    const r = await runWorkflow(wfDef(), { env: envWith(db), idempotencyKey: 'null-out-1' })
    expect(r.status).toBe('duplicate')
    expect(r.output).toEqual({})
  })

  test('output_json이 배열이면 {}로 파싱 (149)', async () => {
    const db = makeWorkflowDb()
    db._db.prepare(
      `INSERT INTO workflow_runs (workflow_id, idempotency_key, trigger_type, status, output_json)
       VALUES (?, ?, 'manual', 'completed', '[1,2]')`,
    ).run('test-wf', 'arr-out-1')
    const r = await runWorkflow(wfDef(), { env: envWith(db), idempotencyKey: 'arr-out-1' })
    expect(r.status).toBe('duplicate')
    expect(r.output).toEqual({})
  })

  test('output_json이 손상됐으면 {}로 파싱 (154)', async () => {
    const db = makeWorkflowDb()
    db._db.prepare(
      `INSERT INTO workflow_runs (workflow_id, idempotency_key, trigger_type, status, output_json)
       VALUES (?, ?, 'manual', 'failed', '{broken')`,
    ).run('test-wf', 'bad-out-1')
    const r = await runWorkflow(wfDef(), { env: envWith(db), idempotencyKey: 'bad-out-1' })
    expect(r.status).toBe('duplicate')
    expect(r.output).toEqual({})
  })

  test('id 없음 → throw (160)', async () => {
    await expect(runWorkflow(wfDef({ id: '' }), { env: envWith(makeWorkflowDb()) }))
      .rejects.toThrow('id 없음')
  })

  test('node id 없음 → throw (160)', async () => {
    const d = wfDef({ nodes: [{ id: '', name: 'X', run: async () => ({}) }] })
    await expect(runWorkflow(d, { env: envWith(makeWorkflowDb()) }))
      .rejects.toThrow('node id 없음')
  })

  test('node run 없음 → throw (163)', async () => {
    const d = wfDef({ nodes: [{ id: 'x', name: 'X' } as any] })
    await expect(runWorkflow(d, { env: envWith(makeWorkflowDb()) }))
      .rejects.toThrow('run 없음')
  })

  test('event 트리거에 event 없음 → throw (169)', async () => {
    const d = wfDef({ trigger: { type: 'event' } as any })
    await expect(runWorkflow(d, { env: envWith(makeWorkflowDb()) }))
      .rejects.toThrow('event 트리거에 event 없음')
  })

  test('cron 트리거에 cron식 없음 → throw', async () => {
    const d = wfDef({ trigger: { type: 'cron' } as any })
    await expect(runWorkflow(d, { env: envWith(makeWorkflowDb()) }))
      .rejects.toThrow('cron 트리거에 cron식 없음')
  })
})

describe('workflow — claimRun 경합 (236-245)', () => {
  function makeRaceDb(racedRow: any) {
    let firstCalls = 0
    return {
      prepare(_sql: string) {
        return {
          bind(..._p: any[]) { return this },
          async first() {
            firstCalls++
            if (firstCalls === 1) return null // 선점 조회 시점에는 행 없음
            return racedRow
          },
          async all() { return { results: [] } },
          async run() {
            // INSERT OR IGNORE가 0건 — 다른 실행이 먼저 선점함
            return { meta: { changes: 0, last_row_id: 0 } }
          },
        }
      },
    }
  }

  test('선점 경합 후 상대 행 발견 → duplicate + 저장된 출력 (236-244)', async () => {
    const db = makeRaceDb({ id: 7, status: 'completed', output_json: JSON.stringify({ a: 1 }) })
    let ran = 0
    const d = wfDef({ nodes: [{ id: 'a', name: 'A', run: async () => { ran++; return { a: 1 } } }] })
    const r = await runWorkflow(d, { env: { DB: db } as any, idempotencyKey: 'race-1' })
    expect(r.status).toBe('duplicate')
    expect(r.runId).toBe(7)
    expect(r.output).toEqual({ a: 1 })
    expect(ran).toBe(0) // 노드 미실행
  })

  test('선점 경합 후 상대 행도 없으면 새로 실행 (245)', async () => {
    const db = makeRaceDb(null)
    let ran = 0
    const d = wfDef({ nodes: [{ id: 'a', name: 'A', run: async () => { ran++; return { a: 1 } } }] })
    const r = await runWorkflow(d, { env: { DB: db } as any, idempotencyKey: 'race-2' })
    expect(r.status).toBe('completed')
    expect(r.runId).toBeNull()
    expect(r.output).toEqual({ a: 1 })
    expect(ran).toBe(1)
  })
})

// ---------------- memory-service.ts ----------------

function makeMemDb(handlers: {
  first?: (sql: string, params: any[]) => any
  all?: (sql: string, params: any[]) => any
  run?: (sql: string, params: any[]) => any
  batch?: (stmts: any[]) => any
} = {}) {
  return {
    prepare(sql: string) {
      return {
        _params: [] as any[],
        bind(...p: any[]) { this._params = p; return this },
        async first() {
          if (handlers.first) return handlers.first(sql, this._params)
          return null
        },
        async all() {
          if (handlers.all) return handlers.all(sql, this._params)
          return { results: [] }
        },
        async run() {
          if (handlers.run) return handlers.run(sql, this._params)
          return { meta: { last_row_id: 1, changes: 1 } }
        },
      }
    },
    async batch(stmts: any[]) {
      if (handlers.batch) return handlers.batch(stmts)
      return stmts.map(() => ({ meta: { changes: 1, last_row_id: 1 } }))
    },
  }
}

describe('memory-service — db_error catch', () => {
  test('buildMemoryPage SELECT 실패 → db_error (450)', async () => {
    const db = makeMemDb({ all: () => { throw new Error('db down') } })
    const r = await buildMemoryPage({ DB: db } as any, { title: '페이지', memoryIds: [1, 2] })
    expect(r).toEqual({ ok: false, error: 'db_error' })
  })

  test('buildMemoryPage INSERT 실패 → db_error (450)', async () => {
    const db = makeMemDb({
      all: () => ({ results: [{ id: 1, content: '첫 문장입니다. 나머지는 무시.', summary: null }] }),
      run: () => { throw new Error('db down') },
    })
    const r = await buildMemoryPage({ DB: db } as any, { title: '페이지', memoryIds: [1] })
    expect(r).toEqual({ ok: false, error: 'db_error' })
  })

  test('supersedeMemory batch 실패 → db_error (482)', async () => {
    const db = makeMemDb({ batch: () => { throw new Error('db down') } })
    expect(await supersedeMemory({ DB: db } as any, 1, 2)).toEqual({ ok: false, error: 'db_error' })
  })

  test('restoreMemory UPDATE 실패 → db_error (499)', async () => {
    const db = makeMemDb({ run: () => { throw new Error('db down') } })
    expect(await restoreMemory({ DB: db } as any, 1)).toEqual({ ok: false, error: 'db_error' })
  })

  test('markContradiction UPDATE 실패 → db_error (516)', async () => {
    const db = makeMemDb({ run: () => { throw new Error('db down') } })
    expect(await markContradiction({ DB: db } as any, 1, true)).toEqual({ ok: false, error: 'db_error' })
  })

  test('markContradiction 잘못된 ID → invalid_id (509)', async () => {
    const db = makeMemDb()
    expect(await markContradiction({ DB: db } as any, 0, true)).toEqual({ ok: false, error: 'invalid_id' })
  })

  test('createHandoff INSERT 실패 → db_error (559)', async () => {
    const db = makeMemDb({ run: () => { throw new Error('db down') } })
    const r = await createHandoff({ DB: db } as any, {
      fromPersona: 'keeper', toPersona: 'concierge', memoryIds: [1], summary: '요약',
    })
    expect(r).toEqual({ ok: false, error: 'db_error' })
  })

  test('claimHandoff UPDATE 실패 → db_error (607)', async () => {
    const db = makeMemDb({ run: () => { throw new Error('db down') } })
    expect(await claimHandoff({ DB: db } as any, 'token-1')).toEqual({ ok: false, error: 'db_error' })
  })

  test('claimHandoff meta 없음 → already_claimed_or_expired (584)', async () => {
    const db = makeMemDb({ run: () => ({}) })
    expect(await claimHandoff({ DB: db } as any, 'token-1')).toEqual({ ok: false, error: 'already_claimed_or_expired' })
  })

  test('claimHandoff 수령 성공 후 행 부재 → not_found (590)', async () => {
    const db = makeMemDb({
      run: () => ({ meta: { changes: 1, last_row_id: 1 } }),
      first: () => null,
    })
    expect(await claimHandoff({ DB: db } as any, 'token-1')).toEqual({ ok: false, error: 'not_found' })
  })
})

// ---------------- nl-cron.ts ----------------

describe('nl-cron — 시간 변환 경계', () => {
  test('"0시" = 자정 (70)', () => {
    const p = parseNlCron('매일 0시에 알려줘')
    expect(p?.schedule.hour).toBe(0)
    expect(p?.schedule.cronKst).toBe('0 0 * * *')
  })

  test('"24시"는 범위 초과 → null (72)', () => {
    expect(parseNlCron('매일 24시에 알려줘')).toBeNull()
    expect(parseNlCron('매일 25시에 알려줘')).toBeNull()
  })

  test('13-23시는 24시간 표기로 그대로 (73)', () => {
    expect(parseNlCron('매일 15시에 알려줘')?.schedule.hour).toBe(15)
    expect(parseNlCron('매일 23시에 알려줘')?.schedule.hour).toBe(23)
    expect(parseNlCron('매일 13시에 알려줘')?.schedule.hour).toBe(13)
  })

  test('시간대 단어 없이 "8시" → 그대로 8시 (82)', () => {
    const p = parseNlCron('매일 8시에 알려줘')
    expect(p?.schedule.hour).toBe(8)
    expect(p?.schedule.minute).toBe(0)
  })

  test('문자열이 아니면 null (141)', () => {
    expect(parseNlCron(null as any)).toBeNull()
    expect(parseNlCron(123 as any)).toBeNull()
  })

  test('시간 간격 범위 초과 → null (160)', () => {
    expect(parseNlCron('24시간마다 알려줘')).toBeNull()
    expect(parseNlCron('0시간마다 알려줘')).toBeNull()
  })

  test('분 간격 범위 초과 → null', () => {
    expect(parseNlCron('0분마다 알려줘')).toBeNull()
    expect(parseNlCron('60분마다 알려줘')).toBeNull()
  })

  test('"8시 99분" → null (203)', () => {
    expect(parseNlCron('매일 8시 99분에 알려줘')).toBeNull()
  })

  test('매월 날짜 범위 초과 → null (203)', () => {
    expect(parseNlCron('매월 32일 오전 9시에 브리핑해줘')).toBeNull()
    expect(parseNlCron('매월 0일 오전 9시에 브리핑해줘')).toBeNull()
  })

  test('쉼표 목록 + 요일 접미사 혼합 — list 분기 (225-226)', () => {
    const p = parseNlCron('매주 월, 수, 금요일 오후 6시에 알려줘')
    expect(p?.schedule.kind).toBe('weekly')
    expect(p?.schedule.daysOfWeek).toEqual([1, 3, 5])
    expect(p?.schedule.hour).toBe(18)
    expect(p?.schedule.cronKst).toBe('0 18 * * 1,3,5')
  })

  test('매주인데 요일이 없으면 null (237)', () => {
    expect(parseNlCron('매주 오후 6시에 알려줘')).toBeNull()
  })

  test('interval 하한 — 0분 간격 스케줄은 다음 실행 없음 (290)', () => {
    const s: NlCronSchedule = {
      kind: 'interval', hour: 0, minute: 0, daysOfWeek: null, dayOfMonth: null,
      intervalMinutes: 0, timezone: 'Asia/Seoul', cronKst: '*/0 * * * *',
    }
    expect(nextRunAfter(s, new Date('2026-10-26T00:00:00Z'))).toBeNull()
  })

  test('잘못된 from 날짜 → null', () => {
    const s: NlCronSchedule = {
      kind: 'daily', hour: 8, minute: 0, daysOfWeek: null, dayOfMonth: null,
      intervalMinutes: null, timezone: 'Asia/Seoul', cronKst: '0 8 * * *',
    }
    expect(nextRunAfter(s, new Date('invalid'))).toBeNull()
  })

  test('월간 설명 문장 (353-354)', () => {
    const p = parseNlCron('매월 1일 오전 9시에 브리핑해줘')
    expect(p).not.toBeNull()
    expect(describeNlCron(p!)).toBe('매월 1일 오전 9시에 아침 브리핑을 보내드릴게요.')
  })
})

// ---------------- prompt-integration.ts ----------------

describe('prompt-integration — scheduler 날짜 블록 경계', () => {
  const timeCtx = {
    nowIso: '2026-10-17T05:00:00Z',
    timezone: 'Asia/Seoul',
    todayLocal: '2026-10-17',
    weekStartLocal: '2026-10-12',
  } as any

  test('단일 확정 + 복수 표현 중 일부 미해석 → 경고 블록 (199-201)', () => {
    // "내일"은 해석되지만 "월요일"(수식어 없음)은 미해석 → 경고가 붙어야 한다
    const result = composeV2Prompt('scheduler', {
      timeContext: timeCtx,
      userMessage: '내일과 월요일에 회의 잡아줘',
    })
    expect(result.prompt).toContain('[서버 확정 날짜]')
    expect(result.prompt).not.toContain('서버 확정 날짜 - 복수')
    expect(result.prompt).toContain('해석하지 못했습니다')
    expect(result.prompt).toContain('"월요일"')
  })

  test('단일 확정 + 표현 1개 → 경고 없음 (200 false)', () => {
    const result = composeV2Prompt('scheduler', {
      timeContext: timeCtx,
      userMessage: '내일 회의 잡아줘',
    })
    expect(result.prompt).toContain('[서버 확정 날짜]')
    expect(result.prompt).not.toContain('해석하지 못했습니다')
  })

  test('해석된 날짜 없음 + 표현 있음 → 확인 요청 블록 (208)', () => {
    // "월요일" 단독은 수식어가 없어 해석 불가 → 확정 없이 되묻기 지시
    const result = composeV2Prompt('scheduler', {
      timeContext: timeCtx,
      userMessage: '월요일에 회의 잡아줘',
    })
    expect(result.prompt).toContain('[날짜 확인 필요]')
    expect(result.prompt).toContain('어떤 날짜를 말씀하시는지 확인해주세요')
    expect(result.prompt).not.toContain('[서버 확정 날짜]')
  })

  test('날짜 표현 자체가 없으면 날짜 블록 없음', () => {
    const result = composeV2Prompt('scheduler', {
      timeContext: timeCtx,
      userMessage: '회의실 예약해줘',
    })
    expect(result.prompt).not.toContain('[날짜 확인 필요]')
    expect(result.prompt).not.toContain('[서버 확정 날짜]')
  })
})

// ---------------- briefing-export.ts ----------------

function makeBriefingDb(): any {
  const d1 = createLocalD1()
  d1.exec(fs.readFileSync(path.join(__dirname, '../../migrations/0001_init.sql'), 'utf8'))
  // 0013은 files 테이블에도 컬럼을 추가하므로 스텁을 먼저 만든다
  d1.exec('CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY AUTOINCREMENT)')
  d1.exec(fs.readFileSync(path.join(__dirname, '../../migrations/0013_memo_lock.sql'), 'utf8'))
  d1.exec(fs.readFileSync(path.join(__dirname, '../../migrations/0014_schedules.sql'), 'utf8'))
  d1.exec(fs.readFileSync(path.join(__dirname, '../../migrations/0016_todos.sql'), 'utf8'))
  return d1
}

function seedBriefingDb(db: any) {
  const run = (sql: string, ...params: any[]) => db._db.prepare(sql).run(...params)
  run(`INSERT INTO schedules (title, location, start_at, end_at, status) VALUES
    ('오늘 회의', '회의실', '2026-10-26T10:00:00', '2026-10-26T11:00:00', 'active'),
    ('취소된 일정', '', '2026-10-26T11:00:00', NULL, 'cancelled'),
    ('내일 일정', '', '2026-10-27T09:00:00', NULL, 'active'),
    ('지난주 일정', '', '2026-10-25T09:00:00', NULL, 'active')`)
  run(`INSERT INTO todos (title, due_at, priority, status) VALUES
    ('급한 일', '2026-10-26T18:00', 2, 'pending'),
    ('여유 있는 일', NULL, 0, 'pending'),
    ('끝난 일', NULL, 1, 'done')`)
  run(`INSERT INTO memos (text, is_locked, sensitivity, created_at) VALUES
    ('오늘 메모 내용입니다', 0, 1, '2026-10-26 08:00:00'),
    ('잠긴 메모 내용입니다', 1, 1, '2026-10-26 08:30:00'),
    ('민감 메모 내용입니다', 0, 2, '2026-10-26 09:00:00'),
    ('지난주 메모 내용입니다', 0, 1, '2026-10-20 08:00:00')`)
}

describe('briefing-export — 날짜 유틸', () => {
  test('kstDateStr: UTC 자정은 KST 당일 09시', () => {
    expect(kstDateStr(new Date('2026-10-26T00:00:00Z'))).toBe('2026-10-26')
    expect(kstDateStr(new Date('2026-10-25T15:00:00Z'))).toBe('2026-10-26')
  })

  test('addDays: 월 경계', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2026-10-26', -1)).toBe('2026-10-25')
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
  })

  test('weekMonday: 수요일 → 같은 주 월요일, 월요일 → 그대로', () => {
    expect(weekMonday('2026-10-28')).toBe('2026-10-26')
    expect(weekMonday('2026-10-26')).toBe('2026-10-26')
    expect(weekMonday('2026-10-25')).toBe('2026-10-19') // 일요일은 전주 월요일
  })
})

describe('briefing-export — 덱 생성 브랜치', () => {
  test('morningBriefingDeck: 위치 있음/없음, 우선순위 기본값, 메모 절단, hhmm 폴백', () => {
    const deck = morningBriefingDeck({
      date: '2026-10-26',
      schedules: [
        { id: 1, title: '회의', start_at: '2026-10-26T10:00:00', end_at: null, location: '회의실' },
        { id: 2, title: '점심', start_at: '2026-10-26 12:00', end_at: null, location: '' },
      ],
      todos: [
        { id: 1, title: '알 수 없는 우선순위', due_at: '2026-10-27T09:00', priority: 5, status: 'pending' },
        { id: 2, title: '마감 없음', due_at: null, priority: 0, status: 'pending' },
      ],
      memos: [{ id: 1, text: `긴 메모 ${'내용 '.repeat(60)}`, created_at: '2026-10-26 08:00:00' }],
    })
    expect(deck.title).toBe('아침 브리핑 2026-10-26')
    const schedSlide = deck.slides[1]
    expect(schedSlide.bullets).toContain('10:00  회의 (회의실)')
    // 'T' 없는 시작 시각은 원문 그대로 (hhmm 폴백)
    expect(schedSlide.bullets).toContain('2026-10-26 12:00  점심')
    const todoSlide = deck.slides[2]
    expect(todoSlide.bullets).toContain('[보통] 알 수 없는 우선순위 (~10/27)')
    expect(todoSlide.bullets).toContain('[낮음] 마감 없음')
    const memoSlide = deck.slides[3]
    expect(memoSlide.bullets[0].endsWith('…')).toBe(true)
    expect(memoSlide.bullets[0].length).toBeLessThanOrEqual(121)
    // 할 일 있음 → 우선순위 분포 차트 슬라이드 추가
    const chart = deck.slides.find((s) => s.kind === 'chart')
    expect(chart).toBeDefined()
    expect((chart as any).series[0].values).toEqual([0, 0, 1])
  })

  test('morningBriefingDeck: 빈 재료면 emptyText + 차트 없음', () => {
    const deck = morningBriefingDeck({ date: '2026-10-26', schedules: [], todos: [], memos: [] })
    expect(deck.slides[1].emptyText).toBe('오늘 일정이 없습니다')
    expect(deck.slides[2].emptyText).toBe('미완료 할 일이 없습니다')
    expect(deck.slides[3].emptyText).toBe('표시할 메모가 없습니다')
    expect(deck.slides.some((s) => s.kind === 'chart')).toBe(false)
  })

  test('weeklyReportDeck: 할 일 0건 → 완료율 대신 안내 문구 (284-286)', () => {
    const deck = weeklyReportDeck({
      weekStart: '2026-10-26', weekEnd: '2026-11-01',
      schedules: [], todosDone: 0, todosPending: 0, memos: [],
    })
    const todoSlide = deck.slides[2]
    expect(todoSlide.bullets).toContain('완료: 0건 (현재 기준)')
    expect(todoSlide.bullets).toContain('미완료: 0건 (현재 기준)')
    expect(todoSlide.bullets).toContain('등록된 할 일이 없습니다')
    expect(deck.slides.some((s) => s.kind === 'chart')).toBe(false)
  })

  test('weeklyReportDeck: 일정 있음 → 요일 그룹 + 차트 (298), 주 밖 일정은 경계로 고정', () => {
    const deck = weeklyReportDeck({
      weekStart: '2026-10-26', weekEnd: '2026-11-01',
      schedules: [
        { id: 1, title: '월요일 회의', start_at: '2026-10-26T10:00:00', end_at: null, location: '' },
        { id: 2, title: '수요일 회의', start_at: '2026-10-28T14:00:00', end_at: null, location: '' },
        { id: 3, title: '주 밖 일정', start_at: '2026-10-20T09:00:00', end_at: null, location: '' },
      ],
      todosDone: 3, todosPending: 1, memos: [],
    })
    const schedSlide = deck.slides[1]
    expect(schedSlide.bullets).toContain('[월 10/26]')
    expect(schedSlide.bullets).toContain('  10:00  월요일 회의')
    expect(schedSlide.bullets).toContain('[수 10/28]')
    expect(schedSlide.bullets).toContain('  14:00  수요일 회의')
    // 주 밖 일정(10/20)은 idx 0으로 고정돼 월요일 그룹에 함께 표시된다
    expect(schedSlide.bullets.filter((b) => b.includes('주 밖 일정'))).toHaveLength(1)
    const todoSlide = deck.slides[2]
    expect(todoSlide.bullets).toContain('완료율: 75%')
    const chart = deck.slides.find((s) => s.kind === 'chart')
    expect(chart).toBeDefined()
    expect((chart as any).series[0].values).toEqual([2, 0, 1, 0, 0, 0, 0])
  })
})

describe('briefing-export — D1 조회', () => {
  const now = new Date('2026-10-26T00:00:00Z') // KST 2026-10-26(월) 09:00

  test('fetchMorningBriefing: 당일 active 일정 + pending 할 일 + 공개 메모만', async () => {
    const db = makeBriefingDb()
    seedBriefingDb(db)
    const data = await fetchMorningBriefing(db, now)
    expect(data.date).toBe('2026-10-26')
    expect(data.schedules.map((s) => s.title)).toEqual(['오늘 회의'])
    expect(data.todos.map((t) => t.title)).toEqual(['급한 일', '여유 있는 일'])
    // 잠긴 메모·민감 메모 제외, 최신순
    expect(data.memos.map((m) => m.text)).toEqual(['지난주 메모 내용입니다', '오늘 메모 내용입니다'])
  })

  test('fetchWeeklyReport: 주 범위 일정 + 전체 할 일 건수 + 주 범위 메모', async () => {
    const db = makeBriefingDb()
    seedBriefingDb(db)
    const data = await fetchWeeklyReport(db, now)
    expect(data.weekStart).toBe('2026-10-26')
    expect(data.weekEnd).toBe('2026-11-01')
    expect(data.schedules.map((s) => s.title)).toEqual(['오늘 회의', '내일 일정'])
    expect(data.todosDone).toBe(1)
    expect(data.todosPending).toBe(2)
    expect(data.memos.map((m) => m.text)).toEqual(['오늘 메모 내용입니다'])
  })

  test('now 기본값 — 인자 없이 호출해도 동작 (101/200)', async () => {
    const db = makeBriefingDb()
    seedBriefingDb(db)
    const morning = await fetchMorningBriefing(db)
    expect(morning.date).toBe(kstDateStr())
    const weekly = await fetchWeeklyReport(db)
    expect(weekly.weekStart).toBe(weekMonday(kstDateStr()))
  })

  test('결과 null이면 빈 배열·0으로 폴백 (133/238-241)', async () => {
    const stubDb = {
      prepare(_sql: string) {
        return {
          bind(..._p: any[]) { return this },
          async all() { return { results: null } },
          async first() { return null },
          async run() { return { meta: { changes: 0, last_row_id: 0 } } },
        }
      },
    } as unknown as D1Database
    const morning = await fetchMorningBriefing(stubDb, now)
    expect(morning).toEqual({ date: '2026-10-26', schedules: [], todos: [], memos: [] })
    const weekly = await fetchWeeklyReport(stubDb, now)
    expect(weekly.schedules).toEqual([])
    expect(weekly.todosDone).toBe(0)
    expect(weekly.todosPending).toBe(0)
    expect(weekly.memos).toEqual([])
  })
})

// ---------------- expert-registry.ts ----------------

describe('expert-registry — ID 매핑 + null 폴백 (현행 표면)', () => {
  // 구 legacyToNewId/getExpertProvider/getExpertCapability/getBriefingOwner/
  // getReminderOwner/listExperts 접근자는 소멸했다. 현행 표면은 EXPERTS +
  // getExpert(양방향 정규화) + ownsBriefing/ownsReminders 플래그다.
  test('레거시 → 신규 ID 매핑: 4명 전부 (getExpert 경유)', () => {
    expect(getExpert('concierge')?.newId).toBe('lumi')
    expect(getExpert('keeper')?.newId).toBe('echo')
    expect(getExpert('builder')?.newId).toBe('nova')
    expect(getExpert('scheduler')?.newId).toBe('cali')
  })

  test('알 수 없는 ID는 null/빈 배열', () => {
    expect(getExpert('bogus')).toBeNull()
    expect(getExpert(null)).toBeNull()
    expect(getExpert('bogus')?.provider ?? null).toBeNull()
    expect(getExpert('bogus')?.capability ?? null).toBeNull()
    expect(getExpertTools('bogus')).toEqual([])
    expect(getExpertProviderByLegacyId('bogus')).toBeNull()
    expect(getExpertCapabilityByLegacyId('bogus')).toBeNull()
  })

  test('신규 ID로도 조회된다', () => {
    expect(getExpert('lumi')?.legacyId).toBe('concierge')
    expect(getExpert('cali')?.provider).toBe('groq')
    expect(getExpert('echo')?.capability).toBe('summarize')
    expect(getExpertTools('concierge')).toEqual(expect.arrayContaining([]))
  })

  test('소유자·목록', () => {
    expect(EXPERTS).toHaveLength(4)
    expect(EXPERTS.find((e) => e.ownsBriefing)?.legacyId).toBe('concierge')
    expect(EXPERTS.find((e) => e.ownsReminders)?.legacyId).toBe('scheduler')
  })
})

// ---------------- provider-registry.ts ----------------

describe('provider-registry — 등록 검증 + 조회', () => {
  const fakePlugin: any = {
    id: 'cov-test',
    displayName: 'Coverage Test',
    listModels: () => [{ id: 'cov-model', provider: 'cov-test' }],
    call: async () => ({ text: 'cov' }),
  }

  afterEach(() => {
    unregisterProvider('cov-test' as any)
  })

  test('isProviderRegistered: 등록 전 false, 등록 후 true (82)', () => {
    expect(isProviderRegistered('cov-test' as any)).toBe(false)
    registerProvider(fakePlugin)
    expect(isProviderRegistered('cov-test' as any)).toBe(true)
    expect(getProvider('cov-test' as any)).toBe(fakePlugin)
    expect(getProviderModels('cov-test' as any)).toHaveLength(1)
  })

  test('registerProvider 검증 — plugin 없음/call 없음/listModels 없음 (68-70)', () => {
    expect(() => registerProvider(null as any)).toThrow('plugin.id required')
    expect(() => registerProvider({ id: 'x' } as any)).toThrow('has no call()')
    expect(() => registerProvider({ id: 'x', call: async () => ({ text: '' }) } as any))
      .toThrow('has no listModels()')
  })

  test('중복 등록은 replace 없으면 throw, replace면 교체', () => {
    registerProvider(fakePlugin)
    expect(() => registerProvider(fakePlugin)).toThrow('already registered')
    const replacement = { ...fakePlugin, displayName: 'Replaced' }
    registerProvider(replacement, { replace: true })
    expect(getProvider('cov-test' as any)?.displayName).toBe('Replaced')
  })

  test('ai.ts 로드 시 등록된 기본 프로바이더 조회', () => {
    // 이 파일이 ai.ts를 import하므로 기본 4개가 등록돼 있다
    expect(isProviderRegistered('gemini')).toBe(true)
    expect(isProviderRegistered('groq')).toBe(true)
    expect(getProvider('gemini')).toBeDefined()
    expect(listProviders().map((p) => p.id)).toEqual(
      expect.arrayContaining(['gemini', 'groq', 'workers-ai', 'nvidia']),
    )
  })

  test('미등록 프로바이더 모델 목록은 [] (91)', () => {
    expect(getProviderModels('not-registered' as any)).toEqual([])
    expect(getProvider('not-registered' as any)).toBeUndefined()
  })

  test('unregisterProvider 반환값', () => {
    expect(unregisterProvider('cov-test' as any)).toBe(false)
    registerProvider(fakePlugin)
    expect(unregisterProvider('cov-test' as any)).toBe(true)
    expect(unregisterProvider('cov-test' as any)).toBe(false)
  })

  test('resolvePersonaProvider: 핀 매핑 + 알 수 없는 비서는 concierge 핀 (112)', () => {
    expect(PERSONA_PROVIDER_PIN.concierge).toBe('gemini')
    // keeper 기본 핀은 nvidia (2026-11-05 실측 판정) — workers-ai는 메모 턴 전용
    expect(PERSONA_PROVIDER_PIN.keeper).toBe('nvidia')
    expect(PERSONA_PROVIDER_PIN.builder).toBe('gemini')
    expect(PERSONA_PROVIDER_PIN.scheduler).toBe('groq')
    expect(resolvePersonaProvider('keeper')).toBe('nvidia')
    expect(resolvePersonaProvider('scheduler')).toBe('groq')
    expect(resolvePersonaProvider('unknown-persona')).toBe('gemini')
  })
})

// ---------------- ai.ts ----------------

function makeMockDb(overrides: any = {}): any {
  const defaultAll = { results: [] }
  return {
    prepare: jest.fn().mockReturnValue({
      bind: jest.fn().mockReturnValue({
        first: jest.fn().mockResolvedValue(overrides.first ?? null),
        all: jest.fn().mockResolvedValue(overrides.all ?? defaultAll),
        run: jest.fn().mockResolvedValue(overrides.run ?? {}),
      }),
    }),
  }
}

describe('aiChat — 호출 직전 민감도 재검사 차단 (750)', () => {
  const mockCheckProviderAllowed = checkProviderAllowed as jest.Mock
  const mockCheckDataPolicy = checkDataPolicy as jest.Mock
  const mockResolveSensitivity = resolvePolicySensitivity as jest.Mock

  beforeEach(() => {
    mockCheckProviderAllowed.mockReset()
    mockCheckDataPolicy.mockReset()
    mockResolveSensitivity.mockReset()
  })

  test('민감도 정책이 프로바이더를 막으면 PrivacyBlockedError로 즉시 실패', async () => {
    mockResolveSensitivity.mockReturnValue('restricted')
    mockCheckProviderAllowed.mockImplementation((_provider: string, sensitivity: string) =>
      sensitivity === 'general' ? { allowed: true } : { allowed: false, reason: '민감 정보 차단' },
    )
    mockCheckDataPolicy.mockReturnValue({ allowed: false, reason: '민감 정보 차단' })
    const env = { DB: makeMockDb(), GEMINI_API_KEY_1: 'test-gemini-key' }
    const policy: TaskPolicy = {
      capability: 'chat',
      privacy: 'external-ok',
      latency: 'interactive',
      quality: 'fast',
      personaId: 'builder',
      providerPin: 'gemini',
    }
    let caught: any
    try {
      await aiChat(env as any, policy, [{ role: 'user', content: '안녕' } as ChatMessage], { disableRetry: true })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(PrivacyBlockedError)
    expect(caught.name).toBe('PrivacyBlockedError')
    expect(caught.message).toContain('개인정보 보호 정책에 따라')
    expect(caught.sensitivity).toBe('restricted')
    // 현행 selectModel은 후보 필터링 단계에서 전 provider가 막히면
    // 'no-allowed-provider'로 차단한다 (구 per-call reason 전파 방식에서 변경)
    expect(caught.reason).toBe('no-allowed-provider')
    // 모델 호출 전에 차단되므로 fetch가 나가지 않는다
    expect(mockCheckProviderAllowed).toHaveBeenCalledWith('gemini', 'restricted')
  })

  test('private 호출은 workers-ai 후보를 checkDataPolicy로 검사한다', async () => {
    // 현행: private 정책은 workers-ai 모델만 후보로 남기고, 그 후보의
    // 허용 여부를 checkDataPolicy로 판정한다 (구 gemini 직접 검사에서 변경)
    mockResolveSensitivity.mockReturnValue('restricted')
    mockCheckDataPolicy.mockReturnValue({ allowed: false, reason: 'private 차단' })
    const env = { DB: makeMockDb(), AI: { run: jest.fn() } }
    const policy: TaskPolicy = {
      capability: 'chat',
      privacy: 'private',
      latency: 'interactive',
      quality: 'fast',
      personaId: 'concierge',
      providerPin: 'workers-ai',
    }
    await expect(
      aiChat(env as any, policy, [{ role: 'user', content: '안녕' } as ChatMessage], { disableRetry: true }),
    ).rejects.toThrow('개인정보 보호 정책에 따라')
    expect(mockCheckDataPolicy).toHaveBeenCalledWith('workers-ai', 'restricted')
  })
})

describe('aiChat — keeper FC 메모 생성 실패 알림 (957)', () => {
  beforeEach(() => {
    (dispatchToolCalls as jest.Mock).mockReset()
    ;(resolvePolicySensitivity as jest.Mock).mockReturnValue(undefined)
    // 모델 선택(ai-model-selection)도 같은 가드 모듈을 본다 — 미설정이면
    // undefined.allowed로 죽으므로 실제 구현으로 위임한다
    const actualGuard = jest.requireActual('../../src/ai/legacy-privacy-guard')
    ;(checkProviderAllowed as jest.Mock).mockImplementation((...a: any[]) =>
      (actualGuard.checkProviderAllowed as any)(...a))
    ;(checkDataPolicy as jest.Mock).mockImplementation((...a: any[]) =>
      (actualGuard.checkDataPolicy as any)(...a))
  })

  test('마지막 라운드 메모 생성 실패 시 사용자에게 실패를 알린다', async () => {
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce({
          response: '',
          tool_calls: [{ name: 'memo_create', arguments: '{"text": "새 메모"}' }],
        })
        .mockResolvedValueOnce({ response: '처리했습니다.' }),
    }
    ;(dispatchToolCalls as jest.Mock).mockResolvedValue([
      { toolName: 'memo_create', status: 'failed', success: false, error: 'DB 오류' },
    ])
    const env = { DB: makeMockDb(), AI: mockAi }
    const policy: TaskPolicy = {
      capability: 'chat',
      privacy: 'external-ok',
      latency: 'background',
      quality: 'balanced',
      personaId: 'keeper',
      providerPin: 'workers-ai',
      origin: 'interactive',
    }
    const result = await aiChat(env as any, policy, [{ role: 'user', content: '메모 만들어줘' } as ChatMessage])
    expect(dispatchToolCalls).toHaveBeenCalled()
    expect((result as any).toolResults).toHaveLength(1)
    expect((result as any).toolResults[0].success).toBe(false)
    // 쓰기 실패인데도 성공했다는 말이 아니라 실패를 명시한다
    expect(result.text).toBe('처리했습니다.\n\n메모 생성에 실패했습니다.')
    // 실패한 쓰기는 dataChanged를 세우지 않는다
    expect((result as any).dataChanged).toBeUndefined()
    expect(mockAi.run).toHaveBeenCalledTimes(2)
  })

  test('후속 응답에 이미 "메모 생성"이 있으면 중복 알림을 붙이지 않는다', async () => {
    const mockAi = {
      run: jest.fn()
        .mockResolvedValueOnce({
          response: '',
          tool_calls: [{ name: 'memo_create', arguments: '{"text": "새 메모"}' }],
        })
        .mockResolvedValueOnce({ response: '메모 생성이 안 됐어요. 다시 시도해 주세요.' }),
    }
    ;(dispatchToolCalls as jest.Mock).mockResolvedValue([
      { toolName: 'memo_create', status: 'failed', success: false, error: 'DB 오류' },
    ])
    const env = { DB: makeMockDb(), AI: mockAi }
    const policy: TaskPolicy = {
      capability: 'chat',
      privacy: 'external-ok',
      latency: 'background',
      quality: 'balanced',
      personaId: 'keeper',
      providerPin: 'workers-ai',
      origin: 'interactive',
    }
    const result = await aiChat(env as any, policy, [{ role: 'user', content: '메모 만들어줘' } as ChatMessage])
    expect(result.text).toBe('메모 생성이 안 됐어요. 다시 시도해 주세요.')
    expect(result.text.match(/메모 생성에 실패했습니다/g)).toBeNull()
  })
})

// ---------------- eval-runner.ts (39-41) — 파일 맨 마지막에 둘 것 ----------------

describe('eval-runner — composeV2Prompt 예외 시 실패 기록 (39-41)', () => {
  test('합성 실패 시 모든 케이스 failed + detail 기록', () => {
    jest.resetModules()
    jest.doMock('../../src/ai/prompt-integration', () => ({
      ...jest.requireActual('../../src/ai/prompt-integration'),
      composeV2Prompt: () => { throw new Error('합성 실패') },
    }))
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mocked = require('../../src/ai/eval-runner')
    const results = mocked.runMockEval()
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(r.passed).toBe(false)
      const check = r.checks.find((c: any) => c.name === 'prompt_composed')
      expect(check).toBeDefined()
      expect(check.passed).toBe(false)
      expect(check.detail).toBe('합성 실패')
      // 실패한 케이스는 time_context_present 등 후속 체크를 받지 않는다
      expect(r.checks).toHaveLength(1)
    }
    const summary = mocked.summarizeEval(results)
    expect(summary.total).toBe(results.length)
    expect(summary.passed).toBe(0)
    expect(summary.failed).toEqual(results.map((r: any) => r.caseId))
    jest.resetModules()
  })

  test('정상 경로는 여전히 전체 케이스를 실행한다 (모듈 복원 확인)', () => {
    const results = runMockEval()
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((r) => r.checks.some((c) => c.name === 'prompt_composed'))).toBe(true)
    const summary = summarizeEval(results)
    expect(summary.total).toBe(results.length)
  })
})

// ---------------- 추가 브랜치 보강 (2차) ----------------

describe('workflow — 추가 경계 분기', () => {
  test('문자열 예외 throw → String(e) 폴백 (316)', async () => {
    const db = makeWorkflowDb()
    const d = wfDef({
      nodes: [{ id: 'x', name: 'X', run: async () => { throw '문자열 예외' } }],
    })
    const r = await runWorkflow(d, { env: envWith(db) })
    expect(r.status).toBe('failed')
    expect(r.error).toBe('문자열 예외')
  })

  test('env에 DB 없음 → 기록 없이 실행만 (341)', async () => {
    const r = await runWorkflow(wfDef(), { env: {} as any })
    expect(r.status).toBe('completed')
    expect(r.runId).toBeNull()
    expect(r.output).toEqual({ a: 1 })
  })

  test('when 조건이 문자열 예외 → when 조건 오류로 실패 (399)', async () => {
    const db = makeWorkflowDb()
    const d = wfDef({
      nodes: [{
        id: 'x', name: 'X',
        when: () => { throw 'when boom' },
        run: async () => ({ a: 1 }),
      }],
    })
    const r = await runWorkflow(d, { env: envWith(db) })
    expect(r.status).toBe('failed')
    expect(r.error).toContain('when 조건 오류: when boom')
  })

  test('노드별 retry 정책이 기본 정책을 덮어쓴다 (368)', async () => {
    const db = makeWorkflowDb()
    let attempts = 0
    const d = wfDef({
      retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      nodes: [{
        id: 'x', name: 'X',
        retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
        run: async () => {
          attempts++
          if (attempts === 1) throw new Error('일시 실패')
          return { ok: true }
        },
      }],
    })
    const r = await runWorkflow(d, { env: envWith(db), sleep: async () => {} })
    expect(r.status).toBe('completed')
    expect(r.attempts).toBe(2)
  })

  test('stale running 갱신 결과가 meta 없음 → duplicate(running) (212)', async () => {
    const db = {
      prepare(_sql: string) {
        return {
          bind(..._p: any[]) { return this },
          async first() {
            return { id: 5, status: 'running', output_json: null }
          },
          async all() { return { results: [] } },
          async run() {
            return {} // meta 없음 → changes ?? 0 = 0 → stale 아님
          },
        }
      },
    }
    let ran = 0
    const d = wfDef({ nodes: [{ id: 'a', name: 'A', run: async () => { ran++; return { a: 1 } } }] })
    const r = await runWorkflow(d, { env: { DB: db } as any, idempotencyKey: 'stale-nometa' })
    expect(r.status).toBe('duplicate')
    expect(r.runId).toBe(5)
    expect(r.output).toEqual({})
    expect(ran).toBe(0)
  })

  test('stale running 갱신 성공 → 재실행 허용', async () => {
    const db = {
      prepare(_sql: string) {
        return {
          bind(..._p: any[]) { return this },
          async first() {
            return { id: 5, status: 'running', output_json: null }
          },
          async all() { return { results: [] } },
          async run() {
            return { meta: { changes: 1, last_row_id: 5 } }
          },
        }
      },
    }
    let ran = 0
    const d = wfDef({ nodes: [{ id: 'a', name: 'A', run: async () => { ran++; return { a: 1 } } }] })
    const r = await runWorkflow(d, { env: { DB: db } as any, idempotencyKey: 'stale-rerun' })
    expect(r.status).toBe('completed')
    expect(r.runId).toBe(5)
    expect(ran).toBe(1)
  })

  test('INSERT last_row_id 0 → runId null로 실행 (233)', async () => {
    const db = {
      prepare(_sql: string) {
        return {
          bind(..._p: any[]) { return this },
          async first() { return null },
          async all() { return { results: [] } },
          async run() {
            return { meta: { changes: 1, last_row_id: 0 } }
          },
        }
      },
    }
    const r = await runWorkflow(wfDef(), { env: { DB: db } as any, idempotencyKey: 'zero-id' })
    expect(r.status).toBe('completed')
    expect(r.runId).toBeNull()
    expect(r.output).toEqual({ a: 1 })
  })
})

describe('memory-service — 추가 경계 분기', () => {
  test('claimHandoff payload JSON 손상 → 빈 payload로 복원 (593)', async () => {
    const db = makeMemDb({
      run: () => ({ meta: { changes: 1, last_row_id: 1 } }),
      first: () => ({ from_persona: 'keeper', to_persona: 'concierge', payload: '{broken' }),
    })
    const r = await claimHandoff({ DB: db } as any, 'token-1')
    expect(r.ok).toBe(true)
    expect(r.payload).toEqual({ memory_ids: [], summary: '' })
    expect(r.fromPersona).toBe('keeper')
    expect(r.toPersona).toBe('concierge')
  })

  test('createHandoff TTL 클램프 — 기본 60분, 0→1분, 초과→1440분 (544/546/553)', async () => {
    const captured: any[][] = []
    const db = makeMemDb({
      run: (_sql: string, params: any[]) => {
        captured.push(params)
        return { meta: { last_row_id: 9, changes: 1 } }
      },
    })
    const base = { fromPersona: 'keeper', toPersona: 'concierge', memoryIds: [1], summary: '요약' }
    await createHandoff({ DB: db } as any, base)
    await createHandoff({ DB: db } as any, { ...base, ttlMinutes: 0 })
    await createHandoff({ DB: db } as any, { ...base, ttlMinutes: 100000 })
    expect(captured).toHaveLength(3)
    const span = (i: number) => Date.parse(captured[i][5]) - Date.parse(captured[i][4])
    expect(span(0)).toBe(60 * 60000)
    expect(span(1)).toBe(1 * 60000)
    expect(span(2)).toBe(24 * 60 * 60000)
  })

  test('buildMemoryPage 성공 — 요약 우선 + 기본 카테고리 (425/427/434/441)', async () => {
    const captured: any[] = []
    const db = makeMemDb({
      all: () => ({
        results: [
          { id: 1, content: '첫 문장입니다. 둘째 문장.', summary: '요약본' },
          { id: 2, content: '두 번째 기억 내용입니다.', summary: null },
        ],
      }),
      run: (_sql: string, params: any[]) => {
        captured.push(params)
        return { meta: { last_row_id: 7, changes: 1 } }
      },
    })
    const r = await buildMemoryPage({ DB: db } as any, { title: '페이지', memoryIds: [1, 2, 2, 99] })
    expect(r).toEqual({ ok: true, id: 7 })
    expect(captured).toHaveLength(1)
    expect(captured[0][0]).toBe('페이지')
    // 요약이 있으면 요약, 없으면 첫 문장 추출; 중복·없는 ID 제외
    expect(captured[0][1]).toBe('- 요약본\n- 두 번째 기억 내용입니다.')
    expect(captured[0][2]).toBe('general')
    expect(JSON.parse(captured[0][3])).toEqual([1, 2, 99])
  })
})

describe('nl-cron — 추가 경계 분기', () => {
  test('요일 집합 null인 weekly는 370일 탐색 후 null (270/315)', () => {
    const s: NlCronSchedule = {
      kind: 'weekly', hour: 8, minute: 0, daysOfWeek: null, dayOfMonth: null,
      intervalMinutes: null, timezone: 'Asia/Seoul', cronKst: '0 8 * * ',
    }
    expect(nextRunAfter(s, new Date('2026-10-26T00:00:00Z'))).toBeNull()
  })

  test('intervalMinutes null이면 60분으로 간주해 다음 정시 (289)', () => {
    const s: NlCronSchedule = {
      kind: 'interval', hour: 0, minute: 0, daysOfWeek: null, dayOfMonth: null,
      intervalMinutes: null, timezone: 'Asia/Seoul', cronKst: '0 * * * *',
    }
    // from = KST 09:07 → 다음 정시 10:00 KST = 01:00Z
    expect(nextRunAfter(s, new Date('2026-10-26T00:07:00Z'))?.toISOString())
      .toBe('2026-10-26T01:00:00.000Z')
  })

  test('2시간마다 설명 문장 (356/357)', () => {
    const p = parseNlCron('2시간마다 알려줘')
    expect(p).not.toBeNull()
    expect(describeNlCron(p!)).toBe('2시간마다 일정 알림을 보내드릴게요.')
  })

  test('요일 집합 null인 weekly 설명 문장 (334)', () => {
    const parsed = {
      action: 'generic',
      original: 'manual',
      schedule: {
        kind: 'weekly', hour: 8, minute: 0, daysOfWeek: null, dayOfMonth: null,
        intervalMinutes: null, timezone: 'Asia/Seoul', cronKst: '0 8 * * ',
      },
    } as any
    expect(describeNlCron(parsed)).toBe('매주 요일 오전 8시에 알림을 보내드릴게요.')
  })
})

describe('prompt-integration — 날짜 블록 조건 경계 (98)', () => {
  const timeCtx = {
    nowIso: '2026-10-17T05:00:00Z',
    timezone: 'Asia/Seoul',
    todayLocal: '2026-10-17',
    weekStartLocal: '2026-10-12',
  } as any

  test('scheduler + userMessage지만 timeContext 없음 → 날짜 블록 없음', () => {
    const result = composeV2Prompt('scheduler', { userMessage: '내일 회의 잡아줘' })
    expect(result.prompt.length).toBeGreaterThan(100)
    expect(result.prompt).not.toContain('[서버 확정 날짜]')
    expect(result.prompt).not.toContain('[날짜 확인 필요]')
  })

  test('날짜 블록 대상이 아닌 비서(builder)는 timeContext·userMessage가 있어도 날짜 블록 없음', () => {
    // 대상은 scheduler·keeper다 (2026-10-30 라이브 게이트: keeper FC
    // 일정 등록에도 서버 확정 날짜가 필요해 keeper가 대상에 포함됐다 —
    // keeper 긍정 케이스는 ai-live-gate-residuals.test.ts가 고정한다).
    const result = composeV2Prompt('builder', {
      timeContext: timeCtx,
      userMessage: '내일 회의 잡아줘',
    })
    expect(result.prompt.length).toBeGreaterThan(100)
    expect(result.prompt).not.toContain('[서버 확정 날짜]')
  })
})

// ---------------- 추가 브랜치 보강 (4차 — workflow 잔여) ----------------

describe('workflow — claimRun meta 없음 + JSON 절단', () => {
  test('INSERT 결과가 meta 없음 → changes 0으로 취급해 경합 조회 후 runId null로 실행 (232/233)', async () => {
    const db = {
      prepare(_sql: string) {
        return {
          bind(..._p: any[]) { return this },
          async first() { return null },
          async all() { return { results: [] } },
          async run() {
            return {} // meta 없음
          },
        }
      },
    }
    const r = await runWorkflow(wfDef(), { env: { DB: db } as any, idempotencyKey: 'meta-less' })
    expect(r.status).toBe('completed')
    expect(r.runId).toBeNull()
    expect(r.output).toEqual({ a: 1 })
  })

  test('4000자를 넘는 입력 JSON은 절단 마킹된 유효 JSON으로 저장 (137)', async () => {
    const db = makeWorkflowDb()
    const big = 'x'.repeat(5000)
    const r = await runWorkflow(wfDef(), {
      env: envWith(db),
      idempotencyKey: 'big-input',
      input: { big },
    })
    expect(r.status).toBe('completed')
    expect(r.runId).not.toBeNull()
    const row = (db as any)._db
      .prepare('SELECT input_json FROM workflow_runs WHERE id = ?')
      .get(r.runId)
    // 결함 2 수정: 구 코드는 JSON을 중간에서 잘라 저장해 파싱이 안 됐다.
    // 이제는 절단 사실을 명시한 유효 JSON을 저장한다.
    expect(row.input_json.length).toBeLessThanOrEqual(4000)
    const parsed = JSON.parse(row.input_json)
    expect(parsed[TRUNCATED_JSON_MARKER]).toBe(true)
    expect(typeof parsed.preview).toBe('string')
    expect(parsed.preview.startsWith('{"big":"xxx')).toBe(true)
  })
})

// ---------------- 추가 브랜치 보강 (5차 — prompt-integration 98) ----------------

describe('createRequestTimeContext — 시간대 미설정 (98)', () => {
  test('설정이 없으면 기본 Asia/Seoul (조회 성공·값 없음 경로)', async () => {
    const db = {
      prepare(_sql: string) {
        return {
          bind(..._p: any[]) { return this },
          async first() { return null }, // 행 없음 → getSetting null
        }
      },
    }
    const ctx = await createRequestTimeContext(db as any)
    expect(ctx.timezone).toBe('Asia/Seoul')
    expect(ctx.todayLocal).toBeDefined()
  })
})
