/// <reference types="jest" />
/**
 * 토큰화 후 민감도 재산정 (src/services/ai.ts, 2026-11-26).
 *
 * 결함: callSingleAssistant는 원본 텍스트로 policy.sensitivity를 매긴다.
 * 카드번호 포함 요청은 'restricted'가 되고, 게이트웨이가 카드번호를
 * [CARD_1]로 토큰화해도 모델 선택은 'restricted' 그대로 봐서 허용
 * Provider가 없어 403(PrivacyBlockedError)이 났다 — 3기둥 프로브의
 * privacy 검사가 2026-11-26 두 차례 실패한 원인.
 *
 * 정본: 게이트웨이가 토큰화한 뒤에는 토큰화된 텍스트로 민감도를 다시
 * 매겨 라우팅에 쓴다. 모델이 받는 텍스트에 원본이 없는데 원본 민감도로
 * 차단하는 것은 토큰화의 의미를 없애기 때문이다. 토큰은 PII 패턴을
 * 지우지 만들지 않으므로 재산정은 원본보다 높아질 수 없고, 토큰화가
 * 놓친 패턴이 있으면 재산정도 그 패턴을 그대로 보고 차단한다.
 *
 * 카나리아: aiChat의 재산정 블록을 제거하면 '카드번호 프롬프트 aiChat
 * 성공' 테스트가 PrivacyBlockedError로 실패해야 한다.
 */
import { aiChat, type TaskPolicy } from '../../src/services/ai'
import {
  resolveRequestSensitivity,
  getLegacyMarkerTools,
} from '../../src/ai/legacy-privacy-guard'
import { resolvePersonaProvider } from '../../src/services/provider-registry'

const CARD_PROMPT =
  '다음 문장에서 카드번호 부분만 골라, 각 글자 사이에 공백을 하나씩 넣어 다시 써 주세요. 다른 설명은 하지 마세요.\n문장: 4111-1111-1111-1111'
const CARD_TOKENIZED =
  '다음 문장에서 카드번호 부분만 골라, 각 글자 사이에 공백을 하나씩 넣어 다시 써 주세요. 다른 설명은 하지 마세요.\n문장: [CARD_1]'
const NAME_PROMPT =
  '다음 문장을 글자 하나도 바꾸지 말고 그대로 다시 써 주세요.\n문장: 연락처 메모: 김도현 님'
const NAME_TOKENIZED =
  '다음 문장을 글자 하나도 바꾸지 말고 그대로 다시 써 주세요.\n문장: 연락처 메모: [NAME_1] 님'

describe('토큰화 전후 민감도', () => {
  test('원본 카드번호 프롬프트는 restricted', () => {
    const r = resolveRequestSensitivity('concierge', CARD_PROMPT, getLegacyMarkerTools('concierge'))
    expect(r.sensitivity).toBe('restricted')
  })

  test('토큰화된 카드번호 프롬프트는 restricted가 아니다', () => {
    const r = resolveRequestSensitivity('concierge', CARD_TOKENIZED, getLegacyMarkerTools('concierge'))
    expect(r.sensitivity).not.toBe('restricted')
    expect(r.sensitivity).toBe('personal') // concierge 도구(search_memo) 하한
  })

  test('이름 프롬프트는 토큰화 전후 모두 personal', () => {
    expect(
      resolveRequestSensitivity('concierge', NAME_PROMPT, getLegacyMarkerTools('concierge')).sensitivity,
    ).toBe('personal')
    expect(
      resolveRequestSensitivity('concierge', NAME_TOKENIZED, getLegacyMarkerTools('concierge')).sensitivity,
    ).toBe('personal')
  })

  test('토큰화가 놓친 카드번호 패턴은 여전히 restricted', () => {
    // [CARD_1]이 아닌 원본이 남아 있으면 재산정도 restricted를 유지한다.
    const missed = CARD_TOKENIZED.replace('[CARD_1]', '4111-1111-1111-1111')
    expect(
      resolveRequestSensitivity('concierge', missed, getLegacyMarkerTools('concierge')).sensitivity,
    ).toBe('restricted')
  })
})

// ---------------------------------------------------------------------------
// aiChat 통합: 카드번호 프롬프트가 403이 아니라 모델 호출까지 가야 한다
// ---------------------------------------------------------------------------
function makeDb(settings: Record<string, string> = {}) {
  const calls: { sql: string; params: any[] }[] = []
  return {
    calls,
    prepare: jest.fn((sql: string) => ({
      bind: jest.fn((...params: any[]) => ({
        first: jest.fn(async () => {
          if (sql.includes('ai_settings')) {
            const key = params[0]
            return settings[key] ? { value: settings[key] } : null
          }
          return null
        }),
        all: jest.fn(async () => ({ results: [] })),
        run: jest.fn(async () => {
          calls.push({ sql, params })
          return {}
        }),
      })),
    })),
  }
}

function geminiOk(text = 'gemini 답변') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }),
  } as any
}

describe('aiChat 카드번호 프롬프트', () => {
  const originalFetch = global.fetch
  afterEach(() => {
    global.fetch = originalFetch
  })

  test('토큰화 뒤 모델 호출까지 가고 원본 카드번호는 외부로 나가지 않는다', async () => {
    const bodies: string[] = []
    global.fetch = jest.fn(async (_url: any, init: any) => {
      if (typeof init?.body === 'string') bodies.push(init.body)
      return geminiOk('네, [CARD_1]을 확인했습니다.')
    }) as any
    const db = makeDb({ 'privacy.korean_mode': 'enforce' })
    const env = { DB: db, GEMINI_API_KEY_1: 'k' } as any
    const policy = {
      capability: 'chat',
      privacy: 'external-ok',
      latency: 'interactive',
      quality: 'balanced',
      personaId: 'concierge',
      providerPin: resolvePersonaProvider('concierge'),
      origin: 'interactive',
      sensitivity: 'restricted', // callSingleAssistant가 원본 텍스트로 매긴 값
    } as unknown as TaskPolicy
    const result = await aiChat(env, policy, [{ role: 'user', content: CARD_PROMPT }])
    expect(result.provider).toBe('gemini')
    // 모델로 나간 요청 본문에 원본 카드번호가 없어야 한다 (토큰화 증거)
    expect(bodies.length).toBeGreaterThan(0)
    expect(bodies.join('\n')).not.toContain('4111')
    expect(bodies.join('\n')).toContain('[CARD_1]')
  })
})
