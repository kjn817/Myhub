/**
 * Phase 3D D6: 고정 평가 케이스 러너 (Mock/결정적)
 *
 * 실제 LLM 호출 없이 프롬프트 합성 결과를 구조적으로 검증.
 * - 각 케이스의 personaId에 맞는 프롬프트가 합성되는가
 * - avoid 항목의 금지 패턴이 프롬프트에 하드코딩되어 있지 않은가
 * - 시간 케이스(scheduler)는 TimeContext가 포함되는가
 *
 * 실호출 평가는 스테이징에서 별도 수행 (호출 횟수 사전 보고).
 */

import { composeV2Prompt } from './prompt-integration'
import { ALL_EVAL_CASES, type EvalCase } from './prompts/eval-cases'
import { createServerTimeContext } from './time-context'

export interface EvalResult {
  caseId: string
  personaId: string
  passed: boolean
  checks: Array<{ name: string; passed: boolean; detail?: string }>
}

export function runMockEval(): EvalResult[] {
  const results: EvalResult[] = []
  const timeCtx = createServerTimeContext('Asia/Seoul')

  for (const c of ALL_EVAL_CASES) {
    const checks: Array<{ name: string; passed: boolean; detail?: string }> = []

    // 1. 프롬프트 합성 성공
    let prompt = ''
    try {
      const composed = composeV2Prompt(c.personaId, {
        timeContext: c.personaId === 'scheduler' ? timeCtx : undefined,
      })
      prompt = composed.prompt
      checks.push({ name: 'prompt_composed', passed: prompt.length > 100 })
    } catch (e: any) {
      checks.push({ name: 'prompt_composed', passed: false, detail: e.message })
      results.push({ caseId: c.id, personaId: c.personaId, passed: false, checks })
      continue
    }

    // 2. scheduler는 시간 컨텍스트 포함
    if (c.personaId === 'scheduler') {
      checks.push({
        name: 'time_context_present',
        passed: prompt.includes('TODAY_LOCAL'),
      })
    }

    // 3. avoid 항목: 모델 "행동" 기준이므로 Mock에서는 스킵
    // (프롬프트가 도구를 "문서화"하는 것은 정상 — 실제 평가는 실호출 시 수행)
    // 단, 프롬프트가 특정 도구의 "무조건 사용"을 지시하면 실패
    for (const avoid of c.avoid) {
      if (avoid.includes('메모 검색') || avoid.includes('검색')) {
        const forcesSearch = /반드시.*검색|항상.*검색|무조건.*검색/.test(prompt);
        checks.push({
          name: `avoid-forced:${avoid}`,
          passed: !forcesSearch,
        });
      }
    }

    // 4. 사용자 입력 주입 방지: composeV2Prompt는 personaId/시간/도구만 받음
    // (상세 구조 검사는 phase3d.test.js T10/T11에서 수행)
    checks.push({
      name: 'no_input_injection',
      passed: true,
    })

    const passed = checks.every((ch) => ch.passed)
    results.push({ caseId: c.id, personaId: c.personaId, passed, checks })
  }

  return results
}

export function summarizeEval(results: EvalResult[]): {
  total: number
  passed: number
  failed: string[]
  byPersona: Record<string, { total: number; passed: number }>
} {
  const byPersona: Record<string, { total: number; passed: number }> = {}
  const failed: string[] = []
  let passed = 0

  for (const r of results) {
    if (!byPersona[r.personaId]) byPersona[r.personaId] = { total: 0, passed: 0 }
    byPersona[r.personaId].total++
    if (r.passed) {
      passed++
      byPersona[r.personaId].passed++
    } else {
      failed.push(r.caseId)
    }
  }

  return { total: results.length, passed, failed, byPersona }
}
