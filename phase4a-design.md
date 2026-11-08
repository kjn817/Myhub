# MyHub Phase 4A — D1 + FTS5 장기 메모리 상세 설계

## 1. 현재 데이터 구조도

### 메모
- `memos`: id, text, created_at, is_locked, sensitivity
- `memos_fts`: FTS5 가상 테이블 (text)
- 트리거로 자동 동기화

### AI 대화
- `ai_chats`: id, persona_id, role, content, model, created_at, prompt_version
- `ai_conversations`: 대화 세션

### 일정
- `schedules`: id, title, description, location, start_at, end_at, timezone, status
- `reminders`: 알림

### 할 일
- `todos`: id, title, description, due_at, priority, status

### 기존 장기 메모리 (미사용)
- `ai_memory`: id, category, key, value, created_at, updated_at
- 문제점: user_id 없음, source 추적 없음, FTS 없음, 동의 관리 없음

## 2. 기존 memos_fts 재사용 범위

**재사용 가능:**
- 토크나이저: 기본 (unicode61)
- 트리거 패턴: INSERT/UPDATE/DELETE 동기화
- 검색 쿼리: `MATCH` + 랭킹

**확장 필요:**
- 메모 외 테이블은 FTS 인덱스 없음
- 잠금 데이터가 FTS에 포함됨 (검색 시 필터링 필요)

## 3. 통합 검색 vs 장기 기억

### A. 통합 검색 (Phase 4B)
- 대상: memos, ai_chats, schedules, todos 원본
- 방식: 각 테이블별 FTS 또는 LIKE, 결과 합산
- 권한: is_locked=1, sensitivity>=2 제외
- 출처: 테이블명 + id 반환

### B. 장기 기억 (Phase 4C)
- 대상: 사용자가 명시적으로 저장 요청한 사실/선호
- 저장: `ai_memory_v2` 새 테이블 (기존 ai_memory는 스키마 부족)
- 자동 추출: 이번 범위 제외 (별도 동의 설계 필요)

## 4. ai_memory_v2 스키마 제안

```sql
CREATE TABLE ai_memory_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,           -- 소유자 (현재 단일 사용자지만 확장 대비)
  category TEXT NOT NULL,          -- 'fact', 'preference', 'project'
  content TEXT NOT NULL,           -- 기억 본문
  source_type TEXT,                -- 'memo', 'chat', 'schedule', 'manual'
  source_id INTEGER,               -- 원본 ID
  persona_scope TEXT DEFAULT 'all', -- 'all' 또는 특정 비서 id
  consent_at TEXT NOT NULL,        -- 동의 시각
  is_active INTEGER DEFAULT 1,    -- 0=삭제됨 (소프트 삭제)
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE ai_memory_fts USING fts5(
  content,
  content='ai_memory_v2',
  content_rowid='id'
);
-- 트리거: is_active=1인 경우만 인덱싱
```

## 5. FTS5 한국어 검색 전략

- D1 FTS5는 unicode61 토크나이저 기본 지원
- 한국어: 단어 단위 분리 제한적 → 2글자 이상 키워드 권장
- 기존 memos_fts와 동일 방식 유지 (LIKE 폴백)

## 6. 개인정보 정책

- user_id 격리 (현재 단일 사용자)
- is_locked=1 메모는 검색·기억 저장 모두 제외
- sensitivity>=2 (기밀 이상)는 FTS 인덱싱 제외
- 기억 삭제 시 FTS에서도 삭제 (트리거)
- 비서별 persona_scope로 접근 제한

## 7. 백업·복원

- 원본: `ai_memory_v2` 일반 테이블 → D1 export 가능
- FTS: 가상 테이블은 export 제외 → 복원 후 트리거로 재생성
- 절차: 원본 복원 → `INSERT INTO ai_memory_fts SELECT...` 재구축

## 8. 예상 변경 파일

- `migrations/0026_ai_memory_v2.sql` (신규)
- `src/modules/ai/memory.ts` (신규)
- `src/modules/ai/routes.ts` (메모리 API 추가)

## 9. Phase 4B/C 순서

- 4B: 통합 검색 API (읽기 전용)
- 4C: 장기 기억 저장/관리 + 비서 연동

## 10. GO/NO-GO

**GO** — 기존 구조 재사용 가능, 스키마 확장으로 해결 가능
