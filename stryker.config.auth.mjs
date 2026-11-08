/**
 * StrykerJS — 인증(PIN 잠금) 기준선용 별도 설정
 *
 * 기본 설정(stryker.config.mjs)과 나누는 이유: PIN 잠금 테스트는
 * auth 전용 스위트 3개로 돌려야 mutant마다 전체 스위트를 안 돈다.
 * - mutate: src/modules/auth/routes.ts (PIN 로그인·OTP·세션·속도 제한)
 * - testMatch: PIN 잠금 게이트·인증 라우트·저수준 수정 검증 스위트
 *
 * 실행: npx stryker run --config stryker.config.auth.mjs
 * (npm run test:mutation은 기본 설정 5개 파일을 돈다)
 */
export default {
  $schema: './node_modules/@stryker-mutator/core/schema/stryker-schema.json',
  mutate: ['src/modules/auth/routes.ts'],
  testRunner: 'jest',
  jest: {
    projectType: 'custom',
    configFile: 'jest.config.js',
    config: {
      testMatch: [
        '<rootDir>/tests/unit/auth-pin-gate.test.ts',
        '<rootDir>/tests/unit/auth-routes.test.ts',
        '<rootDir>/tests/unit/auth-low-fixes.test.ts',
      ],
    },
    enableFindRelatedTests: true,
  },
  // checkers: 기본 설정과 동일하게 끈다 (VM 메모리 제약 — stryker.config.mjs 참조).
  checkers: [],
  reporters: ['clear-text', 'json', 'html'],
  coverageAnalysis: 'perTest',
  timeoutMS: 60000,
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
}
