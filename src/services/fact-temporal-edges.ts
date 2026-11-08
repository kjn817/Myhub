/**
 * 시간 엣지 닫기 — Graphiti 시간 엣지 규칙 (0056):
 * 새 사실이 기존 사실을 대체하면, 기존 사실의 엔티티 연결 유효 기간을
 * 닫는다 (valid_until = 대체 시각). 열린 연결(valid_until IS NULL)만 닫고,
 * 이미 닫힌 연결은 건드리지 않는다 (멱등 — 재실행해도 changes 0).
 * - 0056 미적용 DB에서는 UPDATE가 실패해 { ok: false } 반환 (fail-soft).
 * - 호출: memory-consolidation 중복 병합 + POST /:id/supersede.
 */
export async function closeFactTemporalEdges(
  env: any,
  factId: number,
  nowIso?: string
): Promise<{ ok: boolean; closed: number }> {
  if (!Number.isInteger(factId) || factId < 1) return { ok: false, closed: 0 }
  try {
    const res = await env.DB.prepare(
      'UPDATE memory_fact_entities SET valid_until = ? WHERE fact_id = ? AND valid_until IS NULL'
    ).bind(nowIso || new Date().toISOString(), factId).run()
    return { ok: true, closed: Number(res.meta?.changes ?? 0) }
  } catch {
    return { ok: false, closed: 0 }
  }
}

/**
 * 시간 엣지 다시 열기 — 복원(POST /:id/restore) 전용:
 * 복원된 사실의 닫혔던 연결을 다시 유효하게 한다 (valid_until = NULL).
 * valid_from은 건드리지 않는다 (원래 연결 생성 시각 유지).
 * - memora에는 이런 "제자리 복원"이 없다 (삭제된 내용은 tombstone이 막고,
 *   대체된 내용은 새 행으로만 돌아온다). MyHub restore는 명시적 사용자
 *   행위라 재개를 허용하되, 대체자도 살아 있으면 두 버전이 동시에
 *   유효한 분기(fork)가 된다 — 비교 메모(docs/memora-compare-20261026.md) 참조.
 */
export async function reopenFactTemporalEdges(
  env: any,
  factId: number
): Promise<{ ok: boolean; reopened: number }> {
  if (!Number.isInteger(factId) || factId < 1) return { ok: false, reopened: 0 }
  try {
    const res = await env.DB.prepare(
      'UPDATE memory_fact_entities SET valid_until = NULL WHERE fact_id = ? AND valid_until IS NOT NULL'
    ).bind(factId).run()
    return { ok: true, reopened: Number(res.meta?.changes ?? 0) }
  } catch {
    return { ok: false, reopened: 0 }
  }
}
