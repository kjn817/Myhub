# QA 인벤토리 62차 (고유 ID 기반)

## Track A: P0 결함

| ID | 항목 | 상태 | 비고 |
|----|------|------|------|
| DEF-MEMO-001 | 블록 잠금 렌더러 정지 | FAIL | 버튼 비활성화 중, 원인 미확정 |

## Track B: 기능 QA

### 일정 (SCHED)

| ID | 테스트 | 상태 | 증거 |
|----|--------|------|------|
| SCHED-001 | 일정 생성 | PASS | 55차 브라우저 |
| SCHED-002 | 일정 수정 | PASS | 55차 브라우저 |
| SCHED-003 | 일정 삭제 (커스텀 모달) | PASS | 59차 브라우저 |
| SCHED-004 | 삭제 취소 | PASS | 59차 브라우저 |
| SCHED-005 | Escape 키로 모달 닫기 | PASS | 61차 브라우저 (3회) |
| SCHED-006 | 외부 클릭으로 모달 닫기 | PASS | 60차 브라우저 |
| SCHED-007 | 중복 클릭 방지 | PASS | 60차 브라우저 |
| SCHED-008 | 삭제 API 실패 처리 | NOT TESTED | |
| SCHED-009 | 삭제 후 재시도 | NOT TESTED | |

### 메모 (MEMO)

| ID | 테스트 | 상태 | 증거 |
|----|--------|------|------|
| MEMO-002 | 메모 생성 | PASS | 62차 브라우저 (ID 34) |
| MEMO-003 | 메모 조회 | PASS | 62차 API |
| MEMO-004 | AI 메모 수정 (ID 기반) | PASS | 55차 브라우저 |

### API 인증

| ID | 테스트 | 상태 | 증거 |
|----|--------|------|------|
| API-AUTH-001~011 | 11개 API 미인증 401 | PASS | 60차 curl |

### 잠금 API

| ID | 테스트 | 상태 | 증거 |
|----|--------|------|------|
| API-LOCK-001 | 미인증 401 | PASS | 61차 curl |
| API-LOCK-002 | 없는 ID 404 | NOT TESTED | 인증 세션 필요 |
| API-LOCK-003 | 빈 html 400 | NOT TESTED | 인증 세션 필요 |
| API-LOCK-004 | 정상 요청 200 | NOT TESTED | 인증 세션 필요 |

## 통계

- PASS: 21 (고유 ID 기준)
- FAIL: 1 (DEF-MEMO-001)
- NOT TESTED: 다수 (전체 166개 중 미정리)
