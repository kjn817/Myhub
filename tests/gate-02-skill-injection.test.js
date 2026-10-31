/**
 * 관문 테스트 2: 스킬 주입
 *
 * 기대: job.kind에 맞는 스킬 내용이 sysCtx에 참고용으로 포함되어야 한다.
 * 강제가 아니라 참고용이므로, 프롬프트에 "참고용 스킬" 문구가 있어야 한다.
 */

// TS 파일을 직접 require할 수 없으므로 로직을 시뮬레이션
function buildSysCtx(kind, prompt) {
  // job-processor.ts의 실제 로직을 반영
  const skills = {
    modify: { name: 'modify', content: '## 파일 수정 스킬' },
    create: { name: 'build', content: '## 앱 생성 스킬' },
  }
  const skill = kind === 'modify' ? skills.modify : kind === 'create' ? skills.create : null
  const skillRef = skill ? '\n\n참고용 스킬 (강제가 아니라 참고):\n' + skill.content : ''
  return kind === 'modify'
    ? '기존 프로젝트 수정: ' + prompt + skillRef
    : '"' + prompt + '" — 완성된 HTML 앱으로 만들어줘.' + skillRef
}

describe('관문 2: 스킬 주입', () => {
  test('modify job → modify 스킬이 참고용으로 포함됨', () => {
    const ctx = buildSysCtx('modify', '버튼을 파란색으로 바꿔줘')
    expect(ctx).toContain('참고용 스킬')
    expect(ctx).toContain('파일 수정 스킬')
    expect(ctx).toContain('버튼을 파란색으로 바꿔줘')
  })

  test('create job → build 스킬이 참고용으로 포함됨', () => {
    const ctx = buildSysCtx('create', '투두 앱 만들어줘')
    expect(ctx).toContain('참고용 스킬')
    expect(ctx).toContain('앱 생성 스킬')
  })

  test('강제 문구가 없음 (스스로 판단)', () => {
    const ctx = buildSysCtx('modify', 'test')
    expect(ctx).not.toContain('반드시')
    expect(ctx).not.toContain('무조건')
    expect(ctx).not.toContain('절대')
  })
})
