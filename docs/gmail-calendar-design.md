# Gmail · Google Calendar 연동 설계안

> 진짜 비서 프로그램 3단계 g트랙 — 설계 우선.
> 작성일: 2026-10-26. 상태: 설계 v1 + 읽기 경로 구현 완료, 쓰기 scope·토큰 저장 최종 선택은 **결정 필요**.
> 참고 패턴: Khoj식 이메일·문서 검색, Leon식 일정·이메일 스킬 — 개념만 참고, 코드 복사 없음.

## 1. 목표와 비목표

### 목표
- 사용자가 "내일 일정 알려줘", "○○ 관련 메일 찾아줘"라고 물으면 MyHub 로컬 일정·메모와 함께 **Google 캘린더 일정 / Gmail 메일**을 답에 포함한다.
- 연동은 **단일 사용자 전용**이다 (MyHub 자체가 단일 사용자 시스템). 다중 Google 계정은 지원하지 않는다.
- 토큰이 없을 때 기존 기능은 그대로 동작하고, 비서는 "연동이 안 되어 있어요"라고 안내한다.

### 비목표 (이번 트랙에서 하지 않음)
- Gmail 발송·메일 삭제·캘린더 공유 설정 변경 (쓰기 범위는 결정 필요 — §3).
- Google push notification (watch 채널) — Cron pull로 시작하고, push는 사용량·운영 부담을 보고 후속 판단 (§6).
- 메일 본문 전체를 D1에 미러링 — 본문은 API에서 읽을 때만 가져오고 저장하지 않는다 (§5).

## 2. OAuth 흐름

Google OAuth 2.0 **authorization code + PKCE(S256)** 를 사용한다.
Client secret을 Worker secret으로 두는 것만으로는 부족하다 — authorization code 교환은
서버 측에서 일어나므로 Worker secret 사용이 맞고, PKCE는 혹시 redirect가 가로채질 경우를 막는
두 번째 잠금이다.

```
사용자                MyHub Worker                 Google
  │  GET /api/google/oauth/start?mode=read        │
  │ ─────────────────────────────────────────▶  │  state+PKCE 생성, KV에 10분 저장
  │  302 → accounts.google.com/o/oauth2/v2/auth  │
  │ ─────────────────────────────────────────────────────────▶  │  동의 화면
  │ ◀── 302 /api/google/oauth/callback?code&state ────────────── │
  │  GET /api/google/oauth/callback               │
  │ ─────────────────────────────────────────▶  │  state 검증(KV 1회용) →
  │                                               │  POST /token (code+verifier)
  │                                               │  ◀── access+refresh token
  │  토큰 암호화 후 D1 저장 → /schedule.html?google=connected 로 리다이렉트
```

- **redirect URI**: `https://<Worker 호스트>/api/google/oauth/callback`
  요청 호스트에서 파생하므로 스테이징·운영이 각자 URI를 쓴다.
  Google Cloud 콘솔에는 **두 URI 모두 등록**해야 한다 (결정 필요 §9-①).
- **state**: 32바이트 난수 → KV `google:oauth:state:<nonce>` 에 `{verifier, mode, createdAt}` 저장,
  TTL 600초, 콜백에서 1회 조회 후 삭제. 불일치·만료·재사용 시 콜백을 400으로 거부한다.
- **PKCE**: `code_verifier` 43~128자 난수, `code_challenge = BASE64URL(SHA-256(verifier))`.
- **에러 처리**: 사용자가 동의를 거부하면 Google이 `error=access_denied`로 콜백한다 —
  이 경우 토큰을 저장하지 않고 `/schedule.html?google=denied` 로 보낸다.
- **Client ID/Secret 미설정 시**: `/oauth/start`는 503 `google_oauth_not_configured`를 반환하고,
  그 외 모든 연동 API는 `google_not_connected`를 반환한다. 기존 기능에는 영향이 없다.

## 3. Scope — 최소 범위 (결정 필요)

| 용도 | Scope | 상태 |
|---|---|---|
| 캘린더 읽기 | `https://www.googleapis.com/auth/calendar.readonly` | **기본값 — 구현됨** |
| Gmail 읽기 | `https://www.googleapis.com/auth/gmail.readonly` | **기본값 — 구현됨** |
| 캘린더 쓰기 (일정 생성) | `https://www.googleapis.com/auth/calendar.events` | **결정 필요** — 코드상 `GCAL_CREATE`는 이 scope가 없으면 `scope_missing`으로 거부 |
| Gmail 발송 | `https://www.googleapis.com/auth/gmail.send` | 이번 트랙 범위 밖 — 요청하지 않음 |

- **기본 동의는 읽기 전용**이다. 쓰기를 켜려면 사용자가 Google 콘솔에서 scope를 추가 승인해야
  하고, 기존 refresh token은 scope가 좁으므로 **재동의(재인증)가 필요**하다.
- `mode=read | write` 파라미터로 시작 시점에 scope 집합을 고른다.
  `mode=write`는 쓰기 scope 결정이 끝나기 전에는 시작 엔드포인트에서 400으로 막힌다
  (구현: `GOOGLE_WRITE_ENABLED` 플래그 — 기본 `false`, 결정 후 명시적으로 켜는 방식).
- Gmail 전체 접근(`https://mail.google.com/`) scope는 절대 사용하지 않는다.

## 4. 토큰 저장 — 옵션 비교 (결정 필요)

Worker secrets는 **배포 시점에 정해지는 정적 값**이라 런타임에 발급받는 사용자 OAuth 토큰을
넣을 수 없다. 따라서 런타임 토큰 저장소는 D1 또는 KV 중 하나다.

| | D1 + AES-GCM 암호화 (구현된 기본안) | KV (대안) |
|---|---|---|
| 저장 | `google_integrations` 행 1개 (provider='google'), 토큰은 `MEMO_ENCRYPTION_KEY`로 AES-GCM 암호화 (`ENC:` 접두) | KV 키 `google:tokens` 에 암호화 JSON |
| 장점 | 기존 암호화 인프라(`src/services/crypto.ts`) 재사용, 감사·동기화 로그와 같은 DB에 있음, Time Travel 백업 대상 | 읽기 빠름, TTL 만료 내장 |
| 단점 | D1 행이 통째로 유출되면 키만 있으면 복호화 가능 (키와 DB가 분리되어 있어 단독 유출로는 불가) | 값 조회 API가 있어 오남용 위험, 백업·감사 로그와 분리됨 |
| 갱신 | access 만료 60초 전이면 refresh token으로 교환 후 D1 UPDATE (동시 갱신은 `expires_at` 조건부 UPDATE로 1회만 수행) | 동일 로직, KV CAS 없음 — 선점 로직 별도 필요 |
| 철회 | Google revoke API 호출(베스트 에포트) 후 D1 행 삭제 | 동일 |

- **구현된 기본안: D1 + AES-GCM.** 최종 선택은 사용자에게 달렸고(§9-③),
  선택이 바뀌면 `src/services/google-tokens.ts`의 저장소 함수만 교체하면 된다
  (호출부·클라이언트는 저장소 인터페이스에만 의존).
- **절대 저장하지 않는 것**: 평문 토큰, client secret, 토큰을 포함한 로그·에러 메시지.
  토큰 값은 어떤 로그·AI 프롬프트·디버그 출력에도 들어가지 않는다.
- **만료·철회 처리**:
  - access 만료 시 refresh로 자동 교환. refresh 실패(`invalid_grant`) → status를 `revoked`로
    바꾸고 비서는 "구글 연동을 다시 연결해 주세요"라고 안내한다 (재동의 필요).
  - 사용자가 Google 계정 설정에서 직접 접근을 철회해도 동일하게 `invalid_grant`로 감지된다.
  - 연동 해제(`POST /api/google/disconnect`): revoke API 호출 후 D1 행 삭제.
    revoke 호출 실패 시에도 로컬 행은 삭제한다 (로컬에 토큰을 남기지 않는 것이 우선).

## 5. 개인정보 경계 — 연동 데이터의 AI 전송 규칙

잠긴 메모의 차단 원칙을 연동 데이터에도 그대로 적용한다.
메일·일정은 **기본적으로 민감 정보로 취급**한다.

| 규칙 | 내용 |
|---|---|
| 본문 절단 | Gmail 본문은 AI 전송 시 최대 2,000자까지만, 나머지는 버린다. 첨부파일은 절대 전송하지 않는다 (파일명도 제외). |
| 시크릿 마스킹 | `maskSecrets()`를 본문·제목·일정 설명에 모두 적용한다 (카드번호·API 키·`password=` 등). |
| 참석자 이메일 | 캘린더 참석자 이메일 주소는 AI에 보내지 않는다. 참석자 수만 전달한다. |
| 범위 제한 | 검색은 사용자가 물은 키워드·기간으로만 조회한다. "메일 전부 요약해줘" 같은 전체 스캔 요청은 거부한다 (최대 10건). |
| 저장 금지 | 메일 본문·일정 설명 전문을 D1에 미러링하지 않는다. 동기화 로그에는 건수·기간·성공 여부만 남긴다. |
| 잠긴 메모와 동일 | 연동 데이터를 AI에 넘기는 경로는 `src/services/google-privacy.ts`의 sanitize 함수만 통한다. 우회 경로 금지. |
| 사용자 본인 화면 | 대시보드에서 본인이 직접 보는 메일·일정은 원문 표시가 허용된다 (AI 전송이 아니므로). 단, API 응답에도 첨부파일 바이너리는 포함하지 않는다. |

## 6. 동기화 — Cron pull (push는 후속)

- **방식: 주기적 pull.** Cloudflare Cron 트리거(5분 틱)에서 `handleGoogleSync`가
  30분에 1회만 실행된다 (KV `google:sync:last` 마커로 간격 제어).
- **동기화 내용 (읽기만)**: 오늘~내일 캘린더 이벤트 목록 + 읽지 않은 메일 최대 10건의
  헤더(발신자·제목·스니펫). 본문 전문은 가져오지 않는다.
- **저장**: `google_sync_log`에 `{kind, status, detail(건수), created_at}`만 기록한다.
  이벤트·메일 원문은 D1에 저장하지 않는다 — 조회 시점에 Google API에서 다시 읽는다.
- **실패 처리**: API 오류·토큰 만료는 로그에 남기고 조용히 건너뛴다 (fail-soft).
  Cron 핸들러가 예외로 죽지 않는다. 3회 연속 실패 시 다음 성공까지 간격을 두 배로 늘리지 않고
  그대로 30분 간격을 유지한다 (단순 유지 — 지수 백오프는 후속 과제).
- **Push notification 대안**: Gmail `watch` + Calendar `events.watch`는
  별도 HTTPS 엔드포인트·채널 갱신·구독 관리가 필요해 이번 트랙에서 제외한다.
  pull로 충분한지(30분 지연) 사용해 보고 판단한다.

## 7. API · 모듈 목록 (구현됨)

| 경로 | 설명 |
|---|---|
| `GET /api/google/status` | 연동 상태 (연결 여부·이메일·scope·마지막 동기화) |
| `GET /api/google/oauth/start?mode=read\|write` | OAuth 시작 (Google 동의 화면으로 302) |
| `GET /api/google/oauth/callback?code&state` | 토큰 교환·저장 후 대시보드로 리다이렉트 |
| `POST /api/google/disconnect` | 철회 + 로컬 토큰 삭제 |
| `GET /api/google/gmail/search?q=&max=` | 메일 검색 (헤더+스니펫+본문 절단) |
| `GET /api/google/gmail/:id` | 메일 단건 조회 |
| `GET /api/google/calendar/events?from&to` | 기간 내 이벤트 |
| `POST /api/google/calendar/events` | 일정 생성 (쓰기 scope 결정 전에는 `scope_missing`) |

AI 마커 (캘리·루미가 사용, `src/services/google-tools.ts`):
`[GMAIL_SEARCH]{"q": "..."}[/GMAIL_SEARCH]`, `[GMAIL_GET]{"id": "..."}[/GMAIL_GET]`,
`[GCAL_LIST]{"from": "YYYY-MM-DD", "to": "YYYY-MM-DD"}[/GCAL_LIST]`,
`[GCAL_CREATE]{"title": "...", "start_at": "..."}[/GCAL_CREATE]` (쓰기 도구 — 승인 게이트 대상).

- `GCAL_LIST` 실행 시 로컬 `schedules` 조회 결과와 Google 이벤트를 합쳐서 반환한다
  ("내일 일정 알려줘"가 두 출처를 모두 보여준다). 중복 제거는 하지 않는다 —
  로컬 일정과 Google 일정은 별개 출처이며, 제목·시간이 같아도 합치지 않는다.
- 토큰이 없으면 마커 실행기는 `Google 연동이 안 되어 있어요. 일정 화면 상단의 Google 연동에서 계정을 연결하면 Gmail·캘린더를 함께 볼 수 있어요.`
  라는 안내 문장으로 마커를 교체한다. 기존 로컬 일정 조회에는 영향이 없다.

## 8. 실패 · 철회 절차

| 상황 | 동작 |
|---|---|
| OAuth 미설정 (Client ID 없음) | start 503, 나머지 연동 API `google_not_connected`. 기존 기능 정상. |
| 사용자 동의 거부 | 토큰 저장 안 함, `?google=denied`로 복귀. |
| state 불일치·만료·재사용 | 콜백 400 `invalid_state`. 토큰 저장 안 함. |
| access 만료 | refresh 자동 교환 (60초 여유). |
| refresh 무효 (`invalid_grant`) | status `revoked`, 재연동 안내. 로컬 토큰은 즉시 파기한다. |
| Google API 429/5xx | 해당 호출만 실패로 기록, Cron은 다음 틱에 재시도. 사용자에게는 "구글에서 잠시 응답이 없어요" 안내. |
| 연동 해제 | revoke 베스트 에포트 + D1 행 삭제 + 동기화 마커 삭제. |
| 키 교체 (MEMO_ENCRYPTION_KEY 변경) | 기존 암호화 토큰은 복호화 불가 → 전원 `revoked` 취급, 재연동 안내. (키 교체는 토큰 재발급을 동반한다.) |

## 9. 결정 필요 목록 (사용자가 정해야 할 것)

- [ ] **① OAuth 클라이언트 발급 주체·redirect URI**: 사용자가 Google Cloud 콘솔에서 직접
  OAuth 2.0 클라이언트(ID 유형: 웹 애플리케이션)를 만들고, Client ID/Secret을 Worker secret
  (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`)으로 등록한다.
  등록할 redirect URI: `https://myhub.myhub-app.workers.dev/api/google/oauth/callback`
  (스테이징은 `https://myhub-staging.<서브도메인>/api/google/oauth/callback` — 스테이징 호스트 확정 후 추가).
  **이 결정 없이는 실제 연동 테스트가 불가능하다** — 코드·모의 테스트는 완료된 상태다.
- [ ] **② Scope 범위**: 읽기 전용으로 시작할지, 캘린더 쓰기(`calendar.events`)까지 한 번에
  받을지. 쓰기를 켜면 `GOOGLE_WRITE_ENABLED` 플래그를 명시적으로 `true`로 바꿔야 하고,
  이미 연동한 계정은 재동의가 필요하다.
- [ ] **③ 토큰 저장소 최종 선택**: D1 + AES-GCM(구현된 기본안) 유지 vs KV로 변경.
  KV를 고르면 저장소 함수만 교체하면 된다.
- [ ] **④ 동기화 주기**: 30분 pull 유지 vs 더 짧게(15분) vs push notification 도입.
  30분보다 짧게 하면 Gmail/Calendar API 할당량 소모가 늘어난다.
- [ ] **⑤ 스테이징 테스트 계정**: 스테이징에서 연동 테스트를 할 Google 계정
  (운영 계정과 분리할지 여부). OAuth 동의 화면이 "테스트" 상태면 테스트 사용자 등록이 필요하다.

## 10. 테스트 계획

- 단위: OAuth URL 생성·PKCE·state 검증, 토큰 교환/갱신(모의 fetch), Gmail/Calendar
  클라이언트 파싱(모의 Google API 응답), 개인정보 sanitize(마스킹·절단·참석자 제외),
  마커 파싱·실행(미연동 안내·로컬+Google 일정 합치기).
- 통합: FakeD1 + 모의 fetch로 OAuth 콜백 → 토큰 저장 → Gmail 검색 → 캘린더 조회
  전체 경로를 메모리에서 실행. 실제 Google API 호출 없음.
- NOT TESTED: 실제 Google 콘솔 OAuth 동의·토큰 교환·실계정 메일/캘린더 조회
  (결정 ① 이후 사용자 실계정으로 확인 필요), Cloudflare Cron 실동작(배포 후),
  스테이징·운영 redirect URI 실동작.
