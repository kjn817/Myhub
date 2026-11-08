-- 0054: Gmail · Google Calendar 연동 (진짜 비서 3단계 g트랙)
--
-- - google_integrations: provider별 OAuth 토큰 1행 (단일 사용자 — provider='google' 1행만 사용).
--   토큰은 평문으로 저장하지 않고 MEMO_ENCRYPTION_KEY로 AES-GCM 암호화한
--   문자열(ENC: 접두)을 저장한다 (src/services/crypto.ts 재사용).
--   Worker secrets는 배포 시점 정적 값이라 런타임 OAuth 토큰 저장소로 쓸 수 없음.
--   저장소 최종 선택(D1 유지 vs KV)은 사용자 결정 사항 — docs/gmail-calendar-design.md §4·§9.
-- - google_sync_log: Cron pull 동기화 감사 로그. 건수·상태만 기록하고
--   메일 본문·일정 설명 전문은 저장하지 않는다 (개인정보 경계 §5).
-- - 추가형 변경 — 기존 테이블 ALTER/DROP 없음.
-- - 운영 적용 전 Time Travel bookmark 확보 등 운영 D1 안전 규칙을 따를 것.

CREATE TABLE IF NOT EXISTS google_integrations (
  provider TEXT PRIMARY KEY,
  email TEXT NOT NULL DEFAULT '',
  access_token TEXT NOT NULL DEFAULT '',
  refresh_token TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CHECK (provider IN ('google')),
  CHECK (status IN ('active', 'revoked', 'error'))
);

CREATE TABLE IF NOT EXISTS google_sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL DEFAULT 'google',
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CHECK (kind IN ('calendar', 'gmail', 'token_refresh')),
  CHECK (status IN ('ok', 'failed', 'skipped'))
);

CREATE INDEX IF NOT EXISTS idx_google_sync_log_created ON google_sync_log(created_at DESC);
