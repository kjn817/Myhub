/**
 * 전문가 레지스트리 테스트 (Octop 트랙 4-1)
 * - 4명 전문가 정의, ID 정규화, 프로바이더 핀, 도구 목록, cron 소유권
 *
 * 2026-11-08 재작성 (배치 3, A1): 구 API(listExperts/getExpertProvider/
 * getExpertCapability/getBriefingOwner/getReminderOwner)는 11-01→11-07 개편에서
 * 사라졌다. 현행 표면은 EXPERTS + getExpert(정규화 조회) +
 * getExpertProviderByLegacyId/getExpertCapabilityByLegacyId(레거시 직접 조회) +
 * ownsBriefing/ownsReminders 플래그이며, 같은 성질을 이 표면으로 검증한다.
 * 프로바이더 핀은 2026-11-05 재판정 기준: 에코=nvidia (메모 턴만 workers-ai).
 */
import {
  EXPERTS,
  getExpert,
  getExpertProviderByLegacyId,
  getExpertCapabilityByLegacyId,
  getExpertTools,
  overrideProviderForCapability,
} from '../src/services/expert-registry'
import { getLegacyMarkerTools } from '../src/ai/legacy-privacy-guard'

describe('expert-registry', () => {
  test('전문가 4명이 대표 비서 우선 순서로 정의됨', () => {
    expect(EXPERTS).toHaveLength(4)
    expect(EXPERTS.map((e) => e.legacyId)).toEqual([
      'concierge',
      'keeper',
      'builder',
      'scheduler',
    ])
    expect(EXPERTS.map((e) => e.name)).toEqual(['루미', '에코', '노바', '캘리'])
  })

  test('레거시/신규 어느 ID로든 같은 전문가를 찾음', () => {
    expect(getExpert('concierge')).toBe(getExpert('lumi'))
    expect(getExpert('keeper')).toBe(getExpert('echo'))
    expect(getExpert('builder')).toBe(getExpert('nova'))
    expect(getExpert('scheduler')).toBe(getExpert('cali'))
    expect(getExpert('concierge')?.name).toBe('루미')
  })

  test('모르는 ID는 null (deny-by-default, 기본값 승격 금지)', () => {
    expect(getExpert('bogus')).toBeNull()
    expect(getExpert('')).toBeNull()
    expect(getExpert(undefined)).toBeNull()
    expect(getExpert(null)).toBeNull()
    expect(getExpert(123)).toBeNull()
  })

  test('프로바이더 핀은 현행 확정과 일치 (2026-11-05: 에코 nvidia, 메모 턴만 workers-ai)', () => {
    expect(getExpert('concierge')?.provider).toBe('gemini')
    expect(getExpert('keeper')?.provider).toBe('nvidia')
    expect(getExpert('builder')?.provider).toBe('gemini')
    expect(getExpert('scheduler')?.provider).toBe('groq')
    // 신규 ID로 조회해도 동일
    expect(getExpert('lumi')?.provider).toBe('gemini')
    expect(getExpert('echo')?.provider).toBe('nvidia')
    expect(getExpert('cali')?.provider).toBe('groq')
    expect(getExpert('bogus')?.provider).toBeUndefined()
    // 메모 턴 전용 핀은 에코만 가진다
    expect(getExpert('keeper')?.memoTurnProvider).toBe('workers-ai')
    expect(getExpert('concierge')?.memoTurnProvider).toBeUndefined()
    expect(getExpert('builder')?.memoTurnProvider).toBeUndefined()
    expect(getExpert('scheduler')?.memoTurnProvider).toBeUndefined()
    // 능력 기반 오버라이드는 메모 턴 핀을 우선한다
    expect(overrideProviderForCapability('summarize')).toBe('workers-ai')
    expect(overrideProviderForCapability('chat')).toBe('gemini')
    expect(overrideProviderForCapability('bogus-capability')).toBeUndefined()
  })

  test('검증된 레거시 ID 직접 조회는 정규화 없이 같은 핀을 반환', () => {
    expect(getExpertProviderByLegacyId('concierge')).toBe('gemini')
    expect(getExpertProviderByLegacyId('keeper')).toBe('nvidia')
    expect(getExpertProviderByLegacyId('builder')).toBe('gemini')
    expect(getExpertProviderByLegacyId('scheduler')).toBe('groq')
    expect(getExpertProviderByLegacyId('bogus')).toBeNull()
    expect(getExpertProviderByLegacyId('lumi')).toBeNull() // 신규 ID는 직접 조회 대상이 아님
  })

  test('담당 능력은 라우터 카테고리와 일치', () => {
    expect(getExpertCapabilityByLegacyId('concierge')).toBe('chat')
    expect(getExpertCapabilityByLegacyId('keeper')).toBe('summarize')
    expect(getExpertCapabilityByLegacyId('builder')).toBe('code')
    expect(getExpertCapabilityByLegacyId('scheduler')).toBe('schedule')
    expect(getExpertCapabilityByLegacyId('bogus')).toBeNull()
    // 정규화 조회로도 같은 능력
    expect(getExpert('echo')?.capability).toBe('summarize')
    expect(getExpert('cali')?.capability).toBe('schedule')
  })

  test('도구 목록은 기존 getLegacyMarkerTools와 동일 (중복 정의 금지)', () => {
    for (const e of EXPERTS) {
      expect(getExpertTools(e.legacyId)).toEqual(getLegacyMarkerTools(e.legacyId))
    }
    expect(getExpertTools('bogus')).toEqual([])
  })

  test('아침 브리핑 소유자는 루미, 리마인더 소유자는 캘리', () => {
    expect(EXPERTS.find((e) => e.ownsBriefing)?.legacyId).toBe('concierge')
    expect(EXPERTS.find((e) => e.ownsReminders)?.legacyId).toBe('scheduler')
    expect(EXPERTS.filter((e) => e.ownsBriefing)).toHaveLength(1)
    expect(EXPERTS.filter((e) => e.ownsReminders)).toHaveLength(1)
    expect(getExpert('concierge')?.channels).toContain('cron')
    expect(getExpert('scheduler')?.channels).toContain('cron')
    expect(getExpert('keeper')?.channels).not.toContain('cron')
    expect(getExpert('builder')?.channels).not.toContain('cron')
  })
})
