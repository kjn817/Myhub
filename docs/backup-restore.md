# MyHub 백업·복원 절차 (P0: 독립 암호화 백업 + 격리 복원 검증)

최종 검증: 2026-10-29 20:25~20:40 KST — 운영 백업 1회 생성 + 격리 복원 전 항목 PASS.
최신 드릴: 2026-10-30 — auth_pins 백업 제외 배포(라이브 b8c954d4 @100%) 후 엔드포인트 백업 재실행 + 격리 복원 전 항목 PASS (§7 추가 기록 참조).
이 문서는 절차·범위 결정·검증 결과의 정본이다.

## 1. 현행 감사 결과 (2026-10-29 실측)

### 백업 엔드포인트 (`src/modules/backup/routes.ts`)
- `POST /api/backup/encrypted` — AES-256-GCM 암호화 백업. 키 파생: **PBKDF2-SHA256, 100,000회, salt 16바이트, iv 12바이트**, 비밀번호 최소 8자, 산출물 `format_version 1` (salt/iv/ciphertext base64 + 메타데이터만, 평문 미포함).
- `POST /api/backup/` — 평문 백업 (하위호환용).
- **결함 (수정 전)**: 두 엔드포인트 모두 `ENVIRONMENT !== 'staging'`이면 403. 운영은 `ENVIRONMENT=production`이라 **운영에서는 백업이 원천 불가능**했다. 2026-10-29 라이브 실증: 인증 세션으로 운영에 암호화 백업 요청 → `403 {"error":"백업 API는 스테이징에서만 사용할 수 있습니다"}`. `public/backup.html` UI는 운영에 존재하지만 항상 실패하는 상태였다.
- **결함 (수정 전)**: 백업 범위가 14개 테이블뿐인데 실제 테이블은 52개. 메모·일정 등 핵심은 포함되지만 memory_pages·artifacts·user_cron_jobs·google_integrations 등이 빠져 있었다.
- **복원 경로 부재**: 가져오기/복원 엔드포인트가 코드에 없다. 복원은 이 문서의 스크립트 절차가 유일한 경로다.

### 기존 통합 테스트 2개 — 무엇을 검증하는가
| 테스트 | 실행 결과 | 실제 검증 범위 |
|---|---|---|
| `tests/integration/test_backup_restore.py` | PASS 6/6 (단, `cryptography` 패키지가 없으면 import 단계에서 즉시 실패 — 이 VM에서는 pip 설치 후 통과) | **로컬 합성 데이터만.** Worker 형식 시뮬레이션으로 만든 가짜 백업의 복호화·잘못된 암호 거부·변조 탐지, 로컬 sqlite FTS5 rebuild. 라이브/실데이터/실복원과 무관 |
| `tests/integration/test_backup_14tables.py` | PASS 18/18 | **로컬 합성 데이터만.** 간소화한 가짜 스키마 14개에 각 1~4행을 넣고 sqlite 파일 간 복사 후 비교. 실제 마이그레이션 스키마·실데이터와 무관 |

즉 기존 테스트는 암호 프리미티브와 복사 로직의 단위 성질만 증명했고, **운영 데이터의 종단 간 백업·복원은 이번 P0 작업 전까지 검증된 적이 없었다.**

### 그 밖의 감사 발견
- `scripts/backup_d1.py`, `backup_d1_simple.py`, `backup_encrypted.py`, `restore_d1.py` (Phase 4D 프로토타입): 14개 테이블 기준, 암호화는 비밀번호가 아닌 환경변수 키 방식, 경로는 구 Cloudflare 헬퍼에 의존. 이번에 `backup_production.py` / `restore_local.py`로 대체한다 (포맷은 Worker 엔드포인트와 동일).
- **메모 본문 암호화 미적용 (보안 후속 과제)**: 운영 memos 전체에서 `ENC:` 암호문 형태는 **0건**. 잠긴 메모 4건도 암호문이 아니라 평문 + `is_locked` 플래그로 저장돼 있다 (내용은 열지 않고 길이·공백 패턴으로 판정). 잠금 토글 코드는 암호화 실패 시 플래그만 설정하는 폴백이 있다. 현재 잠금의 실효성은 저장 암호화가 아니라 **접근 계층 차단**(AI·검색 제외)에 있다. 백업은 저장된 바이트를 그대로 보존하므로 백업 자체의 결함은 아니지만, "잠긴 메모는 암호화되어 있다"고 주장할 수 없는 상태다.
- **스키마 드리프트**: `ai_chats.prompt_version` — 마이그레이션 0025는 `TEXT NOT NULL DEFAULT 'legacy'`, 운영 실제 스키마는 `TEXT DEFAULT NULL`(nullable). 운영 행 336건이 NULL이다. 복원 시 대상 기본값으로 치환해야 하며, 복원 스크립트가 치환 횟수를 리포트에 기록한다.

## 2. 백업 범위 결정

원칙: **사용자 콘텐츠와 복원에 필요한 상태는 전부, 휘발성·로그·실행 중 상태는 제외.** 마이그레이션 테이블 52개 전부를 분류했고, 분류는 `tests/unit/backup-scope.test.ts`가 강제한다 (새 테이블을 분류 없이 추가하면 테스트 실패).

### 포함 31개
- 핵심 데이터: memos, memo_tags, schedules, todos, files(메타데이터 + 암호화 백업 v6부터 첨부 실물 바이트 — §4), reminders
- AI 대화·기억: ai_conversations, ai_chats, ai_feedback, ai_memory, ai_memory_v2, memo_conversation_context, memory_pages, memory_entities, memory_relations, memory_fact_entities, memory_handoffs
- 설정·인증: ai_settings(모델·플래그 설정 — 비밀값 없음, 키 목록 실측 확인), accounts(해시만 저장됨), mcp_tokens(해시만)
- 아티팩트: artifacts, artifact_files, artifact_versions, artifact_chats
- 상태·연동: agent_handoffs, channel_messages, google_integrations(OAuth 토큰 포함 — **암호화 백업 안에서만** 보관하는 조건으로 포함. 제외하면 복원 후 재연동 필요), push_subscriptions(endpoint·키 포함 — 동일 조건), user_cron_jobs, tool_approvals, tool_approval_requests

### 제외 21개 (코드 `BACKUP_EXCLUDED_TABLES`에 사유 병기)
- 휘발성·보안: auth_pins(PIN 해시 — 탈취 세션으로 발급한 암호화 백업은 공격자가 백업 암호를 정하므로 복호화된 백업이 오프라인 PIN 추측 경로가 됨. PIN은 복원 대상이 아니라 복원 후 이메일 OTP 본인확인으로 재설정하는 것이 정당한 절차), otp_codes(만료·사용된 코드 부활 위험), rate_limits(시간창 카운터), session_versions(옛 값 복원 시 무효화 세션 부활 가능 — 복원 후 재로그인이 정답)
- 로그·감사·원장: ai_usage(1022행 — 최대 성장 테이블, 통계일 뿐 콘텐츠 아님), ai_error_log, ai_memo_audit, tool_execution_audit, google_sync_log, job_provider_attempts, artifact_job_events, memory_consolidation_log, ai_runs, ai_tool_runs
- 실행 중 상태: agent_runs, agent_run_checkpoints, workflow_runs, workflow_run_steps, artifact_jobs(stale한 running 잡 부활 위험 — 산출물 본체는 artifacts에 있음), ai_tool_operations, mcp_tasks
- FTS 가상 테이블(memos_fts, memos_fts_tri, ai_memory_fts 및 섀도우): 백업하지 않는다. 마이그레이션 + 트리거로 재생성되며, 이번 복원에서도 자동 재구축을 확인했다.

구 14개 범위와의 차이: ai_usage·ai_memo_audit는 구 범위에 있었으나 로그·원장 분류로 제외로 이동했다 (의도된 변경). 나머지 12개는 유지 + 20개 신규 포함.

## 3. 백업 생성 절차

### 방법 A — 스크립트 (현재 운영에서 바로 가능, 권장)
```bash
MYHUB_BACKUP_PASSWORD='<백업 비밀번호>' \
  python3 scripts/backup_production.py \
  --output ~/workspace/myhub-backups/myhub-backup-YYYYMMDD-HHMM.json
```
- 운영 D1을 읽기 전용 쿼리로만 읽는다 (쓰기 없음). 범위는 `routes.ts`의 `BACKUP_TABLES`를 파싱해 쓰므로 코드와 어긋나지 않는다.
- 인증: `CF_API_TOKEN` 환경변수 또는 Muse 커넥터 surrogate.
- 산출물은 **저장소 밖**에 두고 권한 600. 비밀번호는 환경변수로만 전달하고 어디에도 기록하지 않는다.

### 방법 B — Worker 엔드포인트 (운영 배포됨 — 정기 백업 경로, §8)
`POST /api/backup/encrypted` (로그인 세션 + `{password}`). 이번 P0 수정으로 **암호화 경로는 운영 허용**, 평문 경로는 스테이징 전용 유지. `public/backup.html` UI가 이 경로를 쓴다. 단, Worker 제한으로 평문 10MB 초과 시 413 — 데이터가 커지면 방법 A가 정답이다.

### 보관
- 백업 파일과 비밀번호는 **서로 다른 곳**에 보관한다. 비밀번호를 잃으면 복원은 불가능하다 (우회 없음 — §6).
- 최소 2곳 (예: 로컬 디스크 + 별도 매체). 정기 운영의 보관·리허설 기준은 §8을 따른다.

## 4. Cloudinary 주의 (첨부 실물) — 확정표 (2026-10-30 코드·스키마 실측)

메모 첨부 실물의 유일한 사본은 Cloudinary다. 백업이 담는 것은 `files` 테이블의 메타데이터뿐이며, 실물 바이트는 백업에 들어가지 않는다.

### 백업에 들어가는 것 — `files` 메타데이터 10개 필드 (운영 스키마 실측)

| 필드 | 내용 |
|---|---|
| `id` | 파일 행 ID |
| `memo_id` | 소속 메모 |
| `storage_key` | Cloudinary `public_id` (업로드 응답의 public_id를 이 컬럼에 저장) |
| `url` | Cloudinary `secure_url` |
| `filename` | 원본 파일명 |
| `mime` | MIME 타입 |
| `size` | 바이트 크기 |
| `resource_type` | Cloudinary resource_type |
| `is_locked` | 첨부 잠금 여부 |
| `created_at` | 생성 시각 |

- **무결성 해시가 `files`에 없다.** 실물 바이트의 해시·체크섬 컬럼이 스키마에 존재하지 않는다. 단 백업 v6의 attachments 항목마다 SHA-256이 기록되므로(아래), 백업 시점 바이트와의 대조는 백업으로 가능하다.
- D1만 소실된 경우: 복원된 메타데이터의 `url`/`storage_key`로 Cloudinary 실물에 다시 접근 가능 — 복원 성립.
- **첨부 실물 백업 (트랙 4, 2026-10-31)**: 암호화 백업 v6(Worker 엔드포인트·스크립트 방법 A 모두)는 `files` 행 전수의 저장 바이트를 base64 + SHA-256과 함께 봉투의 `attachments` 절에 포함한다. **Cloudinary까지 소실돼도 백업에서 바이트를 추출할 수 있다** (복원 시 Cloudinary 재업로드 + `files.url`/`storage_key` 갱신이 별도 절차로 필요하다 — 바이트 추출·해시 검증까지가 현행 복원 드릴의 범위, §10). 운영 실측(2026-10-31): 첨부 1개·3,465,669바이트 — base64 약 4.6MB로 현 백업 평문(약 1.5MB)과 합쳐도 10MB 제한 안이다.
  - **10MB 제한과의 관계 (fail-closed)**: 첨부를 실은 평문이 10MB를 넘으면 백업은 분리·자동 제외 없이 **거부**된다(엔드포인트 413 `attachments_too_large` 또는 최종 크기 검사 413). 명시적으로 `includeAttachments:false`를 보낸 경우에만 메타데이터만 백업하고, 그 사실이 봉투에 `included:false`로 남는다.
  - **다운로드 실패 시 백업 전체 중단** (엔드포인트 502): 일부 첨부가 빠진 백업을 "완전한 백업"으로 만들지 않는다. URL이 없는 레거시 행은 실물 자체가 없으므로 `missing_file_ids`에 명시하고 계속한다.
  - **잠긴 첨부**: 저장 바이트 자체가 이미 `MEMO_ENCRYPTION_KEY` 암호문이므로 백업에는 그 바이트를 그대로 싣는다(백업 암호로 한 번 더 감싸짐). 따라서 잠긴 첨부의 복원에는 **백업 암호 + `MEMO_ENCRYPTION_KEY`가 모두** 필요하고, 키를 잃으면 백업이 있어도 잠긴 첨부는 열 수 없다 (§6.1).
- 잠긴 파일은 Cloudinary에 암호화된 바이트(.enc 객체)로 올라가 있고 복호화에는 Worker의 `MEMO_ENCRYPTION_KEY`가 필요하다 — 키 자체는 백업에 포함되지 않는다 (§6).
- **대조 — 아티팩트 본체는 복원된다.** 스튜디오 아티팩트 본체는 Cloudinary가 아니라 D1 TEXT 컬럼(`artifacts`·`artifact_files` 등)에 있어 암호화 백업에 그대로 담기고 백업만으로 복원된다. "첨부 = 복원 불가 / 아티팩트 = 복원 가능"이 확정 경계다.

## 5. 복원 절차 (격리 환경)

```bash
# 1) 빈 로컬 D1(miniflare)에 전 마이그레이션 적용
npx wrangler d1 migrations apply myhub-db --local
DBF=$(find .wrangler -name '*.sqlite' | grep D1DatabaseObject | grep -v metadata)

# 2) 복원 + 검증 (운영 DB 경로는 스크립트가 거부)
MYHUB_BACKUP_PASSWORD='<백업 비밀번호>' \
  python3 scripts/restore_local.py \
  --input <백업파일> --db "$DBF" --existing-db --report <리포트.json>
```
- miniflare를 쓰지 않으면 `--db <새 sqlite 파일>`만으로 스크립트가 마이그레이션을 직접 적용한다 (두 경로 모두 검증됨).
- 복원 의미론: 백업이 정본. 넣기 전에 백업 포함 테이블을 비운다 (마이그레이션 시드 행 — 예: 0010의 기본 대화방 — 과의 충돌 방지). **운영 DB에는 절대 실행하지 않는다.**
- 복원 후 운영에 올리는 절차(운영 D1 교체)는 이 문서의 범위가 아니다. 별도 승인 + Time Travel bookmark 확보 후 코디네이터가 수행한다.
- 복원 후 재로그인이 필요하다 (session_versions·otp_codes 제외 때문 — 의도된 동작). 복원 후에는 PIN이 없으므로 이메일 OTP로 로그인해 PIN을 재설정해야 한다 (auth_pins도 백업에서 제외됨 — 의도된 동작). Google 연동·푸시 구독·MCP 토큰은 백업에 포함돼 있어 재설정 불필요.

## 6. 구조적 한계

- **백업 비밀번호 분실 = 복구 불가.** PBKDF2+AES-GCM에 우회는 없다.
- **MEMO_ENCRYPTION_KEY 분실 시** (§6.1): 잠긴 메모 본문·잠긴 블록·잠긴 첨부 바이트는 **영구 복호화 불가**, Google 토큰만 재연동으로 회복 가능.
- **Cloudinary 실물**: 백업 v6부터 첨부 바이트가 포함된다 (§4). 단 복원 드릴이 보장하는 것은 바이트 추출·해시 일치까지이고, Cloudinary 재업로드와 files 포인터 갱신은 수동 절차다. 평문 백업(POST /)과 v5 이전 백업에는 실물이 없다.
- Worker 엔드포인트 경로는 10MB 상한. 스크립트 경로는 D1 API 페이지네이션이라 상한이 사실상 없으나, 대용량 로그 테이블을 제외한 현 범위 기준이다.
- 스키마 드리프트(§1)가 있는 컬럼은 복원 시 대상 기본값으로 치환된다 — 치환은 리포트에 기록되며, 드리프트 자체의 해소(운영 스키마 정합)는 별도 과제다.

### 6.1 MEMO_ENCRYPTION_KEY 복구 절차 (2026-10-30 코드 실측으로 확정)

이 키는 백업에 포함되지 않는 별도 자산이다. 백업이 멀쩡해도 키가 없으면 아래 암호문은 열리지 않는다.

**사용처 4곳** (전부 `src/services/crypto.ts`의 동일 키·동일 함수 사용):

| # | 대상 | 저장 형태 | 키 분실 시 |
|---|---|---|---|
| 1 | 잠긴 메모 본문 | memos.text의 `ENC:` 암호문 | **영구 복호화 불가** |
| 2 | 잠긴 블록 | memos.locked_blocks 안의 암호문 | **영구 복호화 불가** |
| 3 | 잠긴 첨부 바이트 | Cloudinary .enc 객체의 암호화 바이트 | **영구 복호화 불가** |
| 4 | Google OAuth 토큰 | google_integrations의 암호화된 토큰 (`src/services/google-tokens.ts`) | **재연동으로 회복 가능** — 토큰 자체는 못 열지만 Google 계정을 다시 연결하면 새 토큰이 발급·저장된다 |

**재암호화·키 로테이션 도구가 있다 (트랙 4, 2026-10-31 구현).** `POST /api/key-rotation/rotate` (인증 세션 + 보호 메모와 같은 PIN step-up 창 필요)가 사용처 4곳 전수를 현재 키로 복호화해 요청 본문으로 받은 새 키로 재암호화한다. 그래도 **도구를 거치지 않고 키 값만 바꾸면 기존 암호문 전부가 그 즉시 복호화 불가가 된다** — 키 교체는 반드시 아래 절차로만 한다.

**형식 마커와 전환 중 상태**: 로테이션 산출물은 v2 마커(텍스트 `ENC2:`, 첨부 바이트 `MYH2` 매직)를 단다. 복호화 경로는 마커로 세대를 판별하고, `MEMO_ENCRYPTION_KEY_PREV`(구 키) 시크릿이 설정돼 있으면 현행 키로 실패한 항목을 구 키로도 시도한다 — 로테이션이 중단돼 일부만 전환된 혼합 상태에서도 각 항목이 자기 키로 읽힌다. 로테이션 자체는 사전에 전 대상 복호화를 검증해 하나라도 실패하면 쓰기 0건으로 중단하고, 항목 교체는 CAS 단일 UPDATE(첨부는 새 객체 업로드 → 포인터 교체 → 구 객체 파괴)라 항목이 두 키로 찢기지 않는다. 재실행은 멱등하고(이미 새 키인 항목은 건너뜀), `POST /api/key-rotation/rollback`으로 구 형식 복귀도 가능하다. 증명은 격리 환경에서만 했다: Jest 단위(실 SQLite) + miniflare 런타임에서 왕복·전환·잘못된 키 중단·쓰기 중간 실패 주입까지 PASS (§10). **운영 로테이션 실행은 아직 하지 않았다** — 아래 절차의 사전 조건(새 키 외부 보관)을 사용자가 확인한 뒤 별도 절차로 실행한다.

**실행 가능한 키 교체 절차** (중단/복구 기준 포함):

0. **사전 조건**: ① 새 키 값을 먼저 생성해 비밀번호 관리자 보안 노트에 외부 보관한다 (이 단계가 끝나기 전에는 어떤 단계도 시작하지 않는다). ② 현재 키의 외부 보관본도 존재하는지 확인한다 — 로테이션의 출발 키는 Worker 시크릿(현재 키)이라 실행 자체에 현재 키 값은 필요 없지만, 롤백·복구의 전제다. ③ 암호화 백업 1부를 먼저 만들어 둔다 (§3).
1. **dry-run**: step-up(PIN 재확인) 후 `POST /api/key-rotation/rotate {newKey, dryRun:true}`. 대상 건수(메모 본문·블록·Google 토큰 행·잠긴 첨부)가 예상과 일치하고 `ok:true`인지 확인한다. 실패(preflight)면 쓰기는 0건이므로 원인을 해소하기 전에는 진행하지 않는다.
2. **실행**: 같은 요청에서 `dryRun`을 빼고 실행한다. 응답의 `rotated` 건수가 dry-run의 `pending`과 일치하는지 확인한다. 중간 실패(`ok:false, stage:'write'`)면 전환분은 새 키로, 미전환분은 구 키로 읽히는 상태로 남는다 — 같은 요청을 재실행해 마저 전환하거나(멱등), 5단계의 PREV 병행으로 읽기를 보장한 뒤 원인을 본다.
3. **검증 (시크릿 교체 전)**: 응답 건수 + 잠긴 첨부·Google 연동이 응답 시점 기준으로 이상 없는지 확인한다. 이 시점의 운영 Worker는 아직 구 키를 들고 있어 **전환된 항목은 운영 화면에서 읽히지 않는다** — 실행과 다음 단계는 붙여서 수행하고, 이 상태를 방치하지 않는다.
4. **Worker Secret 교체 (사용자, 대시보드)**: `MEMO_ENCRYPTION_KEY`를 새 키 값으로 교체한다. 안전망으로 그 직후 한시적으로 `MEMO_ENCRYPTION_KEY_PREV`에 구 키 값을 함께 등록하면 미전환 잔여 항목도 읽힌다. 교체 후 잠긴 메모 열람(step-up)·잠긴 첨부 다운로드·Google 연동 상태가 정상인지 확인한다. 문제가 있으면 시크릿을 구 키로 되돌리고 `POST /api/key-rotation/rollback {rotatedKey}`로 암호문을 구 형식으로 되돌린다.
5. **마무리**: 검증이 끝나면 `MEMO_ENCRYPTION_KEY_PREV`를 제거하고, 구 키의 외부 보관본은 "폐기됨(교체일·새 키 보관 위치)" 표기 후 폐기한다. 새 정기 백업 1부를 만들어 새 세대 암호문이 백업에도 반영됐는지 확인한다.

**사용자 보관 절차 (필수):**

- Cloudflare Worker 시크릿은 등록 후 대시보드에서 값을 다시 볼 수 없다 (Cloudflare 공식 문서 — 시크릿 값은 조회 불가, 교체만 가능). 즉 대시보드는 보관소가 아니다.
- 키를 등록·교체하는 시점에, 비밀번호 관리자의 보안 노트에 **값 + 용도(MEMO_ENCRYPTION_KEY / MyHub 메모 암호화) + 경고("이 값을 잃으면 잠긴 메모·블록·첨부가 영구히 열리지 않는다")** 를 함께 저장한다.
- 보관 위치는 **백업 파일·백업 암호와 다른 곳**에, 이중으로 둔다 (예: 비밀번호 관리자 + 별도 매체의 보안 노트). 백업 암호와 같은 노트에 합치지 않는다 — 한 곳이 털리면 전부가 털리는 구조를 만들지 않기 위해서다.
- **확인 불가 항목**: 현재 운영 키의 외부 보관본이 실제로 존재하는지는 시스템에서 확인할 방법이 없다 (값 조회 자체가 불가). 존재 여부의 확인은 사용자가 비밀번호 관리자를 직접 열어 눈으로 확인하는 몫이며, 없으면 다음 키 관련 작업 전에 보관본부터 만드는 것이 선행 과제다.

## 7. 이번 검증 결과 (2026-10-29)

- 백업 산출물: `~/workspace/myhub-backups/myhub-backup-20261029-2025.json` — **1,424,500 bytes**, 32개 테이블 **1,091행**. 파일 구조 검사: 암호화 봉투 키(algorithm/ciphertext/iv/salt 등)만 존재, 평문 마커(`"rows"`, `"tables"`, `ENC:`, 계정 이메일) 없음, salt 16B·iv 12B 규격 확인. 비밀번호는 검증용 임시 비밀번호 (저장소 밖 600 파일에 임시 보관 — 확인 후 폐기할 것).
- 복원 대상: miniflare 로컬 D1 (마이그레이션 63개 전부 적용) + 일반 sqlite 경로 병행 — **두 경로 모두 전 항목 PASS**.
- 검증 리포트: `~/workspace/myhub-backups/restore-report-20261029.json`

| 검증 항목 | 결과 |
|---|---|
| AES-GCM 복호화 (인증 태그) | PASS — 잘못된 비밀번호는 InvalidTag로 거부됨도 확인 |
| 테이블별 행 수 (32개 전수) | PASS — 백업=복원 전수 일치 (아래 표) |
| 테이블별 전 행 정규화 해시 | PASS — 32개 전부 일치 (드리프트 치환 1건 투명 기록: ai_chats.prompt_version NULL 336행 → 기본값 'legacy') |
| 잠긴 메모 저장 텍스트 동일성 | PASS — 잠긴 메모 4건 (id·text) 해시 집합 일치. 단 저장 형태는 암호문이 아님 (§1 발견 참조) |
| 참조 무결성 | PASS — `PRAGMA foreign_key_check` 위반 0, 논리 참조 고아 0 (memo_tags·files·ai_chats·artifact_*·memory_relations 등) |
| FTS 재구축 | PASS — memos_fts 24행 = memos_fts_tri 24행 = 비잠금·민감도<2 메모 24건, MATCH 검색 동작 |

### 행 수 표 (백업 = 복원, 전수 일치)

| 테이블 | 행 | 테이블 | 행 |
|---|---:|---|---:|
| memos | 28 | ai_settings | 11 |
| memo_tags | 0 | accounts | 0 |
| schedules | 12 | auth_pins | 1 |
| todos | 5 | artifacts | 8 |
| files | 1 | artifact_files | 26 |
| reminders | 0 | artifact_versions | 8 |
| ai_conversations | 227 | artifact_chats | 109 |
| ai_chats | 640 | agent_handoffs | 0 |
| ai_feedback | 2 | channel_messages | 0 |
| ai_memory | 0 | google_integrations | 1 |
| ai_memory_v2 | 0 | push_subscriptions | 0 |
| memo_conversation_context | 12 | mcp_tokens | 0 |
| memory_pages | 0 | user_cron_jobs | 0 |
| memory_entities | 0 | tool_approvals | 0 |
| memory_relations | 0 | tool_approval_requests | 0 |
| memory_fact_entities | 0 | **합계** | **1,091** |
| memory_handoffs | 0 | | |

백업 직전 독립 카운트(d1q)와 백업 내 행 수가 32개 전 테이블에서 일치했다.

### 코드 변경 검증
- Jest: 258/258 스위트, **5266/5266 PASS** (기준선 5258 + 신규 8: 백업 라우트 +2, 범위 분류 +7, 순증 정합). tsc 클린.
- 카나리아: `BACKUP_TABLES`에서 `user_cron_jobs`를 빼면 범위 테스트 정확히 2건 실패 확인 후 원복.
- 런타임(vitest) 스위트는 이 worktree의 node_modules 불일치로 실행하지 못했다 (백업 모듈을 다루는 런타임 테스트는 없음). 병합 시 코디네이터 재실행 권고.
- 기존 통합 테스트: `test_backup_restore.py` 6/6, `test_backup_14tables.py` 18/18 (로컬 합성 검증 — §1의 성격 참조).

### 추가 검증 기록 (2026-10-30 — auth_pins 제외 배포 후 최신 드릴)

§7의 2026-10-29 기록은 당시 범위(32개 테이블·auth_pins 포함)의 역사적 사실로 유지한다. 아래는 auth_pins 백업 제외(b9726f2)가 배포된 뒤의 최신 드릴이다.

- 일시·기준: 2026-10-30 14:56 KST, 라이브 버전 **b8c954d4 @100%** (deployments API로 실측 확인).
- 백업 산출물: `~/workspace/myhub-backups/myhub-backup-DRILL-NOT-FOR-RESTORE-20261030-0556.json` — **1,506,520 bytes**, **31개 테이블 1,327행**. 이번에는 방법 B(운영 엔드포인트 `POST /api/backup/encrypted`, 인증 세션)로 생성했다 — 배포된 엔드포인트 자체가 새 범위를 내보내는지를 라이브로 확인하기 위해서다. **파일명대로 실복구용이 아니다** (드릴 암호는 검증 직후 폐기했으므로 이 파일은 다시 열 수 없다).
- 검증 리포트: `~/workspace/myhub-backups/restore-report-DRILL-NOT-FOR-RESTORE-20261030-0556.json`

| 검증 항목 | 결과 |
|---|---|
| AES-GCM 복호화 (인증 태그) | PASS |
| **auth_pins 부재 (라이브 증거)** | **PASS — 복호화한 백업의 테이블 목록 31개에 auth_pins 없음. 복원 DB의 auth_pins 행 0 (테이블 스키마는 마이그레이션으로 생기나 데이터는 복원되지 않음)** |
| 테이블별 행 수 (31개 전수) | PASS — 백업=복원 전수 일치, 합계 1,327행 |
| 테이블별 전 행 정규화 해시 | PASS — 31개 전부 일치 (드리프트 치환 투명 기록: ai_chats.prompt_version NULL 411행 → 기본값 'legacy') |
| 잠긴 메모 암호문 동일성 | PASS — 잠긴 메모 4건, ciphertext 다이제스트 일치 |
| files 행 복원 | PASS — 1행 복원, 메타데이터 10개 필드 (§4 확정표) 그대로. 실물 바이트는 다루지 않음 |
| 참조 무결성 | PASS — `PRAGMA foreign_key_check` 위반 0, 논리 참조 고아 0 |
| FTS 재구축 | PASS — memos_fts 25행 = memos_fts_tri 25행 = 비잠금 메모 25건, 두 인덱스 모두 MATCH 검색 동작 |

행 수 (백업 = 복원, 주요 테이블): memos 29 · schedules 12 · todos 10 · files 1 · ai_conversations 290 · ai_chats 780 · ai_memory_v2 6 · ai_settings 11 · artifacts 8 · artifact_files 26 · artifact_versions 8 · artifact_chats 109 · memo_conversation_context 15 · memory_entities 2 · memory_relations 1 · memory_fact_entities 5 · google_integrations 1 · mcp_tokens 3 · tool_approvals 2 · tool_approval_requests 6 · ai_feedback 2 · 나머지 10개 테이블 0행.

같은 날 라이브 QA (기준선 복귀 확인): 비서 3명 스모크 전부 HTTP 200 오늘자 응답 (루미 gemini-3.5-flash-lite · 에코 workers-ai qwen3-30b — NVIDIA 제외 유지 · 캘리 groq gpt-oss-120b), 잠긴 메모 133 PIN 없이 해제 시도 → **403 PIN_REQUIRED · 암호문 메타데이터 불변**, QA 전후 메모 29건·잠긴 평문 0건 기준선 동일.

## 8. 정기 백업 운영 절차 (2026-10-30 확정)

정기 백업의 주체는 사용자다. 아래 절차가 운영 정본이며, 자동 리마인더는 아직 없다 (말미 참조).

### 월 1회 정기 백업 (방법 B — backup.html)

1. MyHub에 로그인해 `backup.html`을 연다.
2. 백업 암호를 정해 암호화 백업을 만든다 (암호 최소 8자 — 잊으면 복구 불가, §6). 정기 백업 암호는 드릴용 1회용 암호와 다른, 본인이 관리하는 암호를 쓴다.
3. 내려받은 백업 파일을 아래 보관 규칙대로 저장한다.
4. 데이터 변경이 큰 작업(마이그레이션 적용, 대량 삭제) **직전**에는 월 주기와 무관하게 1회 추가한다.

### 보관 규칙

- **백업 파일과 백업 암호는 분리 보관한다.** 파일이 있는 곳에 암호를 같이 두지 않는다 (암호는 비밀번호 관리자에).
- 파일은 최소 2곳 (예: 로컬 디스크 + 별도 매체/클라우드). 저장소에 커밋하지 않는다.
- `MEMO_ENCRYPTION_KEY` 보관본은 이 둘과 또 다른 곳에 이중 보관한다 (§6.1).
- 보관 세대: 월말 백업 6개월분 유지.

### 복원 리허설

- **분기 1회**, 가장 최근 백업으로 §5의 격리 복원을 끝까지 돌려 검증 리포트까지 확인한다 (백업만 만들고 복원을 확인하지 않으면 백업이 아니다).
- 리허설 복원 후에는 재로그인 + **PIN 재설정**이 필요하다는 점을 함께 확인한다 (auth_pins·세션 관련 테이블이 백업에서 제외되므로 — §5 상호 참조).
- 반기 1회, 가장 오래된 백업 1개로도 복원 검증을 돌려 보관 매체 열화를 확인한다.

### 리마인더

- 월 1회 백업을 알리는 리마인더 cron은 **신설하지 않았다.** 사용자가 승인하면 후속으로 만든다 (그 전까지는 이 절차가 수동 운영 기준이다).

## 9. 백업 발급 step-up 제안 기록 (2026-10-30 제안 → 2026-11-01 트랙 1에서 구현 완료, §13)

**제안**: 암호화 백업 발급(`POST /api/backup/encrypted`)에도 잠금 해제와 같은 PIN step-up을 걸자는 안.

**이번에 구현하지 않은 근거:**

1. 주 백업 경로인 D1 직접 백업 스크립트(방법 A)는 Worker 엔드포인트를 거치지 않으므로, 엔드포인트에만 step-up을 걸어도 우회 경로가 그대로 남는다 — 방어가 아니라 마찰만 생긴다.
2. 세션 탈취 시나리오의 핵심 연쇄(백업 → 오프라인 PIN 추측 → 계정 탈취)는 auth_pins를 백업에서 제외함으로써 이미 차단됐다 (§2). step-up이 추가로 막는 것은 "백업 파일 자체의 유출"인데, 산출물은 공격자가 모르는 백업 암호로 암호화돼 있다.
3. 월 1회 수동 절차에 PIN 재입력을 강제하면 백업 자체를 미루게 되는 역효과가 있다.

**재검토 조건**: 민감 행위 전반(백업 발급·평문 내보내기·연동 해제 등)에 step-up을 통일 도입하는 설계가 착수될 때, 그 범위 안에서 함께 재검토한다. 그때는 스크립트 경로(방법 A)의 취급도 같이 정해야 한다.

## 10. 트랙 4 검증 기록 (2026-10-31 — 키 로테이션 도구 + 첨부 실물 백업)

배포: 커밋 13f04d3, 운영 버전 **d27cd930 @100%** (DEPLOY VERIFY PASS, 시크릿 이름 30개 유지).

### 키 로테이션 (격리 증명 — 운영 실행은 하지 않음)

| 검증 | 환경 | 결과 |
|---|---|---|
| dry-run 쓰기 0건·전환·멱등 재실행·롤백 원형 복귀 | Jest (실 SQLite 전 마이그레이션 + 가짜 객체 저장소) | PASS — 사용처 4곳 건수 {메모 본문 1, 블록 1, Google 행 1, 잠긴 첨부 1} 전수 |
| 잘못된 현재 키·이질 키 암호문 → preflight 중단, 쓰기 0건 | Jest | PASS — 스냅샷 전후 동일 |
| 쓰기 중간 실패 주입(2번째 첨부 업로드 실패) → 혼합 상태 각자 자기 키로 가독 + 재실행 완주 | Jest | PASS |
| 무인증 401·step-up 없음 403·실 step-up 발급 후 dry-run→실행(ENC2 전환)→롤백 | miniflare 런타임 (실세션·실 D1·실 AES-GCM) | PASS 3/3 |
| v2 마커 판별·`MEMO_ENCRYPTION_KEY_PREV` 폴백(교체 전후 혼합 상태) | Jest (crypto 포맷 테스트 8건) | PASS |
| 카나리아: 엔드포인트 step-up 게이트 제거 시 런타임 테스트 실패 확인 후 원복 | miniflare | PASS (게이트가 실집행점임을 실증) |
| 라이브: OTP 세션(step-up 없음)으로 rotate 호출 | 운영 d27cd930 | **403 STEP_UP_REQUIRED** — 게이트 라이브 확인. PIN을 아는 실행은 사용자 보관 확인 후 별도 절차 (§6.1) |

### 첨부 실물 백업 (라이브 드릴)

- 운영 실측: 첨부 1개(file_id 92, xlsx, 3,465,669바이트, 미잠금). 암호문 메모 4건·잠긴 블록 0건·잠긴 첨부 0건·Google 암호문 1건도 함께 실측 (로테이션 대상 총량 파악용 읽기 전용 조회).
- 드릴 산출물: `~/workspace/myhub-backups/myhub-backup-DRILL-NOT-FOR-RESTORE-20261031-track4.json` (7,711,698바이트 — 파일명대로 실복구용이 아니다. 드릴 암호는 검증 직후 폐기). 운영 엔드포인트(방법 B)로 생성 — 봉투 메타데이터 `attachments_included:true, attachment_count:1, attachment_bytes:3465669` 확인.
- 검증 리포트: `~/workspace/myhub-backups/restore-report-DRILL-NOT-FOR-RESTORE-20261031-track4.json` — **전 항목 PASS** (복호화·행 수·행 해시·잠긴 메모 암호문·참조 무결성·FTS + 신규 `attachment_bytes_match`: 첨부 3,465,669바이트 SHA-256이 원본 Cloudinary 객체와 일치, files 행 복원 확인).
- 라이브 스모크: 백업 엔드포인트·로테이션 엔드포인트 무인증 401, 비서(루미) 응답 200.

### 회귀

- Jest 전수 **5,718/5,718 PASS** (기준선 5,692 + 신규 26: 로테이션 13·crypto 포맷 8·백업 첨부 5), 런타임 **173/173 PASS** (기준선 170 + 신규 3), `tsc --noEmit` 클린. 신규 모듈 등록으로 core-modules 레지스트리 테스트를 18개 모듈 기준으로 갱신했다.

## 11. 통합 복구 절차 (2026-10-31, 트랙 4 확장 — 정본 패키지 + 데이터 백업 결합)

재해 복구는 두 자산이 모두 있어야 성립한다: **① 소스 정본 패키지**(`~/workspace/your_files/myhub-canonical-backup-20261031/`, HEAD `2420523` 아카이브 — git 이력에 구 백업 평문 blob이 남아 있어 bundle은 만들지 않았다, 패키지 README 참조)와 **② 사용자의 정기 암호화 백업 봉투**(§8, 사용자 본인 암호). 어느 한쪽만으로는 복구가 되지 않는다.

### 절차

1. **소스 검증**: 패키지의 `SHA256SUMS.txt`로 아카이브 체크섬을 대조하고, 별도 디렉터리에 풀어 HEAD 트리와 diff 0인지 확인한다(2026-10-31 실측: 파일 996개, 누락 0·내용 상이 0·여분 0, 실행 파일 10개 권한 일치, 심볼릭 링크 0개).
2. **데이터 복원 (격리)**: 1에서 푼 아카이브 안의 `scripts/restore_local.py`로 백업 봉투를 로컬 sqlite에만 복원한다. 운영 DB 경로는 스크립트가 거부하고, 이 절차에서도 운영 D1에 쓰지 않는다.
   ```bash
   MYHUB_BACKUP_PASSWORD='<사용자 본인 백업 암호>' \
     python3 scripts/restore_local.py \
     --input <백업파일> --db <새 로컬 sqlite> --report <리포트.json>
   ```
3. **복원 검증**: 리포트의 8개 검사가 전부 PASS인지 확인한다 — 복호화(AES-GCM 인증 태그)·마이그레이션·행 수·행 해시·잠긴 메모 암호문 동일성·참조 무결성·FTS 재구축·첨부 바이트 해시. 이어서 복원 DB에서 잠기지 않은 메모를 직접 열어 읽고, FTS MATCH 검색이 동작하고, 첨부 SHA-256이 봉투 기록과 일치하는지 확인한다.
4. **사용자 참여 단계 — 여기서 멈춘다**: 잠긴 메모·블록·잠긴 첨부의 **복호화**는 사용자가 외부 보관 중인 `MEMO_ENCRYPTION_KEY` 보관본이 있어야만 가능하다(§6.1). 에이전트는 운영 키 값을 다루지 않으며, 키 보관본 확인과 잠긴 콘텐츠 열람 확인은 사용자가 직접 수행하는 단계다. 키 보관본이 없으면 그 콘텐츠는 복구 불가로 판정하고, 잠기지 않은 데이터만으로 복구를 진행한다.
5. **운영 반영은 별도 절차**: 격리 복원이 PASS여도 운영 D1 교체는 이 문서의 범위가 아니다 — 별도 승인 + Time Travel bookmark 확보 후에만 수행한다(§5).

### 2026-10-31 확장 드릴 실측

- **합성 봉투 드릴 (신규 실행)**: 잠기지 않은 메모 1건·잠긴 메모(합성 암호문) 1건·첨부 1건(590바이트, SHA-256 기록 포함)으로 만든 합성 암호화 봉투를, 작업 트리의 `restore_local.py`와 **아카이브에서 푼 코드** 양쪽으로 격리 복원 — 양쪽 모두 **8개 검사 전 항목 PASS**, 복원 DB에서 잠기지 않은 메모 열람 확인, FTS MATCH 1건, 첨부 해시 일치, 잠긴 메모는 암호문 다이제스트 일치까지만 확인하고 복호화를 시도하지 않았다(위 4단계).
- **실데이터 드릴 (기존 §10 재인용)**: 같은 날 먼저 수행된 트랙 4 라이브 드릴 리포트(`restore-report-DRILL-NOT-FOR-RESTORE-20261031-track4.json`)도 전 항목 PASS — 실 첨부 3,465,669바이트의 해시가 원본 Cloudinary 객체와 일치했다. 단 그 드릴 봉투의 암호는 폐기됐으므로 그 파일로는 재복원을 할 수 없고, 실복구에는 사용자의 정기 백업 봉투와 본인 암호가 필요하다.
- **NOT TESTED**: 잠긴 메모 실물 복호화(사용자 참여 단계), Cloudinary 재업로드와 `files` 포인터 갱신(수동 절차, §4), 운영 D1으로의 반영.

## 12. 트랙 6 (2026-11-01) — 키 보관본 판정 + 사용자 단계 최소화 런북

### 12.1 현재 운영 키의 출처·보관본 판정 (기록 전수 확인)

- **원본 키 (2026-10-09 최초 등록분)**: 에이전트가 생성·등록했고 값은 기록하지 않았다 (`~/memory/2026-10-09.md`). 2026-10-21 사고 후 사용자가 "기억 안 나지, 너가 만든 거야, 나는 몰라"라고 답한 기록이 있어, **사용자 보관본이 없었음이 확정**이다 (`~/memory/2026-10-21.md` 'MEMO_ENCRYPTION_KEY 원본 탐색').
- **현행 키 (2026-10-21 복구 시 신규 등록분)**: 사고 복구 과정에서 원본 키 의존 데이터(메모 #140 잠긴 블록 2건·파일 #92)를 먼저 해제·평문화해 의존 건수를 0으로 만든 뒤, 에이전트가 실행한 일회용 스크립트 `.scratch/exp7_prod.py`가 **프로세스 안에서 32바이트 난수(`token_bytes(32)`)를 생성해 base64로 인코딩하고, 그 값을 출력·기록하지 않은 채** `POST /versions` + `keep_bindings`의 `secret_text`로 Cloudflare에 직접 등록했다 (시크릿 목록 5→6개, `~/memory/2026-10-21.md` '시크릿 상속 메커니즘 정정 + lineage 복원 진행'). **이 값을 사용자에게 전달했다는 기록은 어느 문서에도 없다.** 스크립트 구조상 값은 화면에 표시된 적도 없다.
- **판정**: 현행 키의 사용자 외부 보관본은 **존재를 확인할 기록이 없으며, 전달 경로 자체가 없었다고 보는 것이 기록과 정합하다.** 단 "전달 안 했다"는 직접 문서는 없으므로 엄밀히는 **불명확(미전달로 강하게 추정)** 으로 남긴다. 실무 결론은 같다: Cloudflare 시크릿은 값 조회가 불가하고 에이전트도 값을 보유하지 않으므로, **현행 키의 보관본은 지금 만들 방법이 없다.** 보관본을 확보하는 유일한 길은 §12.3대로 **사용자가 값을 아는 새 키로 로테이션**하는 것이다 (§6.1 절차의 특수 케이스 — 구 키 보관본 확인 단계는 이 사유로 건너뛴다).

### 12.2 로테이션 대상 census + preflight 판정 (2026-11-01, 읽기 전용)

- D1 읽기 전용 집계(`.scratch/d1q.py`, 암호문·평문 값을 조회하지 않고 접두사·건수만): **메모 본문 암호문 4건 — 전부 v1(`ENC:`), v2 0건.** 2026-10-31 트랙 4 실측(잠긴 블록 0건·잠긴 첨부 0건·Google 암호문 1행)과 합친 현재 대상 총량은 **메모 본문 4 + Google 토큰 1행**이다. 블록·첨부·Google 항목의 당일 재집계는 D1 무료 일일 행 읽기 한도 초과(오류 7500, UTC 자정 리셋)로 **NOT TESTED** — 트랙 4의 같은 날 실측을 기준선으로 쓴다.
- **복호화 preflight(dry-run) 자체는 오늘 실행하지 않았다.** 구조 판정: `rotateEncryptionKey`의 `dryRun:true` 경로는 전 대상 복호화 검증 뒤 쓰기 구간 전에 반환하므로 **쓰기를 동반하지 않는다** (DB SELECT + 잠긴 첨부 GET만). 그러나 실행 진입점인 `POST /api/key-rotation/rotate`는 PIN step-up 세션을 요구하고(무인증 401·step-up 없음 403 — 2026-10-31 라이브 및 2026-11-01 무인증 401로 재확인), PIN은 에이전트가 알 수 없고 알아서도 안 되며, 복호화 키도 Worker 안에서만 존재하므로 D1 조회만으로는 복호화 성공/실패 건수를 셀 수 없다. **즉 오늘 기준 "복호화 가능 N건·실패 0건"이라는 수치는 존재하지 않고, 그 수치는 §12.3의 dry-run 실행 자체가 만든다.**
- **안전 판정 (조건부)**: 대상이 5건 수준으로 작고 전부 v1이며, 도구 preflight가 1건이라도 실패하면 쓰기 0건으로 중단하는 fail-closed 구조이고, 격리 환경 증명(§10)이 PASS이므로, **사용자 step-up 세션에서 dry-run을 첫 단계로 실행하는 것은 안전하다.** 단 실제 로테이션 실행은 dry-run 응답이 `ok:true`이고 `pending`이 census(메모 본문 4·블록 0·Google 1행·잠긴 첨부 0)와 일치할 때만 진행한다.

### 12.3 사용자 런북 — 값 1개 등록으로 끝내는 키 보관본 확보 (사용자 단계 6개, 약 15분)

전제: 키 값은 채팅·에이전트를 거치지 않는다. 사용자가 만들고, 사용자가 붙여넣고, 에이전트는 건수 보고만 받는다.

1. **새 키 값 1개 만들기 (≈3분)** — 비밀번호 관리자의 비밀번호 생성기로 32자 이상 무작위 값을 1개 생성해, 보안 노트에 이름 `MEMO_ENCRYPTION_KEY (2026-11 교체)` + 경고 "이 값을 잃으면 잠긴 메모·블록·첨부가 영구히 열리지 않는다"와 함께 저장한다. 백업 암호를 적는 노트와는 다른 노트에 둔다 (§6.1).
2. **정기 백업 1부 만들기 (≈3분)** — MyHub 로그인 → `backup.html` → 백업 암호(본인이 정해 비밀번호 관리자에 저장, 최소 8자) 입력·확인 → 백업 생성 → 내려받은 파일을 2곳에 보관한다. 사전 조건은 2026-11-01 라이브로 재확인했다: health 200, `backup.html`은 인증 뒤에서만 열리고(무인증 302), `POST /api/backup/encrypted`는 무인증 401로 게이트가 먼저 동작하며, 암호 형식 검증(8자 미만 400)은 코드 경로로, 봉투 복호화·복원 8개 검사는 §7·§10 드릴로 확인돼 있다. **남은 관문은 로그인 세션 + 이 암호 입력뿐이다.**
3. **로테이션 페이지 열기 (≈1분)** — MyHub에 로그인한 브라우저에서 `key-rotation.html`을 연다 (백업 페이지에도 링크가 있다). 별도로 step-up 세션을 열 필요는 없다 — 페이지가 dry-run 요청 시점에 공용 step-up 모달로 PIN 재인증을 요구한다 (창이 만료됐으면 실행 시점에 다시 요구한다).
4. **로테이션 dry-run → 실행 (≈3분)** — 페이지의 새 키 값 입력란에 1단계의 값을 본인이 붙여넣고 "dry-run으로 대상 확인"을 누른다. 페이지가 `pending`을 12.2의 census(메모 본문 4·블록 0·Google 1행·잠긴 첨부 0)와 자동으로 대조해 표로 보여 주고, **전 항목이 일치할 때만 실행 버튼이 활성화**된다 (불일치하면 fail-closed로 막히며, 그 건수만 Claude에 알리면 된다). 실행 후에는 페이지가 `rotated` = `pending`을 확인하고 경고를 표시한다. 값은 입력란 → `POST /api/key-rotation/rotate` 본문으로만 전송되고 저장소·쿠키·로그 어디에도 남지 않으며, 실행이 끝나면 입력란이 비워진다 (이 성질은 `tests/unit/key-rotation-ui.test.ts`의 정적 검사 + jsdom 흐름 테스트로 고정). **주의: 이 시점부터 5단계 전까지 전환된 항목은 운영 화면에서 읽히지 않으므로 4·5단계는 붙여서 한 번에 마친다.**
   - (폴백) 페이지가 동작하지 않을 때만 종전 콘솔 스니펫 방식으로 같은 엔드포인트를 호출한다 — 순서는 위와 동일하다: dry-run `ok:true` + census 일치 확인 후에만 실행, `rotated` = `pending` 확인.
5. **Worker 시크릿 교체 (≈3분)** — Cloudflare 대시보드 → Workers & Pages → `myhub` → Settings → Variables and Secrets → `MEMO_ENCRYPTION_KEY` 편집 → 1단계의 값으로 교체 → Deploy. 현행 키 값을 모르므로 §6.1의 `MEMO_ENCRYPTION_KEY_PREV` 안전망은 **이번에는 쓸 수 없다** — 대신 4단계에서 전 대상 전환 완료(`rotated` 전수 일치)를 확인한 뒤에만 이 단계를 진행하는 것이 안전 조건이다.
6. **검증 + 새 백업 (≈2분)** — 잠긴 메모 1건을 열어(PIN step-up) 본문이 보이는지, Google 연동 상태가 정상인지 확인하고, 2단계와 같은 방법으로 새 정기 백업 1부를 더 만든다. 문제가 있으면 값 교체 자체는 되돌릴 수 없으므로(구 값 미보유) 즉시 Claude에 알린다 — 복구는 백업 + 로테이션 롤백 절차로 별도 진행한다.

### 12.4 NOT TESTED (트랙 6)

- 로테이션 dry-run의 복호화 성공/실패 건수 — step-up이 필요한 라이브 실행이라 사용자 합동 세션(12.3의 4단계)에서 처음 생성된다.
- 잠긴 블록·잠긴 첨부·Google 암호문의 2026-11-01 당일 재집계 — D1 일일 읽기 한도(7500) 초과로 차단, 2026-10-31 트랙 4 실측이 최신 기준선.
- 인증 세션으로의 백업 암호 형식 검증(8자 미만 400) 라이브 재현 — 무인증 401 게이트까지만 라이브 확인, 형식 검증은 코드 + 과거 드릴(§7·§10) 근거.

## 13. 백업 발급 step-up 적용 (2026-11-01, 트랙 1 — GPT 재평가 P0-3)

GPT 재평가 신규 지적: 백업 발급은 세션만으로 가능해, 세션 탈취자가 자기 암호로 전체 백업(일반 메모·AI 대화·일정 포함)을 발급받을 수 있었다. auth_pins를 백업에서 제외한 것(§2)과는 별개의 표면이다. §9의 제안이 이 트랙에서 구현됐다 — 당시 "미구현 근거" 1번(스크립트 우회 경로)은 아래 표면 구분으로 답한다.

### HTTP 발급 — step-up 적용

- 발급 엔드포인트 전수 (라우트 파일 `src/modules/backup/routes.ts` 전수 확인): `POST /api/backup/encrypted`(암호화 발급)와 `POST /api/backup/`(평문 발급, 스테이징 전용) 2개뿐이다. 상태 조회 같은 읽기 전용 경로는 이 모듈에 없다.
- 두 경로 모두 보호 메모와 같은 집행점 `requireProtectedAccess()`를 적용한다: 환경(fail-closed)·인증(401) 확인 뒤, 데이터 읽기(`db.batch`) 전에 게이트를 집행한다. PIN 설정 계정은 5분 step-up 창이 없으면 `403 { ok:false, error:'step_up_required', code:'STEP_UP_REQUIRED' }`, PIN 미설정 계정은 면제(기존 정책과 동일 — lockout 방지).
- 프론트: `backup.html`이 공용 `public/js/step-up.js`(메모 화면 pane.js의 PIN 모달·`POST /api/auth/step-up`·재시도 계약을 추출해 공용화)를 로드하고, 발급이 403 STEP_UP_REQUIRED면 PIN 모달 → step-up 발급 → 1회 재시도한다. 사용자가 취소하면 발급은 중단되고 안내 문구가 표시된다.
- §9 근거 2번(auth_pins 제외로 PIN 추측 연쇄 차단)은 여전히 유효하지만, 그것은 백업 파일이 유출된 뒤의 연쇄 차단이고, step-up은 발급 자체를 막는 층이다 — 두 방어는 대체가 아니라 중첩이다. 근거 3번(월 1회 절차의 마찰)은 PIN 로그인 직후 5분 창 안에서는 추가 입력이 없다는 점으로 완화된다.

### 스크립트 경로 — 표면이 다르다 (코드 변경 없음)

- `scripts/backup_*.py`(방법 A)는 Worker HTTP 엔드포인트를 거치지 않고, 로컬 머신에서 Cloudflare 자격증명(D1 API 토큰 등)으로 직접 읽는다. 즉 이 경로의 전제는 이미 "로컬 머신 + 계정 자격증명을 가진 사람"이며, 탈취된 웹 세션만으로는 도달할 수 없다.
- 따라서 step-up(PIN 재확인)은 웹 세션 탈취라는 위협 모델에 대한 방어이고, 스크립트 경로의 방어는 자격증명 보관(로컬 파일 권한·토큰 관리)이 담당한다. 두 표면을 같은 게이트로 묶지 않는다 — 스크립트에 웹 PIN을 강제하면 방어 실익 없이 운영 절차만 깨진다.
- 범위: 이번 트랙에서 스크립트 파일은 변경하지 않았다.

### 검증

- Jest: 게이트 전용 하네스(auth_pins 조회를 실제로 흉내)로 ① 세션만(su 없음) → 403 STEP_UP_REQUIRED + batch 미호출 ② 만료 창 → 403 ③ 유효 창 → 200 + 봉투 형식·31개 테이블 무변경 ④ PIN 미설정 → 면제 200 ⑤ 평문 발급도 동일 게이트 (`tests/unit/backup-stepup-gate.test.ts` 5건 + `tests/unit/backup-routes.test.ts`의 게이트 describe). 봉투 복호 라운드트립은 기존 backup-routes 스위트가 담당한다. 프론트 모달→step-up→재시도 흐름은 공용 헬퍼를 함께 쓰는 키 로테이션 페이지의 jsdom 테스트(트랙 5, `tests/unit/key-rotation-ui.test.ts`)가 검증한다 — backup.html 자체의 클릭 종단 흐름은 라이브·jsdom 모두 미수행 (NOT TESTED).
- 카나리아: 암호화 발급 게이트를 제거하면 ①②가 실패함을 실측으로 확인했다 (2건 실패 → 복원 후 전부 PASS).
- 라이브: 배포 후 무인증 발급 시도는 인증 단계에서 차단되고, 세션만으로( step-up 없이) 발급 시도는 403 STEP_UP_REQUIRED까지 확인한다. 실제 PIN 입력이 필요한 step-up 이후 발급 경로는 라이브에서 수행하지 않는다 (NOT TESTED).
