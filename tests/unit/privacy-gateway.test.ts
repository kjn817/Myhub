/// <reference types="jest" />
/**
 * privacy-gateway — 한국어 게이트웨이 후보 상한 회귀 테스트 (재구축, 2026-11-07)
 *
 * 소실된 원본: 파일명 미상, **15건 전건 PASS + 카나리아 실증** 기록 (2026-11-07, 커밋 6ca15777).
 * 사고 경위: 메모 스니펫 주입 메시지에서 한국어 판정 후보가 Clef 채점용 상한(8개)을 넘으면
 * (운영 실측 33개) 게이트웨이가 전면 차단해 에코 메모 경로가 "권한이 없어요"로 죽었다.
 * 수정: 집행 경로(결정적 채점 + 비시스템 메시지)에 한해 상한 512로 전부 판정·전부 토큰화.
 * 시스템·Clef 경로는 8 유지, 512 초과 병리 밀도는 fail-closed 유지 — 보안 경계 약화 아님.
 *
 * 카나리아: 상한을 8로 되돌리면 이 스위트에서 정확히 2건(집행 경로 통과·시스템 degraded)이
 * 실패해야 한다 — 원본에서 실증된 성질이다.
 *
 * 상태: 대상 모듈(privacy-gateway·privacy-korean)이 아직 재구성 전이라 모듈 도착 후 실행된다.
 */
import {
  inspectEgress,
  inspectEgressKorean,
  privacyGatewayUserNotice,
  PrivacyGatewayBlockedError,
} from '../../src/services/privacy-gateway'
import { extractCandidates, judgeKorean } from '../../src/services/privacy-korean'

// 직책과 함께 등장하는 이름들 — 메모 스니펫이 실제로 만드는 후보 형태
const NAMES = [
  '김철수 과장', '이영희 대리', '박민수 팀장', '최지현 부장', '정우성 주임',
  '강동원 차장', '조인성 이사', '윤서연 사원', '장혁진 과장', '임수아 대리',
  '한지민 팀장', '서준호 부장',
]
const MANY_NAMES_TEXT = `회의 참석자: ${NAMES.join(', ')}. 전원에게 일정 공유 바랍니다.`
const HUGE_NAMES_TEXT = Array.from({ length: 45 }, () => NAMES.join(', ')).join(', ')

const userMsg = (content: string) => ({ role: 'user' as const, content })
const systemMsg = (content: string) => ({ role: 'system' as const, content })

describe('픽스처 전제', () => {
  test('MANY_NAMES_TEXT에서 기본 상한(8)을 넘는 후보가 실제로 추출된다', () => {
    const capped = extractCandidates(MANY_NAMES_TEXT)
    expect(capped.candidates.length).toBe(8) // 상한에서 잘린다
    expect(capped.overflow).toBeGreaterThan(0)
    const full = extractCandidates(MANY_NAMES_TEXT, { maxCandidates: 512 })
    expect(full.candidates.length).toBeGreaterThan(8)
    expect(full.overflow).toBe(0)
  })

  test('HUGE_NAMES_TEXT에서는 512 상한으로도 overflow가 발생한다', () => {
    const { overflow } = extractCandidates(HUGE_NAMES_TEXT, { maxCandidates: 512 })
    expect(overflow).toBeGreaterThan(0)
  })
})

describe('inspectEgressKorean — 집행 경로 상한 512 (사고 회귀 가드)', () => {
  test('[카나리아 A] 민감 출처의 비시스템 메시지는 후보가 8을 넘어도 차단되지 않고 끝까지 판정된다', async () => {
    const r = await inspectEgressKorean({
      origin: 'unit-test',
      messages: [userMsg(MANY_NAMES_TEXT)],
      mode: 'enforce',
      memoDerived: true,
    })
    expect(r.action).not.toBe('block')
    expect(r.koreanDecisions.length).toBeGreaterThan(0)
  })

  test('[카나리아 B] 시스템 메시지는 상한 8 유지 — overflow여도 차단 대신 degraded 사유가 남는다', async () => {
    const r = await inspectEgressKorean({
      origin: 'unit-test',
      messages: [systemMsg(MANY_NAMES_TEXT)],
      mode: 'enforce',
      memoDerived: true,
    })
    expect(r.action).not.toBe('block')
    expect(r.reasons.some((x) => x.includes('korean-overflow-system-capped'))).toBe(true)
  })

  test('Clef 경로는 상한 8 유지 — 비시스템 메시지 overflow는 enforce·민감에서 차단된다', async () => {
    await expect(
      inspectEgressKorean({
      origin: 'unit-test',
        messages: [userMsg(MANY_NAMES_TEXT)],
        mode: 'enforce',
        memoDerived: true,
        clefInvoke: async () => [],
      }),
    ).rejects.toBeInstanceOf(PrivacyGatewayBlockedError)
  })

  test('병리 밀도(후보 512 초과)는 비시스템·enforce·민감에서 여전히 fail-closed 차단', async () => {
    const p = inspectEgressKorean({
      origin: 'unit-test',
      messages: [userMsg(HUGE_NAMES_TEXT)],
      mode: 'enforce',
      memoDerived: true,
    })
    await expect(p).rejects.toBeInstanceOf(PrivacyGatewayBlockedError)
    await expect(p).rejects.toMatchObject({ reasons: ['korean-candidates-overflow'] })
  })

  test('shadow 모드에서는 overflow가 있어도 차단하지 않는다 (기록만)', async () => {
    const r = await inspectEgressKorean({
      origin: 'unit-test',
      messages: [userMsg(HUGE_NAMES_TEXT)],
      mode: 'shadow',
      memoDerived: true,
    })
    expect(r.action).not.toBe('block')
  })

  test('민감하지 않은 출처에서는 overflow가 있어도 차단하지 않는다', async () => {
    const r = await inspectEgressKorean({
      origin: 'unit-test',
      messages: [userMsg(HUGE_NAMES_TEXT)],
      mode: 'enforce',
    })
    expect(r.action).not.toBe('block')
  })

  test('잠긴 메모 마커가 있으면 판정과 무관하게 block·level 3·locked-source', async () => {
    const r = await inspectEgressKorean({
      origin: 'unit-test',
      messages: [userMsg('[LOCKED_MEMO] 비밀 회의록 본문')],
      mode: 'enforce',
      memoDerived: true,
    })
    expect(r.action).toBe('block')
    expect(r.level).toBe(3)
    expect(r.reasons).toContain('locked-source')
  })
})

describe('judgeKorean — 상한 계약 자체', () => {
  test('기본 상한은 8이다 (Clef 채점 비용 계약)', () => {
    const r = judgeKorean(MANY_NAMES_TEXT, { sensitiveSource: true })
    expect(r.overflow).toBeGreaterThan(0)
    expect(r.scored.length).toBeLessThanOrEqual(8)
  })

  test('maxCandidates 512를 주면 같은 텍스트에서 overflow가 사라진다', () => {
    const r = judgeKorean(MANY_NAMES_TEXT, { sensitiveSource: true, maxCandidates: 512 })
    expect(r.overflow).toBe(0)
    expect(r.scored.length).toBeGreaterThan(8)
  })
})

describe('토큰화 적용 경계', () => {
  test('enforce·민감에서 tokenize 판정이 난 이름은 반환 메시지에 원문으로 남지 않는다', async () => {
    const judged = judgeKorean(MANY_NAMES_TEXT, { sensitiveSource: true, maxCandidates: 512 })
    const tokenized = judged.scored.filter((_, i) => judged.actions[i] === 'tokenize')
    expect(tokenized.length).toBeGreaterThan(0)
    const r = await inspectEgressKorean({
      origin: 'unit-test',
      messages: [userMsg(MANY_NAMES_TEXT)],
      mode: 'enforce',
      memoDerived: true,
    })
    const out = r.messages.map((m) => m.content as string).join('\n')
    for (const s of tokenized) {
      expect(out).not.toContain(MANY_NAMES_TEXT.slice(s.start, s.end))
    }
  })

  test('shadow 모드에서는 판정이 있어도 메시지가 원문 그대로다', async () => {
    const r = await inspectEgressKorean({
      origin: 'unit-test',
      messages: [userMsg(MANY_NAMES_TEXT)],
      mode: 'shadow',
      memoDerived: true,
    })
    expect(r.messages[0].content).toBe(MANY_NAMES_TEXT)
    expect(r.koreanDecisions.length).toBeGreaterThan(0)
  })
})

describe('inspectEgress — 패턴 층 (한국어 판정과 별개로 유지되는 경계)', () => {
  test('전화번호는 토큰화돼 원번호가 메시지에 남지 않는다', () => {
    const r = inspectEgress({ origin: 'unit-test', messages: [userMsg('연락처는 010-1234-5678 입니다')] })
    expect(r.action).toBe('tokenized')
    expect((r.messages[0].content as string)).not.toContain('010-1234-5678')
    expect(r.reasons.some((x) => x.startsWith('pii:'))).toBe(true)
  })

  test('잠긴 마커는 패턴 층에서도 block이다', () => {
    const r = inspectEgress({ origin: 'unit-test', messages: [userMsg('[LOCKED] 절대 전송 금지 내용')] })
    expect(r.action).toBe('block')
    expect(r.level).toBe(3)
    expect(r.reasons).toContain('locked-source')
  })
})

describe('privacyGatewayUserNotice — 사유별 안내 분기', () => {
  test('locked-source는 잠긴 메모를 언급하는 안내', () => {
    expect(privacyGatewayUserNotice(['locked-source'])).toContain('잠긴 메모')
  })

  test('engine-error는 재시도를 안내하는 문구', () => {
    expect(privacyGatewayUserNotice(['engine-error'])).toContain('다시 시도')
  })

  test('그 외 사유는 일반 차단 안내', () => {
    const notice = privacyGatewayUserNotice(['pii:PHONE:L2'])
    expect(notice).toContain('차단')
    expect(notice).not.toContain('잠긴 메모')
  })
})
