# MyHub 운영 수동 백업 계획 (Phase 4D)

## 1. 백업 방식

- **도구**: `scripts/backup_encrypted.py`
- **암호화**: AES-256-GCM
- **키 관리**: 환경변수 `MYHUB_BACKUP_KEY` (별도 보관, Git 금지)
- **형식**: JSON → 암호화 → `.enc.json`

## 2. 백업 대상 (14개 테이블)

memos, memo_tags, schedules, todos, files, reminders,
ai_conversations, ai_chats, ai_feedback, ai_usage, ai_memo_audit,
ai_memory, ai_memory_v2, ai_settings

**제외**:
- otp_codes: 일회용 인증코드
- push_subscriptions: 별도 보안 검토 필요
- FTS 테이블: 복원 시 재생성
- KV/Secrets: 별도 관리

## 3. 백업 절차 (수동)

### 사전 준비
1. 백업 키 준비 (환경변수 설정)
2. 저장 위치 확인 (암호화된 파일만)
3. 쓰기 중지 여부 결정

### 실행
```bash
export MYHUB_BACKUP_KEY=$(cat /secure/backup_key.txt)
python3 scripts/backup_encrypted.py \
  --db-id 0dd871c5-3d1c-4cea-bfbe-3e258f477106 \
  --output /secure/myhub-backup-20261011.enc.json
```

### 검증
1. 파일 생성 확인
2. 복호화 테스트 (별도 키로)
3. 무결성 검증 (스크립트 내장)
4. 파일 권한 확인 (600)

## 4. 일관성 확보

**현재 한계**: REST API는 트랜잭션 일관성 보장 안 됨

**수동 백업 시 권장**:
- 트래픽이 적은 시간대 선택
- 백업 중 대량 쓰기 작업 금지
- 백업 후 행 수 기록

**향후**: Worker 내 `db.batch()` 기반 백업 엔드포인트 구현 검토

## 5. 삭제 기억 처리

- 삭제 이력을 별도 파일에 기록 (ID+시각, 본문 제외)
- 복원 시 삭제 이력 적용
- 삭제 이력 보존 기간 >= 백업 보존 기간

## 6. 보존 정책

| 항목 | 기간 |
|------|------|
| 일일 백업 | 7일 |
| 주간 백업 | 4주 |
| 월간 백업 | 3개월 |
| 삭제 이력 | 백업 보존 기간과 동일 |

## 7. 복원 절차

1. 격리 D1 생성
2. `scripts/restore_d1.py`로 복원
3. 외래키 검증
4. FTS 재생성 (0028 마이그레이션)
5. integrity-check
6. 삭제 이력 적용
7. 데이터 검증

## 8. 보안

- 키 분실 시 복구 불가 (문서화)
- 백업 파일 접근 권한: 600
- 평문 백업 금지
- Git에 백업 파일 커밋 금지
- 로그에 개인정보 출력 금지

## 9. 실패 대응

- 백업 실패: 파일 삭제, 재실행
- 복원 실패: 격리 DB 폐기
- 키 분실: 백업 무효 (새 키로 새 백업)

---

**상태**: 계획 완료, 실행은 별도 승인 필요
**다음**: 최초 운영 수동 백업 실행 승인 요청
