import { defineConfig } from 'vitest/config'

/**
 * POC 전용 vitest 설정 — 메인 vitest.config.ts(tests/runtime/**)와 별개이다.
 * createTestHarness가 두 Worker를 workerd로 띄우고 마이그레이션까지 적용하므로
 * 타임아웃을 넉넉히 둔다.
 */
export default defineConfig({
  test: {
    include: ['e2e.test.ts'],
    testTimeout: 120000,
    hookTimeout: 120000,
  },
})
