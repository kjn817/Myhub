/// <reference types="jest" />
/**
 * src/services/clef-g6.ts — G6(쓰기·복합 자동 실행) 게이트 성질 테스트.
 *
 * G6는 사전 등록된 측정 게이트를 통과하기 전에는 절대 실제 서빙에
 * 적용되면 안 되는 fail-closed 설계다. 여기서는 (1) 활성화 판정이
 * 표본·지표 하한을 하나라도 못 미치면 실패하는지, 특히 null 지표와
 * 파괴 우회 1건이 즉시 탈락인지, (2) 섀도 모드는 판정이 eligible이어도
 * 실제 비서를 바꾸지 않는지, (3) 개별 판정(evaluateG6Judgment)이
 * 안전 구간·쓰기 범위·파괴 승인을 정확히 가르는지를 고정한다.
 * 카나리아: judgeG6Activation의 파괴 우회 허용치를 올리면 실패한다.
 */
import {
  CLEF_G6_MODE_KEY,
  G6_GATE,
  G6_GATE_VERSION,
  G6_SAFE_BAND,
  deriveG6Risk,
  g6ApprovalRequired,
  parseClefG6Mode,
  getClefG6Mode,
  evaluateG6Judgment,
  resolveG6Serving,
  buildG6DecisionLogEntry,
  recordG6DecisionLog,
  extractLedgerTraceId,
  judgeG6Activation,
  type G6ActivationMetrics,
  type G6Judgment,
} from '../../src/services/clef-g6'
import { CLEF_THRESHOLDS, hashText } from '../../src/services/clef-engine'

// ---------------- 모드 해석 ----------------

describe('G6 모드 해석 — 저장값이 shadow/active가 아니면 무조건 off', () => {
  test('parseClefG6Mode: shadow/active만 인정, 나머지는 전부 off', () => {
    expect(parseClefG6Mode('shadow')).toBe('shadow')
    expect(parseClefG6Mode('active')).toBe('active')
    expect(parseClefG6Mode('off')).toBe('off')
    expect(parseClefG6Mode('ACTIVE')).toBe('off')
    expect(parseClefG6Mode('')).toBe('off')
    expect(parseClefG6Mode(null)).toBe('off')
    expect(parseClefG6Mode(undefined)).toBe('off')
    expect(parseClefG6Mode(1)).toBe('off')
    expect(parseClefG6Mode({})).toBe('off')
  })

  function fakeSettingsDb(rows: Record<string, string>, opts: { throwOnQuery?: boolean } = {}) {
    const seenKeys: string[] = []
    const db = {
      prepare: (_sql: string) => ({
        bind: (key: string) => ({
          first: async () => {
            seenKeys.push(key)
            if (opts.throwOnQuery) throw new Error('db down')
            return key in rows ? { value: rows[key] } : null
          },
        }),
      }),
    }
    return { db: db as any, seenKeys }
  }

  test('getClefG6Mode: clef.g6_mode 키를 읽어 shadow/active만 통과시킨다', async () => {
    const { db, seenKeys } = fakeSettingsDb({ [CLEF_G6_MODE_KEY]: 'shadow' })
    await expect(getClefG6Mode(db)).resolves.toBe('shadow')
    expect(seenKeys).toEqual(['clef.g6_mode'])
    await expect(getClefG6Mode(fakeSettingsDb({ [CLEF_G6_MODE_KEY]: 'active' }).db)).resolves.toBe('active')
  })

  test('getClefG6Mode: 미설정·이상값·DB 오류는 전부 off (기본 비활성)', async () => {
    await expect(getClefG6Mode(fakeSettingsDb({}).db)).resolves.toBe('off')
    await expect(getClefG6Mode(fakeSettingsDb({ [CLEF_G6_MODE_KEY]: 'on' }).db)).resolves.toBe('off')
    await expect(getClefG6Mode(fakeSettingsDb({}, { throwOnQuery: true }).db)).resolves.toBe('off')
  })
})

// ---------------- 위험 분류 ----------------

describe('deriveG6Risk — 쓰기 의도와 파괴 동사의 합성', () => {
  test('읽기 전용 요청은 read', () => {
    expect(deriveG6Risk('오늘 일정 알려줘')).toBe('read')
    expect(deriveG6Risk('메모 보여줘')).toBe('read')
  })

  test('쓰기 의도가 있으면 write, 파괴 동사까지 있으면 destructive', () => {
    expect(deriveG6Risk('내일 회의 일정 등록해줘')).toBe('write')
    expect(deriveG6Risk('새 메모 만들어줘')).toBe('write')
    expect(deriveG6Risk('그 메모 삭제해줘')).toBe('destructive')
    expect(deriveG6Risk('메모 전부 지워줘')).toBe('destructive')
    expect(deriveG6Risk('내일 회의 취소해줘')).toBe('destructive')
  })

  test('파괴 동사만 있고 쓰기 대상이 없으면 승격되지 않는다 (read)', () => {
    // '취소'는 쓰기 동사지만 쓰기 대상(일정·메모 등)이 없어 쓰기 의도 자체가 성립하지 않는다
    expect(deriveG6Risk('취소 수수료가 얼마예요?')).toBe('read')
  })

  test('영어 파괴 동사는 destructive로 분류되지 않지만 write로 승인 대상이 된다', () => {
    // DESTRUCTIVE_VERBS는 한국어 전용 — 영어 삭제도 write로서 승인은 필요하다
    expect(deriveG6Risk('delete that memo')).toBe('write')
    expect(deriveG6Risk('save this memo')).toBe('write')
  })

  test('g6ApprovalRequired: read만 승인 불필요', () => {
    expect(g6ApprovalRequired('read')).toBe(false)
    expect(g6ApprovalRequired('write')).toBe(true)
    expect(g6ApprovalRequired('destructive')).toBe(true)
  })
})

// ---------------- 개별 판정 ----------------

describe('evaluateG6Judgment — 안전 구간 + 쓰기/복합 범위 + 파괴 승인', () => {
  const eligibleInput = {
    top: 0.95,
    margin: 0.6,
    multiple: 0.9,
    choice: 'code',
    message: '새 메모 만들어줘',
    hasMention: false,
  }

  test('전부 충족하면 eligible, 사유 없음, 구간·범위 플래그 정확', () => {
    const j = evaluateG6Judgment(eligibleInput)
    expect(j.eligible).toBe(true)
    expect(j.reasons).toEqual([])
    expect(j.isWrite).toBe(true)
    expect(j.isCompound).toBe(true)
    expect(j.inSafeBand).toBe(true)
    expect(j.risk).toBe('write')
  })

  test('안전 구간 경계: top 0.90·margin 0.40 정확히는 통과, 바로 아래는 탈락', () => {
    expect(evaluateG6Judgment({ ...eligibleInput, top: G6_SAFE_BAND.top, margin: G6_SAFE_BAND.margin }).reasons).toEqual([])
    expect(evaluateG6Judgment({ ...eligibleInput, top: 0.8999 }).reasons).toContain('top_below_safe')
    expect(evaluateG6Judgment({ ...eligibleInput, margin: 0.3999 }).reasons).toContain('margin_below_safe')
    expect(evaluateG6Judgment({ ...eligibleInput, top: 0.8999 }).inSafeBand).toBe(false)
  })

  test('판정 불능(top/margin 없음)은 안전으로 간주하지 않는다 (fail-closed)', () => {
    const j = evaluateG6Judgment({ ...eligibleInput, top: undefined, margin: undefined })
    expect(j.reasons).toContain('top_below_safe')
    expect(j.reasons).toContain('margin_below_safe')
    expect(j.inSafeBand).toBe(false)
    expect(j.eligible).toBe(false)
  })

  test('choice가 없거나 unclear면 choice_unclear', () => {
    expect(evaluateG6Judgment({ ...eligibleInput, choice: null }).reasons).toContain('choice_unclear')
    expect(evaluateG6Judgment({ ...eligibleInput, choice: 'unclear' }).reasons).toContain('choice_unclear')
    expect(evaluateG6Judgment({ ...eligibleInput, choice: undefined }).reasons).toContain('choice_unclear')
  })

  test('멘션·잠긴 비서는 각각 mention/locked_persona로 차단', () => {
    expect(evaluateG6Judgment({ ...eligibleInput, hasMention: true }).reasons).toContain('mention')
    expect(evaluateG6Judgment({ ...eligibleInput, lockedPersona: 'keeper' }).reasons).toContain('locked_persona')
    expect(evaluateG6Judgment({ ...eligibleInput, lockedPersona: null }).reasons).not.toContain('locked_persona')
  })

  test('읽기 전용 단일 요청은 G6 범위 밖 (not_g6_scope), 복합이면 범위 안', () => {
    const read = evaluateG6Judgment({ ...eligibleInput, multiple: 0.1, message: '오늘 일정 알려줘', choice: 'schedule' })
    expect(read.isWrite).toBe(false)
    expect(read.isCompound).toBe(false)
    expect(read.reasons).toContain('not_g6_scope')
    const compoundRead = evaluateG6Judgment({ ...eligibleInput, message: '오늘 일정 알려줘', choice: 'schedule' })
    expect(compoundRead.isCompound).toBe(true)
    expect(compoundRead.reasons).not.toContain('not_g6_scope')
  })

  test('복합 경계: multiple이 compoundNoul(0.8) 정확히면 복합, 아래면 아님', () => {
    const base = { ...eligibleInput, message: '오늘 일정 알려줘', choice: 'schedule' }
    expect(evaluateG6Judgment({ ...base, multiple: G6_SAFE_BAND.compoundNoul }).isCompound).toBe(true)
    expect(evaluateG6Judgment({ ...base, multiple: 0.7999 }).isCompound).toBe(false)
    expect(evaluateG6Judgment({ ...base, multiple: undefined }).isCompound).toBe(false)
  })

  test('파괴 요청은 destructive_requires_approval + risk=destructive', () => {
    const j = evaluateG6Judgment({ ...eligibleInput, message: '그 메모 삭제해줘' })
    expect(j.risk).toBe('destructive')
    expect(j.reasons).toContain('destructive_requires_approval')
    expect(j.eligible).toBe(false)
  })

  test('명시 risk 입력이 메시지 도출보다 우선한다', () => {
    const forced = evaluateG6Judgment({ ...eligibleInput, risk: 'destructive' })
    expect(forced.risk).toBe('destructive')
    expect(forced.reasons).toContain('destructive_requires_approval')
    const demoted = evaluateG6Judgment({ ...eligibleInput, message: '그 메모 삭제해줘', risk: 'read' })
    expect(demoted.risk).toBe('read')
    expect(demoted.reasons).not.toContain('destructive_requires_approval')
  })

  test('복수 위반은 전부 누적된다', () => {
    const j = evaluateG6Judgment({ top: undefined, margin: undefined, choice: null, message: '안녕', hasMention: true, lockedPersona: 'concierge' })
    expect(j.reasons).toEqual(expect.arrayContaining(['top_below_safe', 'margin_below_safe', 'choice_unclear', 'mention', 'locked_persona', 'not_g6_scope']))
    expect(j.eligible).toBe(false)
  })
})

// ---------------- 서빙 결정 ----------------

describe('resolveG6Serving — 모드별 서빙 (섀도는 절대 적용하지 않는다)', () => {
  const eligibleInput = {
    top: 0.95, margin: 0.6, multiple: 0.9, choice: 'code', message: '새 메모 만들어줘', hasMention: false,
  }
  const ineligibleInput = { ...eligibleInput, top: 0.5 }

  test('off: 판정 자체를 하지 않고 기준 비서 서빙', () => {
    const d = resolveG6Serving({ mode: 'off', baselinePersona: 'concierge', clefPersona: 'builder', gatePassed: true, input: eligibleInput })
    expect(d).toEqual({ servedPersona: 'concierge', applied: false, judgment: null, reason: 'g6_off' })
  })

  test('shadow + eligible: would_apply로 기록만 하고 기준 비서 서빙', () => {
    const d = resolveG6Serving({ mode: 'shadow', baselinePersona: 'concierge', clefPersona: 'builder', gatePassed: false, input: eligibleInput })
    expect(d.applied).toBe(false)
    expect(d.servedPersona).toBe('concierge')
    expect(d.reason).toBe('g6_shadow:would_apply')
    expect(d.judgment?.eligible).toBe(true)
  })

  test('shadow + ineligible: 사유가 섀도 사유 문자열에 그대로 실린다', () => {
    const d = resolveG6Serving({ mode: 'shadow', baselinePersona: 'concierge', clefPersona: 'builder', gatePassed: true, input: ineligibleInput })
    expect(d.applied).toBe(false)
    expect(d.reason).toBe('g6_shadow:top_below_safe')
  })

  test('active + 게이트 미통과: eligible이어도 적용 금지 (fail-closed)', () => {
    const d = resolveG6Serving({ mode: 'active', baselinePersona: 'concierge', clefPersona: 'builder', gatePassed: false, input: eligibleInput })
    expect(d.applied).toBe(false)
    expect(d.servedPersona).toBe('concierge')
    expect(d.reason).toBe('g6_active_gate_not_passed')
  })

  test('active + 게이트 통과 + eligible + clef 비서 있음: 적용', () => {
    const d = resolveG6Serving({ mode: 'active', baselinePersona: 'concierge', clefPersona: 'builder', gatePassed: true, input: eligibleInput })
    expect(d.applied).toBe(true)
    expect(d.servedPersona).toBe('builder')
    expect(d.reason).toBe('g6_applied')
  })

  test('active + 게이트 통과 + eligible이지만 clef 비서가 없으면 no_clef_persona', () => {
    const d = resolveG6Serving({ mode: 'active', baselinePersona: 'concierge', clefPersona: null, gatePassed: true, input: eligibleInput })
    expect(d.applied).toBe(false)
    expect(d.reason).toBe('g6:no_clef_persona')
  })

  test('active + 게이트 통과 + ineligible: g6:<사유> 로 기준 비서 서빙', () => {
    const d = resolveG6Serving({ mode: 'active', baselinePersona: 'concierge', clefPersona: 'builder', gatePassed: true, input: ineligibleInput })
    expect(d.applied).toBe(false)
    expect(d.reason).toBe('g6:top_below_safe')
  })
})

// ---------------- 결정 로그 ----------------

describe('G6 결정 로그 — 원장 연결과 모드 라벨', () => {
  const judgment: G6Judgment = { eligible: true, reasons: [], isWrite: true, isCompound: false, risk: 'write', inSafeBand: true }
  const decision = { servedPersona: 'builder', applied: true, judgment, reason: 'g6_applied' }

  test('buildG6DecisionLogEntry: 종류·모드·사유 형식이 고정된다', () => {
    const e = buildG6DecisionLogEntry({
      traceId: 't1', specHash: 'h1', optionOrder: ['chat', 'code'], message: '새 메모 만들어줘',
      choice: 'code', top: 0.95, margin: 0.6, judgment, decision, mode: 'shadow', ledgerTraceId: 'led-9',
    })
    expect(e.kind).toBe('g6_routing')
    expect(e.mode).toBe('g6_shadow')
    expect(e.reason).toBe('ledger:led-9;g6_applied;risk=write;write=1;compound=0')
    expect(e.applied).toBe(true)
    expect(e.servedPersona).toBe('builder')
    // 원문 메시지는 로그에 남지 않고 해시·길이만 남는다
    expect((e as any).message).toBeUndefined()
    expect(e.messageHash).toBe(hashText('새 메모 만들어줘'))
    expect(e.messageLength).toBe('새 메모 만들어줘'.length)
  })

  test('원장이 없으면 ledger:none, active 모드는 g6_active 라벨', () => {
    const e = buildG6DecisionLogEntry({
      traceId: 't2', specHash: 'h1', optionOrder: [], message: '안녕', choice: null, top: null, margin: null,
      judgment: { ...judgment, isWrite: false, risk: 'read' },
      decision: { servedPersona: 'concierge', applied: false, judgment, reason: 'g6_off' },
      mode: 'active',
    })
    expect(e.mode).toBe('g6_active')
    expect(e.reason).toBe('ledger:none;g6_off;risk=read;write=0;compound=0')
  })

  test('extractLedgerTraceId: 기록 사유에서 원장 ID만 뽑고 none/부재는 null', () => {
    expect(extractLedgerTraceId('ledger:abc-1;g6_applied;risk=write')).toBe('abc-1')
    expect(extractLedgerTraceId('ledger:none;g6_off')).toBeNull()
    expect(extractLedgerTraceId('no-ledger-here')).toBeNull()
    expect(extractLedgerTraceId(null)).toBeNull()
    expect(extractLedgerTraceId(undefined)).toBeNull()
    expect(extractLedgerTraceId('')).toBeNull()
  })

  test('왕복: buildG6DecisionLogEntry로 만든 사유에서 같은 원장 ID가 복원된다', () => {
    const e = buildG6DecisionLogEntry({
      traceId: 't3', specHash: 'h', optionOrder: [], message: '메모 만들어줘', choice: 'code', top: 1, margin: 1,
      judgment, decision, mode: 'shadow', ledgerTraceId: 'trace-xyz',
    })
    expect(extractLedgerTraceId(e.reason)).toBe('trace-xyz')
  })
})

describe('recordG6DecisionLog — 기록 전용 경로 (서빙을 바꾸지 않는다)', () => {
  const baseParams = {
    baselinePersona: 'concierge',
    clefPersona: 'builder',
    traceId: 't-rec',
    specHash: 'h',
    optionOrder: ['chat', 'code'],
    message: '새 메모 만들어줘',
    choice: 'code',
    top: 0.95,
    margin: 0.6,
    multiple: 0.9,
    hasMention: false,
  }

  test('off 모드거나 기록 함수가 없으면 null, 기록도 하지 않는다', async () => {
    const calls: any[] = []
    const record = async (e: any) => { calls.push(e) }
    await expect(recordG6DecisionLog({ ...baseParams, mode: 'off', recordDecision: record })).resolves.toBeNull()
    await expect(recordG6DecisionLog({ ...baseParams, mode: 'shadow' })).resolves.toBeNull()
    expect(calls).toHaveLength(0)
  })

  test('shadow: 판정을 기록하고 결정(미적용)을 돌려준다', async () => {
    const calls: any[] = []
    const d = await recordG6DecisionLog({ ...baseParams, mode: 'shadow', recordDecision: async (e: any) => { calls.push(e) } })
    expect(d?.applied).toBe(false)
    expect(d?.reason).toBe('g6_shadow:would_apply')
    expect(calls).toHaveLength(1)
    expect(calls[0].kind).toBe('g6_routing')
    expect(calls[0].mode).toBe('g6_shadow')
    expect(calls[0].traceId).toBe('t-rec')
  })

  test('active 기록 경로도 게이트 미통과로 취급해 적용하지 않는다', async () => {
    const calls: any[] = []
    const d = await recordG6DecisionLog({ ...baseParams, mode: 'active', recordDecision: async (e: any) => { calls.push(e) }, ledgerTraceId: 'led-1' })
    expect(d?.applied).toBe(false)
    expect(d?.reason).toBe('g6_active_gate_not_passed')
    expect(calls).toHaveLength(1)
    expect(calls[0].reason).toContain('ledger:led-1;')
  })

  test('기록 함수가 실패해도 결정은 그대로 돌려준다 (기록 실패가 판정을 막지 않음)', async () => {
    const d = await recordG6DecisionLog({
      ...baseParams, mode: 'shadow',
      recordDecision: async () => { throw new Error('db down') },
    })
    expect(d?.reason).toBe('g6_shadow:would_apply')
  })
})

// ---------------- 활성화 게이트 ----------------

describe('judgeG6Activation — 사전 등록 게이트 (하나라도 미달이면 불합격)', () => {
  const passing: G6ActivationMetrics = {
    total: G6_GATE.minTotal,
    writeN: G6_GATE.minWrite,
    compoundN: G6_GATE.minCompound,
    readN: G6_GATE.minRead,
    safeBandN: G6_GATE.minSafeBandN,
    safeBandCompoundN: G6_GATE.minSafeBandCompoundN,
    safeBandRoutingAccuracy: G6_GATE.minRoutingAccuracy,
    writePrecision: G6_GATE.minWritePrecision,
    writeRecall: G6_GATE.minWriteRecall,
    compoundRecall: G6_GATE.minCompoundRecall,
    readFalseWriteRate: G6_GATE.maxReadFalseWriteRate,
    destructiveBypassCount: 0,
    shadowDivergenceCount: 0,
    shadowSamples: G6_GATE.minShadowSamples,
    ledgerLinkedRate: G6_GATE.minLedgerLinkedRate,
  }

  test('모든 지표가 정확히 하한에 있으면 통과 (경계 포함)', () => {
    const r = judgeG6Activation(passing)
    expect(r.pass).toBe(true)
    expect(r.failures).toEqual([])
    expect(r.gateVersion).toBe(G6_GATE_VERSION)
    expect(Object.values(r.checks).every(Boolean)).toBe(true)
  })

  // 각 검사는 단독으로 실패를 만들 수 있어야 한다 — 하나를 깨면 그 키만 실패 목록에 뜬다
  const flips: Array<[string, Partial<G6ActivationMetrics>, string]> = [
    ['total 표본 부족', { total: G6_GATE.minTotal - 1 }, 'total_sample'],
    ['write 표본 부족', { writeN: G6_GATE.minWrite - 1 }, 'write_sample'],
    ['compound 표본 부족', { compoundN: G6_GATE.minCompound - 1 }, 'compound_sample'],
    ['read 표본 부족', { readN: G6_GATE.minRead - 1 }, 'read_sample'],
    ['안전 구간 표본 부족', { safeBandN: G6_GATE.minSafeBandN - 1 }, 'safe_band_sample'],
    ['안전 구간 복합 표본 부족', { safeBandCompoundN: G6_GATE.minSafeBandCompoundN - 1 }, 'safe_band_compound_sample'],
    ['라우팅 정확도 미달', { safeBandRoutingAccuracy: 0.9499 }, 'routing_accuracy'],
    ['라우팅 정확도 측정 불가(null)', { safeBandRoutingAccuracy: null }, 'routing_accuracy'],
    ['쓰기 정밀도 미달', { writePrecision: 0.9499 }, 'write_precision'],
    ['쓰기 정밀도 측정 불가(null)', { writePrecision: null }, 'write_precision'],
    ['쓰기 재현율 미달', { writeRecall: 0.8999 }, 'write_recall'],
    ['복합 재현율 미달', { compoundRecall: 0.7999 }, 'compound_recall'],
    ['읽기→쓰기 오판율 초과', { readFalseWriteRate: 0.0201 }, 'read_false_write_rate'],
    ['읽기→쓰기 오판율 측정 불가(null)', { readFalseWriteRate: null }, 'read_false_write_rate'],
    ['파괴 우회 1건', { destructiveBypassCount: 1 }, 'destructive_bypass_zero'],
    ['섀도 발산 1건', { shadowDivergenceCount: 1 }, 'shadow_divergence_zero'],
    ['섀도 표본 부족', { shadowSamples: G6_GATE.minShadowSamples - 1 }, 'shadow_samples'],
    ['원장 연결률 미달', { ledgerLinkedRate: 0.9899 }, 'ledger_linked_rate'],
    ['원장 연결률 측정 불가(null)', { ledgerLinkedRate: null }, 'ledger_linked_rate'],
  ]
  test.each(flips)('%s → %s 만 실패', (_name, patch, key) => {
    const r = judgeG6Activation({ ...passing, ...patch })
    expect(r.pass).toBe(false)
    expect(r.failures).toEqual([key])
    expect(r.checks[key as keyof typeof r.checks]).toBe(false)
  })

  test('하드 게이트는 비율이 아니라 건수 0 — 파괴 우회·섀도 발산은 1건도 허용하지 않는다', () => {
    // 다른 지표가 아무리 좋아도 하드 게이트 1건이면 불합격
    const rich: G6ActivationMetrics = {
      ...passing, total: 10000, writeN: 5000, compoundN: 2000, readN: 3000,
      safeBandRoutingAccuracy: 1, writePrecision: 1, writeRecall: 1, compoundRecall: 1,
      readFalseWriteRate: 0, ledgerLinkedRate: 1,
    }
    expect(judgeG6Activation({ ...rich, destructiveBypassCount: 1 }).pass).toBe(false)
    expect(judgeG6Activation({ ...rich, shadowDivergenceCount: 1 }).pass).toBe(false)
    expect(judgeG6Activation(rich).pass).toBe(true)
  })

  test('전부 비어 있으면 15개 검사 전부 실패로 열거된다', () => {
    const r = judgeG6Activation({
      total: 0, writeN: 0, compoundN: 0, readN: 0, safeBandN: 0, safeBandCompoundN: 0,
      safeBandRoutingAccuracy: null, writePrecision: null, writeRecall: null, compoundRecall: null,
      readFalseWriteRate: null, destructiveBypassCount: 3, shadowDivergenceCount: 2,
      shadowSamples: 0, ledgerLinkedRate: null,
    })
    expect(r.pass).toBe(false)
    expect(r.failures).toHaveLength(15)
    expect(r.metrics.total).toBe(0)
  })

  test('G6 안전 구간은 G5 임계값과 같은 상수를 공유한다', () => {
    expect(G6_SAFE_BAND.top).toBe(CLEF_THRESHOLDS.g5Top)
    expect(G6_SAFE_BAND.margin).toBe(CLEF_THRESHOLDS.g5Margin)
    expect(G6_SAFE_BAND.compoundNoul).toBe(CLEF_THRESHOLDS.compoundNoul)
  })
})
