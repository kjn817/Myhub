# MyHub 프로젝트 전체 기술 검토 요청 (Phase 1 ~ Phase 4D 완료, Phase 5+ 계획)

당신은 MyHub 프로젝트의 외부 기술 검토자입니다. 당신은 프로젝트 코드를 직접 읽을 수 없으므로, 아래에 제공된 상세 구현 내용을 바탕으로 검토해주세요.

---

## 1. 프로젝트 개요

- **이름**: MyHub (1인용 개인 취미 웹 서비스, 수십 년 사용할 시스템 목표)
- **스택**: Cloudflare Workers + Hono (TypeScript) + D1 (SQLite) + KV + Static Assets
- **운영 URL**: https://myhub.myhub-app.workers.dev
- **스테이징 URL**: https://myhub-staging.myhub-app.workers.dev
- **GitHub**: https://github.com/kjn817/Myhub
- **인증**: 이메일 OTP (Resend API) + HMAC HttpOnly 세션 쿠키 (1일 유효)
- **배포**: Wrangler + Static Assets 방식 (multipart 2.3MB silent fail 이슈로 전환)

### 파일 구조 원칙 (프로젝트 코드 헌법)
```
src/
  modules/<모듈>/     # memo, ai, schedule, todo, auth, memory, backup, search 등
    routes.ts         # 라우트만 (300줄 이하)
  services/           # 공용 서비스 (ai.ts, crypto.ts, *-tools.ts 등)
  lib/                # 순수 유틸 (DB 의존성 없음)
  modules.ts          # 모듈 레지스트리 (새 모듈은 1줄 추가로 등록)
public/
  <페이지>.html       # 500줄 이하
  js/<페이지>.js      # 페이지 로직
```

### 마스터 로드맵
| Phase | 내용 | 상태 |
|-------|------|------|
| Phase 0 | 기존 코드 분석·성능 측정·테스트 기반 | 완료 |
| Phase 1 | Function Calling 엔진 (핵심) | 완료 |
| Phase 2 | 모델 라우팅·안전한 Fallback | 완료 |
| Phase 3 | 프롬프트 v1·피드백·시간 검증 | 완료 (2026-10-11 공식 종료) |
| Phase 4 | D1+FTS5 장기 메모리 (공통 기억·검색·백업) | 4C/4D 완료, 4B 잔여 |
| Phase 5 | Cron 아침 브리핑 | 미착수 |
| Phase 6 | Web Push·PWA | 미착수 |

---

## 2. Phase 1: Function Calling 엔진 (완료)

### 구현 파일
- `src/services/*-tools.ts`: 각 도구의 마커 파서/실행기
  - `memo-tools.ts`: 메모 검색·생성
  - `schedule-tools.ts`: 일정 생성·조회·수정
  - `todo-tools.ts`: 할 일 관리
- `src/services/ai-access.ts`: AI 접근 제어 (보안 경계)
- `src/services/orchestrator.ts`: 도구 호출 오케스트레이션

### 동작 방식
1. AI 모델이 응답에 특수 마커 (예: `[SEARCH:query]`) 출력
2. 마커 파서가 이를 감지해 해당 도구 실행
3. 도구 결과를 AI에게 전달하여 최종 응답 생성

### 핵심 이슈 및 해결
- **캘리(scheduler) FC 비활성화**: 일정 생성 시 Groq API에서 HTTP 400 `invalid_request_error:tool_use_failed` 반복 발생
  - 해결: 캘리 전용으로 `model.schedule='openai/gpt-oss-120b'` D1 오버라이드 (capability 기준)
  - `ai.engine=legacy` 유지, FC는 비활성화 상태로 운영 중
- **비서별 도구 권한 경계**: 기존 concierge 설정을 scheduler로 단순 치환 금지. 각 비서의 도구 사용 정책을 개별 확정해야 함.

### 보안 경계
- AI는 절대 잠금/해제 불가 (마커 자체를 만들지 않음)
- 잠긴 메모/파일은 AI 접근 계층(`ai-access.ts`)에서 원천 차단

---

## 3. Phase 2: 모델 라우팅·안전한 Fallback (완료)

### 구현 파일
- `src/services/ai.ts`: 정책 중심 모델 선택, 키 풀 라운드로빈 + 서킷브레이커, D1 `ai_usage` 원장 (KV 카운터 대신 D1 사용)
- `src/services/router.ts`: 모델 라우팅 로직

### Provider 구성
| Provider | 모델 | 용도 |
|----------|------|------|
| Gemini | 2.5-flash | 웹검색 필요 시 (무료 티어 유일 grounding 지원) |
| Gemini | 3.5-flash | 일반 대화/코드 (안정성 우선) |
| Groq | openai/gpt-oss-120b | 캘리 일정 생성용 |
| Groq | openai/gpt-oss-20b, qwen/qwen3-8b | 일반 |
| Workers AI | llama-3.2-1b, mistral-small-3.1 | 폴백 |

### 핵심 이슈
- **Gemini 지역 제한**: Cloudflare Workers의 직접 호출은 egress IP(홍콩 등) 문제로 `400 User location is not supported` → Deno Deploy 무료 릴레이로 우회 (사용자가 직접 배포, RELAY_SECRET 설정)
- **Gemini 2.5-flash 신규 키 지원 종료** (2026-10-10 확인): 신규 발급 키로 호출 시 404. 기존 운영 키는 동작 중이나 정책 재검토 필요.
- **웹검색 파이프라인**: Exa API 우선 → 2.5-flash grounding 폴백 → 3.x URL Context. 트리거는 모델 판단 `[SEARCH:]` 마커 기반.
- **Groq ZDR** (Zero Data Retention): 활성화 확인됨
- **llama-3.3-70b-versatile**: Groq가 2026-08-16 완전 종료 → 코드에서 deprecated 처리

### Fallback 규칙 (사용자 지시)
- 작성 모델 실패 시 받은 Exa URL을 그대로 재사용해 3.7→3.5 순서로 재시도
- 세 모델 모두 실패해야 2.5-flash 폴백

---

## 4. Phase 3: 프롬프트 v1·피드백·시간 검증 (2026-10-11 공식 종료)

### 구현 내용
- **프롬프트 버전 관리**: D1에 `prompt_version` 컬럼 (TEXT, 기존 32개 기록은 NULL 유지)
  - 명칭 규칙: 기존=legacy, 신규=persona-v1
  - `ai.prompt_v2`는 새 프롬프트를 켜는 기능 플래그 이름 (품질 평가와 혼동 금지)
- **AI 피드백**: `ai_feedback` 테이블 (0024 마이그레이션), 좋아요/싫어요
- **네 비서 persona-v1 전환 완료**:
  - 컨시어지 (keeper), 기록관 (librarian), 빌더 (builder), 캘리 (scheduler)

### 운영 상태
- 운영 Worker에 persona-v1 적용됨
- `ai.engine=legacy` 유지
- 캘리 FC 비활성화 유지

### 개인정보 보호 패치 (2026-10-10 운영 배포, Phase 3D 제외 최소 패치)
```typescript
// 레거시 경로 정책
- personal 이상 민감도: Gemini 차단 (Groq는 허용)
- restricted: 전 Provider 차단
- sensitivity=general 명시해도 keeper/scheduler는 personal로 유지
- 허용 Provider 없으면 403 안내
```
- **긴급 차단**: D1 `ai_settings`의 `ai.emergency_disable` 키 (값: `keeper,scheduler` 또는 `all`)

---

## 5. Phase 4B: 통합 검색 (코드 완료, 운영 배포 잔여)

### 구현 파일
- `src/services/unified-search.ts` (신규)
- `src/modules/search/routes.ts` (신규)
- API: `GET /api/search`

### 검색 대상
- 메모 (memos + memos_fts)
- AI 대화 (ai_chats)
- 일정 (schedules)
- 할 일 (todos)

### 상태
- 코드 구현 및 스테이징 배포 완료 (스테이징 Worker 4e33d8d5)
- **미완료**: 보안 검증, 사용자 격리, 실제 D1 통합 테스트, 검색 UI
- **운영 배포**: NO-GO

---

## 6. Phase 4C: 장기 기억 관리 (운영 제한적 출시 완료)

### 6-1. 데이터베이스 스키마

**0027_memory_v2.sql** - `ai_memory_v2` 테이블:
```sql
CREATE TABLE IF NOT EXISTS ai_memory_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,                    -- 최대 5000자 (CHECK 제약)
  category TEXT NOT NULL DEFAULT 'general',
  created_by TEXT NOT NULL DEFAULT 'user',  -- 'user' 또는 'assistant'
  source_type TEXT,
  source_id INTEGER,
  consent_type TEXT NOT NULL DEFAULT 'explicit',
  consent_detail TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_active INTEGER NOT NULL DEFAULT 1,     -- 1=활성, 0=보관
  deleted_at DATETIME,
  CHECK (length(content) > 0 AND length(content) <= 5000),
  CHECK (created_by IN ('user', 'assistant')),
  CHECK (is_active IN (0, 1))
);
CREATE INDEX idx_memory_v2_active ON ai_memory_v2(is_active, updated_at DESC);
```

**0028_memory_fts.sql** - FTS5 가상 테이블:
```sql
-- ai_memory_fts 가상 테이블 + 3개 트리거
-- 트리거 조건: is_active=1인 행만 인덱싱
--   memory_fts_ai: AFTER INSERT
--   memory_fts_ad: AFTER DELETE
--   memory_fts_au: AFTER UPDATE
```

**0029_memory_consent.sql** - 동의 컬럼 추가:
```sql
ALTER TABLE ai_memory_v2 ADD COLUMN allow_ai_use INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_memory_v2 ADD COLUMN allow_provider_send INTEGER NOT NULL DEFAULT 0;
-- 기본값 0 (OFF): 사용자가 명시적으로 허용해야 활성화
```

### 6-2. API 엔드포인트 (`src/modules/memory/routes.ts`)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/api/memory` | 기억 생성 (content, category, allow_ai_use, allow_provider_send) |
| GET | `/api/memory` | 목록 조회 (is_active=1만) |
| GET | `/api/memory/search?q=` | FTS 검색 |
| PUT | `/api/memory/:id` | 수정 (content, category, 동의 필드) |
| DELETE | `/api/memory/:id` | 보관 (is_active=0) |
| DELETE | `/api/memory/:id/permanent` | 영구 삭제 |

### 6-3. 중요 버그: PUT 동의 필드 누락 (2026-10-11 발견·수정)

**버그 코드** (수정 전):
```typescript
// PUT /api/memory/:id가 content와 category만 업데이트하고
// allow_ai_use, allow_provider_send를 무시했음
const updates: string[] = ['updated_at = ?'];
if (content !== undefined) {
  updates.push('content = ?');
}
if (body.category) {
  updates.push('category = ?');
}
// ❌ 동의 필드 업데이트 누락!
```

**수정 후 코드**:
```typescript
const body = await c.req.json<{
  content?: string;
  category?: string;
  allow_ai_use?: boolean;        // 추가됨
  allow_provider_send?: boolean;  // 추가됨
}>();

// 동의 필드 업데이트 (명시적으로 전달된 경우만)
if (body.allow_ai_use !== undefined) {
  updates.push('allow_ai_use = ?');
  params.push(body.allow_ai_use === true ? 1 : 0);  // false → 0 확실
}
if (body.allow_provider_send !== undefined) {
  updates.push('allow_provider_send = ?');
  params.push(body.allow_provider_send === true ? 1 : 0);
}
```

**검증** (스테이징 D1 직접 확인):
1. 두 동의 OFF로 생성 → DB 0/0 ✅
2. AI 활용 ON → DB 1/0 ✅
3. 외부 전송 ON → DB 1/1 ✅
4. 외부 전송 철회 (false) → DB 1/0 ✅
5. AI 활용 철회 (false) → DB 0/0 ✅
6. 영구 삭제 → 0건 ✅

**회귀 테스트**: 6개 추가 → 전체 592/592 통과

### 6-4. 네 비서 기억 연동 (`src/services/memory-service.ts`)

**`getRelevantMemories(env, query, limit=5)` 함수**:
```typescript
// 1. 기능 플래그 확인 (기본 OFF)
const flag = await env.DB.prepare(
  "SELECT value FROM ai_settings WHERE key = 'memory.v2_enabled'"
).first();
if (!flag || flag.value !== 'true') {
  return [];  // 플래그 없으면 빈 배열
}

// 2. FTS 검색 (동의 필터 포함)
const { results } = await env.DB.prepare(`
  SELECT m.id, m.content, m.category
  FROM ai_memory_fts fts
  JOIN ai_memory_v2 m ON m.id = fts.rowid
  WHERE ai_memory_fts MATCH ?
    AND m.is_active = 1
    AND m.allow_ai_use = 1         -- AI 활용 동의
    AND m.allow_provider_send = 1   -- 외부 전송 동의
  ORDER BY m.updated_at DESC
  LIMIT ?
`).bind(searchTerms, maxLimit).all();

// 3. 각 기억을 200자로 제한 (Prompt Injection 방어)
return results.map(r => ({ ...r, content: r.content.slice(0, 200) }));
```

**채팅 라우트 연동** (`src/modules/ai/routes.ts`):
```typescript
// Phase 4C-3: v2 장기 기억 (기본 OFF, 관련 기억만)
let v2MemoryContext = '';
try {
  const userQuery = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const relevant = await getRelevantMemories(env, userQuery, 5);
  if (relevant.length > 0) {
    v2MemoryContext = formatMemoryContext(relevant);
  }
} catch { /* 기억 조회 실패는 무시 */ }

// 최종 메시지: systemPrompt + memoryContext + v2MemoryContext
```

### 6-5. Legacy 기억 기본 OFF 변경

**변경 전** (`src/modules/ai/routes.ts`):
```typescript
// 플래그가 없으면 Legacy 기억 활성화 (기본 ON)
const legacyFlag = await env.DB.prepare(
  "SELECT value FROM ai_settings WHERE key = 'memory.legacy_enabled'"
).first();
if (!legacyFlag || legacyFlag.value !== 'false') {
  // Legacy 기억 주입 (기본 동작)
}
```

**변경 후**:
```typescript
// memory.legacy_enabled='true'일 때만 주입 (기본 OFF)
if (legacyFlag && legacyFlag.value === 'true') {
  // Legacy 기억 주입
}
// 플래그 없음/조회 실패/다른 값 → 주입 안 함
```

**중요**: 운영 Worker에 이 코드가 배포되기 전에는 기본 ON이었음. 롤백 시 개인정보 정책 후퇴 가능.

### 6-6. 운영 배포 (2026-10-11)

| 항목 | 값 |
|------|-----|
| 운영 Worker | `7050052b` (이전: `8fac7d0c`) |
| Git SHA | `614556a1b9a1abdfc92a55a65c181032e7717e6a` |
| D1 마이그레이션 | 0027→0028→0029 순차 적용 성공 |
| 기존 데이터 | memos 26건, schedules 11건, todos 5건 모두 보존 |

**제한적 출시 정책**:
- `memory.v2_enabled`: 미설정 → OFF (기본값)
- `memory.legacy_enabled`: 미설정 → OFF (기본값)
- 즉, 사용자는 기억을 저장·관리할 수 있으나 AI 자동 주입은 안 됨

**UI 확인**: 운영 `memory.html`에서 `allowAiUse` 체크박스 2개 확인됨 (HTTP 직접 확인)

---

## 7. Phase 4D: 백업·복원 (기술 구현 완료)

### 7-1. FTS5 Export 제약 발견

**실험**:
```bash
$ wrangler d1 export myhub-db-staging --remote
# 오류: D1 Export error: cannot export databases with virtual tables (like FTS5)
```

**결론**: Cloudflare 공식 제약. FTS5 가상 테이블이 있으면 전체 export 불가.

**대안**: 테이블별 SELECT → JSON 백업 (FTS 테이블 제외, 복원 시 재생성)

### 7-2. 백업 대상 테이블 (14개, 화이트리스트)

```
memos, memo_tags, schedules, todos, files, reminders,
ai_conversations, ai_chats, ai_feedback, ai_usage, ai_memo_audit,
ai_memory, ai_memory_v2, ai_settings
```

**제외**:
- `otp_codes`: 일회용 인증코드 (백업 불필요)
- `push_subscriptions`: endpoint·키 포함 (별도 보안 검토 필요)
- FTS 테이블 (`memos_fts*`, `ai_memory_fts*`): 복원 시 재생성
- KV, Secrets: 별도 관리

**중요 발견**: `ai_chats` 테이블이 `ai_conversations(id)`를 외래키로 참조하는데, 초기 백업 목록에 `ai_conversations`가 누락됨 → 추가 후 해결. `ai_conversations`에 35행 존재했음.

### 7-3. 암호화 백업

**구현** (`scripts/backup_encrypted.py`):
- 방식: AES-256-GCM
- 키: 환경변수 `MYHUB_BACKUP_KEY` (32바이트, base64)
- 키 Git 저장 금지
- 잘못된 키/변조된 파일은 복호화 거부 (InvalidTag)

**검증**:
- 스테이징: 561행 → 197KB 암호화 파일 → 무결성 통과
- 운영: 638행 → 212KB 암호화 파일 → 무결성 통과

### 7-4. 복원

**구현** (`scripts/restore_d1.py`):
- 암호화 파일 복호화 → 무결성 확인 → 스키마 생성 → 데이터 삽입
- **중요**: `INSERT OR REPLACE` 사용 금지 (ON DELETE CASCADE로 자식 데이터 손실 위험)
- 일반 `INSERT` 사용, 중복 시 오류 처리

**검증** (격리 D1):
- 561행 전체 복원 성공
- 외래키 위반 0건 (`PRAGMA foreign_key_check`)
- 고아 `ai_chats` 0건
- FTS 재생성 성공 (`integrity-check` 통과)

### 7-5. 일관성 백업 (db.batch())

**문제**: REST API 순차 SELECT는 트랜잭션 일관성 보장 불가

**해결**: Worker `db.batch()`로 14개 테이블을 단일 트랜잭션에서 읽기

**구현** (`src/modules/backup/routes.ts`):
```typescript
// POST /api/backup/consistent (인증 필요)
// 프로덕션에서는 ENVIRONMENT 체크로 403 차단
app.post('/api/backup/consistent', async (c) => {
  if (env.ENVIRONMENT === 'production') {
    return c.json({ error: '프로덕션에서는 사용 불가' }, 403);
  }
  const userEmail = (c as any).get('userEmail');
  if (!userEmail) return c.json({ error: '인증 필요' }, 401);

  // 14개 테이블을 하나의 batch 트랜잭션으로 읽기
  const statements = BACKUP_TABLES.map(table =>
    env.DB.prepare(`SELECT * FROM ${table}`)
  );
  const results = await env.DB.batch(statements);
  // ...
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
  return c.json(backup);
});
```

**실증** (격리 테스트 Worker):
- 14개 테이블, 561행, 296ms에 조회 성공
- 모든 테이블 성공

### 7-6. 삭제 기억 재등장 방지

**문제**: 오래된 백업을 복원하면 영구 삭제된 기억이 되살아남

**정책**:
- 삭제 이력을 별도 저장소에 기록 (ID + 삭제 시각만, 본문 제외)
- 복원 후 삭제 이력을 적용하여 해당 기억 제거
- 삭제 이력 보존 기간 >= 가장 오래된 백업 보존 기간

### 7-7. 최초 운영 백업 (2026-10-11 실행)

| 항목 | 값 |
|------|-----|
| 시각 | 2026-10-11T07:53:03Z |
| 행 수 | 638행 (memos 26, ai_chats 42, ai_usage 532 등) |
| 크기 | 212,236 bytes (암호화됨) |
| 권한 | 600 |
| 복원 검증 | 격리 D1에 638행 전체 복원 성공, 외래키 0건 |

**운영 변경 없음** (읽기 전용 백업)

---

## 8. Phase 5: Cron 아침 브리핑 (미착수, 다음 단계)

### 로드맵 기준 계획
- Cloudflare Cron Triggers를 사용한 아침 브리핑
- 전날 일정·할 일·메모 요약
- AI 비서가 자연어로 브리핑 생성

### 구현 시 고려사항
1. **Phase 4D 안정화 후 착수**: 백업이 안정적으로 동작해야 함
2. **개인정보 정책**: 브리핑에 포함될 정보 범위 결정 필요
   - 잠금 메모는 브리핑에서 제외해야 하는가?
   - 브리핑 생성 시 AI에게 전달되는 데이터 범위
3. **Push 알림 연계** (Phase 6): 브리핑을 푸시로 전송할지 여부
4. **Cron 스케줄**: 사용자 시간대(Asia/Seoul) 기준 아침 시간
5. **실패 처리**: 브리핑 생성 실패 시 재시도 정책

### 선행 조건
- [ ] Phase 4D 운영 백업 자동화 여부 결정 (현재 수동만)
- [ ] 브리핑에 포함할 데이터 범위 정책 확정
- [ ] AI 모델 선택 (비용 vs 품질)

---

## 9. Phase 6: Web Push·PWA (미착수)

### 로드맵 기준 계획
- Web Push 알림 (일정 리마인더 등)
- PWA 설치 지원

### 현재 상태
- iOS PWA 흰색 테마 통일됨 (2026-10-09)
- `push_subscriptions` 테이블 존재 (백업 제외 중, 보안 검토 필요)

---

## 10. 검토 요청 사항

당신은 코드를 직접 읽을 수 없으므로, 위 상세 내용을 바탕으로 다음을 검토해주세요:

### 1. 아키텍처 검토
- Phase 1~4의 전체 설계에 구조적 문제가 있는가?
- 모듈 분리 (`src/modules/<모듈>/routes.ts`) 방식이 적절한가?
- Hono + D1 + Workers 조합에서 놓친 점이 있는가?

### 2. 개인정보 보호 검토
- **PUT 동의 버그**와 같은 결함이 다른 API에도 있을 가능성은?
  - 힌트: `PUT /api/memory/:id`는 수정됐으나, 다른 PUT/POST 엔드포인트도 점검 필요
- 동의 기반 필터 (`allow_ai_use=1 AND allow_provider_send=1`)가 충분한가?
- Legacy 기억 기본 OFF 전환이 완전한가? (롤백 시나리오 포함)
- FTS 트리거가 `is_active=1`만 인덱싱하는 것이 확실한가?
- 최종 Provider payload에 동의 없는 기억이 포함될 가능성은?
  - 현재 `getRelevantMemories()`에서 필터링되나, Fallback 시 재검사 없음

### 3. 백업·복원 검토
- AES-256-GCM + `db.batch()` 방식에 빠진 점이 있는가?
- 14개 테이블 목록에 누락된 사용자 데이터가 있는가?
  - 힌트: `ai_tool_runs`, `ai_tool_operations`는 운영에 없음 (스테이징 전용)
  - `files` 테이블은 메타데이터만 (실제 파일은 Cloudinary 외부)
- 삭제 이력 정책 (ID+시각만 보관)이 충분한가?
- 백업 일관성이 REST API 방식에서는 보장되지 않는데, 운영 수동 백업에 acceptable한가?

### 4. Phase 5 준비 검토
- 아침 브리핑을 구현하기 전에 선행되어야 할 작업은?
- 브리핑 생성 시 AI에 전달되는 데이터의 개인정보 범위는?
- Cron 실패 시 사용자 영향은?

### 5. 운영 위험 검토
현재 운영 상태:
- Worker: `7050052b`
- D1: 0029까지 적용 (0026 FTS 개인정보, 0027 v2, 0028 FTS, 0029 동의)
- v2/Legacy 자동 주입: OFF
- 테스트: 592/592 통과

주의할 점이 있는가?

### 6. 누락 기능 검토
- 로드맵에 없지만 필요한 기능이나 검증이 있는가?
- Phase 4B 통합 검색의 운영 배포 전 필요한 보안 검증은?
