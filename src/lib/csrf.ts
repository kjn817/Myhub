/**
 * 전역 CSRF 방어 — Origin/Referer 검사.
 *
 * feedback.ts의 checkOrigin과 같은 규칙을 전역 미들웨어용으로 공유한다:
 * - 안전 메서드(GET/HEAD/OPTIONS)는 검사하지 않는다.
 * - Origin·Referer가 둘 다 없으면 허용한다 — 비브라우저 클라이언트
 *   (curl·MCP 클라이언트·웹훅 발신자)는 Origin을 보내지 않는다.
 * - Origin이 있으면 요청 URL의 호스트와 일치해야 한다.
 * - Origin이 없고 Referer만 있으면 Referer의 호스트가 일치해야 한다.
 * - 파싱 불가·불투명 Origin(null)은 차단한다 (fail-closed).
 *
 * 브라우저는 상태 변경 요청에 Origin을 항상 보내므로, 교차 출처
 * 폼·fetch CSRF는 여기서 걸린다. Hono의 csrf() 미들웨어는 폼 계열
 * Content-Type만 검사하고 Origin·sec-fetch-site가 둘 다 없는 요청을
 * 차단해 비브라우저 클라이언트를 깨뜨리므로 쓰지 않는다.
 */

export interface CsrfRequestLike {
  method: string
  url: string
  header(name: string): string | undefined
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function isCsrfSafeRequest(req: CsrfRequestLike): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return true
  const origin = req.header('Origin')
  const referer = req.header('Referer')
  if (!origin && !referer) return true
  let expectedHost: string
  try {
    expectedHost = new URL(req.url).host
  } catch {
    return false
  }
  const matches = (value: string): boolean => {
    try {
      return new URL(value).host === expectedHost
    } catch {
      return false
    }
  }
  if (origin) return matches(origin)
  return matches(referer as string)
}
