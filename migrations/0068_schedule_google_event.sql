-- 0068: 일정 Google 캘린더 쓰기-스루 링크 (schedules.google_event_id)
--
-- 배경: 사용자 결정(2026-11-05) "일정 앱에 저장하면 구글 캘린더에 자동
-- 등록" — 생성·수정·삭제 쓰기-스루가 대응하는 Google 이벤트 ID를 행에
-- 보관한다 (src/services/schedule-google-sync.ts). 운영 적용 시 Time Travel
-- bookmark API가 404를 반환해, schedules·reminders 전량 논리 스냅샷을
-- 먼저 남기고 단독 적용한 기록이 있다 (2026-11-05).
--
-- 재구축 근거: ~/memory/2026-11-05.md "마이그레이션 0068 schedules.
-- google_event_id 추가"로 본문 확정. 운영 D1에는 이미 적용된 상태다.
--
-- 미확정 사항: google_sync_log 테이블(provider, kind, status, detail —
-- 운영 번들 INSERT 실측)의 생성 마이그레이션 귀속이 기록만으로 확정되지
-- 않아 이 파일에 포함하지 않았다. 운영 D1 스키마 대조 단계에서 귀속을
-- 확정해 해당 파일에 반영할 것.
--
-- 주의: 추가형 변경만 포함한다.

ALTER TABLE schedules ADD COLUMN google_event_id TEXT;
