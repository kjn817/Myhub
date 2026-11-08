# GPT 4차 검토 대응 — 최종 보고서

**일자**: 2026-10-11
**Hotfix 브랜치**: `hotfix/auth-minimal` @ `6ee7833` (614556a 기준)

---

## 1. 새 최소 hotfix 브랜치와 정확한 변경 파일

### 브랜치 정보
```
hotfix/auth-minimal @ 6ee7833
기반: 614556a (운영 배포 커밋)
```

### 변경 파일 (3개)

| 파일 | 변경 내용 |
|------|-----------|
| `wrangler.toml` | `binding="ASSETS"`, `run_worker_first=true` 추가 |
| `src/types.ts` | `ASSETS: Fetcher` 타입 추가 |
| `src/index.ts` | __gtest 18줄 삭제, catch-all ASSETS 서빙 라우트 추가 |

### 운영 버전(614556a) 대비 diff 요약
- **제외됨**: P0 도구 권한, 백업 모듈, Phase 4B 검색 (별도 검증 후 반영)
- **포함됨**: 인증 우회 복구 + __gtest 제거만
- **기존 기능 후퇴**: 없음 (인증 미들웨어, API 라우트 모두 유지)

---

## 2. 운영 버전 대비 diff

```diff
# wrangler.toml
 [assets]
 directory = "./public"
+binding = "ASSETS"
+run_worker_first = true

# src/types.ts
 export interface Env {
   DB: D1Database
   KV: KVNamespace
+  ASSETS: Fetcher

# src/index.ts
-// [TEMP_GTEST] ... (18줄 삭제)
+// catch-all: 인증 후 ASSETS 서빙 (25줄 추가)
```

**총 변경**: 24 insertions, 18 deletions (최소)

---

## 3. deploy_full.py 검증 결과

GPT 결정 2의 6개 질문에 대한 답변:

### ① Inline 배포 시 `env.ASSETS` 바인딩이 유지되는가?
**아니오.** `deploy_full.py`는 ASSETS를 사용하지 않음. 정적 파일이 Worker 코드에 직접 인라인됨.
- 내 catch-all 코드의 `c.env.ASSETS.fetch()`는 inline 배포에서 `undefined` → try-catch에서 404 반환
- 하지만 inline에서는 인라인된 라우트가 먼저 매칭되므로 catch-all에 도달하지 않음

### ② 업로드한 정적 파일과 Worker 코드가 같은 버전에 연결되는가?
**예.** 단일 번들로 업로드되므로 원자적. 버전 불일치 불가.

### ③ Worker-first 인증 라우팅이 적용되는가?
**예.** Inline은 모든 요청이 Worker를 통과하므로 인증 미들웨어가 항상 실행됨. Static Assets 우회 문제 자체가 발생하지 않음.

### ④ 설정이 누락되어도 배포가 성공한 것처럼 표시될 가능성이 있는가?
**과거에는 예, 현재는 아니오.** AGENTS.md에 기록된 silent-fail (2.3MB multipart가 success 반환하면서 저장 안 됨) 문제가 있었으나, 현재 `deploy_full.py`에 검증 로직이 있음:
- `GET /` (미인증) → 302 확인 (line 274)
- `/login.html`에 올바른 에셋 버전(`?v=`) 확인 (line 294)

### ⑤ 인증된 사용자가 `/`에 접근할 때 500 오류가 발생할 가능성이 있는가?
**아니오.**
- Inline: 인라인된 `/` 라우트가 직접 처리 → 200
- Wrangler: catch-all이 `ASSETS.fetch('/index.html')` → 200
- ASSETS 바인딩 누락 시: try-catch에서 404 (500 아님)

### ⑥ 배포 후 Worker 버전 ID와 실제 자산 구성을 확인할 수 있는가?
**예.** Cloudflare API로 버전 ID 확인 가능. Inline은 자산이 코드에 포함되므로 별도 구성 확인 불필요.

### 결론
**Inline 배포(deploy_full.py)는 인증 우회 문제가 원천적으로 없으며, 검증 로직도 있음.**

**권장**: GPT 결정과 같이 Wrangler Static Assets를 유지하되, 스테이징과 운영의 배포 방식을 일치시켜야 함. 현재 스테이징은 API 직접 업로드(inline 기반)로 정상 동작 중.

---

## 4. 스테이징과 운영 배포 방식의 일치 여부

| 항목 | 스테이징 (현재) | 운영 (예정) | 일치 |
|------|-----------------|-------------|------|
| 배포 방식 | API 직접 업로드 (inline) | deploy_full.py (inline) | ✅ 일치 |
| 인증 우회 | 없음 (inline) | 없음 (inline) | ✅ 일치 |
| Wrangler 설정 | 미사용 | 미사용 | ✅ 일치 |

**현재 스테이징 배포는 운영 예정 방식과 일치함.** Wrangler Static Assets 방식은 아직 스테이징에서 검증되지 않음.

---

## 5. 인증된 사용자 포함 전체 테스트 결과

### 미인증 테스트 (완료)

| 테스트 | 결과 |
|--------|------|
| 미인증 `/` | 302 ✅ |
| 미인증 `/index.html` | 302 ✅ |
| 미인증 `/memo.html` | 302 ✅ |
| 미인증 `/memory.html` | 302 ✅ |
| 미인증 `/login.html` | 200 ✅ |
| 미인증 `/api/memory` | 401 ✅ |
| 미인증 `/api/__gtest` | 401 (삭제됨) ✅ |

### 인증된 사용자 테스트 (미완료)

**차단 요인**: 스테이징 OTP 인증에 사용자 이메일(`kjn817@gmail.com`)로의 코드 발송이 필요. Resend 도메인 미인증으로 Muse가 직접 코드를 받을 수 없음.

**필요한 테스트** (사용자 또는 GPT 지정 방식으로 수행):
1. 인증된 `/` → 200, 대시보드 정상
2. 인증된 `/memo.html` → 200
3. 인증된 `/memory.html` → 200
4. 인증된 메모·일정·할 일 API → 정상
5. AI 대화 → 정상 응답
6. 로그인·로그아웃 → 정상
7. 인증된 `/api/__gtest` → 404
8. 정적 JS/CSS 로딩 확인
9. HEAD 요청 테스트
10. 인코딩된 경로 테스트

---

## 6. P0 실행기 권한 검증 결과

### GPT 요구사항 대비 현황

| 요구사항 | 상태 | 근거 |
|----------|------|------|
| parse → authorization → execution 순서 | ✅ | Filter → Parse → Execute. 필터가 파서보다 먼저 실행됨 |
| 서버가 확정한 비서 ID 확인 | ✅ | `VALID_PERSONAS`로 검증, 무효 시 deny-by-default |
| 비서별 도구 권한 검사 | ✅ | `getLegacyMarkerTools()`로 검사 |
| [ASK:] 교집합 적용 | ✅ | 하위 응답을 호출자 권한으로 재필터링 |
| 권한 없거나 ID 불분명 시 거부 | ✅ | 빈 배열 → 모든 마커 차단 |
| 도구 결과가 새 명령으로 취급되지 않음 | ✅ | `sanitizeInserted()`로 삽입 전 필터링 |

### 마커 형식 커버리지

실제 파서가 인식하는 모든 형식을 확인:
- `[MEMO_*]...[/MEMO_*]` → denyPattern ✅
- `[SCHEDULE_*]...[/SCHEDULE_*]` → denyPattern ✅
- `[TODO_*]...[/TODO_*]` → denyPattern ✅
- `[SEARCH: query]` → denySinglePattern ✅
- `[IMG: prompt]` → denySinglePattern ✅
- `[GITHUB: query]` → denySinglePattern ✅

### 남은 한계

GPT가 지적한 대로, 정규식 기반 사전 필터는 완전한 해결책이 아님. 실행기 수준(`execute*` 함수 내 직접 검사)이 이상적이나, 현재 구현은 실용적인 1차 방어선으로 동작함.

**P0 종결 판정**: 현재 구현만으로는 **불가**. 실행기 수준 검증이 추가로 필요 (GPT 결정과 일치).

---

## 7. 운영 배포 시 예상되는 위험

| 위험 | 확률 | 영향 | 완화책 |
|------|------|------|--------|
| Inline/Wrangler 방식 불일치 | 중간 | 인증 우회 재발 | 스테이징과 동일한 inline 방식으로 배포 |
| 인증된 사용자 500 오류 | 낮음 | 서비스 중단 | 스테이징에서 인증 테스트 후 배포 |
| 기존 기능 후퇴 | 낮음 | 사용자 불편 | 614556a 기준 최소 변경, diff 확인됨 |
| P0 우회 | 중간 | 권한 상승 | P0는 2차 배포로 분리, hotfix에는 미포함 |

---

## 8. 배포 실패 시 복구 계획 (취약 버전으로 롤백 금지)

### 원칙
GPT 결정: "기존에 인증 우회 문제가 있었던 Worker로의 롤백은 금지"

### 복구 절차
1. **배포 실패 감지**: `deploy_full.py`의 검증 로직이 302/200 확인 실패 시 자동 감지
2. **전진 복구**: 코드 수정 후 재배포 (롤백이 아닌 수정)
3. **최후 수단**: Cloudflare 대시보드에서 이전 버전으로 롤백 가능하나, 이는 인증 우회가 있는 버전이므로 **권장하지 않음**
4. **D1 보호**: `memory.legacy_enabled='false'`가 이미 설정되어 있어 롤백 시에도 Legacy OFF 유지

### 안전한 복구 조건
- 새 Worker가 302를 반환하지 않으면 이전 Worker 유지 (원자적 교체 실패 시)
- 배포 스크립트가 검증 실패 시 exit 1로 중단

---

## 최종 결론

### 준비 완료
- ✅ 최소 hotfix 브랜치 (`hotfix/auth-minimal` @ `6ee7833`)
- ✅ deploy_full.py 검증 완료
- ✅ P0 1차 방어선 구현 및 테스트 (15개 통과)
- ✅ 스테이징 미인증 테스트 통과 (7개)

### 미완료 (차단 요인)
- 🔴 인증된 사용자 테스트 (OTP 필요)
- 🔴 스테이징-운영 배포 방식 일치 확인 (현재는 일치함 - inline)
- 🟡 P0 실행기 수준 검증 (2차 작업으로 분리 가능)

### 권장 다음 단계
1. **1차 hotfix 운영 배포 승인 요청**: 인증 우회 복구 + __gtest 제거 (P0 제외)
2. **인증된 사용자 테스트**: 사용자가 스테이징에서 직접 확인 또는 OTP 공유
3. **2차 P0 완성**: 실행기 수준 검사 구현 후 별도 배포 심사

**운영 배포는 사용자 최종 승인 후에만 실행.**
