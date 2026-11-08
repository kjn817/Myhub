# 시크릿·개인정보 패턴 스캔 요약 (트랙 4 확장, 2026-10-31)

방식: gitleaks가 이 VM에 없어 `which gitleaks` 실패를 확인하고, grep 동등 방식의 자체 패턴 스캔(Python `re`, 바이트 단위)으로 수행했다. 규칙: 개인키 헤더, AWS/GitHub/OpenAI/Google/Slack 토큰 접두, Bearer 장기 토큰, 일반 시크릿 할당(따옴표 값 12자 이상, placeholder/test 값 1차 필터), 이메일 패턴, 한국 휴대폰 패턴, 주민번호 유사 패턴. **매치 값은 어디에도 기록하지 않았다 — 아래는 파일·커밋·규칙·건수뿐이다.** 바이너리 파일은 패턴 스캔에서 제외하고 개수만 기록했다.

## 1. 현재 트리 (HEAD 2420523, 추적 1,018개 중 텍스트 995개 스캔, 바이너리 23개 제외)

### 규칙별 집계

| 규칙 | 건수 | 판정 |
|---|---:|---|
| private_key_header | 0 | — |
| cloudflare_or_bearer_long | 0 | — |
| kr_rrn_like | 0 | — |
| aws_access_key | 2 | 아래 테스트 픽스처 |
| github_token | 1 | 아래 테스트 픽스처 |
| openai_key | 20 | 아래 테스트 픽스처 |
| google_api_key | 1 | 아래 테스트 픽스처 |
| slack_token | 3 | 아래 테스트 픽스처 |
| generic_secret_assignment | 15 | 아래 테스트 환경값 |
| email_pattern | 380 | 소유자 계정 이메일(문서·스크립트) + 테스트 픽스처 이메일 |
| kr_phone_pattern | 7 | 아래 테스트 픽스처 |

### 고신뢰 토큰 형식 히트 27건 — 전부 테스트 픽스처 (실 시크릿 0)

민감도 분류·마스킹 기능을 시험하기 위해 테스트에 넣은 합성 토큰 문자열이다. `src/`·`scripts/`·`public/`·`docs/`의 운영 코드·문서에는 0건이다.

| 파일 | 규칙 | 건수 |
|---|---|---:|
| phase2a.test.js | openai_key | 3 |
| phase2b.test.js | openai_key | 1 |
| tests/approval-flow-cov.test.ts | openai_key | 2 |
| tests/google-privacy.test.ts | openai_key | 1 |
| tests/sandbox.test.ts | openai_key | 2 |
| tests/tool-approval.test.ts | openai_key | 3 |
| tests/unit/ai-fallback-controller.test.ts | openai_key | 3 |
| tests/unit/ai-model-router.test.ts | openai_key | 5 |
| tests/unit/ai-model-router.test.ts | github_token | 1 |
| tests/unit/ai-model-router.test.ts | google_api_key | 1 |
| tests/unit/ai-model-router.test.ts | slack_token | 3 |
| tests/unit/svc-secret-mask.test.ts | aws_access_key | 2 |

### generic_secret_assignment 15건 — 전부 테스트 파일의 테스트용 환경값

| 파일 | 건수 |
|---|---:|
| auth-resend.test.js | 1 |
| push.test.js | 1 |
| tests/google-services-cov.test.ts | 2 |
| tests/runtime/memo-block-flow.test.ts | 1 |
| tests/runtime/memo-read-paths-sensitive.test.ts | 1 |
| tests/unit/auth-low-fixes.test.ts | 2 |
| tests/unit/auth-routes.test.ts | 5 |
| tests/unit/backup-routes.test.ts | 2 |

placeholder/test 값을 빼기 전 원시 히트에는 `vitest.config.ts`·`.semgrep/baseline.json` 같은 테스트 설정·기준선 파일의 동일 성격 항목이 더 있으나, 성격은 같다(테스트용 값·탐지 기준선 스니펫).

### 개인정보 패턴

- email_pattern 380건: 파일 약 120개. 대부분 테스트 픽스처 이메일이고, 실주소 성격은 소유자 본인의 계정 이메일이 문서(`SYSTEM_INFO.md` 등)·`.scratch` 스크립트·일부 테스트에 등장하는 것이다 — 이미 공개 저장소와 시스템 문서에 있는 식별자이며 자격증명이 아니다.
- kr_phone_pattern 7건: `tests/integration/memory-citation-lock-real.test.js` 5건, `tests/unit/ai-routes.test.ts` 2건 — 인용 잠금·마스킹 테스트에 넣은 픽스처 번호로, 맥락(마스킹 기대값 단언)이 레닥션 형태로 확인됐다.
- **구 백업 평문: 현재 트리 0건.** `backups/` 경로는 추적 파일에 없다(`2420523`에서 추적 해제 완료, `tests/unit/no-tracked-plaintext-backup.test.ts`가 강제).

**현재 트리 판정: 실 시크릿·평문 백업 없음 — 아카이브 패키지 제작·업로드 가능한 상태.** 위 히트는 전부 테스트 픽스처·테스트 환경값·기지의 본인 이메일로 분류 근거를 남겼다.

## 2. git 이력 전체 (838개 커밋, `git log --all` 대상)

### 방식 보정 기록

고유 blob 전수를 `git cat-file` 배치로 스캔하는 1차 방식은 이 VM에서 교착·과도한 지연으로 완료되지 못했다(중간 산출물 없음). 그래서 단일 스트림 방식으로 교체했다: `git log --all -p` 출력(총 5,695,844줄 처리)을 한 프로세스로 흘리며 **추가된 줄만** 스캔한다 — 각 내용 버전은 도입·변경 시점에 한 번 스캔되므로, 건수는 blob 버전별 누적이 아니라 **도입 기준**이다. 경로 목록 자체는 `git rev-list --objects --all`로 별도 확정했다. 규칙·기록 방식(값 미기록)은 현재 트리 스캔과 같다.

### 규칙별 집계 (도입 기준)

| 규칙 | 건수 | 주된 출처 |
|---|---:|---|
| email_pattern | 1,634 | 테스트 픽스처 + 과거 추적됐던 node_modules의 package.json·CHANGELOG + 아래 알려진 오염 2건 |
| generic_secret_assignment | 65 | 테스트 환경값 + node_modules 의존성 코드(miniflare·hono·wrangler) |
| openai_key | 45 | 테스트 픽스처 + node_modules/miniflare UI 자산 9건 |
| kr_phone_pattern | 14 | 테스트 픽스처 2개 파일 |
| aws_access_key | 6 | 테스트 픽스처 4건 + node_modules/miniflare dist 2건 |
| slack_token | 6 | 테스트 픽스처 (ai-model-router) |
| private_key_header | 5 | **전부 node_modules 의존성 dist 코드** — 실제 키 물질이 아니라 라이브러리 코드 안의 헤더 문자열 리터럴 |
| google_api_key | 4 | 테스트 픽스처 2건 + **아래 알려진 오염 2건** |
| github_token | 2 | 테스트 픽스처 (ai-model-router) |
| cloudflare_or_bearer_long | 0 | — |
| kr_rrn_like | 0 | — |

`src/`·`scripts/`·`.scratch` 경로의 비이메일 히트는 이력 전체에서 0건이다.

### 알려진 오염 — 구 백업 평문 (분리 명시, 예상 범위)

커밋 `94084132`에 도입된 `backups/prod-20261013-predeploy/` **27개 파일 전체**가 오염 경로다. 패턴 건수와 무관하게, 이 디렉터리는 운영 데이터의 평문 스냅샷이라는 자체로 이력 히트다. 트랙 3에서 확인된 사실: 그 안의 `memos.json`에 잠긴 메모 4건의 평문이 있었다(이번 스캔에서는 값을 다시 읽지 않았다).

- `backups/prod-20261013-predeploy/MANIFEST.json`
- `backups/prod-20261013-predeploy/ai_chats.json`
- `backups/prod-20261013-predeploy/ai_conversations.json`
- `backups/prod-20261013-predeploy/ai_feedback.json`
- `backups/prod-20261013-predeploy/ai_memo_audit.json`
- `backups/prod-20261013-predeploy/ai_memory.json`
- `backups/prod-20261013-predeploy/ai_memory_fts.json`
- `backups/prod-20261013-predeploy/ai_memory_fts_config.json`
- `backups/prod-20261013-predeploy/ai_memory_fts_data.json`
- `backups/prod-20261013-predeploy/ai_memory_fts_docsize.json`
- `backups/prod-20261013-predeploy/ai_memory_fts_idx.json`
- `backups/prod-20261013-predeploy/ai_memory_v2.json`
- `backups/prod-20261013-predeploy/ai_settings.json`
- `backups/prod-20261013-predeploy/ai_usage.json`
- `backups/prod-20261013-predeploy/files.json`
- `backups/prod-20261013-predeploy/memo_tags.json`
- `backups/prod-20261013-predeploy/memos.json`
- `backups/prod-20261013-predeploy/memos_fts.json`
- `backups/prod-20261013-predeploy/memos_fts_config.json`
- `backups/prod-20261013-predeploy/memos_fts_data.json`
- `backups/prod-20261013-predeploy/memos_fts_docsize.json`
- `backups/prod-20261013-predeploy/memos_fts_idx.json`
- `backups/prod-20261013-predeploy/otp_codes.json`
- `backups/prod-20261013-predeploy/push_subscriptions.json`
- `backups/prod-20261013-predeploy/reminders.json`
- `backups/prod-20261013-predeploy/schedules.json`
- `backups/prod-20261013-predeploy/todos.json`

이 디렉터리 안에서 패턴으로 잡힌 것 (파일 · 커밋 · 규칙 · 건수):

| 파일 | 커밋 | 규칙 | 건수 |
|---|---|---|---:|
| backups/prod-20261013-predeploy/memos.json | 94084132 | google_api_key | 1 |
| backups/prod-20261013-predeploy/memos_fts.json | 94084132 | google_api_key | 1 |
| backups/prod-20261013-predeploy/ai_feedback.json | 94084132 | email_pattern | 1 |
| backups/prod-20261013-predeploy/otp_codes.json | 94084132 | email_pattern | 1 |

특히 `memos_fts.json`에도 같은 형식 히트 1건이 있어, 본문뿐 아니라 **FTS 인덱스 복사본에도 잔존 흔적**이 있음을 파일 단위로 확인했다. 패턴에 잡히지 않는 평문(국문 본문·비밀번호·카드류 등 패턴 외 형식)은 이 표에 나타나지 않으므로, 이 표를 오염의 전체 규모로 읽으면 안 된다 — 규모 판정은 위 27개 파일 경로 기준이 정본이다.

### private_key_header 5건 상세 (의존성 코드)

| 파일 | 커밋 | 건수 |
|---|---|---:|
| node_modules/miniflare/dist/src/index.js | d5d5c23b | 1 |
| node_modules/wrangler/wrangler-dist/cli.js | d5d5c23b | 4 |

node_modules가 추적되던 시기(`f76145c`에서 추적 해제)의 서드파티 배포 코드다. 실제 개인키가 저장된 사례로 보지 않지만, 이력에 node_modules가 통째로 들어 있던 것 자체가 이력을 정본으로 재사용할 수 없는 또 하나의 이유다.

## 3. 종합 판정

- **현재 트리: 깨끗 (위 분류 기준)** — 실 시크릿·평문 백업 없음. HEAD 아카이브 패키지 제작과 그 패키지의 Drive 업로드가 가능한 상태.
- **git 이력: 오염** — 구 백업 평문 blob(커밋 `94084132`)이 남아 있다. **git bundle을 만들지 않았다.** 이력을 살리는 경로는 히스토리 재작성(과거 blob 제거)뿐이며, 그 실행 여부와, 아니면 신규 저장소로 아카이브-only 이전할지는 **별도 결정 사항**이다.
