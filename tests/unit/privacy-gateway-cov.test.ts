/// <reference types="jest" />
/**
 * src/services/privacy-gateway.ts — 출구 게이트웨이 결정 성질 테스트 (보강).
 * (privacy-gateway.test.ts의 후보 상한 회귀와 겹치지 않는 분기들)
 *
 * 핵심 성질: ① 단독 비밀(짧은 텍스트 대부분이 비밀번호)이면 토큰화가
 * 아니라 전면 차단하고, 긴 문맥 속 비밀번호는 토큰화로 처리한다
 * ② 정책 민감도는 깨끗한 텍스트에도 레벨 하한을 건다 (restricted=2)
 * ③ 엔진 오류는 PrivacyGatewayBlockedError(engine-error)로 fail-closed
 * ④ Clef 채점 경로는 점수 밴드·액션을 결정 기록에 남기고, Clef 장애 시
 * enforce+민감이면 차단, 아니면 degraded 사유를 남기고 진행한다
 * ⑤ 잠금 마커 차단은 한국어 결정 기록을 보존한 채 일어난다.
 * 카나리아: isStandaloneSecret의 비율 조건(0.35)을 지우거나
 * 민감도 하한 적용을 빼면 실패한다.
 */
import {
  PRIVACY_GATEWAY_BLOCK_MESSAGE,
  PrivacyGatewayBlockedError,
  canUseRelay,
  guardSearchQuery,
  inspectEgress,
  inspectEgressKorean,
  inspectToolResult,
  privacyGatewayUserNotice,
  scoreBand,
} from '../../src/services/privacy-gateway'
import type { ClefInvoke } from '../../src/services/privacy-korean-clef'

const userMsg = (content: any) => ({ role: 'user', content })

describe('privacyGatewayUserNotice — 우선순위와 사유 분기', () => {
  test('locked-source가 다른 사유보다 우선한다', () => {
    const notice = privacyGatewayUserNotice(['l3-standalone-secret', 'locked-source', 'engine-error'])
    expect(notice).toContain('잠긴 메모 내용')
  })

  test('l3-standalone-secret는 단독 비밀 안내', () => {
    expect(privacyGatewayUserNotice(['l3-standalone-secret'])).toContain('단독 비밀정보(비밀번호 등)')
  })

  test('korean-* 사유는 검사 문제 안내로 간다', () => {
    expect(privacyGatewayUserNotice(['korean-degraded:context-quota'])).toContain('개인정보 검사에서 문제가 생겨')
    expect(privacyGatewayUserNotice(['korean-candidates-overflow'])).toContain('개인정보 검사에서 문제가 생겨')
  })

  test('알 수 없는 사유·중복 사유는 일반 안내', () => {
    expect(privacyGatewayUserNotice(['pii:EMAIL:L2', 'pii:EMAIL:L2'])).toContain('민감한 정보가 포함된 요청')
    expect(privacyGatewayUserNotice([])).toContain('민감한 정보가 포함된 요청')
  })
})

describe('scoreBand — 경계값', () => {
  test('밴드 경계가 정확한 구간에 떨어진다', () => {
    expect(scoreBand(1)).toBe('ge-0.85')
    expect(scoreBand(0.85)).toBe('ge-0.85')
    expect(scoreBand(0.849)).toBe('0.75-0.85')
    expect(scoreBand(0.75)).toBe('0.75-0.85')
    expect(scoreBand(0.749)).toBe('0.60-0.75')
    expect(scoreBand(0.6)).toBe('0.60-0.75')
    expect(scoreBand(0.599)).toBe('0.40-0.60')
    expect(scoreBand(0.4)).toBe('0.40-0.60')
    expect(scoreBand(0.399)).toBe('lt-0.40')
    expect(scoreBand(0)).toBe('lt-0.40')
  })
})

describe('inspectEgress — 패턴 층 결정', () => {
  test('깨끗한 메시지는 allow·level 0·findings 없음', () => {
    const r = inspectEgress({ origin: 't', messages: [userMsg('오늘 날씨가 좋네요')] })
    expect(r.action).toBe('allow')
    expect(r.level).toBe(0)
    expect(r.findings).toEqual([])
    expect(r.messages[0].content).toBe('오늘 날씨가 좋네요')
  })

  test('빈 문자열 메시지는 그대로 통과한다', () => {
    const r = inspectEgress({ origin: 't', messages: [userMsg('')] })
    expect(r.action).toBe('allow')
    expect(r.messages[0].content).toBe('')
  })

  test('문자열이 아닌 content는 engine-error 차단 예외 (fail-closed)', () => {
    let caught: any
    try {
      inspectEgress({ origin: 't', messages: [userMsg(42)] })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(PrivacyGatewayBlockedError)
    expect(caught.reasons).toEqual(['engine-error'])
    expect(caught.code).toBe('PRIVACY_GATEWAY_BLOCKED')
    expect(caught.retryable).toBe(false)
    expect(caught.message).toBe(PRIVACY_GATEWAY_BLOCK_MESSAGE)
  })

  test('두 번째 메시지의 잠금 마커도 전체를 차단하고 findings는 비운다', () => {
    const msgs = [userMsg('일반 문장'), userMsg('[LOCKED_CONTENT] 비밀')]
    const r = inspectEgress({ origin: 't', messages: msgs })
    expect(r.action).toBe('block')
    expect(r.level).toBe(3)
    expect(r.reasons).toEqual(['locked-source'])
    expect(r.findings).toEqual([])
    expect(r.messages).toBe(msgs)
  })

  test('PII가 있는 메시지만 토큰화되고 사유는 중복 제거된다', () => {
    const r = inspectEgress({
      origin: 't',
      messages: [userMsg('첫째는 a@x.com 입니다'), userMsg('둘째는 b@y.com 입니다'), userMsg('깨끗한 셋째')],
    })
    expect(r.action).toBe('tokenized')
    expect(r.level).toBe(2)
    expect(r.findings).toHaveLength(2)
    expect(r.reasons).toEqual(['pii:EMAIL:L2'])
    expect(r.messages[0].content).toContain('[EMAIL_')
    expect(r.messages[0].content).not.toContain('a@x.com')
    expect(r.messages[2].content).toBe('깨끗한 셋째')
  })

  test('단독 비밀번호(짧고 대부분이 값)는 토큰화가 아니라 차단', () => {
    const msgs = [userMsg('password: sunrise42')]
    const r = inspectEgress({ origin: 't', messages: msgs })
    expect(r.action).toBe('block')
    expect(r.reasons).toContain('l3-standalone-secret')
    expect(r.messages).toBe(msgs) // 원본 그대로 — 밖으로 나가지 않는다
  })

  test('긴 문맥 속 비밀번호는 차단이 아니라 토큰화', () => {
    const text = '이 문서는 분기 회의 자료로 작성된 긴 설명 문장입니다. 접근용 password: sunrise42 라고 적혀 있으나 나머지 내용은 일반적인 업무 협의 사항으로 채워져 있습니다.'
    expect(text.length).toBeGreaterThan(80)
    const r = inspectEgress({ origin: 't', messages: [userMsg(text)] })
    expect(r.action).toBe('tokenized')
    expect(r.messages[0].content).not.toContain('sunrise42')
    expect(r.messages[0].content).toContain('[PASSWORD_')
  })

  test('비밀번호 값의 비중이 낮으면(≤0.35) 단독 비밀로 보지 않는다', () => {
    const text = '비밀번호: a1b2c3 그리고 오늘 회의 안건은 세 가지입니다'
    const r = inspectEgress({ origin: 't', messages: [userMsg(text)] })
    expect(r.action).toBe('tokenized')
    expect(r.messages[0].content).not.toContain('a1b2c3')
  })

  test('정책 민감도 하한: restricted는 깨끗해도 level 2, personal·메모 파생은 level 1', () => {
    const clean = '아무 문제 없는 일반 문장입니다'
    const restricted = inspectEgress({ origin: 't', messages: [userMsg(clean)], policy: { sensitivity: 'restricted' } })
    expect(restricted.level).toBe(2)
    expect(restricted.action).toBe('tokenized')
    expect(restricted.messages[0].content).toBe(clean) // 바꿀 것이 없으면 원문 유지
    const personal = inspectEgress({ origin: 't', messages: [userMsg(clean)], policy: { sensitivity: 'personal' } })
    expect(personal.level).toBe(1)
    expect(personal.action).toBe('allow')
    const memoDerived = inspectEgress({ origin: 't', messages: [userMsg(clean)], memoDerived: true })
    expect(memoDerived.level).toBe(1)
  })
})

describe('guardSearchQuery / inspectToolResult / canUseRelay', () => {
  test('깨끗한 검색어는 그대로, PII·잠금 마커가 있으면 null', () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => {})
    try {
      expect(guardSearchQuery('오늘 날씨 알려줘')).toBe('오늘 날씨 알려줘')
      expect(guardSearchQuery('내 메일 a@x.com 으로 보내줘')).toBeNull()
      expect(guardSearchQuery('[LOCKED_MEMO] 내용 검색')).toBeNull()
      expect(info).toHaveBeenCalledWith('search_query_blocked', expect.anything())
    } finally {
      info.mockRestore()
    }
  })

  test('도구 결과 검사: 토큰화·허용·차단을 그대로 반영한다', () => {
    const tok = inspectToolResult('연락처는 a@x.com 입니다')
    expect(tok.action).toBe('tokenized')
    expect(tok.text).toContain('[EMAIL_')
    expect(tok.level).toBe(2)
    const clean = inspectToolResult('일반적인 도구 출력')
    expect(clean).toMatchObject({ action: 'allow', text: '일반적인 도구 출력', level: 0 })
    const blocked = inspectToolResult('[LOCKED_BLOCK] 비밀')
    expect(blocked.action).toBe('block')
    expect(blocked.text).toBe('[LOCKED_BLOCK] 비밀') // 차단 시 원본을 돌려주되 action이 block
  })

  test('릴레이는 level 1까지만 허용', () => {
    expect(canUseRelay(0)).toBe(true)
    expect(canUseRelay(1)).toBe(true)
    expect(canUseRelay(2)).toBe(false)
    expect(canUseRelay(3)).toBe(false)
  })
})

describe('inspectEgressKorean — Clef 채점 경로', () => {
  const NAME_TEXT = '김철수 과장에게 회의 자료를 전달해 주세요'
  const invokeWith = (score: number | number[]): ClefInvoke =>
    async (req) => {
      const answers: Record<string, unknown> = {}
      Object.keys(req.questions).forEach((k, i) => {
        answers[k] = { type: 'noul', noul: Array.isArray(score) ? score[i] : score }
      })
      return { answers }
    }

  test('enforce: 고득점 이름은 토큰화되고 결정 기록(밴드·액션)이 남는다', async () => {
    const r = await inspectEgressKorean({
      origin: 't', messages: [userMsg(NAME_TEXT)], mode: 'enforce', clefInvoke: invokeWith(0.95),
    })
    expect(r.koreanMode).toBe('enforce')
    // 이 문장의 후보는 이름형 3개(김철수·전달해·주세요 — 추출기 실측) 전부 NAME이다
    expect(r.koreanDecisions.length).toBe(3)
    expect(r.koreanDecisions[0]).toEqual({ type: 'NAME', action: 'tokenize', scoreBand: 'ge-0.85' })
    expect(r.koreanDecisions.every((d) => d.action === 'tokenize')).toBe(true)
    expect(r.messages[0].content).not.toContain('김철수')
    expect(r.action).toBe('tokenized')
  })

  test('shadow: 결정은 기록하되 메시지는 원문 그대로', async () => {
    const r = await inspectEgressKorean({
      origin: 't', messages: [userMsg(NAME_TEXT)], mode: 'shadow', clefInvoke: invokeWith(0.95),
    })
    expect(r.koreanDecisions.length).toBe(3)
    expect(r.koreanDecisions[0]).toEqual({ type: 'NAME', action: 'tokenize', scoreBand: 'ge-0.85' })
    expect(r.messages[0].content).toBe(NAME_TEXT)
    expect(r.action).toBe('allow')
  })

  test('회색 지대 점수는 민감 출처에서만 tokenize로 승격된다', async () => {
    const sensitive = await inspectEgressKorean({
      origin: 't', messages: [userMsg(NAME_TEXT)], mode: 'enforce',
      clefInvoke: invokeWith(0.7), memoDerived: true,
    })
    expect(sensitive.koreanDecisions[0]).toMatchObject({ action: 'tokenize', scoreBand: '0.60-0.75' })
    expect(sensitive.messages[0].content).not.toContain('김철수')
    const plain = await inspectEgressKorean({
      origin: 't', messages: [userMsg(NAME_TEXT)], mode: 'enforce', clefInvoke: invokeWith(0.7),
    })
    expect(plain.koreanDecisions[0].action).toBe('gray')
    expect(plain.messages[0].content).toBe(NAME_TEXT)
  })

  test('낮은 점수는 pass — 결정만 남고 아무것도 바뀌지 않는다', async () => {
    const r = await inspectEgressKorean({
      origin: 't', messages: [userMsg(NAME_TEXT)], mode: 'enforce', clefInvoke: invokeWith(0.5),
    })
    expect(r.koreanDecisions[0]).toMatchObject({ action: 'pass', scoreBand: '0.40-0.60' })
    expect(r.messages[0].content).toBe(NAME_TEXT)
    expect(r.action).toBe('allow')
  })

  test('후보가 없는 텍스트에서는 Clef를 부르지 않는다', async () => {
    let called = false
    const invoke: ClefInvoke = async () => { called = true; return { answers: {} } }
    const r = await inspectEgressKorean({
      // 후보 추출 0개가 실측으로 확인된 텍스트 (한국어 일상 문장은 이름형 후보가 잡힌다)
      origin: 't', messages: [userMsg('hello world this is plain english text')], mode: 'enforce', clefInvoke: invoke,
    })
    expect(called).toBe(false)
    expect(r.koreanDecisions).toEqual([])
  })

  test('Clef 장애(quota): enforce+민감이면 차단, 아니면 degraded 사유로 진행', async () => {
    const quotaInvoke: ClefInvoke = async () => { throw new Error('quota exceeded 3036') }
    await expect(
      inspectEgressKorean({
        origin: 't', messages: [userMsg(NAME_TEXT)], mode: 'enforce',
        clefInvoke: quotaInvoke, memoDerived: true,
      }),
    ).rejects.toMatchObject({ reasons: ['context-quota'] })
    const degraded = await inspectEgressKorean({
      origin: 't', messages: [userMsg(NAME_TEXT)], mode: 'enforce', clefInvoke: quotaInvoke,
    })
    expect(degraded.reasons).toContain('korean-degraded:context-quota')
    expect(degraded.action).toBe('allow')
    const shadowDegraded = await inspectEgressKorean({
      origin: 't', messages: [userMsg(NAME_TEXT)], mode: 'shadow',
      clefInvoke: quotaInvoke, memoDerived: true,
    })
    expect(shadowDegraded.reasons).toContain('korean-degraded:context-quota')
  })

  test('Clef 장애(일반 오류)는 context-unavailable로 분류된다', async () => {
    const boom: ClefInvoke = async () => { throw new Error('socket boom') }
    const r = await inspectEgressKorean({
      origin: 't', messages: [userMsg(NAME_TEXT)], mode: 'enforce', clefInvoke: boom,
    })
    expect(r.reasons).toContain('korean-degraded:context-unavailable')
  })
})

describe('inspectEgressKorean — 결정적 판정 경로와 경계', () => {
  test('관계 표현이 있으면 relationSignal이 선다', async () => {
    const withRelation = await inspectEgressKorean({
      origin: 't', messages: [userMsg('김철수 과장의 아내에게도 결과를 공유해 주세요')], mode: 'shadow',
    })
    expect(withRelation.relationSignal).toBe(true)
    const without = await inspectEgressKorean({
      origin: 't', messages: [userMsg('오늘 회의는 세 시에 시작합니다')], mode: 'shadow',
    })
    expect(without.relationSignal).toBe(false)
  })

  test('잠금 마커 차단은 먼저 쌓인 한국어 결정을 보존한다', async () => {
    const invoke: ClefInvoke = async (req) => {
      const answers: Record<string, unknown> = {}
      Object.keys(req.questions).forEach((k) => { answers[k] = { type: 'noul', noul: 0.95 } })
      return { answers }
    }
    const r = await inspectEgressKorean({
      origin: 't',
      messages: [userMsg('김철수 과장에게 전달해 주세요'), userMsg('[LOCKED_MEMO] 비밀 본문')],
      mode: 'enforce',
      clefInvoke: invoke,
    })
    expect(r.action).toBe('block')
    expect(r.level).toBe(3)
    expect(r.reasons).toEqual(['locked-source'])
    expect(r.koreanDecisions.length).toBeGreaterThan(0)
    expect(r.koreanMode).toBe('enforce')
  })

  test('문자열이 아닌 content는 한국어 경로에서도 engine-error 차단', async () => {
    await expect(
      inspectEgressKorean({ origin: 't', messages: [userMsg(42)], mode: 'enforce' }),
    ).rejects.toMatchObject({ reasons: ['engine-error'] })
  })

  test('빈 메시지는 건너뛰고, 시스템 메시지의 이름도 결정 기록에는 남는다', async () => {
    const r = await inspectEgressKorean({
      origin: 't',
      messages: [userMsg(''), { role: 'system', content: '김철수 과장이 작성한 문서입니다' }],
      mode: 'shadow',
    })
    expect(r.action).toBe('allow')
    expect(r.messages[0].content).toBe('')
  })
})
