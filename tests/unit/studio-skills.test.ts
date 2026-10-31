/**
 * studio-skills.ts 100% 커버리지 단위 테스트
 */
/// <reference types="jest" />
import { STUDIO_SKILLS, StudioSkill, getSkillForKind, listSkills } from '../../src/services/studio-skills'

describe('STUDIO_SKILLS', () => {
  test('5개의 스킬이 정의되어 있다', () => {
    const keys = Object.keys(STUDIO_SKILLS)
    expect(keys).toHaveLength(5)
    expect(keys).toEqual(expect.arrayContaining(['modify', 'build', 'plan', 'review']))
  })

  test.each(['modify', 'build', 'plan', 'review'] as const)('스킬 %s는 name/when/content를 가진다', (key) => {
    const skill: StudioSkill = STUDIO_SKILLS[key]
    expect(skill.name).toBe(key)
    expect(typeof skill.when).toBe('string')
    expect(skill.when.length).toBeGreaterThan(0)
    expect(typeof skill.content).toBe('string')
    expect(skill.content.length).toBeGreaterThan(0)
  })

  test('modify 스킬은 검색→읽기→수정→검증 순서를 안내한다', () => {
    expect(STUDIO_SKILLS.modify.content).toContain('search_in_files')
    expect(STUDIO_SKILLS.modify.content).toContain('read_file')
    expect(STUDIO_SKILLS.modify.content).toContain('apply_patch')
    expect(STUDIO_SKILLS.modify.content).toContain('validate_files')
  })

  test('build 스킬은 도구 사용을 안내한다', () => {
    expect(STUDIO_SKILLS.build.content).toContain('create_file')
    expect(STUDIO_SKILLS.build.content).toContain('validate_files')
  })

  test('plan 스킬은 plan.md 생성을 안내한다', () => {
    expect(STUDIO_SKILLS.plan.content).toContain('plan.md')
  })

  test('review 스킬은 완료 전 체크리스트를 포함한다', () => {
    expect(STUDIO_SKILLS.review.content).toContain('완료')
  })
})

describe('getSkillForKind', () => {
  test("'modify' → modify 스킬 반환", () => {
    const skill = getSkillForKind('modify')
    expect(skill).not.toBeNull()
    expect(skill!.name).toBe('modify')
    expect(skill).toBe(STUDIO_SKILLS.modify)
  })

  test("'create' → build 스킬 반환", () => {
    const skill = getSkillForKind('create')
    expect(skill).not.toBeNull()
    expect(skill!.name).toBe('build')
    expect(skill).toBe(STUDIO_SKILLS.build)
  })

  test('그 외 kind → null 반환', () => {
    expect(getSkillForKind('chat')).toBeNull()
    expect(getSkillForKind('plan')).toBeNull()
    expect(getSkillForKind('')).toBeNull()
    expect(getSkillForKind('unknown')).toBeNull()
    expect(getSkillForKind('MODIFY')).toBeNull() // 대소문자 구분
  })
})

describe('listSkills', () => {
  test('모든 스킬의 name과 when을 한 줄씩 반환한다', () => {
    const result = listSkills()
    const lines = result.split('\n')
    expect(lines).toHaveLength(5)
    for (const key of ['modify', 'build', 'plan', 'review']) {
      const skill = STUDIO_SKILLS[key]
      expect(result).toContain(`- ${skill.name}: ${skill.when}`)
    }
  })

  test('빈 스킬 목록이 아님', () => {
    expect(listSkills().length).toBeGreaterThan(0)
  })
})
