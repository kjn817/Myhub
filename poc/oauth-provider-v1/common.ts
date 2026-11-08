/**
 * OAuth Provider v1 POC — 공용 상수·스코프 헬퍼.
 *
 * 식별자는 운영 형태 그대로 쓴다 (docs/oauth-provider-v1-design-20261028.md §1).
 * 단, issuer는 POC용 자리 표시자이다 — 운영 도메인은 배포 결정 때 정한다.
 * 리소스 URL만 실제 운영 엔드포인트(고정)이다.
 * 하네스는 DNS를 타지 않으므로 로컬 workerd에서도 이 값으로 검증된다.
 * 스코프 함의 규칙: 없음 — mcp:write는 mcp:read를 함의하지 않고,
 * mcp:admin은 읽기·쓰기를 함의하지 않는다 (설계 문서 §2-2).
 */

export const MCP_RESOURCE = 'https://myhub.myhub-app.workers.dev/api/mcp'
export const OAUTH_ISSUER = 'https://myhub-auth.myhub-app.workers.dev'

export const MCP_READ = 'mcp:read'
export const MCP_WRITE = 'mcp:write'
export const MCP_ADMIN = 'mcp:admin'

/** 인증 서버가 광고하는 전체 카탈로그 (RFC 8414 scopes_supported). */
export const SCOPES_SUPPORTED = [MCP_READ, MCP_WRITE, MCP_ADMIN, 'offline_access']

/** POC 쓰기 도구 — 이 목록에 있는 도구 호출에만 mcp:write를 요구한다. */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(['memo.create'])

/** 필요한 스코프 중 부여되지 않은 것. 빈 배열이면 충분하다. */
export function missingScopes(granted: readonly string[], needed: readonly string[]): string[] {
  return needed.filter((s) => !granted.includes(s))
}
