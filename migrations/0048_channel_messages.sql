-- 0048: 채널 게이트웨이 감사 로그 (OpenClaw 패턴 이식 — 트랙 5)
--
-- channel_messages: 외부 채널(웹훅 등)을 경유한 인바운드/아웃바운드 메시지 기록
-- - 게이트웨이는 이 테이블 없이도 동작한다 (logChannelMessage가 best-effort).
-- - 운영 미적용: 이 트랙에서는 파일만 생성. 적용은 사용자 승인 후
--   운영 D1 안전 규칙(단독 적용·Time Travel bookmark 확보)을 따라 별도 수행.
-- - 추가형 변경 (기존 테이블·데이터 불변), 롤백 시 DROP TABLE channel_messages.

CREATE TABLE IF NOT EXISTS channel_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  persona_id TEXT,
  direction TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CHECK (direction IN ('inbound', 'outbound'))
);

CREATE INDEX IF NOT EXISTS idx_channel_messages_channel ON channel_messages(channel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_channel_messages_sender ON channel_messages(sender_id, created_at DESC);
