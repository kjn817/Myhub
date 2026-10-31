-- Phase B (B1): modify 작업의 파일 스냅샷+해시 저장
-- 에이전트가 작업 시작 시점의 파일 상태를 기록 → B5 충돌 감지/버전 분기의 기준점
ALTER TABLE artifact_jobs ADD COLUMN base_version_id INTEGER;
ALTER TABLE artifact_jobs ADD COLUMN base_snapshot TEXT;
