// 성찰 (Reflection) — 작업 완료 후 "무엇을 배웠나"를 기억에 반영한다
// (진짜 비서 2단계 d트랙)
//
// Agent Zero의 성찰 프롬프트 패턴만 이식 (Agent Zero 코드 미사용):
// - 작업(메모 작성·요약·일정·할 일 등)이 끝난 뒤, 요청 + 결과에서 배운
//   사실·선호·제약을 추출해 장기 기억에 저장한다.
// - 저장 경로는 0046의 captureFacts를 재사용한다 (중복 구현 금지):
//   source_type='reflection'으로 구분, category='fact',
//   allow_ai_use/allow_provider_send 기본 0 (명시적 허용 전까지 외부 전송 불가).
// - 기본 경로는 zero-LLM (결정적 사실 추출). LLM 성찰은 플래그 기본 OFF,
//   패턴만 준비 (fact-graph의 llmExtract 주입 방식과 동일).
// - 잠긴 메모는 읽지 않는다: 성찰 입력은 호출자가 넘긴 요청·결과 텍스트뿐이고,
//   '[LOCKED_BLOCK]' 자리표시자는 문장 경계로 치환한다 (0046 메모 캡처와 동일).
//   자리표시자 자체는 isFactSentence가 제외하므로 사실로 저장되지 않는다.
// - 실패해도 호출자(채팅 응답)는 보호된다 — reflectOnTask는 예외를 삼키지 않고
//   { ok:false }를 반환하고, 호출 지점도 try/catch로 감싼다 (fail-soft).

import { sanitizeMemoryContent, isMemoryV2Enabled } from './memory-service'
import { captureFacts, type CaptureFactsResult } from './fact-graph'
import { extractFacts } from './fact-extract'
import { readBooleanSetting } from '../lib/d1-setting'

export type ReflectionTaskType =
  | 'memo_create'
  | 'memo_update'
  | 'summary'
  | 'briefing'
  | 'schedule'
  | 'todo'
  | 'artifact'
  | 'chat'

export interface ReflectOnTaskInput {
  /** 작업 종류 (source_id와 함께 감사 추적용) */
  taskType?: ReflectionTaskType | string
  /** 사용자의 원래 요청 (AI가 본 텍스트 — 잠긴 메모 본문은 포함되지 않음) */
  taskText?: string
  /** 작업 결과 텍스트 (마커 실행 후 최종 응답 — 도구 결과 문장 포함) */
  resultText?: string
  /** 작업을 수행한 비서 persona id */
  persona?: string
  /** 작업이 만든 대상의 id (예: 생성된 메모 id) */
  sourceId?: number
  /** LLM 성찰기 (주입식). 플래그 memory.llm_reflection_enabled='true'일 때만 사용. 기본 OFF. */
  llmReflect?: (text: string) => Promise<string[]>
  maxFacts?: number
}

export interface ReflectOnTaskResult extends CaptureFactsResult {
  /** 실제로 성찰이 수행됐는지 (게이트 OFF·빈 입력이면 false) */
  reflected: boolean
}

/** LLM 성찰 플래그 (기본 OFF). */
export async function isLlmReflectionEnabled(env: any): Promise<boolean> {
  return readBooleanSetting(env.DB, 'memory.llm_reflection_enabled')
}

/**
 * 성찰 입력 텍스트 구성 (순수 함수 — 단위 테스트 대상).
 * - 요청과 결과를 "요청 [taskType]: ... / 결과 [taskType]: ..." 두 문단으로 합친다.
 * - 라벨을 독립 줄로 두지 않는다 — 독립 줄은 extractFacts가 사실 문장으로
 *   착각해 "[memo_create]" 같은 잡음이 기억에 저장되기 때문이다.
 * - '[LOCKED_BLOCK]' 자리표시자는 문장 경계('. ')로 치환한다 (0046 메모 캡처와
 *   동일 처리) — 잠긴 블록 뒤의 공개 문장이 통째로 버려지지 않게 한다.
 *   자리표시자 자체는 isFactSentence가 제외하므로 저장되지 않는다.
 */
export function buildReflectionText(
  taskType: string | undefined,
  taskText: string | undefined,
  resultText: string | undefined
): string {
  const label = (taskType || 'chat').trim() || 'chat'
  const clean = (s: string | undefined) =>
    sanitizeMemoryContent(s || '', 2000).replace(/\[LOCKED_BLOCK\]/g, '. ').trim()
  const task = clean(taskText)
  const result = clean(resultText)
  if (!task && !result) return ''
  const parts: string[] = []
  if (task) parts.push(`요청 [${label}]: ${task}`)
  if (result) parts.push(`결과 [${label}]: ${result}`)
  return parts.join('\n')
}

/**
 * 작업 완료 후 성찰 — 요청 + 결과에서 사실을 추출해 기억에 저장한다.
 * - 마스터 게이트: memory.v2_enabled OFF면 저장하지 않는다 (0044와 동일).
 * - 추출: 기본 결정적, LLM은 플래그 ON + 성찰기 주입 시에만 (실패 시 결정적 폴백).
 * - 저장: captureFacts(sourceType='reflection', createdBy='assistant') 재사용 —
 *   near-duplicate는 skipped, 동의 게이트 기본 0.
 * - 반환: reflected=false면 저장 시도를 하지 않은 것이다.
 */
export async function reflectOnTask(
  env: any,
  input: ReflectOnTaskInput
): Promise<ReflectOnTaskResult> {
  const text = buildReflectionText(input.taskType, input.taskText, input.resultText)
  if (!text) {
    return { ok: true, reflected: false, extraction: 'deterministic', created: [], skipped: [], entities: [] }
  }
  try {
    if (!(await isMemoryV2Enabled(env))) {
      return { ok: true, reflected: false, extraction: 'deterministic', created: [], skipped: [], entities: [] }
    }
  } catch {
    return { ok: false, reflected: false, error: 'db_error' }
  }

  // LLM 성찰은 플래그 ON + 추출기 주입 시에만; captureFacts의 llmExtract와
  // 같은 주입 패턴을 재사용하되, 성찰 전용 플래그(memory.llm_reflection_enabled)
  // 를 여기서 확인한다. 추출된 사실은 captureFacts의 facts 주입으로 그대로
  // 전달한다 (재추출로 LLM 결과가 걸러지지 않게).
  let llmExtract: ((text: string) => Promise<string[]>) | undefined
  if (input.llmReflect) {
    try {
      if (await isLlmReflectionEnabled(env)) llmExtract = input.llmReflect
    } catch {
      llmExtract = undefined
    }
  }
  let facts = extractFacts(text, Math.min(Math.max(input.maxFacts || 5, 1), 10))
  let extraction: 'deterministic' | 'llm' = 'deterministic'
  if (llmExtract) {
    try {
      const llmFacts = (await llmExtract(text))
        .map((f) => sanitizeMemoryContent(String(f || ''), 200).trim())
        .filter((f) => f.length >= 5)
        .slice(0, 10)
      if (llmFacts.length > 0) {
        facts = llmFacts
        extraction = 'llm'
      }
    } catch {
      // LLM 성찰 실패 시 결정적 결과 유지 (폴백)
    }
  }
  if (!facts.length) {
    return { ok: true, reflected: true, extraction, created: [], skipped: [], entities: [] }
  }
  // captureFacts가 near-duplicate를 걸러내고 그래프를 연결한다.
  // 동의 게이트(allow_ai_use/allow_provider_send 기본 0)도 그대로 유지된다.
  const r = await captureFacts(env, {
    text: facts.join('\n'),
    facts,
    sourceType: 'reflection',
    sourceId: input.sourceId,
    createdBy: 'assistant',
    maxFacts: facts.length,
  })
  return { ...r, reflected: true, extraction }
}
