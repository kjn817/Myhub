-- 0079: Drive 하이브리드 저장소 — 오라클 저장소 파일 (2026-11-19)
--
-- 배경: 브라우저 다운로드가 10MB(Cloudinary 상한)를 넘으면 Finder에 못
-- 들어가던 것을, 큰 파일은 오라클 서버 저장소(/downloads)에 그대로 두고
-- D1에만 등록해 Finder에서 동일하게 다루는 하이브리드로 바꾼다.
-- storage='oracle'인 행은 url이 NULL이고 oracle_path가 실물 위치다.
-- 기존 행은 DEFAULT 'cloudinary'로 그대로 Cloudinary 경로를 탄다.
-- 구 Worker 코드는 새 컬럼을 몰라도 동작한다 (INSERT 명시 컬럼,
-- SELECT *의 여분 컬럼 무시) — 마이그레이션 후 Worker 배포 순서.
-- 적용은 단독 파일로만 (docs/migration-history-check.md §5).

ALTER TABLE drive_files ADD COLUMN storage TEXT NOT NULL DEFAULT 'cloudinary';
ALTER TABLE drive_files ADD COLUMN oracle_path TEXT;

CREATE INDEX IF NOT EXISTS idx_drive_files_oracle_path
  ON drive_files(oracle_path) WHERE oracle_path IS NOT NULL;
