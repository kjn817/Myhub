# Findings Detail — run-002

medium 이상은 상세 재현, low는 결정적 재현 요약을 적는다.
기계 판독용 전문은 `findings.json` 참조. 모든 재현은 로컬에서 더미 값만으로 수행됐다.

## medium

### auth/pin-lock-gate-stale-read — PIN 잠금 게이트가 SELECT 시점 값이라 동시 버스트가 5회 예산을 넘긴다

- **파일:** `src/modules/auth/routes.ts` (`:484` SELECT, `:504` 게이트, `:509` verifyPin, `:512-515` 무조건 증가 UPDATE)
- **재현 (헌터·검증자 각자 독립 하네스, 실제 routes.ts import, 상태 저장 Mock D1, 실제 PBKDF2 100k):**

| 시나리오 | 결과 |
|---|---|
| A. 동시 오답 10개, IP 분리 | 전부 401, 버스트 내 429 0건, `fail_count=10`, `locked_until` 설정됨 |
| B. 동시 오답 10개, 동일 IP | 전부 401, `fail_count=10` — `pinip` 10회/시간 제한도 버스트를 막지 못함 |
| C. 순차 오답 6개 (대조군) | 401×5 후 6번째 429, `fail_count=5` — 순차 경로는 정상 |
| D. 버스트 후 후속 요청 | 오답·정답 PIN 모두 429, `locked_until ≈ now+900초` — 버스트 후 잠금은 실효 |
| E. 동시 오답 20개, IP 분리 | 전부 401, `fail_count=20` — 추측 예산이 버스트 크기 N에 비례 |
| F. 잠금 만료 후 오답 1회 | 401 후 즉시 재잠금 (`fail_count=6`, `locked_until` 재설정), 이어 정답 PIN도 429 |

- **실질 예산:** 공격자는 15분 창마다 버스트 1회분(N회 추측)을 얻고, 그 후에는 15분간 전면 차단된다. N=100이면 15분당 100회(시간당 400회, 하루 9,600회)이며 10⁶ 공간 전수에는 약 104일이 걸린다. 큰 N에는 버스트당 N개의 서로 다른 IP가 필요하다.
- **대조:** `/verify`는 `:423`의 `UPDATE ... WHERE email = ? AND attempts < 5`가 실질 게이트로 동작해 동등한 race가 없다. PIN 쪽에는 동등한 조건부 게이트가 없다.
- **Remediation:** `/verify` 패턴을 PIN에 그대로 적용 — PBKDF2 검증 전에 `UPDATE ... WHERE email = ? AND (locked_until IS NULL OR locked_until <= ?)` 조건부 UPDATE로 게이트를 선점하고 `changes==0`이면 429를 반환한 뒤 검증에 들어가지 않는다.

## low — 결정적 재현 요약

### auth/sessver-fail-open
- **파일:** `src/modules/auth/routes.ts` (`:202` catch→0, `:209` bump, `:282` 버전 대조, `:605` set-pin, `:618` logout)
- **재현:** S7a — sessver=1, KV.get 실패 시 v0 `/me` → 200(정상 401), v1 `/me` → 401(정상 200). S7b — sessver=3, KV.get 실패 중 `/logout` → 저장값 3→1 하락, KV 복구 후 v1 `/me` → 200(부활). S7c — `/set-pin` 중 KV.put 실패 시 200 + 토큰 발급, 저장된 버전 없음 → 발급 토큰 `/me` → 401(즉시 무효), 구 OTP 토큰은 여전히 유효.
- **Remediation:** '없음'과 '읽기 실패'를 구분해 fail-closed로 바꾸고, bump put 실패를 호출자에게 전파한다. 근본적으로 D1 원자 카운터로 이동한다.

### auth/sessver-bump-race
- **파일:** `src/modules/auth/routes.ts` (`:208-216` bump, `:605` set-pin 발급, `:618` logout, `:283` 대조)
- **재현:** 직접 bump 2개 동시 × 5 trial 전부 `[1, 1]`·최종값 1(기대 2), 3개 동시 × 5 trial 전부 `[1, 1, 1]`·최종값 1(기대 3). 지연 0ms KV에서도 동일하게 붕괴. 동시 `/set-pin` 2건 10 trial 중 4회에서 두 발급 세션 모두 `/me` 200으로 생존. 순차 bump 3회 → `[1, 2, 3]` 정상. 동시 `/logout` 2건은 최종값 1이나 기존 토큰은 401로 무효화돼 무해.
- **Remediation:** D1 원자 `UPDATE ... RETURNING`으로 이동하거나 발급 직전 버전을 다시 읽어 토큰을 만든다.

### auth/rate-limit-kv-race
- **파일:** `src/modules/auth/routes.ts` (`:300-312` checkRateLimit, 사용처 `:327`·`:331`·`:396`·`:475`)
- **재현:** T1 checkRateLimit 직접 동시 10개 → 전부 false, 최종 카운터 '1'(기대 10). T2 `/request` 동시 5개 → 200×5, `rl:ip:`·전역 `rl:` 모두 '1', OTP 행 1개 생성(순차 대조군은 '5'). T3 `/pin-login` 동시 10개 → 401×10, `pinip:` '1', D1 `fail_count` 10·잠금 설정됨(순차 대조군은 401×5·429×5, `pinip:` '10').
- **Remediation:** Durable Objects 원자 카운터 또는 D1 조건부 UPDATE로 이전한다.

### auth/pin-failcount-no-decay
- **파일:** `src/modules/auth/routes.ts` (`:513` CASE 식, `:519-522` 성공 시 초기화, `:503` 잠금 검사), `migrations/0045_auth_pins_fail_count.sql:10-11`
- **재현 (실 SQLite, better-sqlite3):** 5회 오답 → `fail_count=5`·잠금, 정답 429. 만료 시뮬레이션 후 정답 → 200·카운터 0(소유자 창 존재). 다시 5회 오답 → 만료 후 오답 1개 → 401, `fail_count` 5→6·잠금 재설정, 정답 429. 두 번째 사이클 → `fail_count` 7·재잠금. 잠금 중 OTP → `/set-pin` → `fail_count=0`·복구 확인. KV 폴백 대조군: 오답 5회 → `pinfail=5`, 6번째 429(KV put 추가 없음), KV 시계 +901초 → 카운터 소멸·오답 1개 → 401·카운터 1부터 재시작.
- **Remediation:** 실패 UPDATE 안에서 `locked_until`이 이미 과거면 fail_count를 현재 창 기준으로 재시작하도록 CASE 식을 확장한다 (D1 단일 UPDATE 원자성 유지).

### auth/rate-limit-unknown-ip
- **파일:** `src/modules/auth/routes.ts` (`:291-297` getClientIp, `:296` return 'unknown', 사용처 `:327`·`:396`·`:475`)
- **재현:** 헤더 없이 `/request` 5회(A) → 전부 200, `rl:ip:unknown=5`·전역 `rl:`=5(상한 20 미소진). 헤더 없는 B의 6번째 `/request` → 429(공유 버킷에서 옴이 확정). XFF '203.0.113.1' 5회 200 → 6회째 429, XFF를 바꾸면 각각 200(새 버킷). CF-Connecting-IP가 함께 있으면 조작된 XFF는 무시되고 429 유지. `verifyip:unknown=20`·`pinip:unknown=10` 사전 설정 시 헤더 없는 `/verify`·`/pin-login`도 429.
- **Remediation:** 운영에서는 CF-Connecting-IP만 신뢰하고 XFF를 무시하며, 식별 불가 요청은 per-IP 버킷을 건너뛰고 전역 상한에만 의존하거나 별도의 매우 낮은 공유 상한을 둔다.

### auth/pin-kv-fallback-race
- **파일:** `src/modules/auth/routes.ts` (`:482-489` try/catch, `:486` 바인딩 없는 catch, `:488` useD1Counter=false, `:532-558` 폴백, `:534` KV get, `:550` KV put)
- **재현:** 시나리오 A('no such column') — 동시 오답 10개 전부 401, KV `pinfail` '1', D1 `fail_count` 0·잠금 없음, 11번째 정답 PIN → 200. 시나리오 B('database is locked') — A와 완전히 동일한 결과. 시나리오 C(폴백 순차 대조군) — 오답 6개 순차 → 401×5 후 6번째 429, `pinfail` '5'. 시나리오 D(D1 경로 대조군) — 동시 오답 10개 전부 401, D1 `fail_count` 10·잠금 설정, 11번째 정답 PIN → 429.
- **Remediation:** catch를 오류 구분형으로 바꾸고('no such column' 계열일 때만 폴백, 그 외는 5xx), 0045 적용을 57b5554 운영 배포의 명시적 게이트로 만든다.

### auth/login-csp-unsafe-inline
- **파일:** `public/login.html` (`:15` CSP, `:12-14` 주석, `:19` SRI 태그, `:154`·`:156`·`:162`·`:163`·`:174`·`:175`·`:191`·`:192` onclick 8개, `:197-388` 인라인 스크립트, `:20` 인라인 스타일)
- **재현 (정적 확인):** CSP 문자열에 'unsafe-inline'이 script-src·style-src 양쪽에 존재. SRI 태그 존재(버전 고정 0.469.0, sha384 해시 base64 64자 = 48바이트, crossorigin 있음). 반사/삽입 지점 전무: innerHTML·outerHTML·document.write·insertAdjacentHTML·eval(·new Function·URLSearchParams·location.search·location.hash 전부 없음. DOM 쓰기 17건 모두 textContent 경유. `src/index-inline.ts:81`의 배포 번들 내장본도 CSP·SRI 동일.
- **Remediation:** onclick 8개를 addEventListener로, 인라인 스크립트·스타일을 외부 파일로 분리한 뒤 'unsafe-inline'을 제거하고, CSP를 HTTP 응답 헤더로 발급해 frame-ancestors를 실제로 강제한다.

### auth/lockout-dos-verify-pin-residual
- **파일:** `src/modules/auth/routes.ts` (`:396` /verify 20회, `:413` attempts>=5 삭제, `:423` 원자 UPDATE, `:475` /pin-login 10회, `:504-506` 잠금 429, `:330-331` /request 전역 20회)
- **재현:** /verify 다리 — 공격자 IP 오답 5회 순차 → 전부 400, attempts=5, verifyip 버킷 5(20 미도달). 소유자 다른 IP 정답 → 400 '시도 횟수 초과', otp 행 삭제됨. PIN 다리 — 공격자 IP 오답 PIN 5회 → 전부 401, fail_count=5·잠금, pinip 버킷 5(10 미도달). 소유자 다른 IP 정답 PIN → 429. 전역 소진 — 4개 IP에서 /request 5회씩 → 20회 전부 200, 전역 rl 20. 소유자 다른 IP /request → 429. 복구 — /verify 소진 후 소유자 재요청 200 → 새 코드 → 정답 /verify 200. PIN 잠금 중 OTP /verify 200 → /set-pin 200 → fail_count=0 → 새 PIN 로그인 200. PIN 잠금 중에도 /me 200.
- **Remediation:** 5회 소진 예산을 발신자별 버킷으로 잡고 전역 상한은 훨씬 높은 백스톱으로만 두거나, 정답 제출은 카운터와 무관하게 성공시킨다. /verify 소진 후 재요청은 전역 버킷과 분리된 복구 버킷으로 허용한다.
