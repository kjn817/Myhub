-- ask_question 도구용: 에이전트가 사용자 입력을 기다리는 동안의 상태 저장
-- pending_state JSON: { questions: [...], answers: [...], files: {...} }
ALTER TABLE artifact_jobs ADD COLUMN pending_state TEXT;
