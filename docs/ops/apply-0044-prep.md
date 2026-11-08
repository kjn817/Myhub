# 0044 운영 적용 준비서 (2026-10-25 작성 — 적용 전 사용자 명시 승인 필요)

## 대상
- 마이그레이션: `migrations/0044_memory_pages_aging.sql` (커밋 11655d0, 브랜치 fix/unlock-block-remove-ciphertext)
- 내용: ai_memory_fts를 일반 FTS5로 재구성(0028 'delete' 결함 수정) + ai_memory_v2에 노화/대체 컬럼 7개 추가 + memory_pages/memory_handoffs 테이블 신규
- 코드: src/services/memory-service.ts, src/modules/memory/routes.ts, src/modules/ai/routes.ts 변경분 포함 (같은 커밋)

## 사전 검증 완료 (실행 증거)
- 통합 테스트 `tests/integration/memory-0044-real.test.js`: 11/11 통과 (2026-10-25 재실행, 실제 SQLite에 0027→0028→0029→0044 순서 적용 후 FTS 트리거 동기화·랭킹·touch·페이지·대체·복원·핸드오프 종단 검증)
- 운영 D1 읽기 전용 스냅샷 (2026-10-25, 쓰기 없음): ai_memory_v2 0행, memos 26행, artifact_jobs 50행. memory_pages/memory_handoffs 아직 없음 → 0044 미적용 상태 확인됨.
- 0044는 ai_memory_v2 원본을 건드리지 않음 (DROP TABLE은 FTS 인덱스에만 적용, ADD COLUMN 추가형 + 신규 테이블). ai_memory_v2 0행이라 FTS 재구성 시 데이터 위험 없음.

## 운영 적용 절차 (승인 후 순서대로)
1. Time Travel bookmark 확보 시도: `.scratch/bookmark.py` (404면 스냅샷으로 대체한 전례 방식 — 위 행 수 기록)
2. 지정 파일만 단독 적용 (일괄 마이그레이션 금지):
   `wrangler d1 execute myhub-db --remote --file migrations/0044_memory_pages_aging.sql`
   또는 D1 API로 동일 파일 단독 적용
3. 적용 후 확인: memory_pages/memory_handoffs 존재, ai_memory_v2에 신규 컬럼 7개 존재, `ai_memory_fts` MATCH 조회 + UPDATE/DELETE 트리거 동작 실측 (표준 SQLite에서는 D1 고유 동작이 재현되지 않으므로 운영 D1에서 직접 확인)
4. 재배포: `python3 ~/workspace/myhub/deploy_full.py production` (시크릿 소실 가드 내장, 커밋 2494f05)
5. 기능 활성화는 별도 결정: `memory.v2_enabled` 플래그 기본 OFF. 사용자가 ai_settings에서 true로 켜야 v2 검색 주입 동작.

## 주의
- 배포 전 HEAD에 트랙 2~9 작업물이 섞이지 않았는지 확인할 것 (각 트랙은 별도 apply/* 브랜치에서 작업 중).
- 운영 D1 쓰기·배포는 이 문서만으로 실행하지 말 것. 사용자 채팅 명시 승인이 있어야 함.
