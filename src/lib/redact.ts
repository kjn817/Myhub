/**
 * 로그용 리댁션 — 민감한 키 이름 패턴을 가진 값을 구조적으로 가린다.
 * - 깊이 상한 6, 순환 참조·직렬화 불가 값은 표식으로 대체한다.
 * - 알려진 시크릿 문자열은 직렬화 결과에서 한 번 더 치환한다.
 */

export const REDACTED = '[REDACTED]'

const SENSITIVE_KEY_RE =
  /(newkey|rotatedkey|oldkey|password|passwd|pwd|pin|secret|token|api[-_]?key|access[-_]?key|authorization|cookie|credential|private[-_]?key|encryption[-_]?key)/i

const MAX_DEPTH = 6

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key)
}

export function redactForLog(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCATED]'
  if (value === null || value === undefined) return value
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[CIRCULAR]'
    seen.add(value)
    return value.map((v) => redactForLog(v, depth + 1, seen))
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]'
    seen.add(value)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      const secretShaped = typeof v === 'string' || (v !== null && typeof v === 'object')
      out[k] = isSensitiveKey(k) && secretShaped ? REDACTED : redactForLog(v, depth + 1, seen)
    }
    return out
  }
  return '[UNSERIALIZABLE]'
}

export function redactKnownSecrets(text: string, secrets: unknown[]): string {
  let out = text
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 4) {
      out = out.split(s).join(REDACTED)
    }
  }
  return out
}

export function stringifyForLog(value: unknown, knownSecrets: unknown[] = []): string {
  let json: string
  try {
    json = JSON.stringify(redactForLog(value)) ?? 'null'
  } catch {
    json = '"[UNSERIALIZABLE]"'
  }
  return redactKnownSecrets(json, knownSecrets)
}
