// 수면 통합 (Sleep-time Consolidation) — 새벽 유휴 시간에 장기 기억을 정리한다
// (진짜 비서 2단계 d트랙)
//
// Letta의 sleep-time 에이전트 패턴만 이식 (Letta 코드 미사용 — 서버 메모리
// sunset 후 피벗 중이라 개념만 참고):
// - 백그라운드에서 기억을 재작성·통합한다 (사용자 요청 경로가 아님).
// - 중복·유사 기억 병합, 오래된 기억 요약, 모순되는 기억 표시, 노화 티어 정리.
// - 기본 경로는 zero-LLM (결정적 규칙). LLM 요약은 플래그 기본 OFF, 주입식.
// - 사용자 데이터를 자동 삭제하지 않는다: 병합은 대체(supersede) 표시로만
//   남기고, 원본 행은 그대로 둔다. 통합 내역은 memory_consolidation_log(0053)
//   에 감사 기록으로 남긴다 (무엇을 병합·대체·표시했는지 재현 가능).
// - 잠긴 메모는 읽지 않는다: 통합 대상은 ai_memory_v2 행뿐이고, 잠긴 메모의
//   본문은 이 경로에서 조회하지 않는다. 외부 전송도 하지 않는다.
// - 노화 티어는 저장하지 않고 decayTier로 파생 계산한다 (0044 원칙 유지) —
//   "노화 티어 정리"는 cold/archived 기억의 요약(summary) 채우기로 수행한다.

import {
  decayTier,
  extractCoreFact,
  generateClaimToken,
  isMemoryV2Enabled,
  markContradiction,
  normalizeForDuplicate,
  supersedeMemory,
  type MemoryTier,
} from './memory-service'
import { closeFactTemporalEdges } from './fact-graph'
import { readBooleanSetting, readSettingValue } from '../lib/d1-setting'
import {
  contradictionFeatures,
  detectContradictionFromFeatures,
  fetchAllActiveMemories,
} from './memory-scan'

export { contentTokens, hasNegationMarker } from './memory-scan'

/** 수면 통합 실행 시각 (KST). Cron은 5분마다 틱하므로 03:00~03:59 중 첫 틱에 1회 실행. */
export const CONSOLIDATION_HOUR_KST = 3
/** 한 번의 실행에서 읽는 활성 기억 상한. */
export const CONSOLIDATION_BATCH_LIMIT = 500

export interface ConsolidationRow {
  id: number
  content: string
  summary: string | null
  entities: string | null
  accessCount: number
  lastAccessedAt: string | null
  updatedAt: string | null
  contradictionFlag: number
}

export interface ConsolidationStats {
  ok: boolean
  ran: boolean
  runId?: string
  merged: number
  contradictions: number
  cleared: number
  summarized: number
  skipped: number
  scanned: number
  pages: number
  reason?: string
  error?: string
}

export interface ConsolidationOptions {
  now?: Date | number
  batchLimit?: number
  /** LLM 요약기 (주입식). 플래그 memory.llm_consolidation_enabled='true'일 때만 사용. 기본 OFF. */
  llmSummarize?: (text: string) => Promise<string>
}

// ---------------------------------------------------------------------------
// 순수 헬퍼 (결정적 — 단위 테스트 대상)
// ---------------------------------------------------------------------------

/** KST 날짜·시각 (UTC+9 고정 — Asia/Seoul은 DST 없음). */
export function kstParts(now: Date | number): { date: string; hour: number } {
  const ms = now instanceof Date ? now.getTime() : now
  const kst = new Date(ms + 9 * 3600 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}`,
    hour: kst.getUTCHours(),
  }
}

/**
 * 중복 그룹 찾기: 정규화 내용(normalizeForDuplicate)이 같은 활성 기억끼리 묶는다.
 * - 대소문자·공백·구두점 차이만 있는 near-duplicate를 같은 그룹으로 본다.
 * - 1개짜리 그룹은 반환하지 않는다.
 */
export function findDuplicateGroups(rows: ConsolidationRow[]): ConsolidationRow[][] {
  const byNorm = new Map<string, ConsolidationRow[]>()
  for (const row of rows) {
    const norm = normalizeForDuplicate(row.content)
    if (!norm) continue
    const group = byNorm.get(norm) || []
    group.push(row)
    byNorm.set(norm, group)
  }
  return [...byNorm.values()].filter((g) => g.length > 1)
}

/**
 * 병합 생존자 선택: 최신 updated_at → 접근 횟수 → id 순.
 * - 최신 정보가 남고, 오래된 쪽이 superseded_by로 생존자를 가리킨다.
 */
export function pickMergeSurvivor(group: ConsolidationRow[]): ConsolidationRow {
  return [...group].sort((a, b) => {
    const byTime = String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
    if (byTime !== 0) return byTime
    if (b.accessCount !== a.accessCount) return b.accessCount - a.accessCount
    return b.id - a.id
  })[0]
}

/** 노화 티어 (decayTier 재사용 — 저장하지 않고 파생 계산). */
export function tierOf(row: ConsolidationRow): MemoryTier {
  return decayTier(row.accessCount, row.lastAccessedAt || row.updatedAt)
}

// ---------------------------------------------------------------------------
// 플래그·실행 마커 (ai_settings)
// ---------------------------------------------------------------------------

/** LLM 통합 요약 플래그 (기본 OFF). */
export async function isLlmConsolidationEnabled(env: any): Promise<boolean> {
  return readBooleanSetting(env.DB, 'memory.llm_consolidation_enabled')
}

/** 마지막 통합 실행일 (KST YYYY-MM-DD) — 하루 1회 중복 실행 방지 마커. */
export async function getLastConsolidationDate(env: any): Promise<string | null> {
  try {
    return await readSettingValue(env.DB, 'memory.last_consolidation_date')
  } catch {
    return null
  }
}

/** 통합 실행일 마커 기록 (성공한 실행 뒤에만 호출). */
export async function markConsolidationRun(env: any, date: string): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO ai_settings (key, value, updated_at) VALUES ('memory.last_consolidation_date', ?, datetime('now'))"
    ).bind(date).run()
  } catch {
    // 마커 기록 실패는 무시 (다음 틱에 재실행될 뿐, 데이터 손상 없음)
  }
}

// ---------------------------------------------------------------------------
// 감사 로그 (0053 memory_consolidation_log — 실패해도 통합은 계속)
// ---------------------------------------------------------------------------

export type ConsolidationAction = 'run' | 'merge' | 'contradiction' | 'clear' | 'summarize'

async function logConsolidation(
  env: any,
  runId: string,
  action: ConsolidationAction,
  memoryId: number | null,
  relatedMemoryId: number | null,
  detail: string
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO memory_consolidation_log
       (run_id, action, memory_id, related_memory_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).bind(runId, action, memoryId, relatedMemoryId, detail.slice(0, 500)).run()
  } catch {
    // 0053 미적용 DB에서는 감사 로그만 건너뜀
  }
}

// ---------------------------------------------------------------------------
// 수면 통합 실행
// ---------------------------------------------------------------------------

/**
 * 수면 통합 1회 실행 (결정적 규칙 우선):
 * 1) 중복 병합 — 정규화 내용 동일 그룹에서 생존자 1개만 남기고 나머지는
 *    supersedeMemory로 대체 표시 (행 삭제 없음). 동시에 패자의 시간 엣지를
 *    닫는다 (0056 closeFactTemporalEdges — "새 사실이 오면 기존 사실의
 *    valid_until을 닫는다"는 Graphiti 시간 엣지 규칙).
 * 2) 모순 표시 — detectContradictionFromFeatures가 true인 쌍은 양쪽에
 *    contradiction_flag=1. 반대로 플래그가 있는데 더 이상 모순이 아닌 기억은
 *    플래그를 자동 해제한다 (clear).
 * 3) 오래된 기억 요약 — cold/archived 티어 중 summary가 빈 기억에
 *    extractCoreFact(첫 문장) 요약을 채운다. LLM 요약은 플래그 ON + 주입 시에만
 *    사용하고, 실패하면 결정적 요약으로 폴백한다.
 * 4) 실행 내역은 memory_consolidation_log에 남기고, 통계를 반환한다.
 * - 마스터 게이트: memory.v2_enabled OFF면 실행하지 않는다 (ran=false).
 */
export async function runSleepConsolidation(
  env: any,
  options: ConsolidationOptions = {}
): Promise<ConsolidationStats> {
  const runId = generateClaimToken()
  const stats: ConsolidationStats = {
    ok: true, ran: false, runId, merged: 0, contradictions: 0, cleared: 0,
    summarized: 0, skipped: 0, scanned: 0, pages: 0,
  }
  try {
    if (!(await isMemoryV2Enabled(env))) {
      stats.reason = 'disabled'
      return stats
    }
  } catch {
    return { ...stats, ok: false, error: 'db_error' }
  }

  const explicitLimit = options.batchLimit
    ? Math.min(Math.max(options.batchLimit, 1), 1000)
    : null
  let rows: ConsolidationRow[] = []
  try {
    const fetched = await fetchAllActiveMemories(env, {
      pageSize: explicitLimit ?? CONSOLIDATION_BATCH_LIMIT,
      totalLimit: explicitLimit,
    })
    rows = fetched.rows
    stats.pages = fetched.pages
    stats.scanned = rows.length
  } catch {
    return { ...stats, ok: false, error: 'db_error' }
  }
  stats.ran = true

  // 1) 중복 병합 (삭제 없음 — 대체 표시만)
  // 0056 Graphiti 시간 엣지 규칙: 생존자(새 사실)가 오면 패자(옛 사실)의
  // 엔티티 연결 유효 기간을 닫는다 (valid_until = 병합 시각). 닫힌 연결은
  // 그래프 확장(expandGraphFacts / getFactNeighbors)에서 제외된다.
  // closeFactTemporalEdges는 0056 미적용 DB에서 { ok:false }로 fail-soft라
  // 병합 자체는 영향받지 않는다 (닫기 실패를 skipped로 세지 않는다 —
  // 감사 로그 detail에만 남긴다).
  const supersededIds = new Set<number>()
  for (const group of findDuplicateGroups(rows)) {
    const survivor = pickMergeSurvivor(group)
    for (const row of group) {
      if (row.id === survivor.id) continue
      const r = await supersedeMemory(env, row.id, survivor.id)
      if (r.ok) {
        stats.merged++
        supersededIds.add(row.id)
        const closed = await closeFactTemporalEdges(env, row.id)
        await logConsolidation(env, runId, 'merge', row.id, survivor.id,
          `중복 병합 → 기억 #${survivor.id}` +
          (closed.ok ? ` (시간 엣지 ${closed.closed}건 닫힘)` : ' (시간 엣지 닫기 미적용: 0056 이전 DB)'))
      } else {
        stats.skipped++
      }
    }
  }
  const activeRows = rows.filter((r) => !supersededIds.has(r.id))

  // 2) 모순 표시 (쌍 비교 — 특징을 한 번만 계산해 재사용한다)
  const features = activeRows.map((r) => contradictionFeatures(r))
  const stillContradicting = new Set<number>()
  const flaggedPairs: Array<[ConsolidationRow, ConsolidationRow]> = []
  for (let i = 0; i < activeRows.length; i++) {
    for (let j = i + 1; j < activeRows.length; j++) {
      if (!detectContradictionFromFeatures(features[i], features[j])) continue
      stillContradicting.add(activeRows[i].id)
      stillContradicting.add(activeRows[j].id)
      const a = activeRows[i]
      const b = activeRows[j]
      if (a.contradictionFlag === 1 && b.contradictionFlag === 1) continue
      flaggedPairs.push([a, b])
    }
  }
  for (const [a, b] of flaggedPairs) {
    const ra = await markContradiction(env, a.id, true)
    const rb = await markContradiction(env, b.id, true)
    if (ra.ok && rb.ok) {
      stats.contradictions++
      await logConsolidation(env, runId, 'contradiction', a.id, b.id, `모순 의심: 기억 #${a.id} ↔ 기억 #${b.id}`)
    } else {
      stats.skipped++
    }
  }
  for (const row of activeRows) {
    if (row.contradictionFlag !== 1) continue
    if (stillContradicting.has(row.id)) continue
    const r = await markContradiction(env, row.id, false)
    if (r.ok) {
      stats.cleared++
      row.contradictionFlag = 0
      await logConsolidation(env, runId, 'clear', row.id, null, `모순 해소로 플래그 자동 해제: 기억 #${row.id}`)
    } else {
      stats.skipped++
    }
  }

  // 3) 오래된 기억 요약 채우기 (cold/archived + summary 없음)
  let useLlm = false
  if (options.llmSummarize) {
    try {
      useLlm = await isLlmConsolidationEnabled(env)
    } catch {
      useLlm = false
    }
  }
  for (const row of activeRows) {
    if (row.summary && row.summary.trim()) continue
    if (tierOf(row) !== 'cold' && tierOf(row) !== 'archived') continue
    let summary = extractCoreFact(row.content)
    if (useLlm && options.llmSummarize) {
      try {
        const llm = (await options.llmSummarize(row.content)).trim()
        if (llm.length >= 5) summary = llm.slice(0, 200)
      } catch {
        // LLM 요약 실패 시 결정적 요약 유지 (폴백)
      }
    }
    if (!summary) { stats.skipped++; continue }
    try {
      // updated_at은 건드리지 않는다 — 요약 채우기가 노화 입력(마지막 활동)을
      // 리셋하면 식은 기억이 다시 hot으로 보이기 때문이다.
      const res = await env.DB.prepare(
        `UPDATE ai_memory_v2 SET summary = ?
         WHERE id = ? AND (summary IS NULL OR TRIM(summary) = '')`
      ).bind(summary, row.id).run()
      if ((res.meta?.changes ?? 0) > 0) {
        stats.summarized++
        await logConsolidation(env, runId, 'summarize', row.id, null, `오래된 기억 요약 (${tierOf(row)})`)
      }
    } catch {
      stats.skipped++
    }
  }

  // 4) 실행 내역 (run 행 — 통계 JSON)
  await logConsolidation(
    env, runId, 'run', null, null,
    JSON.stringify({
      merged: stats.merged,
      contradictions: stats.contradictions,
      cleared: stats.cleared,
      summarized: stats.summarized,
      skipped: stats.skipped,
      scanned: rows.length,
      pages: stats.pages,
    })
  )
  return stats
}
