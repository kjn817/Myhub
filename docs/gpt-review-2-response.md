# GPT 2차 검토 대응 보고서

**일자**: 2026-10-11
**Git 커밋**: `b44770f` (release/phase3d-echo-fix, 로컬)
**이전 커밋**: `75ce728`

---

## 1. wrangler.staging.toml 검사 및 수정 결과

### 발견된 누락
`wrangler.staging.toml`의 `[assets]` 섹션에 다음이 빠져 있었음:
- `binding = "ASSETS"` ❌
- `run_worker_first = true` ❌

### 수정 완료
```toml
[assets]
directory = "./public"
binding = "ASSETS"
run_worker_first = true
```

### 스테이징 설정 검증

| 항목 | 값 | 상태 |
|------|-----|------|
| Worker 이름 | myhub-staging | ✅ 운영과 다름 |
| D1 | myhub-db-staging (995184a9...) | ✅ 운영(0dd871c5...)과 분리 |
| KV | 45e164df... | ✅ 운영(83d3e902...)과 분리 |
| ENVIRONMENT | staging | ✅ |
| assets.directory | ./public | ✅ |
| assets.binding | ASSETS | ✅ (수정됨) |
| assets.run_worker_first | true | ✅ (수정됨) |

**배포 대상이 운영 Worker가 아님을 확인**: `name = "myhub-staging"`으로 명시됨.

---

## 2. P0 권한 게이트 추가 보안 검증 결과

### GPT 지적사항 반영

**문제**: `getLegacyMarkerTools(originalPersonaId || 'concierge')`에서 personaId가 없을 때 최고 권한 기본 적용.

**수정**:
```typescript
const VALID_PERSONAS = ['concierge', 'keeper', 'builder', 'scheduler']
const effectivePersonaId = (originalPersonaId && VALID_PERSONAS.includes(originalPersonaId))
  ? originalPersonaId
  : null
const allowedTools = effectivePersonaId ? getLegacyMarkerTools(effectivePersonaId) : []
```

이제 personaId가 없거나 유효하지 않으면 **빈 배열** (deny-by-default).

### 마커 형식 커버리지 검증

실제 파서가 인식하는 형식을 조사한 결과:

| 형식 | 예시 | 처리 |
|------|------|------|
| Paired | `[MEMO_DELETE]...[/MEMO_DELETE]` | ✅ denyPattern |
| Single | `[SEARCH: query]` | ✅ denySinglePattern (추가됨) |
| Single | `[IMG: prompt]` | ✅ denySinglePattern (추가됨) |
| Single | `[GITHUB: query]` | ✅ denySinglePattern (추가됨) |
| `[ASK:]` | `[ASK:keeper]...[/ASK]` | ✅ 별도 처리 + 하위 응답 재필터링 |

### 테스트 결과 (15/15 통과)

| 테스트 | 결과 |
|--------|------|
| keeper + SCHEDULE_DELETE 차단 | ✅ |
| keeper + MEMO_SEARCH 허용 | ✅ |
| builder + MEMO_DELETE 차단 | ✅ |
| builder + SEARCH 허용 | ✅ |
| scheduler + SCHEDULE_CREATE 허용 | ✅ |
| scheduler + MEMO_DELETE 차단 | ✅ |
| concierge + 모든 도구 허용 | ✅ |
| 혼합 마커 부분 차단 | ✅ |
| **personaId 없음 → 전체 차단** | ✅ (신규) |
| **personaId null → 전체 차단** | ✅ (신규) |
| **무효한 personaId → 전체 차단** | ✅ (신규) |
| **keeper + [SEARCH: query] 허용** | ✅ (신규) |
| **keeper + [IMG:] 차단** | ✅ (신규) |
| **builder + [GITHUB:] 허용** | ✅ (신규) |
| **scheduler + [SEARCH:] 허용** | ✅ (신규) |

### 남은 한계 (정직한 보고)

GPT가 지적한 대로, **정규식 필터는 완전한 해결책이 아님**. 더 robust한 방법은 실제 파싱된 도구 호출에 대해 권한을 검사하는 것.

현재 구조의 한계:
1. 새로운 마커 형식이 추가되면 정규식도 업데이트해야 함
2. 파서와 필터의 정규식이 달라지면 우회 가능
3. 중첩된 마커의 엣지 케이스

**권장 후속 작업** (이번 긴급 수정 범위 밖):
- 각 `execute*` 함수 시작 부분에 persona 권한 검사를 직접 추가
- 또는 `processToolMarkers`를 파서 기반으로 리팩토링

현재 수정은 **실용적인 1차 방어선**으로 동작하며, 15개 테스트로 검증됨.

---

## 3. 정적 파일 인증 경로 검증 결과

### 라우트 순서 확인

```
Line 12: /api/health (공개, 미들웨어 전)
Line 15: /api/auth (공개, 미들웨어 전)
Line 20: 인증 미들웨어 (app.use)
Line 48: /api/system (보호)
Line 166: /api/modules (보호)
Line 172: /api/<모듈> (보호)
Line 176: /api/push (보호)
Line 182: /* catch-all (보호, 마지막)
```

✅ 인증 미들웨어가 catch-all보다 먼저 실행됨.

### 엣지 케이스 검증

| 항목 | 결과 |
|------|------|
| 존재하지 않는 API (`/api/nonexistent`) | ASSETS에서 404 반환 (HTML 대체 없음) ✅ |
| `/` → `/index.html` 매핑 | catch-all에서 처리 ✅ |
| 로그인 페이지 리소스 | `/manifest.json`만 필요 (허용됨), lucide는 외부 CDN ✅ |
| `public/` 내 비밀 파일 | 없음 (grep 확인) ✅ |
| HTML Cache-Control | `no-store, no-cache, must-revalidate` 적용 ✅ |

### 미검증 항목 (스테이징 실측 필요)

- `HEAD` 요청 우회
- URL 인코딩 우회 (`/%2e%2e/`, 이중 인코딩 등)
- `Sec-Fetch-Mode: navigate` 헤더 동작

---

## 4. 새 Git 커밋과 원격 반영 여부

### 로컬 커밋
```
b44770f GPT 2차 검토 반영: 스테이징 설정 + P0 deny-by-default + 단일 마커 차단
75ce728 긴급 보안 수정: run_worker_first 인증 우회 복구 + P0 도구 권한 + __gtest 제거
```

### 원격 반영
**미반영**. 이유: 이 실행 환경에 GitHub 인증 정보가 없음.
```
fatal: could not read Username for 'https://github.com': No such device or address
```

사용자가 로컬에서 `git push origin release/phase3d-echo-fix` 실행 필요.

---

## 5. 사용자가 실행해야 하는 정확한 배포 명령

### 전제 조건
1. MyHub 프로젝트 디렉토리에서 실행
2. `git pull` 또는 위 커밋(`b44770f`)이 로컬에 있어야 함
3. `wrangler.staging.toml`에 수정사항 포함 확인

### 단계

**1단계 — Cloudflare 로그인 상태 확인**
```bash
npx wrangler whoami
```

**2단계 — 로그인되지 않은 경우에만 실행**
```bash
npx wrangler login
```
브라우저가 열리면 Cloudflare 계정으로 승인.

**3단계 — 스테이징 배포**
```bash
cd ~/workspace/myhub  # 또는 MyHub 프로젝트 경로
npx wrangler deploy --config wrangler.staging.toml
```

### 주의사항
- 반드시 `--config wrangler.staging.toml` 지정 (기본 `wrangler.toml`은 운영용)
- 배포 후 출력된 Version ID 기록

---

## 6. 스테이징 배포 후 실행할 테스트

### 자동 테스트 (사용자가 실행)
```bash
# 미인증 접근 테스트
curl -s -o /dev/null -w "GET /: %{http_code}\n" https://myhub-staging.myhub-app.workers.dev/
curl -s -o /dev/null -w "GET /index.html: %{http_code}\n" https://myhub-staging.myhub-app.workers.dev/index.html
curl -s -o /dev/null -w "GET /memo.html: %{http_code}\n" https://myhub-staging.myhub-app.workers.dev/memo.html
curl -s -o /dev/null -w "GET /memory.html: %{http_code}\n" https://myhub-staging.myhub-app.workers.dev/memory.html
curl -s -o /dev/null -w "GET /login.html: %{http_code}\n" https://myhub-staging.myhub-app.workers.dev/login.html
curl -s -o /dev/null -w "GET /api/memory: %{http_code}\n" https://myhub-staging.myhub-app.workers.dev/api/memory
curl -s -o /dev/null -w "GET /api/__gtest: %{http_code}\n" "https://myhub-staging.myhub-app.workers.dev/api/__gtest?t=test"
```

### 기대 결과

| 테스트 | 기대 |
|--------|------|
| 미인증 `GET /` | 302 → /login.html |
| 미인증 `GET /index.html` | 302 → /login.html |
| 미인증 `GET /memo.html` | 302 → /login.html |
| 미인증 `GET /memory.html` | 302 → /login.html |
| 미인증 `GET /login.html` | 200 |
| 미인증 `GET /api/memory` | 401 |
| 미인증 `GET /api/__gtest` | 404 |

### 인증 후 테스트 (브라우저)
1. 스테이징 로그인 (OTP)
2. `/` → 200, 대시보드 정상 표시
3. `/memo.html` → 200, 메모 목록 표시
4. AI 채팅에서 keeper로 스케줄 삭제 마커 테스트 → 차단 메시지 확인

---

## 7. 운영 배포 전에 남아 있는 차단 요인

| # | 차단 요인 | 상태 | 해소 방법 |
|---|-----------|------|-----------|
| 1 | 스테이징 배포 미완료 | 🔴 차단 | 사용자가 위 5번 명령 실행 |
| 2 | 스테이징 인증 회귀 실측 미완료 | 🔴 차단 | 배포 후 위 6번 테스트 실행 |
| 3 | 원격 GitHub 미반영 | 🟡 주의 | 사용자가 `git push` 실행 |
| 4 | 정규식 필터의 구조적 한계 | 🟡 인지 | 후속 작업으로 execute* 레벨 검사 검토 |
| 5 | URL 인코딩 우회 미검증 | 🟡 인지 | 스테이징에서 추가 테스트 |

### 운영 배포 승인 조건
- [ ] 스테이징 배포 완료
- [ ] 7개 미인증 테스트 모두 기대 결과와 일치
- [ ] 인증 후 정상 동작 확인
- [ ] P0 차단 동작 실측 확인

**운영 배포는 아직 승인되지 않음** (사용자 결정 유지).

---

## 부록: 기존 추적 항목 상태

| 항목 | 상태 |
|------|------|
| 사용자 입력 마커 무력화 | P0 필터로 1차 방어 (입력 단계 이스케이프는 미구현) |
| 저장된 도구 결과 재귀 파싱 | P0 필터가 파싱 전 마커를 제거하므로 완화됨 |
| __gtest 제거 | 완료 (코드 삭제, Git 히스토리는 잔존) |
| Legacy 방어 설정 | 완료 (운영 D1에 `false` 설정) |

---

**다음 단계**: 사용자가 스테이징 배포 → 결과 보고 → GPT 3차 검토 → 운영 배포 결정
