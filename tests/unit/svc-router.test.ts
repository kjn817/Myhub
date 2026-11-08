/// <reference types="jest" />
/**
 * router.ts 커버리지 테스트 (Clef-flash 라우터)
 * - 명시적 멘션 (@노바 등)
 * - 규칙 기반 (인사/정적응답/계속/워크플로우 잠금)
 * - Clef 분류 (유효/무효 응답, 신뢰도 임계값, 다중작업)
 * - 폴백 (쓰기동작 감지)
 * NOTE: 91행 `if (id)`의 false 분기는 MENTION 정규식 alternation이
 * MENTION_IDS의 모든 키를 커버하므로 도달 불가. `top-second < 0.15` 분기도
 * probabilities 합계 제약(|sum-1|<=0.03)상 top>=0.70과 양립 불가하여 도달 불가.
 * 소스 수정 없이 도달 불가. 달성: statements 100% / branches 98.91% /
 * functions 100% / lines 100%
 */
import {
  isValidPersonaId,
  extractMention,
  routeMessage,
  classifyIntent,
  CLEF_MODEL,
  type ClefInvoker,
  type Category,
  type RouteContext,
} from '../../src/services/router'

const CATS: Category[] = ['chat', 'summarize', 'code', 'schedule', 'unclear']

/** 유효한 Clef 응답 생성. probabilities 합 = 1 (허용 오차 0.03 이내) */
function validResp(
  choice: Category,
  top: number,
  opts: { second?: number; secondCat?: Category; multiple?: number; confidence?: number } = {},
): unknown {
  const second = opts.second ?? 0.1
  const secondCat = opts.secondCat ?? (choice === 'chat' ? 'summarize' : 'chat')
  const probs: Record<string, number> = {}
  let rest = 1 - top - second
  for (const c of CATS) {
    if (c === choice) probs[c] = top
    else if (c === secondCat) probs[c] = second
    else {
      const v = Math.max(0, rest / 3)
      probs[c] = Math.round(v * 10000) / 10000
      rest -= probs[c]
    }
  }
  // 부동소수점 오차 보정
  const sum = Object.values(probs).reduce((a, b) => a + b, 0)
  probs[choice] = Math.round((probs[choice] + (1 - sum)) * 10000) / 10000
  return {
    answers: {
      assistant: {
        type: 'choice',
        choice,
        probabilities: probs,
        ...(opts.confidence !== undefined ? { confidence: opts.confidence } : {}),
      },
      multiple_actions: { type: 'noul', noul: opts.multiple ?? 0.1 },
    },
  }
}

const invokeOf = (resp: unknown): ClefInvoker => async () => resp
const throwingInvoke: ClefInvoker = async () => {
  throw new Error('provider down')
}

describe('isValidPersonaId', () => {
  test.each(['lumi', 'echo', 'nova', 'cali'])('%s 유효', (id) => {
    expect(isValidPersonaId(id)).toBe(true)
  })
  test.each(['LUMI', '', 'gpt', null, undefined, 123])('%p 무효', (id) => {
    expect(isValidPersonaId(id)).toBe(false)
  })
})

describe('extractMention', () => {
  test('한글 멘션', () => {
    expect(extractMention('@노바 코드 짜줘')).toBe('nova')
  })
  test('영문 멘션', () => {
    expect(extractMention('@cali 일정 등록')).toBe('cali')
  })
  test('calli 변형', () => {
    expect(extractMention('@calli 안녕')).toBe('cali')
  })
  test('대소문자 무관', () => {
    expect(extractMention('@LUMI 안녕')).toBe('lumi')
  })
  test('괄호 앞 멘션', () => {
    expect(extractMention('(@에코) 메모 찾아줘')).toBe('echo')
  })
  test('멘션 없음 → null', () => {
    expect(extractMention('그냥 대화해요')).toBeNull()
  })
  test('서로 다른 2개 멘션 → null (모호)', () => {
    expect(extractMention('@노바 @캘리 해줘')).toBeNull()
  })
  test('동일 멘션 반복 → 단일로 인식', () => {
    expect(extractMention('@노바 @노바 부탁')).toBe('nova')
  })
})

describe('routeMessage - 명시/규칙', () => {
  test('빈 메시지', async () => {
    const r = await routeMessage(invokeOf(null), '   ')
    expect(r).toEqual({ persona: null, source: 'rule', reason: 'empty_message' })
  })

  test('단일 명시 멘션', async () => {
    const r = await routeMessage(invokeOf(null), '@노바 코드 짜줘')
    expect(r).toEqual({ persona: 'nova', source: 'explicit', reason: 'explicit_mention' })
  })

  test('모호한 멘션', async () => {
    const r = await routeMessage(invokeOf(null), '@노바 @캘리 둘 다 해줘')
    expect(r.persona).toBeNull()
    expect(r.source).toBe('explicit')
    expect(r.reason).toBe('ambiguous_mentions')
  })

  test('워크플로우 잠금', async () => {
    const r = await routeMessage(invokeOf(null), '계속해줘', { lockedPersona: 'echo' })
    expect(r).toEqual({ persona: 'echo', source: 'rule', reason: 'active_workflow_lock' })
  })

  test('명시 멘션이 잠금보다 우선', async () => {
    const r = await routeMessage(invokeOf(null), '@노바 봐줘', { lockedPersona: 'echo' })
    expect(r.persona).toBe('nova')
    expect(r.source).toBe('explicit')
  })

  test('인사 → 루미', async () => {
    const r = await routeMessage(invokeOf(null), '안녕하세요')
    expect(r).toEqual({ persona: 'lumi', source: 'rule', reason: 'greeting' })
  })

  test('인사 + 잠금 → 잠금 유지', async () => {
    const r = await routeMessage(invokeOf(null), '안녕', { lockedPersona: 'cali' })
    expect(r.persona).toBe('cali')
  })
})

describe('classifyIntent - 규칙', () => {
  test('빈 메시지', async () => {
    const r = await classifyIntent(invokeOf(null), '')
    expect(r.reason).toBe('empty_message')
    expect(r.source).toBe('rule')
  })

  test('인사 변형', async () => {
    expect((await classifyIntent(invokeOf(null), 'hi')).reason).toBe('greeting')
    expect((await classifyIntent(invokeOf(null), 'Hello!')).reason).toBe('greeting')
  })

  test('인사 + 잠금 → 인사 규칙 스킵, invoke 호출됨', async () => {
    let called = false
    const inv: ClefInvoker = async () => {
      called = true
      return validResp('chat', 0.9)
    }
    const r = await classifyIntent(inv, '안녕', { lockedPersona: 'nova' })
    expect(called).toBe(true)
    expect(r.persona).toBe('lumi')
  })

  test('정적 응답: 고마워', async () => {
    const r = await classifyIntent(invokeOf(null), '고마워')
    expect(r).toEqual({ persona: 'lumi', source: 'rule', reason: 'static_response' })
  })

  test('정적 응답: 구두점/대소문자 정규화', async () => {
    expect((await classifyIntent(invokeOf(null), '고마워!')).reason).toBe('static_response')
    expect((await classifyIntent(invokeOf(null), 'Thanks')).reason).toBe('static_response')
    expect((await classifyIntent(invokeOf(null), '감사합니다.')).reason).toBe('static_response')
  })

  test('정적 응답: 워크플로우 잠금 시 스킵', async () => {
    let called = false
    const inv: ClefInvoker = async () => {
      called = true
      return validResp('chat', 0.9)
    }
    await classifyIntent(inv, '고마워', { lockedPersona: 'lumi' })
    expect(called).toBe(true)
  })

  test('계속 + previousPersona', async () => {
    const r = await classifyIntent(invokeOf(null), '계속', { previousPersona: 'cali' })
    expect(r).toEqual({ persona: 'cali', source: 'rule', reason: 'active_workflow_continuation' })
  })

  test('계속 변형', async () => {
    const r = await classifyIntent(invokeOf(null), '더 자세히 설명해줘', { previousPersona: 'echo' })
    expect(r.persona).toBe('echo')
  })

  test('계속이지만 previousPersona 없음 → invoke', async () => {
    let called = false
    const inv: ClefInvoker = async () => {
      called = true
      return validResp('code', 0.9)
    }
    await classifyIntent(inv, '계속')
    expect(called).toBe(true)
  })
})

describe('classifyIntent - invoke 요청 구성', () => {
  test('긴 메시지는 축약된다 (reducedMessage)', async () => {
    let captured: any = null
    const inv: ClefInvoker = async (req: any) => {
      captured = req
      return validResp('chat', 0.9)
    }
    const long = 'x'.repeat(4000)
    await classifyIntent(inv, long)
    expect(captured.state.current_message.length).toBeLessThan(4000)
    expect(captured.state.current_message).toContain('[중간 내용 생략]')
  })

  test('짧은 메시지는 그대로', async () => {
    let captured: any = null
    const inv: ClefInvoker = async (req: any) => {
      captured = req
      return validResp('chat', 0.9)
    }
    await classifyIntent(inv, '짧은 메시지')
    expect(captured.state.current_message).toBe('짧은 메시지')
  })

  test('컨텍스트 전달 (previous 800자, persona, workflow)', async () => {
    let captured: any = null
    const inv: ClefInvoker = async (req: any) => {
      captured = req
      return validResp('chat', 0.9)
    }
    await classifyIntent(inv, '질문', {
      previousMessage: 'y'.repeat(1000),
      previousPersona: 'echo',
      lockedPersona: 'nova',
    })
    expect(captured.state.previous_message).toHaveLength(800)
    expect(captured.state.previous_persona).toBe('echo')
    expect(captured.state.active_workflow).toBe(true)
  })

  test('모델 상수', () => {
    expect(CLEF_MODEL).toBe('@cf/cloudflare/clef-flash')
  })
})

describe('classifyIntent - Clef 응답 처리', () => {
  test('정상 분류 → clef', async () => {
    const r = await classifyIntent(invokeOf(validResp('code', 0.9)), '함수 만들어줘')
    // 현행 계약: 분류 결과는 Clef 진단 필드(probabilities·margin·multiple·
    // specHash·traceId)를 함께 싣는다 (필드가 늘어난 것이 현행 형태).
    expect(r.persona).toBe('nova')
    expect(r.source).toBe('clef')
    expect(r.reason).toBe('classified')
    expect(r.confidence).toBe(0.9)
    expect(r.probabilities).toEqual({ chat: 0.1, code: 0.9, schedule: 0, summarize: 0, unclear: 0 })
    expect(r.margin).toBeCloseTo(0.8)
    expect(r.multiple).toBeCloseTo(0.1)
    expect(typeof r.specHash).toBe('string')
    expect(r.specHash.length).toBeGreaterThan(0)
    expect(typeof r.traceId).toBe('string')
    expect(r.traceId).toMatch(/^clef-/)
  })

  test('카테고리별 매핑', async () => {
    expect((await classifyIntent(invokeOf(validResp('summarize', 0.85)), 'x')).persona).toBe('echo')
    expect((await classifyIntent(invokeOf(validResp('schedule', 0.85)), 'x')).persona).toBe('cali')
  })

  test('provider 에러 → fallback', async () => {
    const r = await classifyIntent(throwingInvoke, '일반 질문')
    expect(r).toEqual({ persona: 'lumi', source: 'fallback', reason: 'provider_error' })
  })

  test('provider 에러 + 쓰기동작 → persona null', async () => {
    const r = await classifyIntent(throwingInvoke, '일정 등록해줘')
    expect(r.persona).toBeNull()
    expect(r.reason).toBe('provider_error')
  })

  test('무효 응답들 → invalid_response fallback', async () => {
    const bads: unknown[] = [
      null,
      42,
      { answers: {} },
      { answers: { assistant: { type: 'noul' }, multiple_actions: { type: 'noul', noul: 0 } } },
      // choice가 문자열이 아니거나 카테고리가 아님 → 132행
      {
        answers: {
          assistant: { type: 'choice', choice: 'invalid_choice', probabilities: { chat: 1, summarize: 0, code: 0, schedule: 0, unclear: 0 } },
          multiple_actions: { type: 'noul', noul: 0 },
        },
      },
      {
        answers: {
          assistant: { type: 'choice', choice: 123, probabilities: { chat: 1, summarize: 0, code: 0, schedule: 0, unclear: 0 } },
          multiple_actions: { type: 'noul', noul: 0 },
        },
      },
      // choice와 top 확률 불일치
      (() => {
        const r: any = validResp('chat', 0.9)
        r.answers.assistant.choice = 'code'
        return r
      })(),
      // probabilities 키 누락
      (() => {
        const r: any = validResp('chat', 0.9)
        delete r.answers.assistant.probabilities['unclear']
        return r
      })(),
      // 합이 1이 아님
      {
        answers: {
          assistant: {
            type: 'choice',
            choice: 'chat',
            probabilities: { chat: 0.5, summarize: 0.5, code: 0.5, schedule: 0.5, unclear: 0.5 },
          },
          multiple_actions: { type: 'noul', noul: 0 },
        },
      },
      // 예상 밖 choice id
      {
        answers: {
          assistant: {
            type: 'choice',
            choice: 'chat',
            probabilities: { chat: 1, summarize: 0, code: 0, schedule: 0, unclear: 0, foo: 0 },
          },
          multiple_actions: { type: 'noul', noul: 0 },
        },
      },
      // confidence 무효
      (() => {
        const r: any = validResp('chat', 0.9, { confidence: 2 })
        return r
      })(),
      // noul 무효
      (() => {
        const r: any = validResp('chat', 0.9)
        r.answers.multiple_actions.noul = 'high'
        return r
      })(),
      // 확률 무효 (NaN)
      (() => {
        const r: any = validResp('chat', 0.9)
        r.answers.assistant.probabilities['chat'] = NaN
        return r
      })(),
    ]
    for (const bad of bads) {
      const r = await classifyIntent(invokeOf(bad), '질문 있어요')
      expect(r.reason).toBe('invalid_response')
      expect(r.source).toBe('fallback')
    }
  })

  test('다중 작업 (>=0.75) → multiple_actions', async () => {
    const r = await classifyIntent(invokeOf(validResp('chat', 0.9, { multiple: 0.8 })), '회의 등록하고 요약해줘')
    expect(r.persona).toBeNull()
    expect(r.reason).toBe('multiple_actions')
    expect(r.confidence).toBe(0.9)
  })

  test('unclear → low_confidence', async () => {
    const r = await classifyIntent(invokeOf(validResp('unclear', 0.9)), '음...')
    expect(r.persona).toBeNull()
    expect(r.reason).toBe('low_confidence')
  })

  test('top < 0.70 → low_confidence', async () => {
    const r = await classifyIntent(invokeOf(validResp('chat', 0.6)), '애매한 질문')
    expect(r.reason).toBe('low_confidence')
  })

  test('top-second < 0.15 분기는 합계 제약상 도달 불가 (문서화)', async () => {
    // top>=0.70 이면서 top-second<0.15 이려면 top+second>1.03이 되어
    // readAnswer의 합계 검증(|sum-1|>0.03 → null)에서 먼저 탈락한다.
    // 따라서 이 분기는 방어 코드로 도달 불가. invalid_response로 폴백됨을 확인.
    const r = await classifyIntent(invokeOf(validResp('chat', 0.8, { second: 0.75 })), '애매')
    expect(r.reason).toBe('invalid_response')
  })

  test('쓰기동작 감지: 일정 삭제 → fallback lumi가 아닌 null', async () => {
    // invalid_response 경로에서 looksLikeWriteAction 발동
    const r = await classifyIntent(invokeOf(null), '회의를 삭제해줘')
    expect(r.persona).toBeNull()
    expect(r.reason).toBe('invalid_response')
  })

  test('비쓰기동작: fallback은 lumi', async () => {
    const r = await classifyIntent(invokeOf(null), '날씨가 어때')
    expect(r.persona).toBe('lumi')
  })

  test('writeActionPossible 컨텍스트 → null', async () => {
    const r = await classifyIntent(throwingInvoke, '알려줘', { writeActionPossible: true } as RouteContext)
    expect(r.persona).toBeNull()
  })
})
