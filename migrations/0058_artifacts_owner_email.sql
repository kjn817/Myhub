-- 0058: artifacts 소유권 컬럼 + 스키마 드리프트 해소 (2026-10-27)
--
-- 배경 (2026-10-27 읽기 전용 실측):
--   * artifacts.owner_email: 어떤 마이그레이션에도 없고 운영 D1에도 없었다.
--     그런데 배포된 코드(94a7a06)가 owner_email을 25곳에서 참조해, 소유권 참조
--     엔드포인트(상세·PATCH·게시·버전·채팅 등)가 운영에서 500이었다.
--     HEAD 32bbd4a의 routes.ts는 33곳에서 참조한다.
--   * artifacts.source_job_id: 운영 D1에는 있으나 어떤 마이그레이션에도 없었다
--     (기록 외 변경). 새 DB에서는 artifact_jobs 연결 INSERT가 실패한다.
--   * uq_artifacts_source_job 부분 유니크 인덱스도 운영에만 있고 마이그레이션에
--     없었다.
--   이 파일이 세 가지를 모두 만들어 새 DB를 운영 최종 상태와 일치시킨다.
--   운영 적용 시 주의: 운영에는 source_job_id와 인덱스가 이미 있으므로,
--   운영 D1에는 이 파일 전체가 아니라 owner_email ALTER 1문장만 단독 적용한다.
--   (2026-10-27 사용자 승인으로 d1w.py 단독 실행, 행 수 불변 확인.)
ALTER TABLE artifacts ADD COLUMN owner_email TEXT;
ALTER TABLE artifacts ADD COLUMN source_job_id INTEGER;
CREATE UNIQUE INDEX uq_artifacts_source_job ON artifacts(source_job_id) WHERE source_job_id IS NOT NULL;
