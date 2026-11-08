# MyHub 전체 기능·페이지·API 목록 (49차 1단계)

기준: Git 12bf9c0, 2026-10-12

## 1. 정적 페이지 (10개)

| # | 경로 | 용도 | 인증 |
|---|------|------|------|
| 1 | /index.html | 대시보드 홈 | 필요 |
| 2 | /login.html | 이메일 OTP 로그인 | 불필요 |
| 3 | /memo.html | 메모 CRUD | 필요 |
| 4 | /schedule.html | 일정 관리 | 필요 |
| 5 | /todo.html | 할 일 관리 | 필요 |
| 6 | /chat.html | AI 비서 채팅 | 필요 |
| 7 | /search.html | 통합 검색 | 필요 |
| 8 | /memory.html | AI 기억 관리 | 필요 |
| 9 | /backup.html | 암호화 백업 | 필요 |
| 10 | /briefing.html | 아침 브리핑 | 필요 |

## 2. API 모듈 (10개)

| 모듈 | 주요 엔드포인트 |
|------|----------------|
| auth | POST /request, POST /verify, POST /logout, GET /me |
| memo | GET /list, GET /:id, POST /, PUT /:id, DELETE /:id, POST /:id/lock, POST /:id/sensitivity |
| schedule | GET /list, GET /calendar, POST /, PUT /:id, DELETE /:id |
| todo | GET /list, POST /, PUT /:id, POST /:id/toggle, DELETE /:id, PUT /reorder |
| ai | POST /chat, GET /personas, GET /models, GET /usage, GET /quota, POST /orchestrate |
| search | GET / (통합 검색) |
| memory | GET /memory, POST /memory, DELETE /memory/:key |
| backup | POST /encrypted |
| briefing | GET /today |
| push | GET /vapid-key, POST /subscribe, DELETE /unsubscribe |

## 3. 환경 비교

| 항목 | 스테이징 | 운영 |
|------|----------|------|
| Worker | myhub-staging | myhub |
| 버전 | f297f9cc-886b-480d-838a-eedf80e6b161 | ae896dc3-0599-4b54-8628-8b8cce5d94d8 |
| URL | myhub-staging.myhub-app.workers.dev | myhub.myhub-app.workers.dev |
| D1 | myhub-db-staging (21 테이블) | myhub-db (17 테이블) |
| Git SHA | 12bf9c0 | 불명 (별도 배포) |
| 허용 이메일 | kjn817@gmail.com | kimjn00003@naver.com |

### D1 스키마 차이
- 스테이징에만: ai_runs, ai_tool_runs, ai_error_log, ai_tool_operations
- 운영에만: 없음

## 4. QA 상태

| 영역 | 상태 |
|------|------|
| 백업 UI | BROWSER PASS (6/6) |
| 브리핑 UI | BROWSER PASS (기본) |
| 브리핑 API | API PASS (로컬) |
| 로그인 | BROWSER PASS |
| 메모/일정/할일 | NOT TESTED (심층 QA 필요) |
| AI 비서 | NOT TESTED (심층 QA 필요) |
| 검색 | 부분 PASS |
| 파일 | NOT TESTED |
| Push | NOT TESTED |

## 5. 알려진 결함

| ID | 내용 | 심각도 | 상태 |
|----|------|--------|------|
| - | 없음 (신규 QA에서 발견 예정) | - | - |

## 6. 미검증 항목

- 전체 CRUD 심층 테스트
- AI 비서 16개 질문 시나리오
- 파일 업로드/다운로드
- Push 알림
- 운영-스테이징 기능 동등성
