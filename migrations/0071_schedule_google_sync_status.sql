-- 0071: 일정 Google 동기화 상태 (schedules.google_sync_status 외)
--
-- 배경: J-01 "구글 연동 사망의 침묵 + 정합 회복 수단 전무"의 회복 수단.
-- 연동이 끊긴 동안 쌓인 행을 포함해, 행마다 동기화 상태
-- ('pending' | 'synced' | 'delete_pending')를 추적해 백필·재동기화가
-- 가능하게 했다. 2웨이브에서 운영 적용됐고, 적용 시점에 일정 12건이
-- pending 상태임이 확인됐다 (이후 백필로 12건 전부 google_event_id 보유).
--
-- 스키마 확정 (2026-11-07 재구축): 운영 D1(myhub-db)의 sqlite_master 실측으로
-- 확정했다. 역추정 초안에서 달라진 점:
-- - google_sync_status는 TEXT NOT NULL DEFAULT 'pending'이다 (초안은
--   NOT NULL이 빠져 있었다). 신규 일정 INSERT가 이 컬럼을 명시하지 않고
--   DB 기본값에 의존하는 것은 번들 실측과도 정합한다.
-- - 같은 웨이브의 동반 컬럼 google_sync_last_error TEXT /
--   google_sync_updated_at TEXT가 함께 존재한다 (초안에는 없었다).
-- - 조회용 인덱스 idx_schedules_google_sync_status
--   (google_sync_status, start_at)가 함께 존재한다.
-- 운영 D1에는 이미 적용된 상태다 (재적용 금지).
--
-- 주의: 추가형 변경만 포함한다.

ALTER TABLE schedules ADD COLUMN google_sync_status TEXT NOT NULL DEFAULT 'pending';

ALTER TABLE schedules ADD COLUMN google_sync_last_error TEXT;

ALTER TABLE schedules ADD COLUMN google_sync_updated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_schedules_google_sync_status
  ON schedules(google_sync_status, start_at);
