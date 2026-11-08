/** 검색 limit 파라미터 정규화 — 기본 20, 범위 1~100, 무효값은 기본값. */

export function normalizeSearchLimit(raw: unknown): number {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return 20
  }
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < 1) {
    return 20
  }
  return Math.min(n, 100)
}
