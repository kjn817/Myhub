# 운영 DB 변경 기록

## 2026-10-10 0024_ai_feedback.sql 단독 적용

- **파일:** `migrations/0024_ai_feedback.sql`
- **체크섬 (SHA256):** `cf0efe8e9562673958db942134bc2d223e3f4af11c60a777c2435b52bbfbd40d`
- **적용 시각 (UTC):** 2026-10-10T09:58:29Z
- **대상 DB:** myhub-db (`0dd871c5-3d1c-4cea-bfbe-3e258f477106`)
- **방법:** D1 API 직접 SQL 실행 (wrangler migrations 미사용 — 운영에 이력 테이블 없음)
- **적용 전 스키마:** ai_feedback 테이블 없음
- **적용 후 스키마:**
  - `ai_feedback` 테이블 생성 (id, user_id, message_id, value, reason_code, created_at, updated_at)
  - UNIQUE(user_id, message_id)
  - CHECK (value IN ('like','dislike'))
  - CHECK (reason_code IN (...))
  - FOREIGN KEY message_id → ai_chats(id) ON DELETE CASCADE
  - 인덱스 3개: idx_ai_feedback_message, idx_ai_feedback_user, idx_ai_feedback_created
- **제외:** 0020, 0021, 0022, 0023, 0025 모두 미적용
- **검증:** PUT/GET/DELETE E2E 통과, 미인증 401 확인
- **기존 데이터:** ai_chats 30→32건 (테스트 2건 포함), ai_conversations 8→9건 (테스트 1건 포함), 모두 보존
- **테스트 데이터 정리:** ai_feedback 0건 (DELETE로 정리됨)

## 참고
- 운영 DB에는 Wrangler 마이그레이션 이력 테이블이 없음 (수동 적용 방식)
- 추후 마이그레이션 체계 도입 시 이 기록과 대조 필요
