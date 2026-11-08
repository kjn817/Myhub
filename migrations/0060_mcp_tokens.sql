-- 0060: MCP 서버 토큰 (mcp_tokens) — 2026-10-28 MCP 서버 본체
--
-- 배경: MCP 엔드포인트(POST /api/mcp)는 브라우저 세션 쿠키를 못 보내는
-- 외부 MCP 클라이언트(Claude Code·Cursor 등)도 쓰므로, PIN 세션 외에
-- 별도 Bearer 토큰 인증이 필요하다. OAuth 2.1 풀 구현은 하지 않는다
-- (개인용 단일 사용자 — docs/mcp-server-20261028.md 참조).
--
-- 설계:
--   - 토큰 값은 평문으로 저장하지 않는다. SHA-256 해시(token_hash)만 저장하고
--     평문은 발급 시 1회만 반환한다 (재조회 불가).
--   - 발급·폐기는 PIN 세션이 있는 /api/mcp/tokens 엔드포인트에서만 수행한다.
--   - 토큰 값은 로그·에러 응답에 절대 포함하지 않는다.
--   - revoked_at이 NULL인 행만 유효하다 (폐기는 소프트 삭제 — 감사 추적용).
--   - 활성 토큰 상한은 앱 코드에서 강제한다 (MAX_ACTIVE_MCP_TOKENS=10).
--
-- 주의: 운영 D1에는 적용하지 않는다 (이 트랙은 구현+검증까지만).

CREATE TABLE IF NOT EXISTS mcp_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_mcp_tokens_hash ON mcp_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_email ON mcp_tokens(email);
