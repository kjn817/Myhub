# Needs Validation — run-003

run-003에서는 needs_validation 판정의 finding이 0건이다 (confirmed 3건 — low 2건 + informational 1건, rejected 0건).
아래는 이번 run에서 finding으로 승격되지 않았으나 후속 확인이 필요한 리드 목록이다.
배포·런타임 확인이 필요한 항목은 운영 접근 없이는 판정할 수 없어 여기에 남긴다.

## 후속 run 후보 (스코프 밖에서 발견 — run-002에서 이월)

1. **다른 페이지의 `lucide@latest`** — `public/memo.html`, `schedule.html`, `todo.html`,
   `search.html`, `memory.html`, `backup.html`이 여전히 SRI 없는 `lucide@latest`를 로드한다.
   login.html만 run-002 스코프였고 나머지는 확인하지 않았다. 후속 run에서 페이지 단위
   standard 감사로 다룰 것 (고정 버전+SRI 또는 로컬 번들 적용 여부).
2. **미들웨어의 allowlist 이메일 바인딩 부재** (`src/index.ts:36`) — 미들웨어가
   `verifySessionForEnv(c.env, token)`를 allowlist 이메일 없이 호출한다. 토큰은
   allowlist 이메일로만 발급되므로 현재는 악용 불가하나 `/me`와 불일치한다.
   방어 깊이 차원의 후속 검토 대상.
3. **CSP frame-ancestors 메타 태그 무효** — 메타 태그의 `frame-ancestors`는 스펙상
   무시된다(헤더로만 유효). HTTP 헤더 CSP·`X-Frame-Options`가 전무하다.
   `auth/login-csp-unsafe-inline`의 remediation(헤더 CSP 발급)에 포함돼 있다.

## 런타임 확인 필요 (운영 접근 없이는 판정 불가)

4. **마이그레이션 0045의 운영 D1 적용 여부** — 라이브 조회 금지로 미확인이다.
   cf80259 운영 배포 전 반드시 확인할 것 (배포 게이트). 코드만 배포되고 0045가
   빠지면 run-001 medium(`auth/pin-lockout-kv-race`)이 통째로 되돌아간다
   (`auth/pin-kv-fallback-race` 참조).
5. **실제 D1에서의 `meta.changes` 의미** — 조건부 UPDATE의 changes 판정은
   Mock이 SQLite/D1 문서 동작을 모델링한 것이며 운영 D1에서 실측하지 않았다.
6. **실제 Cloudflare KV의 일관성·지연·장애 빈도** — Mock은 강한 일관성 + 인위 지연
   모델이다. KV 장애 시 fail-open(`auth/sessver-fail-open`)의 실제 발생 빈도는
   운영에서만 알 수 있다.
7. **실제 D1 동시성** — 게이트 선점 UPDATE의 동시 버스트 억제는 로컬 하네스에서만
   확인했다. 실제 D1에서의 동시 요청 경합은 미확인이다.
8. **fail_count NULL 행** — 마이그레이션 0045 적용 전 행(기존 auth_pins 행)의
   fail_count NULL 상태에서의 게이트 동작은 미확인이다.
