/**
 * 승인 게이트 커버리지 보강 (그룹 E)
 * - describeToolAction 전 도구 분기 + 미리보기 절단 + targetId 문자열/결측
 * - buildApprovalRequestText 되돌림 가능/근거 없음/dry-run 포함
 * - parseApprovalReply / isPossibleApprovalReply 전 분기
 * - ToolApprovalRequestStore: insert 실패, 잘못된 expiresAt, rowToPending 분기
 * - resolveApprovalReply: 감사 기록 실패·세션 허용 실패 시에도 결정은 유지,
 *   personaId 폴백, now 기본값
 */
import {
  parseApprovalReply,
  isPossibleApprovalReply,
  describeToolAction,
  describeMaskedToolAction,
  buildApprovalRequestText,
  resolveApprovalReply,
  ToolApprovalRequestStore,
  APPROVAL_TIMEOUT_MS,
} from '../src/services/approval-flow'
import { ToolApprovalStore } from '../src/services/tool-approval'
import { FakeD1, asD1 } from './fake-d1'

const NOW = new Date('2026-10-26T02:00:00Z')
const FUTURE = new Date(NOW.getTime() + APPROVAL_TIMEOUT_MS).toISOString()

function makeStores() {
  const fake = new FakeD1()
  const db = asD1(fake)
  return { fake, db, requests: new ToolApprovalRequestStore(db), approvals: new ToolApprovalStore(db) }
}

async function seedPending(requests: ToolApprovalRequestStore, overrides: Record<string, any> = {}) {
  return requests.createPending({
    personaId: 'concierge',
    conversationId: 1,
    tool: 'MEMO_DELETE',
    scopeKey: 'MEMO_DELETE:123',
    markerText: '[MEMO_DELETE]{"id":123}[/MEMO_DELETE]',
    summary: '메모 #123 삭제',
    userRequest: '그 메모 삭제해줘',
    reversible: false,
    impact: '메모 1개가 영구히 삭제됩니다. 되돌릴 수 없어요.',
    expiresAt: FUTURE,
    createdAt: NOW.toISOString(),
    ...overrides,
  })
}

/** FakeD1을 감싸 INSERT INTO tool_approvals의 n번째 실행에서 실패를 일으키는 DB */
function dbFailingApprovalInsert(fake: FakeD1, failOnNth: number, throwValue: unknown = new Error('db write failed')): D1Database {
  let insertCount = 0
  return {
    prepare(sql: string) {
      const inner = fake.prepare(sql)
      return {
        bind(...args: any[]) {
          const bound = inner.bind(...args)
          return {
            async run() {
              if (sql.includes('INSERT INTO tool_approvals')) {
                insertCount += 1
                if (insertCount === failOnNth) throw throwValue
              }
              return bound.run()
            },
            async all() { return bound.all() },
            async first() { return bound.first() },
          }
        },
      }
    },
  } as unknown as D1Database
}

/** UPDATE tool_approval_requests의 run()이 meta 없이 반환하는 DB (changes ?? 0 경로) */
function dbWithoutMeta(fake: FakeD1): D1Database {
  return {
    prepare(sql: string) {
      const inner = fake.prepare(sql)
      return {
        bind(...args: any[]) {
          const bound = inner.bind(...args)
          return {
            async run() {
              if (sql.includes('UPDATE tool_approval_requests SET status = ?')) {
                return { success: true, meta: undefined }
              }
              return bound.run()
            },
            async all() { return bound.all() },
            async first() { return bound.first() },
          }
        },
      }
    },
  } as unknown as D1Database
}

/** run()이 last_row_id 없는 meta를 돌려주는 DB (insert 실패 경로) */
const brokenInsertDb = {
  prepare() {
    return {
      bind() {
        return {
          async run() { return { success: true, meta: {} } },
          async all() { return { success: true, results: [] } },
          async first() { return null },
        }
      },
    }
  },
} as unknown as D1Database

describe('describeToolAction — 나머지 도구 분기', () => {
  test('일정: 생성(제목 유/무)·수정·삭제(제목/ID/둘 다 없음)', () => {
    expect(describeToolAction('SCHEDULE_CREATE', { title: '치과' })).toEqual({
      summary: '일정 "치과" 등록', reversible: true,
      impact: '새 일정 1개가 등록됩니다. 필요 없으면 삭제할 수 있어요.',
    })
    expect(describeToolAction('SCHEDULE_CREATE', {}).summary).toBe('일정 등록')
    expect(describeToolAction('SCHEDULE_UPDATE', { id: 7 }).summary).toBe('일정 #7 수정')
    expect(describeToolAction('SCHEDULE_UPDATE', { id: 7 }).reversible).toBe(false)
    expect(describeToolAction('SCHEDULE_DELETE', { title: '주간 회의' }).summary).toBe('일정 "주간 회의" 삭제')
    expect(describeToolAction('SCHEDULE_DELETE', { id: 7 }).summary).toBe('일정 #7 삭제')
    expect(describeToolAction('SCHEDULE_DELETE', {}).summary).toBe('일정 삭제')
  })

  test('할 일: 추가(제목 유/무)·수정·삭제', () => {
    expect(describeToolAction('TODO_ADD', { title: '우유 사기' }).summary).toBe('할 일 "우유 사기" 추가')
    expect(describeToolAction('TODO_ADD', {}).summary).toBe('할 일 추가')
    expect(describeToolAction('TODO_ADD', { title: '우유 사기' }).reversible).toBe(true)
    expect(describeToolAction('TODO_UPDATE', { id: 9 }).summary).toBe('할 일 #9 수정')
    expect(describeToolAction('TODO_UPDATE', { id: 9 }).reversible).toBe(false)
    expect(describeToolAction('TODO_DELETE', { id: 9 }).summary).toBe('할 일 #9 삭제')
  })

  test('아티팩트·자동화 생성·GitHub 가져오기', () => {
    expect(describeToolAction('ARTIFACT_CREATE', { title: '계산기' }).summary).toBe('아티팩트 "계산기" 생성')
    expect(describeToolAction('ARTIFACT_CREATE', {}).summary).toBe('아티팩트 생성')
    expect(describeToolAction('ARTIFACT_DELETE', { id: 3 }).summary).toBe('아티팩트 #3 삭제')
    expect(describeToolAction('ARTIFACT_FROM_GITHUB', { repo: 'x/y' }).summary).toBe('GitHub에서 아티팩트 가져오기')
    expect(describeToolAction('CRON_CREATE', { text: '매일 아침 브리핑' }).summary).toBe('자동화 저장 "매일 아침 브리핑"')
    expect(describeToolAction('CRON_CREATE', { text: '매일 아침 브리핑' }).reversible).toBe(true)
  })

  test('CRON_TOGGLE: 켜기/끄기/판단 불가', () => {
    expect(describeToolAction('CRON_TOGGLE', { id: 5, enabled: true }).summary).toBe('자동화 #5 켜기')
    expect(describeToolAction('CRON_TOGGLE', { id: 5, enabled: false }).summary).toBe('자동화 #5 끄기')
    expect(describeToolAction('CRON_TOGGLE', { id: 5 }).summary).toBe('자동화 #5 켜기/끄기')
    expect(describeToolAction('CRON_TOGGLE', { id: 5, enabled: 'yes' }).summary).toBe('자동화 #5 켜기/끄기')
  })

  test('알 수 없는 도구: 기본 분기', () => {
    expect(describeToolAction('SOME_NEW_TOOL', { id: 1 })).toEqual({
      summary: 'SOME_NEW_TOOL 실행', reversible: false,
      impact: '이 작업의 영향을 확인하지 못했어요.',
    })
    expect(describeToolAction('memo_create', { text: 'x' }).summary).toBe('메모 생성 "x"')
  })

  test('미리보기: 50자 초과 텍스트는 …로 절단, content 키도 사용', () => {
    const long = '가'.repeat(60)
    const d = describeToolAction('MEMO_CREATE', { text: long })
    expect(d.summary).toBe(`메모 생성 "${'가'.repeat(50)}…"`)
    expect(describeToolAction('MEMO_CREATE', { content: '내용 키' }).summary).toBe('메모 생성 "내용 키"')
    expect(describeToolAction('MEMO_CREATE', { text: '   ' }).summary).toBe('메모 생성')
  })

  test('targetId: 문자열 숫자 id, memoId 폴백, 소수·빈 문자열은 건너뜀', () => {
    expect(describeToolAction('MEMO_UPDATE', { id: '123', text: 'x' }).summary).toContain('#123')
    expect(describeToolAction('MEMO_DELETE', { memoId: 7 }).summary).toBe('메모 #7 삭제')
    expect(describeToolAction('MEMO_DELETE', { id: 1.5, memoId: 7 }).summary).toBe('메모 #7 삭제')
    expect(describeToolAction('MEMO_DELETE', { id: '  ' }).summary).toBe('메모 #? 삭제')
    expect(describeToolAction('MEMO_DELETE', {}).summary).toBe('메모 #? 삭제')
  })

  test('id가 없으면 #? — MEMO_UPDATE·SCHEDULE_UPDATE·TODO·ARTIFACT·CRON', () => {
    expect(describeToolAction('MEMO_UPDATE', { text: 'x' }).summary).toBe('메모 #? 수정 "x"')
    expect(describeToolAction('SCHEDULE_UPDATE', {}).summary).toBe('일정 #? 수정')
    expect(describeToolAction('TODO_DONE', {}).summary).toBe('할 일 #? 완료 처리')
    expect(describeToolAction('TODO_UPDATE', {}).summary).toBe('할 일 #? 수정')
    expect(describeToolAction('TODO_DELETE', {}).summary).toBe('할 일 #? 삭제')
    expect(describeToolAction('ARTIFACT_DELETE', {}).summary).toBe('아티팩트 #? 삭제')
    expect(describeToolAction('CRON_DELETE', {}).summary).toBe('자동화 #? 삭제')
    expect(describeToolAction('CRON_TOGGLE', {}).summary).toBe('자동화 #? 켜기/끄기')
  })

  test('인자가 null·객체가 아니면 빈 인자로 취급', () => {
    expect(describeToolAction('MEMO_DELETE', null).summary).toBe('메모 #? 삭제')
    expect(describeToolAction('MEMO_DELETE', '문자열').summary).toBe('메모 #? 삭제')
    expect(describeToolAction('TODO_DONE', undefined).summary).toBe('할 일 #? 완료 처리')
  })
})

describe('describeMaskedToolAction — 마스킹된 인자로 설명', () => {
  test('일반 인자는 그대로, 시크릿 패턴은 마스킹되어 요약에 안 남음', () => {
    expect(describeMaskedToolAction('MEMO_CREATE', { text: '장보기' }).summary).toBe('메모 생성 "장보기"')
    const masked = describeMaskedToolAction('MEMO_CREATE', { text: '키 sk-abcdefghij1234567890 확인' })
    expect(masked.summary).not.toContain('sk-abcdefghij1234567890')
    expect(masked.summary).toContain('[API_KEY_MASKED]')
  })
})

describe('buildApprovalRequestText — 되돌림 가능·근거 없음·dry-run', () => {
  test('되돌릴 수 있는 작업은 "네, 되돌릴 수 있어요"', () => {
    const text = buildApprovalRequestText({
      summary: '메모 생성', userRequest: '메모 써줘', reversible: true, impact: '새 메모 1개',
    })
    expect(text).toContain('되돌릴 수 있나요: 네, 되돌릴 수 있어요')
  })

  test('근거가 비어 있으면 근거 행이 없음', () => {
    const text = buildApprovalRequestText({
      summary: '메모 #1 삭제', userRequest: '', reversible: false, impact: '영구 삭제',
    })
    expect(text).not.toContain('근거:')
    expect(text).toContain('되돌릴 수 있나요: 아니요, 되돌릴 수 없어요')
  })

  test('dry-run 미리보기가 있으면 문안 뒤에 붙음', () => {
    const text = buildApprovalRequestText({
      summary: '메모 #1 삭제', userRequest: '지워줘', reversible: false,
      impact: '영구 삭제', dryRunPreview: '[실행 전 미리보기]\n대상: 메모 #1',
    })
    expect(text).toContain('[실행 전 미리보기]')
    expect(text).toContain('대상: 메모 #1')
  })
})

describe('parseApprovalReply / isPossibleApprovalReply — 나머지 분기', () => {
  test('parseApprovalReply: 비문자열·끝 구두점·세션 허용 변형', () => {
    expect(parseApprovalReply(42 as any)).toBeNull()
    expect(parseApprovalReply(null as any)).toBeNull()
    expect(parseApprovalReply('승인해!')).toBe('approve')
    expect(parseApprovalReply('승인해요')).toBeNull()
    expect(parseApprovalReply('대화 허용')).toBe('approve_session')
    expect(parseApprovalReply('이번 대화 계속 허용해줘')).toBe('approve_session')
    expect(parseApprovalReply('허용해줘 세션')).toBe('approve_session')
    expect(parseApprovalReply('   ')).toBeNull()
  })

  test('parseApprovalReply: 삭제 동사 + 소문자 도구명도 승인', () => {
    expect(parseApprovalReply('지워줘', 'todo_delete')).toBe('approve')
    expect(parseApprovalReply('지워버려', 'SCHEDULE_DELETE')).toBe('approve')
    expect(parseApprovalReply('지워', 'MEMO_UPDATE')).toBeNull()
  })

  test('isPossibleApprovalReply: 가능성 판정 (DB 조회 전 필터)', () => {
    expect(isPossibleApprovalReply('승인해')).toBe(true)
    expect(isPossibleApprovalReply('거부해')).toBe(true)
    expect(isPossibleApprovalReply('삭제해')).toBe(true) // 도구 맥락 없이도 가능성에는 포함
    expect(isPossibleApprovalReply('이 세션 허용해')).toBe(true)
    expect(isPossibleApprovalReply('안녕하세요')).toBe(false)
    expect(isPossibleApprovalReply('승인해 그리고 요약해줘')).toBe(false)
    expect(isPossibleApprovalReply('')).toBe(false)
    expect(isPossibleApprovalReply('   ')).toBe(false)
    expect(isPossibleApprovalReply(undefined)).toBe(false)
    expect(isPossibleApprovalReply(123)).toBe(false)
  })
})

// [삭제 기록 — 2026-11-08 배치 3] 'approvalRequestSummary (toSummary) — 요약 매핑'
// describe(1건): 구 approvalRequestSummary() 런타임 매퍼는 현행·번들 어디에도 없고,
// 현행은 PendingApprovalRequest가 ApprovalRequestSummary를 확장해 그대로 전달되는
// 구조라 "7개 필드만 남기고 버리는" 런타임 동작 자체가 존재하지 않는다.
describe('ToolApprovalRequestStore — 실패·경계 경로', () => {
  test('insert가 last_row_id를 안 돌려주면 에러', async () => {
    const store = new ToolApprovalRequestStore(brokenInsertDb)
    await expect(seedPending(store)).rejects.toThrow('approval request insert failed')
  })

  test('expiresAt이 파싱 불가면 만료로 취급해 expired로 갱신', async () => {
    const { fake, requests } = makeStores()
    const created = await seedPending(requests, { expiresAt: 'not-a-date' })
    const { request, expired } = await requests.findNewestPending(1, NOW)
    expect(expired).toBe(true)
    expect(request?.status).toBe('expired')
    expect(fake.tables.tool_approval_requests.find((r) => r.id === created.id)?.status).toBe('expired')
    expect((await requests.findNewestPending(1, NOW)).request).toBeNull()
  })

  test('rowToPending: 모든 ?? 폴백 — null 필드 행은 빈 문자열로 매핑', async () => {
    const { fake, requests } = makeStores()
    fake.tables.tool_approval_requests.push({
      id: 100,
      persona_id: null,
      conversation_id: 5,
      tool: null,
      scope_key: null,
      marker_text: null,
      summary: null,
      user_request: null,
      reversible: 0,
      impact: null,
      status: 'pending',
      created_at: null,
      expires_at: null,
      decided_at: null,
    })
    const { request, expired } = await requests.findNewestPending(5, NOW)
    // expiresAt이 ''이면 파싱 불가 → 만료로 취급되지만, 매핑된 값 자체는 빈 문자열
    expect(expired).toBe(true)
    expect(request).toMatchObject({
      id: 100,
      personaId: '',
      conversationId: 5,
      tool: '',
      scopeKey: '',
      markerText: '',
      summary: '',
      userRequest: '',
      reversible: false,
      impact: '',
      createdAt: '',
      expiresAt: '',
    })
  })

  test('createPending reversible:true는 1로 저장', async () => {
    const { fake, requests } = makeStores()
    await seedPending(requests, { reversible: true })
    expect(fake.tables.tool_approval_requests[0].reversible).toBe(1)
  })

  test('resolveRequest now 기본값으로 해결됨', async () => {
    const { requests } = makeStores()
    const created = await seedPending(requests)
    expect(await requests.resolveRequest(created.id, 'approved')).toBe(true)
  })

  test('resolveRequest: meta 없는 run은 false (행은 그대로 pending)', async () => {
    const { fake, requests } = makeStores()
    const created = await seedPending(requests)
    const store = new ToolApprovalRequestStore(dbWithoutMeta(fake))
    expect(await store.resolveRequest(created.id, 'denied')).toBe(false)
    expect(fake.tables.tool_approval_requests.find((r) => r.id === created.id)?.status).toBe('pending')
    void requests
  })
  test('rowToPending: reversible=true·personaId null도 처리', async () => {
    const { fake, requests } = makeStores()
    fake.tables.tool_approval_requests.push({
      id: 99,
      persona_id: null,
      conversation_id: 5,
      tool: 'MEMO_DELETE',
      scope_key: 'MEMO_DELETE:1',
      marker_text: 'm',
      summary: 's',
      user_request: 'u',
      reversible: true,
      impact: 'i',
      status: 'pending',
      created_at: NOW.toISOString(),
      expires_at: FUTURE,
      decided_at: null,
    })
    const { request, expired } = await requests.findNewestPending(5, NOW)
    expect(expired).toBe(false)
    expect(request?.personaId).toBe('')
    expect(request?.reversible).toBe(true)
  })

  test('findNewestPending·findPendingByScope now 기본값 (인자 생략)', async () => {
    const { requests } = makeStores()
    await seedPending(requests, { expiresAt: '2999-01-01T00:00:00.000Z' })
    expect((await requests.findNewestPending(1)).request).not.toBeNull()
    expect(await requests.findPendingByScope(1, 'MEMO_DELETE:123')).not.toBeNull()
  })
})

describe('resolveApprovalReply — 감사 기록 실패에도 결정은 유지', () => {
  let errorSpy: jest.SpyInstance

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  test('감사 기록 실패(거부) → denied 반환 + 요청은 denied로 해결 + 에러 로그', async () => {
    const { fake, requests } = makeStores()
    const db = dbFailingApprovalInsert(fake, 1)
    await seedPending(requests)
    const res = await resolveApprovalReply(db, {
      conversationId: 1, personaId: 'concierge', reply: '거부해', now: NOW,
    })
    expect(res.status).toBe('denied')
    expect(fake.tables.tool_approval_requests[0].status).toBe('denied')
    expect(errorSpy).toHaveBeenCalledWith(
      '[approval] audit record failed:', expect.stringContaining('db write failed'),
    )
  })

  test('감사 기록 실패(승인) → approved 반환 + 요청은 approved로 해결', async () => {
    const { fake, requests } = makeStores()
    const db = dbFailingApprovalInsert(fake, 1)
    await seedPending(requests)
    const res = await resolveApprovalReply(db, {
      conversationId: 1, personaId: 'concierge', reply: '승인해', now: NOW,
    })
    expect(res.status).toBe('approved')
    expect(fake.tables.tool_approval_requests[0].status).toBe('approved')
    expect(errorSpy).toHaveBeenCalledWith(
      '[approval] audit record failed:', expect.anything(),
    )
  })

  test('세션 허용 기록 실패 → approved_session 반환 + 세션 허용 행 없음 + 에러 로그', async () => {
    const { fake, requests, approvals } = makeStores()
    const failingDb = dbFailingApprovalInsert(fake, 2) // 1번째=감사, 2번째=세션 허용
    await seedPending(requests)
    const res = await resolveApprovalReply(failingDb, {
      conversationId: 1, personaId: 'concierge', reply: '이 세션 허용해', now: NOW,
    })
    expect(res.status).toBe('approved_session')
    expect(fake.tables.tool_approval_requests[0].status).toBe('approved')
    // 감사 기록은 남았고, 세션 허용 행은 실패로 없음
    expect(await approvals.findLatestApproval('concierge', 'MEMO_DELETE', 'MEMO_DELETE:123'))
      .toMatchObject({ decision: 'approved' })
    expect(await approvals.findSessionAllowance('concierge', 'MEMO_DELETE', 1, NOW)).toBeNull()
    expect(errorSpy).toHaveBeenCalledWith(
      '[approval] session allowance failed:', expect.stringContaining('db write failed'),
    )
  })

  test('감사 기록 실패가 Error가 아니면 message 대신 값 그대로 로그', async () => {
    const { fake, requests } = makeStores()
    const db = dbFailingApprovalInsert(fake, 1, 'db write failed')
    await seedPending(requests)
    const res = await resolveApprovalReply(db, {
      conversationId: 1, personaId: 'concierge', reply: '거부해', now: NOW,
    })
    expect(res.status).toBe('denied')
    expect(errorSpy).toHaveBeenCalledWith('[approval] audit record failed:', 'db write failed')
  })

  test('세션 허용 실패가 Error가 아니면 message 대신 값 그대로 로그', async () => {
    const { fake, requests } = makeStores()
    const failingDb = dbFailingApprovalInsert(fake, 2, 'allowance boom')
    await seedPending(requests)
    const res = await resolveApprovalReply(failingDb, {
      conversationId: 1, personaId: 'concierge', reply: '이 세션 허용해', now: NOW,
    })
    expect(res.status).toBe('approved_session')
    expect(errorSpy).toHaveBeenCalledWith('[approval] session allowance failed:', 'allowance boom')
  })

  test('요청의 personaId가 비어 있으면 입력 personaId로 감사 기록', async () => {
    const { db, requests, approvals } = makeStores()
    await seedPending(requests, { personaId: '' })
    const res = await resolveApprovalReply(db, {
      conversationId: 1, personaId: 'keeper', reply: '승인해', now: NOW,
    })
    expect(res.status).toBe('approved')
    const audit = await approvals.findLatestApproval('keeper', 'MEMO_DELETE', 'MEMO_DELETE:123')
    expect(audit?.decision).toBe('approved')
  })

  test('now 생략 시 기본값(현재 시각)으로 동작', async () => {
    const { db, requests } = makeStores()
    await seedPending(requests, { expiresAt: '2999-01-01T00:00:00.000Z' })
    const res = await resolveApprovalReply(db, {
      conversationId: 1, personaId: 'concierge', reply: '승인해',
    })
    expect(res.status).toBe('approved')
  })
})
