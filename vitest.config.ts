/**
 * miniflare 실런타임 테스트 설정 (트랙 C7, 2-7절).
 *
 * - Jest를 대체하지 않는다. 런타임 의존도가 높은 경로(인증 미들웨어·D1
 *   마이그레이션·뉴스 체인 시간 예산)만 `tests/runtime/`에서 실런타임으로
 *   검증한다. 단위 테스트는 계속 Jest가 담당한다.
 * - 엔트리는 배포 생성물(`src/index-inline.ts`)이 아니라 소스
 *   (`src/index.ts`)를 쓴다. wrangler.toml의 main은 배포용으로
 *   `src/index-inline.ts`를 가리킨 채로 둔다 (건드리지 말 것).
 * - 바인딩은 전부 로컬 전용이다. 운영 D1/KV ID를 쓰지 않으며, D1은 테스트
 *   파일마다 격리된 로컬 SQLite이다. 운영 DB·운영 배포·OTP 라이브 호출 없음.
 * - miniflare는 로컬 시뮬레이터라 실제 egress(Google News RSS 503, Exa의
 *   가짜 publishedDate 등)는 재현하지 못한다. "실런타임 ≠ 실망" — 라이브
 *   평가는 promptfoo 하네스(`tests/evals/`)가 담당한다.
 */
import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      // 소스 엔트리 (배포 생성물 src/index-inline.ts가 아님)
      main: './src/index.ts',
      miniflare: {
        compatibilityDate: '2026-10-01',
        // 로컬 전용 식별자 — 운영 D1/KV ID가 아니다.
        d1Databases: { DB: 'myhub-runtime-test-db' },
        kvNamespaces: ['KV'],
        // miniflare는 평문 var도 `bindings`로 받는다 (`vars` 키는 무시된다).
        bindings: {
          APP_NAME: 'MyHub',
          ENVIRONMENT: 'test',
          // 테스트 전용 값. 운영 SESSION_SECRET이 아니다.
          SESSION_SECRET: 'runtime-test-only-session-secret-not-for-production',
          // 테스트 전용 값. 운영 MEMO_ENCRYPTION_KEY가 아니다.
          // Google 토큰 시드·복호화(google-write.test.ts)가 같은 키를 쓴다.
          MEMO_ENCRYPTION_KEY: 'runtime-test-only-memo-key',
          // 테스트 전용 더미 값. 운영 GOOGLE_CLIENT_ID/SECRET이 아니다.
          // /oauth/start 라우트(isGoogleOAuthConfigured)가 필요로 한다.
          // 실제 Google 호출은 하지 않는다 (동의 URL 생성까지만 검증).
          GOOGLE_CLIENT_ID: 'runtime-test-client-id',
          GOOGLE_CLIENT_SECRET: 'runtime-test-client-secret',
        },
        assets: {
          directory: './public',
          binding: 'ASSETS',
          run_worker_first: true,
        },
      },
    }),
  ],
  test: {
    include: ['tests/runtime/**/*.test.ts'],
    // workerd 부팅 + D1 마이그레이션 전수 적용이 있어 단위 테스트 기본값(5초)
    // 으로는 부족하다.
    testTimeout: 15000,
  },
})
