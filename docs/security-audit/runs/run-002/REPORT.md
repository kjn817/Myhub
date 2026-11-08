# 보안 감사 보고서 — run-002 (재감사, quick, 인증 모듈 + 미들웨어)

- **실행:** run-002, 프로파일 quick, 스코프 인증 모듈 + 미들웨어
- **대상:** `57b5554` (트랙 2: run-001 7건 수정본), 브랜치 `fix/unlock-block-remove-ciphertext`
- **에이전트:** 헌터 1명 + 후보별 독립 검증자 9명 = 10명
- **결과:** confirmed 9건 (medium 1건, low 8건), needs_validation 0건, rejected 0건, **P0/P1 0건**
- **두 검증기:** `validate-findings.cjs` PASS (9 findings valid), `validate-coverage-ledger.cjs` PASS (9 coverage units valid)

## 최종 판정

- **P0/P1 없음 — P0/P1 기준으로는 배포 NO-GO 사유가 없다.**
- 단, **medium 1건(`auth/pin-lock-gate-stale-read`)이 남아 있다.** PIN 잠금 게이트의 stale-read race로, 15분당 허용 추측이 버스트 크기 N배로 늘어난다. 운영 배포 전 수정 여부를 결정할 것 (권장: 수정 후 재배포).
- **배포 게이트 (필수): 마이그레이션 0045를 코드 배포와 함께 운영 D1에 적용할 것.** `auth/pin-kv-fallback-race` 검증에서 확인됐듯, 코드만 배포되고 0045가 빠지면 run-001 medium(`auth/pin-lockout-kv-race`)이 통째로 되돌아간다. 0045 운영 적용은 아직 확인되지 않았다 (라이브 조회 금지로 미확인 상태).

## 1. run-001 7건 재검증 결과

| run-001 finding | run-001 심각도 | run-002 판정 | 비고 |
|---|---|---|---|
| auth/pin-lockout-kv-race | medium | **PARTIAL** | 카운터 손실은 고쳐졌으나 게이트 race 잔존 → 신규 `auth/pin-lock-gate-stale-read` (medium) |
| auth/otp-verify-attempts-race | medium | **FIXED** | 동시 오답 10개 → 5건 400 '틀렸습니다' + 5건 400 '시도 횟수 초과', attempts 5에서 고정 |
| auth/login-page-cdn-no-sri | medium | **FIXED** | lucide 0.469.0 고정 + SRI + CSP. SRI 해시는 조정자가 unpkg 바이트를 직접 받아 계산해 일치 확인 |
| auth/session-no-revocation | low | **FIXED** | 로그아웃·재발급 후 구 토큰 /me 401, 새 토큰 200 |
| auth/set-pin-no-step-up | low | **FIXED** | PIN 세션·구 토큰으로 /set-pin → 403, OTP 세션 → 200 |
| auth/otp-request-race | low | **PARTIAL** | 메일 1통·코드 1개로 고쳐졌으나 속도 제한 카운터 race 잔존 → 신규 `auth/rate-limit-kv-race` (low) |
| auth/attempt-counter-lockout-dos | low | **PARTIAL** | /request 다리만 완화, /verify 코드 소진·PIN 잠금 DoS 그대로 → 신규 `auth/lockout-dos-verify-pin-residual` (low) |

**FIXED 4건, PARTIAL 3건.** PARTIAL 3건의 잔여는 각각 신규 confirmed finding으로 승격됐다.

## 2. 신규 confirmed findings (9건)

| fingerprint | 심각도 | 한 줄 요약 |
|---|---|---|
| auth/pin-lock-gate-stale-read | **medium** | PIN 잠금 게이트가 SELECT 시점 값이라 동시 버스트가 5회 예산을 넘긴다 |
| auth/sessver-fail-open | low | KV 장애 시 세션 버전 대조가 fail-open되어 무효화 토큰이 통과하고 버전이 하락한다 |
| auth/sessver-bump-race | low | bumpSessionVersion KV read-modify-write — 동시 /set-pin 시 4/10 확률로 두 세션 모두 생존 |
| auth/rate-limit-kv-race | low | checkRateLimit KV read-modify-write — 모든 속도 제한 버킷이 동시 버스트에 무력화 |
| auth/pin-failcount-no-decay | low | fail_count가 절대 감소하지 않아 오답 1개로 15분 잠금을 무기한 재연장 |
| auth/rate-limit-unknown-ip | low | IP 헤더가 없을 때 모든 클라이언트가 'unknown' 버킷 하나를 공유 |
| auth/pin-kv-fallback-race | low | 0045 미적용 판정이 try/catch라 일시적 D1 오류도 racy한 KV 폴백으로 떨어뜨림 |
| auth/login-csp-unsafe-inline | low | 로그인 페이지 CSP가 'unsafe-inline'을 허용해 인라인 스크립트 주입을 막지 못함 |
| auth/lockout-dos-verify-pin-residual | low | /verify 코드 소진과 PIN 잠금 DoS가 그대로 — 발신자별 상한이 소진 5회보다 높음 |

상세 재현은 `FINDINGS-DETAIL.md`, 기계 판독용 기록은 `findings.json` 참조.

## 3. 커버리지

9개 유닛 중 8개 candidate·1개 covered. `src/index.ts` 미들웨어 유닛은 run-001에서 out_of_scope였으나 이번 run에서 스코프로 들어와 검토됐다 — finding은 없으나 관찰 1건(아래 4절)이 있다. 나머지 스코프 밖 모듈(메모·AI·일정·할 일·스튜디오 등)은 별도 run에서 다룬다.

## 4. finding이 아닌 관찰 (기록용)

1. **미들웨어의 allowlist 이메일 바인딩 부재** (`src/index.ts:36`): 미들웨어가 `verifySessionForEnv(c.env, token)`를 allowlist 이메일 없이 호출해 토큰 이메일 바인딩을 하지 않는다. 토큰은 allowlist 이메일로만 발급되므로 현재는 악용 불가하나 `/me`와 불일치한다. 방어 깊이 차원의 후속 검토 대상.
2. **frame-ancestors 메타 태그 무효**: CSP 메타 태그의 `frame-ancestors`는 스펙상 무시된다(헤더로만 유효). HTTP 헤더 CSP·`X-Frame-Options`가 전무하므로 주석의 '프레임 차단' 주장은 실제로 강제되지 않는다. `auth/login-csp-unsafe-inline`의 remediation에 포함돼 있다.
3. **다른 페이지의 `lucide@latest`**: `public/memo.html`, `schedule.html`, `todo.html`, `search.html`, `memory.html`, `backup.html`은 여전히 SRI 없는 `lucide@latest`를 로드한다. login.html만 이번 스코프이며, 나머지는 후속 run의 후보로 기록한다 (`NEEDS-VALIDATION.md` 참조).

## 5. 조정자가 직접 검증한 항목 (헌터 NOT TESTED 중 해소된 것)

- **SRI 해시와 실제 unpkg 바이트의 일치**: 조정자가 `lucide@0.469.0` 파일을 unpkg에서 직접 받아 SHA-384 해시를 계산했고, login.html의 integrity 값과 일치함을 확인했다. (헌터·검증자는 외부 fetch 금지라 미검증이었음)
- **마이그레이션 0045의 로컬 SQLite 실측**: 조정자가 0043 적용 후 0045를 적용해 컬럼 추가를 확인하고, 실패 UPDATE를 1회·5회 실행해 fail_count 1→5·locked_until 설정·초기화(0·NULL)를 실측했다.
- **전체 Jest**: `npx jest` 216 스위트/3591 테스트 전부 통과, `tsc --noEmit` 클린 (커밋 57b5554 기준).
- **esbuild 번들**: `src/index-inline.ts` 재생성 후 번들 성공, 내장 login.html에 CSP·SRI·고정 버전 포함 확인.

## 6. NOT TESTED

- 실제 D1에서의 `meta.changes` 의미(조건부 INSERT/UPDATE) — Mock이 SQLite/D1 문서 동작을 모델링한 것이며 운영 D1에는 접근하지 않음.
- 실제 Cloudflare KV의 일관성·지연·장애 빈도 — Mock은 강한 일관성 + 인위 지연 모델.
- 운영 요청에 `CF-Connecting-IP`가 실제로 존재하는지 — 라이브 트래픽 없음.
- 마이그레이션 0045의 실제 운영 D1 적용 — 라이브 조회 금지로 미확인 (배포 전 확인 필요, 위 최종 판정 참조).
- 실제 브라우저에서의 CSP/SRI 동작 — 로컬 정적 검증만 수행.
- Jest 전체 스위트 외의 브라우저 QA — 이번 run의 스코프 밖.

## 7. 다음 단계

1. **medium 1건(`auth/pin-lock-gate-stale-read`) 수정 여부 결정** — /verify 패턴(조건부 UPDATE 게이트 선점)을 PIN에 적용하는 것이 검증자들이 제시한 방향이다.
2. **low 8건의 수정 우선순위 결정** — 같은 뿌리끼리 묶어 고치는 것이 효율적이다: (a) 세션 버전 계열 A+B → D1 원자 카운터로 이동 + fail-closed, (b) 속도 제한 계열 D+F+I → D1 원자 카운터 또는 발신자별 예산 재설계, (c) PIN 카운터 계열 C+E+G → 조건부 게이트 + 만료 시 리셋 + 폴백 오류 구분, (d) CSP 계열 H → 인라인 분리 + 헤더 CSP.
3. **0045 운영 적용 + 재배포 승인** — 수정 여부와 무관하게 57b5554 배포 시 0045 단독 적용이 선행되어야 한다.
4. **후속 run 후보**: 다른 페이지의 `lucide@latest`, 미들웨어 allowlist 바인딩, 모듈 단위 standard 감사 확대.
