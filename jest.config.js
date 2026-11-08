export default {
  testEnvironment: 'node',
  // Track A (2026-10-29): 플레이크 실패 시 테스트명·조건을 reports/flake-failures.jsonl에
  // 자동 기록하는 리포터. 기본 출력은 'default'가 그대로 담당한다.
  reporters: ['default', '<rootDir>/jest-flake-reporter.cjs'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/tests/e2e/',  // Playwright E2E 테스트는 Jest에서 제외
    '/tests/runtime/',  // miniflare 실런타임 테스트는 vitest가 담당 (npm run test:runtime)
    '/poc/',  // POC 전용 vitest 설정으로 별도 실행 (poc/oauth-provider-v1/vitest.config.ts)
    'studio-workspace.real.test.ts',  // tsx 전용 스크립트 (npx tsx로 실행)
  ],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        target: 'ES2020',
        module: 'commonjs',
        esModuleInterop: true,
        skipLibCheck: true,
        strict: false,
        types: ['jest', 'node', '@cloudflare/workers-types'],
      },
      // strict:false에서는 boolean-literal discriminant narrowing(TS2339)이
      // 오탐으로 발생한다. 프로젝트 tsc(strict:true)는 통과하므로 해당 코드만 무시.
      diagnostics: { ignoreCodes: [2339] },
    }],
    // MSW v2의 ESM 전용 전이 의존성(rettime·until-async·@open-draft)만
    // CJS로 변환한다. msw/@mswjs 본체는 CJS 빌드라 변환 대상이 아니다.
    // (2026-10-27 MSW 적용 — docs/msw-20261027.md 참조)
    '/node_modules/(rettime|until-async|@open-draft)/.+\\.m?js$': ['ts-jest', {
      tsconfig: {
        target: 'ES2020',
        module: 'commonjs',
        moduleResolution: 'node',
        esModuleInterop: true,
        allowJs: true,
        skipLibCheck: true,
        strict: false,
      },
      diagnostics: false,
    }],
  },
  // 위 ESM 전용 패키지만 transformIgnorePatterns에서 제외한다.
  transformIgnorePatterns: [
    '/node_modules/(?!(rettime|until-async|@open-draft)/)',
  ],
  testMatch: [
    '**/tests/**/*.test.ts',
    '**/tests/**/*.test.js',
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index-inline.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text'],
};
