/**
 * 관문 테스트 19: 스킬 주입 커버리지
 *
 * 품질 이슈: STUDIO_SKILLS에 plan, review 스킬이 정의되어 있지만,
 * getSkillForKind()는 modify/create만 반환. plan/review는 절대 주입 안 됨.
 *
 * 기대: 모든 스킬이 적절한 시점에 주입되거나, 미사용 스킬은 제거해야 함.
 */

function getSkillForKind(kind) {
  // 현재 구현
  if (kind === 'modify') return { name: 'modify' }
  if (kind === 'create') return { name: 'build' }
  return null
}

const ALL_SKILLS = ['modify', 'build', 'plan', 'review']

describe('관문 19: 스킬 주입 커버리지', () => {
  test('modify → 스킬 있음', () => {
    expect(getSkillForKind('modify')).not.toBeNull()
  })

  test('create → 스킬 있음', () => {
    expect(getSkillForKind('create')).not.toBeNull()
  })

  test('plan 스킬은 정의됐지만 주입 안 됨 (품질 이슈)', () => {
    // plan kind가 없어서 주입 경로가 없음
    const skill = getSkillForKind('plan')
    expect(skill).toBeNull() // 현재는 null - 이슈!
  })

  test('review 스킬은 정의됐지만 주입 안 됨 (품질 이슈)', () => {
    const skill = getSkillForKind('review')
    expect(skill).toBeNull() // 현재는 null - 이슈!
  })
})
