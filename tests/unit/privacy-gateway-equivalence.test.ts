/// <reference types="jest" />
/**
 * B-L2 동등성 핀: inspectEgress(동기 패턴 층)와 inspectEgressKorean의
 * 2차 검사 루프는 같은 egress 검사 로직의 이중 구현이다. 통합 전후에
 * 두 경로의 동작이 동일함을 고정한다.
 *
 * 핵심 성질:
 * ① 한국어 판정이 개입하지 않는 입력(shadow 모드·Clef 없음)에서는 두 경로의
 *    공유 필드(action·messages·level·reasons·findings)가 바이트 수준으로 동일하다.
 * ② 잠금 마커 차단은 degraded 사유가 쌓여 있어도 reasons를 ['locked-source']로
 *    고정한다 (degraded 접두사가 잠금 반환에 새지 않는다).
 * ③ 단독 비밀 차단은 한국어 경로에서도 동일하게 동작하고 원본 메시지를 그대로 둔다.
 * ④ enforce 모드에서는 엔진 판정과 한국어 판정이 findings에 함께 합쳐진다.
 * 카나리아: 통합 코어에서 msgLevel >= 2 토큰화 분기나 l3-standalone-secret
 * 차단 분기를 빼면 이 파일의 테스트가 실패한다.
 */
import {
  PrivacyGatewayBlockedError,
  inspectEgress,
  inspectEgressKorean,
  type InspectEgressInput,
  type InspectEgressResult,
} from '../../src/services/privacy-gateway'
import type { ClefInvoke } from '../../src/services/privacy-korean-clef'

const userMsg = (content: any) => ({ role: 'user', content })

/** 한국어 전용 필드를 제외한 공유 결정 필드만 비교한다. */
function shared(r: InspectEgressResult) {
  return {
    action: r.action,
    messages: r.messages,
    level: r.level,
    reasons: r.reasons,
    findings: r.findings,
  }
}

async function bothWays(input: InspectEgressInput) {
  const plain = inspectEgress(input)
  const korean = await inspectEgressKorean({ ...input, mode: 'shadow' })
  return { plain, korean }
}

describe('B-L2 동등성: shadow 모드에서는 두 경로의 공유 결정이 동일하다', () => {
  test.each([
    ['깨끗한 문장', { origin: 't', messages: [userMsg('오늘 날씨가 좋네요')] }],
    ['빈 메시지', { origin: 't', messages: [userMsg('')] }],
    [
      '이메일 PII (다중 메시지)',
      {
        origin: 't',
        messages: [userMsg('첫째는 a@x.com 입니다'), userMsg('둘째는 b@y.com 입니다'), userMsg('깨끗한 셋째')],
      },
    ],
    ['전화번호 PII', { origin: 't', messages: [userMsg('연락처는 010-1234-5678 입니다')] }],
    ['단독 비밀번호', { origin: 't', messages: [userMsg('password: sunrise42')] }],
    [
      '긴 문맥 속 비밀번호',
      {
        origin: 't',
        messages: [
          userMsg(
            '이 문서는 분기 회의 자료로 작성된 긴 설명 문장입니다. 접근용 password: sunrise42 라고 적혀 있으나 나머지 내용은 일반적인 업무 협의 사항으로 채워져 있습니다.',
          ),
        ],
      },
    ],
    [
      '두 번째 메시지의 잠금 마커',
      { origin: 't', messages: [userMsg('일반 문장'), userMsg('[LOCKED_CONTENT] 비밀')] },
    ],
    [
      '메시지 결합 카드번호',
      { origin: 't', messages: [userMsg('카드 앞자리 4111'), userMsg('뒷자리 111111111111')] },
    ],
    [
      'restricted 정책 하한',
      { origin: 't', messages: [userMsg('아무 문제 없는 일반 문장입니다')], policy: { sensitivity: 'restricted' } },
    ],
    [
      '메모 파생 하한',
      { origin: 't', messages: [userMsg('아무 문제 없는 일반 문장입니다')], memoDerived: true },
    ],
  ])('%s', async (_name, input) => {
    const { plain, korean } = await bothWays(input as InspectEgressInput)
    expect(shared(korean)).toEqual(shared(plain))
  })

  test('PII 입력에서는 두 경로 모두 tokenized이고 원값이 남지 않는다', async () => {
    const { plain, korean } = await bothWays({
      origin: 't',
      messages: [userMsg('연락처는 010-1234-5678 입니다')],
    })
    for (const r of [plain, korean]) {
      expect(r.action).toBe('tokenized')
      expect(r.level).toBe(2)
      expect(r.messages[0].content).not.toContain('010-1234-5678')
    }
  })

  test('메시지 결합 카드번호는 두 경로 모두 토큰화한다', async () => {
    const { plain, korean } = await bothWays({
      origin: 't',
      messages: [userMsg('카드 앞자리 4111'), userMsg('뒷자리 111111111111')],
    })
    for (const r of [plain, korean]) {
      expect(r.action).toBe('tokenized')
      expect(r.messages[0].content).not.toContain('4111')
      expect(r.messages[1].content).not.toContain('111111111111')
      expect(r.findings.length).toBeGreaterThan(0)
    }
  })

  test('문자열이 아닌 content는 두 경로 모두 engine-error 차단 예외', async () => {
    let plainCaught: any
    try {
      inspectEgress({ origin: 't', messages: [userMsg(42)] })
    } catch (e) {
      plainCaught = e
    }
    expect(plainCaught).toBeInstanceOf(PrivacyGatewayBlockedError)
    expect(plainCaught.reasons).toEqual(['engine-error'])
    await expect(
      inspectEgressKorean({ origin: 't', messages: [userMsg(42)], mode: 'shadow' }),
    ).rejects.toMatchObject({ reasons: ['engine-error'] })
  })
})

describe('B-L2 동등성: 한국어 경로 고유 분기 핀', () => {
  test('degraded 사유가 쌓여도 잠금 마커 차단은 reasons를 [locked-source]로 고정한다', async () => {
    const quotaInvoke: ClefInvoke = async () => {
      throw new Error('quota exceeded 3036')
    }
    const r = await inspectEgressKorean({
      origin: 't',
      messages: [userMsg('김철수 과장에게 회의 자료를 전달해 주세요'), userMsg('[LOCKED_CONTENT] 비밀')],
      mode: 'shadow',
      clefInvoke: quotaInvoke,
      memoDerived: true,
    })
    expect(r.action).toBe('block')
    expect(r.level).toBe(3)
    // degraded 접두사가 잠금 반환에 새면 안 된다 — 통합 코어가 이 분기를
    // 그대로 재현해야 한다.
    expect(r.reasons).toEqual(['locked-source'])
    expect(r.findings).toEqual([])
  })

  test('단독 비밀번호는 한국어 경로에서도 차단하고 원본 메시지를 그대로 둔다', async () => {
    const msgs = [userMsg('password: sunrise42')]
    const r = await inspectEgressKorean({ origin: 't', messages: msgs, mode: 'enforce' })
    expect(r.action).toBe('block')
    expect(r.reasons).toContain('l3-standalone-secret')
    expect(r.messages).toBe(msgs)
  })

  test('enforce 모드에서는 엔진 판정과 한국어 판정이 findings에 함께 합쳐진다', async () => {
    const invokeWith = (score: number): ClefInvoke => async (req) => {
      const answers: Record<string, unknown> = {}
      Object.keys(req.questions).forEach((k) => {
        answers[k] = { type: 'noul', noul: score }
      })
      return { answers }
    }
    const r = await inspectEgressKorean({
      origin: 't',
      messages: [userMsg('김철수 과장에게 a@x.com 으로 보내주세요')],
      mode: 'enforce',
      clefInvoke: invokeWith(0.95),
    })
    expect(r.action).toBe('tokenized')
    expect(r.messages[0].content).not.toContain('김철수')
    expect(r.messages[0].content).not.toContain('a@x.com')
    // 엔진 판정(EMAIL)과 한국어 판정(NAME·L2)이 모두 findings에 있다.
    // (최종 findings는 {type, level, start, end}만 남기므로 source는 보지 않는다.)
    expect(r.findings.some((f) => f.type === 'EMAIL')).toBe(true)
    expect(r.findings.some((f) => f.type === 'NAME' && f.level === 2)).toBe(true)
  })
})
