# Needs Validation — run-004

run-004에서는 needs_validation 판정의 finding이 0건이다 (confirmed 4건 — low 3건 + informational 1건, rejected 0건).
아래는 이번 run에서 finding으로 승격되지 않았으나 후속 확인이 필요한 리드 목록이다.
배포·런타임 확인이 필요한 항목은 운영 접근 없이는 판정할 수 없어 여기에 남긴다.

## 후속 run 후보 (스코프 밖에서 발견 — run-003에서 이월)

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
   login.html에는 deploy_full.py가 CSP 헤더를 붙이나, 다른 페이지의 헤더 CSP는 미확인.

## 이번 run에서 확인됐으나 미수정으로 남긴 항목

4. **전역 백스톱 잔여 DoS** (`auth/rate-limit-global-backstop-dos`, findings.json) —
   수정 방향 2가지((a) 상한 상향 (b) 속도 제한 검사를 자격 증명 검증 뒤로 이동) 중
   설계 결정을 받아야 한다. (b)는 속도 제한의 DoS 방어 역할이 바뀌는 구조 변경이다.
5. **iterations 상한 부재** (`auth/pin-iterations-no-upper-bound`, findings.json) —
   사전 검증에 상한(예: 1,000,000) 추가, 한 줄 변경. 다음 수정 턴에 포함 검토.

## 이번 run의 관찰 (finding 아님 — 후속 판단용)

6. **set-pin 순서 교환의 맞교환 지점** — bump 성공 후 UPSERT이 D1 오류로 실패하면
   버전은 올라가 모든 세션이 무효화되는데 PIN은 구 PIN 그대로 남는다. fail-closed
   방향이나 재시도 시 OTP를 새로 받아야 한다. D1 장애 시에만 발생하는 UX 비용.
7. **pinLoginKvFallback에 KV read-modify-write 잔존** — 0045 미적용 환경 전용 폴백
   경로. 0051 적용 환경에서는 도달하지 않으므로 배포 게이트로 해소된다.
8. **login.js 최상단 lucide.createIcons() 무방비 호출** — 이전 인라인 스크립트에도
   동일하게 있던 기존 동작이라 이번 커밋의 퇴행이 아니다. lucide 로드 실패 시
   로그인 흐름 전체가 멈추는지 여부는 후속 확인 대상.
