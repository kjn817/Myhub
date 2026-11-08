-- 관문 18: artifact_jobs 인덱스 추가 (성능)
-- 멱등성 체크(owner_email, client_request_id)와 artifact별 조회(artifact_id) 최적화
--
-- 2026-10-27 수정 — 원래 파일은 존재하지 않는 컬럼에 인덱스를 만들어 새 DB에서
-- 마이그레이션 체인이 여기서 멈췄음. 원인: owner_email·client_request_id·
-- provider·model 컬럼을 추가하는 마이그레이션이 git 기록에 전혀 없음.
-- 0035는 테이블을 이 4개 컬럼 없이 만들고, 0039는 컬럼이 있는 줄 알고
-- 인덱스만 만들었음. 운영 D1에는 이 컬럼들이 직접 ALTER로 들어간 기록 외
-- 변경이라 운영은 동작했지만, 새 DB에서는 0039에서 체인이 멈추고 그 뒤
-- 0040~0057이 전부 미적용 + AI 스튜디오 작업 생성 INSERT 자체가 실패함.
-- 그래서 여기에 컬럼 추가를 넣는다. 운영은 이미 컬럼·인덱스를 갖고 있고
-- 마이그레이션 추적 테이블이 없어 재실행되지 않으므로 운영에 영향 없음.
-- (적용된 마이그레이션 파일 수정 금지 규칙의 예외 — 운영과 최종 상태가
-- 동일하다는 것을 D1 직접 조회로 확인함. 2026-10-27.)
ALTER TABLE artifact_jobs ADD COLUMN owner_email TEXT;
ALTER TABLE artifact_jobs ADD COLUMN client_request_id TEXT;
ALTER TABLE artifact_jobs ADD COLUMN provider TEXT;
ALTER TABLE artifact_jobs ADD COLUMN model TEXT;

-- 운영과 동일한 부분 유니크 인덱스 (멱등성 경합 방지 — 운영 D1에 존재)
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_client_req ON artifact_jobs(owner_email, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_artifact_jobs_idempotency ON artifact_jobs(owner_email, client_request_id);
CREATE INDEX IF NOT EXISTS idx_artifact_jobs_artifact ON artifact_jobs(artifact_id);
