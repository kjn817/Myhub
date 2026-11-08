/**
 * 스킬 패키지 레지스트리 테스트 — 진짜 비서 2단계 e트랙
 * 순수 함수만 테스트 — 운영 DB·외부 모델 호출 없음.
 */
import {
  SKILLS,
  getSkill,
  matchSkills,
  buildSkillLoad,
  resolveSkillsForTurn,
  estimateTokens,
  toolDefinitionChars,
  validateSkillDefinitions,
  DEFAULT_TOTAL_SKILL_BUDGET_CHARS,
  SKILL_HINT_TRUNC_SUFFIX,
  type SkillDefinition,
  type SkillMatch,
} from '../src/services/skill-registry'
import { MEMO_FC_TOOLS, prepareToolsFor } from '../src/ai/memo-fc-tools'
import { CRON_FC_TOOLS } from '../src/ai/cron-fc-tools'
import { getLegacyMarkerTools } from '../src/ai/legacy-privacy-guard'

describe('스킬 레지스트리 무결성', () => {
  test('8개 스킬 정의 (메모·일정·일정 등록·Google 연동·할일·자동화·기억·뉴스)', () => {
    // 구 listSkills() 접근자는 사라졌고 SKILLS 상수가 현행 표면이다
    // (동명의 listSkills는 studio-skills의 별도 도메인 함수 — 혼동 금지)
    expect(SKILLS.map((s) => s.id)).toEqual([
      'memo', 'schedule', 'schedule-create', 'google', 'todo', 'automation', 'memory', 'news',
    ])
    expect(getSkill('memo')?.name).toBe('메모')
    expect(getSkill('unknown')).toBeUndefined()
  })

  test('스킬 ID·FC 도구명 중복 없음', () => {
    const ids = SKILLS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    const toolNames = SKILLS.flatMap((s) => s.tools.map((t) => t.name))
    expect(new Set(toolNames).size).toBe(toolNames.length)
  })

  test('잠금/해제 도구가 어떤 스킬에도 없음 (잠금 정책)', () => {
    for (const skill of SKILLS) {
      const names = [...skill.tools.map((t) => t.name), ...skill.markerTools]
      expect(names.filter((n) => /LOCK|UNLOCK/i.test(n))).toEqual([])
    }
    // 정의 검증기가 잠금 스킬을 거부한다
    const bad: SkillDefinition = {
      ...SKILLS[0],
      id: 'bad',
      tools: [],
      markerTools: ['MEMO_LOCK'],
    }
    expect(() => validateSkillDefinitions([bad])).toThrow(/lock tool/i)
    // FC 도구명 중복도 거부한다
    const dupe: SkillDefinition = { ...SKILLS[0], id: 'dupe' }
    expect(() => validateSkillDefinitions([SKILLS[0], dupe])).toThrow(/Duplicate/)
    expect(() => validateSkillDefinitions()).not.toThrow()
  })

  test('스킬 personas의 마커 도구는 해당 비서 허용 목록 안에 있다', () => {
    for (const skill of SKILLS) {
      for (const persona of skill.personas) {
        const allowed = getLegacyMarkerTools(persona)
        for (const marker of skill.markerTools) {
          expect(allowed).toContain(marker)
        }
      }
    }
  })
})

describe('matchSkills — 의도/키워드 매칭', () => {
  test('메모 요청은 메모 스킬만 매칭 (keeper)', () => {
    const matched = matchSkills('이 내용 메모해줘', { personaId: 'keeper' })
    expect(matched.map((m) => m.skill.id)).toEqual(['memo'])
  })

  test('반복 요청은 자동화 스킬이 최우선, 뉴스도 함께 매칭', () => {
    const matched = matchSkills('매일 아침 8시에 뉴스 요약해서 푸시해줘', { personaId: 'keeper' })
    expect(matched[0].skill.id).toBe('automation')
    expect(matched.map((m) => m.skill.id)).toContain('news')
    expect(matched[0].score).toBeGreaterThan(matched[1].score)
  })

  test('일정 스킬은 keeper에게 매칭되지 않고 scheduler에게는 매칭된다', () => {
    expect(matchSkills('내일 일정 알려줘', { personaId: 'keeper' }).map((m) => m.skill.id))
      .not.toContain('schedule')
    expect(matchSkills('내일 일정 알려줘', { personaId: 'scheduler' }).map((m) => m.skill.id))
      .toContain('schedule')
  })

  test('할일·기억·뉴스 매칭', () => {
    expect(matchSkills('할일 추가해줘', { personaId: 'scheduler' }).map((m) => m.skill.id))
      .toContain('todo')
    expect(matchSkills('내 생일 기억하고 있어?', { personaId: 'keeper' }).map((m) => m.skill.id))
      .toEqual(['memory'])
    expect(matchSkills('오늘 뉴스 알려줘', { personaId: 'keeper' }).map((m) => m.skill.id))
      .toEqual(['news'])
  })

  test('신규 비서 ID(echo)도 레거시(keeper)로 정규화해 매칭한다', () => {
    expect(matchSkills('메모 찾아줘', { personaId: 'echo' }).map((m) => m.skill.id))
      .toEqual(['memo'])
  })

  test('매칭 없음·빈 입력은 빈 배열', () => {
    expect(matchSkills('안녕', { personaId: 'keeper' })).toEqual([])
    expect(matchSkills('', { personaId: 'keeper' })).toEqual([])
    expect(matchSkills('   ', { personaId: 'keeper' })).toEqual([])
  })

  test('알 수 없는 비서는 전체 허용 스킬(기억·뉴스)만 매칭한다', () => {
    expect(matchSkills('메모 찾아줘', { personaId: 'unknown-persona' })).toEqual([])
    expect(matchSkills('오늘 뉴스 알려줘', { personaId: 'unknown-persona' }).map((m) => m.skill.id))
      .toEqual(['news'])
  })
})

describe('estimateTokens / toolDefinitionChars', () => {
  test('한글 보수 추정치 — 2자당 1토큰, 올림', () => {
    expect(estimateTokens(0)).toBe(0)
    expect(estimateTokens(100)).toBe(50)
    expect(estimateTokens(101)).toBe(51)
  })

  test('메모 도구 정의 실측 — 예산 책정의 근거', () => {
    const memoChars = MEMO_FC_TOOLS.reduce((s, t) => s + toolDefinitionChars(t), 0)
    const cronChars = CRON_FC_TOOLS.reduce((s, t) => s + toolDefinitionChars(t), 0)
    // 레지스트리 maxChars는 이 실측보다 커야 한다 (힌트 0자 축소 방지)
    expect(memoChars).toBeLessThan(getSkill('memo')!.maxChars)
    expect(cronChars).toBeLessThan(getSkill('automation')!.maxChars)
    expect(memoChars + cronChars).toBeLessThan(DEFAULT_TOTAL_SKILL_BUDGET_CHARS)
  })
})

describe('buildSkillLoad — 컨텍스트 예산', () => {
  const memo = getSkill('memo')!
  const automation = getSkill('automation')!
  const news = getSkill('news')!

  test('기본 로드에서 메모 스킬 힌트가 잘리지 않는다', () => {
    const load = buildSkillLoad([{ skill: memo, score: 1 }])
    expect(load.stats.truncatedSkills).toEqual([])
    expect(load.stats.overBudgetSkills).toEqual([])
    expect(load.promptSection).toContain('메모 도구')
  })

  test('힌트가 스킬 예산을 넘기면 축소 표시와 함께 자른다', () => {
    const longHint: SkillDefinition = {
      ...news,
      id: 'long-hint',
      promptHint: 'x'.repeat(500),
      maxChars: 100,
    }
    const load = buildSkillLoad([{ skill: longHint, score: 1 }])
    expect(load.stats.truncatedSkills).toEqual(['long-hint'])
    expect(load.promptSection).toContain(SKILL_HINT_TRUNC_SUFFIX)
    const hintLine = load.promptSection.split('\n').find((l) => l.startsWith('- 뉴스:'))!
    expect(hintLine.length).toBeLessThanOrEqual('- 뉴스: '.length + 100)
  })

  test('전체 예산 초과 시 낮은 점수 스킬부터 탈락, 최고 점수 1개는 유지', () => {
    const matches: SkillMatch[] = [
      { skill: memo, score: 5 },
      { skill: automation, score: 3 },
      { skill: news, score: 1 },
    ]
    // 예산은 메모 단독 로드 크기에 맞춘다 (도구 정의가 자라 고정값 2500 전제는 소멸)
    const memoChars = buildSkillLoad([{ skill: memo, score: 5 }]).stats.totalChars
    const load = buildSkillLoad(matches, memoChars)
    expect(load.matchedIds).toEqual(['memo'])
    expect(load.stats.droppedSkills).toEqual(['news', 'automation'])
    expect(load.stats.totalChars).toBeLessThanOrEqual(memoChars)
    expect(load.stats.estimatedTokens).toBe(estimateTokens(load.stats.totalChars))
  })

  test('최고 점수 스킬 하나만으로 예산을 넘어도 그 스킬은 유지된다', () => {
    const load = buildSkillLoad(
      [
        { skill: memo, score: 5 },
        { skill: news, score: 1 },
      ],
      100,
    )
    expect(load.matchedIds).toEqual(['memo'])
    expect(load.stats.droppedSkills).toEqual(['news'])
    expect(load.stats.totalChars).toBeGreaterThan(100)
  })

  test('스킬이 없으면 빈 로드 (기본 동작 유지)', () => {
    const load = buildSkillLoad([])
    expect(load.skills).toEqual([])
    expect(load.tools).toEqual([])
    expect(load.promptSection).toBe('')
    expect(load.stats.totalChars).toBe(0)
  })
})

describe('resolveSkillsForTurn — 턴 진입점', () => {
  test('keeper 매칭 없음 → 기본 스킬(메모+자동화) — 기존 도구 집합과 동일', () => {
    const load = resolveSkillsForTurn({ text: '안녕', personaId: 'keeper' })
    expect(load.matchedIds).toEqual(['memo', 'automation'])
    expect(load.tools.map((t) => t.name)).toEqual([
      ...MEMO_FC_TOOLS.map((t) => t.name),
      ...CRON_FC_TOOLS.map((t) => t.name),
    ])
    expect(load.promptSection).toContain('[활성 스킬: 메모, 자동화]')
  })

  test('keeper 메모 요청 → 메모 스킬만 로드 (메모 도구 7개)', () => {
    const load = resolveSkillsForTurn({ text: '메모 찾아줘', personaId: 'keeper' })
    expect(load.matchedIds).toEqual(['memo'])
    expect(load.tools.map((t) => t.name)).toEqual(MEMO_FC_TOOLS.map((t) => t.name))
    expect(load.tools).toHaveLength(7) // memo_ui_action 추가로 6 → 7 (2026-11 개편)
  })

  test('keeper 뉴스 요청 → FC 도구 없음 (마커 경로가 처리)', () => {
    const load = resolveSkillsForTurn({ text: '오늘 뉴스 알려줘', personaId: 'keeper' })
    expect(load.matchedIds).toEqual(['news'])
    expect(load.tools).toEqual([])
    expect(load.markerTools).toEqual(['SEARCH'])
    // aiChat 배선과 동일한 조건: 도구 없으면 fcTools undefined
    const fcTools = load.tools.length > 0 ? load.tools : undefined
    expect(fcTools).toBeUndefined()
  })

  test('기본 스킬이 없는 비서(concierge)는 매칭 없으면 빈 로드', () => {
    const load = resolveSkillsForTurn({ text: '안녕', personaId: 'concierge' })
    expect(load.skills).toEqual([])
    expect(load.promptSection).toBe('')
  })

  test('복합 요청은 여러 스킬의 도구를 합집합으로 로드', () => {
    const load = resolveSkillsForTurn({
      text: '매일 아침 8시에 뉴스 요약해서 메모해줘',
      personaId: 'keeper',
    })
    expect(load.matchedIds).toContain('memo')
    expect(load.matchedIds).toContain('automation')
    expect(load.matchedIds).toContain('news')
    expect(load.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['memo_create', 'cron_create']))
  })
})

describe('채팅 경로 통합 — 스킬 도구 → 프로바이더 형식 변환', () => {
  test('스킬 도구는 prepareToolsFor(nvidia) OpenAI 형식으로 변환된다 (aiChat이 전달하는 형태)', () => {
    const load = resolveSkillsForTurn({ text: '메모 찾아줘', personaId: 'keeper' })
    const converted = prepareToolsFor('nvidia', load.tools)
    expect(converted).toHaveLength(7)
    for (const tool of converted) {
      expect(tool.type).toBe('function')
      expect(typeof tool.function.name).toBe('string')
      expect(tool.function.parameters.type).toBe('object')
    }
    expect(converted.map((t: any) => t.function.name)).toEqual(
      MEMO_FC_TOOLS.map((t) => t.name),
    )
  })

  test('기본 로드(keeper 무매칭) 변환 결과는 기본 도구 집합(메모 7 + cron 4 = 11개)과 동일', () => {
    const load = resolveSkillsForTurn({ text: '안녕', personaId: 'keeper' })
    const converted = prepareToolsFor('nvidia', load.tools)
    expect(converted).toHaveLength(11)
    expect(converted.map((t: any) => t.function.name)).toEqual([
      ...MEMO_FC_TOOLS.map((t) => t.name),
      ...CRON_FC_TOOLS.map((t) => t.name),
    ])
  })
})
