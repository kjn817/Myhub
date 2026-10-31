/**
 * 전문가 레지스트리 테스트 (Octop 트랙 4-1)
 * - 4명 전문가 정의, ID 정규화, 프로바이더 핀, 도구 목록, cron 소유권
 */
import {
  EXPERTS,
  getExpert,
  listExperts,
  getExpertProvider,
  getExpertProviderByLegacyId,
  getExpertCapability,
  getExpertTools,
  getBriefingOwner,
  getReminderOwner,
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
    expect(listExperts()).toHaveLength(4)
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

  test('프로바이더 핀은 현행 확정과 일치 (2026-10-30: 에코 nvidia → workers-ai)', () => {
    expect(getExpertProvider('concierge')).toBe('gemini')
    expect(getExpertProvider('keeper')).toBe('workers-ai')
    expect(getExpertProvider('builder')).toBe('gemini')
    expect(getExpertProvider('scheduler')).toBe('groq')
    // 신규 ID로 조회해도 동일
    expect(getExpertProvider('lumi')).toBe('gemini')
    expect(getExpertProvider('echo')).toBe('workers-ai')
    expect(getExpertProvider('cali')).toBe('groq')
    expect(getExpertProvider('bogus')).toBeNull()
  })

  test('검증된 레거시 ID 직접 조회는 정규화 없이 같은 핀을 반환', () => {
    expect(getExpertProviderByLegacyId('concierge')).toBe('gemini')
    expect(getExpertProviderByLegacyId('keeper')).toBe('workers-ai')
    expect(getExpertProviderByLegacyId('builder')).toBe('gemini')
    expect(getExpertProviderByLegacyId('scheduler')).toBe('groq')
    expect(getExpertProviderByLegacyId('bogus')).toBeNull()
    expect(getExpertProviderByLegacyId('lumi')).toBeNull() // 신규 ID는 직접 조회 대상이 아님
  })

  test('담당 능력은 라우터 카테고리와 일치', () => {
    expect(getExpertCapability('concierge')).toBe('chat')
    expect(getExpertCapability('keeper')).toBe('summarize')
    expect(getExpertCapability('builder')).toBe('code')
    expect(getExpertCapability('scheduler')).toBe('schedule')
    expect(getExpertCapability('bogus')).toBeNull()
  })

  test('도구 목록은 기존 getLegacyMarkerTools와 동일 (중복 정의 금지)', () => {
    for (const e of EXPERTS) {
      expect(getExpertTools(e.legacyId)).toEqual(getLegacyMarkerTools(e.legacyId))
    }
    expect(getExpertTools('bogus')).toEqual([])
  })

  test('아침 브리핑 소유자는 루미, 리마인더 소유자는 캘리', () => {
    expect(getBriefingOwner().legacyId).toBe('concierge')
    expect(getReminderOwner().legacyId).toBe('scheduler')
    expect(getExpert('concierge')?.channels).toContain('cron')
    expect(getExpert('scheduler')?.channels).toContain('cron')
    expect(getExpert('keeper')?.channels).not.toContain('cron')
    expect(getExpert('builder')?.channels).not.toContain('cron')
  })
})
