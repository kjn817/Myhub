/// <reference types="jest" />
/**
 * src/services/privacy-korean-mode.ts — 한국어 판정 모드 라우팅.
 *
 * 핵심 성질: ① 설정값이 없거나 'off'거나 알 수 없는 값이면 기본
 * inspectEgress로만 처리한다(한국어 경로는 기본 비활성) ② 'shadow'·
 * 'enforce'면 모드를 그대로 실어 한국어 검사를 거치고, shadow의
 * 관측 가능성 계약인 판정 로그(type:action:scoreBand)가 남는다
 * ③ 한국어 검사가 실패하면 기본 검사로 조용히 폴백하지 않고 오류가
 * 전파된다 — fail-open으로 개인정보가 새는 것보다 처리가 실패하는
 * 쪽이 안전하다(fail-closed).
 * 카나리아: 모드 판정에서 'enforce'를 빼거나, 한국어 경로 실패 시
 * inspectEgress로 폴백하게 만들면 실패한다.
 */
import { inspectAiChatEgress } from '../../src/services/privacy-korean-mode'
import { getSetting } from '../../src/services/ai-model-selection'
import { inspectEgress, inspectEgressKorean } from '../../src/services/privacy-gateway'

jest.mock('../../src/services/ai-model-selection', () => ({
  getSetting: jest.fn(),
}))
jest.mock('../../src/services/privacy-gateway', () => ({
  inspectEgress: jest.fn(),
  inspectEgressKorean: jest.fn(),
}))

const mockedGetSetting = getSetting as unknown as jest.Mock
const mockedEgress = inspectEgress as unknown as jest.Mock
const mockedKorean = inspectEgressKorean as unknown as jest.Mock

const DB = { __fake: true } as unknown as D1Database
const INPUT = { origin: 'ai-chat', messages: [{ role: 'user', content: '김정남 과장님 일정' }] } as any

const BASE_RESULT = { action: 'pass', messages: INPUT.messages } as any
const KOREAN_RESULT = {
  action: 'tokenize',
  messages: INPUT.messages,
  koreanMode: 'shadow',
  relationSignal: false,
  koreanDecisions: [
    { type: 'NAME', action: 'tokenize', scoreBand: 'high' },
    { type: 'ADDRESS', action: 'gray', scoreBand: 'mid' },
  ],
} as any

let infoSpy: jest.SpyInstance

beforeEach(() => {
  jest.clearAllMocks()
  mockedEgress.mockResolvedValue(BASE_RESULT)
  mockedKorean.mockResolvedValue(KOREAN_RESULT)
  infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  infoSpy.mockRestore()
})

describe('off 계열 — 기본 검사만', () => {
  test.each([
    ['설정 없음(null)', null],
    ["'off'", 'off'],
    ['알 수 없는 값', 'bogus'],
    ['빈 문자열', ''],
  ])('%s이면 inspectEgress 결과 그대로 반환한다', async (_label, stored) => {
    mockedGetSetting.mockResolvedValue(stored)
    const out = await inspectAiChatEgress(DB, INPUT)
    expect(out).toBe(BASE_RESULT)
    expect(mockedKorean).not.toHaveBeenCalled()
  })

  test("설정 키는 'privacy.korean_mode'를 읽는다", async () => {
    mockedGetSetting.mockResolvedValue(null)
    await inspectAiChatEgress(DB, INPUT)
    expect(mockedGetSetting).toHaveBeenCalledWith(DB, 'privacy.korean_mode')
  })
})

describe('shadow/enforce — 한국어 검사 경로', () => {
  test.each(['shadow', 'enforce'] as const)('%s 모드가 입력에 실려 전달되고 한국어 결과가 반환된다', async (mode) => {
    mockedGetSetting.mockResolvedValue(mode)
    const out = await inspectAiChatEgress(DB, INPUT)
    expect(out).toBe(KOREAN_RESULT)
    expect(mockedKorean).toHaveBeenCalledWith({ ...INPUT, mode })
    expect(mockedEgress).not.toHaveBeenCalled()
  })

  test('판정 로그에 모드와 type:action:scoreBand 목록이 남는다', async () => {
    mockedGetSetting.mockResolvedValue('shadow')
    await inspectAiChatEgress(DB, INPUT)
    expect(infoSpy).toHaveBeenCalledWith('privacy_gateway_korean', {
      origin: 'ai-chat',
      mode: 'shadow',
      decisions: 'NAME:tokenize:high,ADDRESS:gray:mid',
    })
  })

  test('한국어 검사가 실패하면 기본 검사로 폴백하지 않고 오류가 전파된다 (fail-closed)', async () => {
    mockedGetSetting.mockResolvedValue('enforce')
    mockedKorean.mockRejectedValue(new Error('clef down'))
    await expect(inspectAiChatEgress(DB, INPUT)).rejects.toThrow('clef down')
    expect(mockedEgress).not.toHaveBeenCalled()
  })
})
