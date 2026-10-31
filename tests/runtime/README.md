# 실런타임 테스트 (`tests/runtime/`)

miniflare(실제 workerd 런타임) 기반 테스트. Jest + mock으로 99% 커버리지를
달성했어도 라이브에서만 터지는 결함(Exa 날짜·RSS 503·FC)이 반복됐기 때문에,
mock이 "믿는 것"만 검증한다는 한계를 보완한다.

## 실행

```sh
npm run test:runtime
```

## 범위 — 여기에는 런타임 의존도가 높은 경로만 둔다

| 파일 | 검증하는 것 |
| --- | --- |
| `auth-middleware.test.ts` | 인증 미들웨어 경로 체크(`?` 분리), HMAC 세션 실제 검증, 세션 버전 D1 대조 |
| `d1-migrations.test.ts` | 마이그레이션 전수 적용 후 스키마, FTS5 삭제(0030 재발 방지), 0051 원자 카운터 |
| `news-chain.test.ts` | 뉴스 체인 전체 시간 예산(hang에도 deadline 안에 종료), 신선도 하드 필터 |

단위 테스트는 계속 Jest가 담당한다. Jest를 버리거나 교체하지 않는다
(`tests/runtime/`은 `jest.config.js`의 `testPathIgnorePatterns`에서 제외됨).

## 실런타임 ≠ 실망 — 한계 명시

miniflare는 **로컬 시뮬레이터**라 실제 egress를 재현하지 못한다:

- Google News RSS 503 (Worker egress 차단) — miniflare의 fetch는 로컬
  네트워크를 타므로 503이 재현되지 않는다. RSS 장애 대응은 체인의
  `statuses` 기록 + 다음 소스 계속 여부로만 검증한다.
- Exa의 가짜 `publishedDate` — 실제 Exa 응답이 없으면 재현되지 않는다.
  URL 날짜 가드·자정 UTC 규칙은 stub 응답으로 검증한다.
- 실제 모델 호출(Gemini/NVIDIA/Groq), OTP 메일 발송 — 이 디렉토리에서
  호출하지 않는다.
- miniflare 에셋 라우터는 `.html` 요청을 확장자 없는 URL로 307 정규화한다
  (`/login.html` → `/login`). 운영은 `/login.html`을 인라인 라우트에서
  직접 서빙하므로 200이다. 인증 테스트는 그래서 `/login.html?v=123`에
  대해 "미들웨어 302가 아니다"를 검증한다 (200 단언이 아님).

라이브 평가는 promptfoo 하네스(`tests/evals/`)가 담당한다.

## 주의

- 바인딩은 전부 로컬 전용이다 (`vitest.config.ts` 참조). 운영 D1/KV ID를
  쓰지 않으며, D1은 테스트 파일마다 격리된 로컬 SQLite이다.
- 엔트리는 소스(`src/index.ts`)이다. 배포 생성물(`src/index-inline.ts`)은
  테스트하지 않는다. `wrangler.toml`의 `main`은 배포용으로
  `src/index-inline.ts`를 가리킨 채로 둔다.
- `import { env, exports } from 'cloudflare:workers'`가 테스트의 진입점이다
  (`cloudflare:test`의 `env`/`SELF`는 deprecated).
- D1 마이그레이션은 miniflare에 자동 적용 옵션이 없어
  `helpers/apply-migrations.ts`가 `migrations/*.sql`을 `?raw`로 읽어
  순서대로 적용한다.
