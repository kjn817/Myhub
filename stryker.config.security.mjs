/**
 * StrykerJS — 보안 핵심 범위 측정용 설정 (2026-10-29 동일 트리 재측정 전용)
 *
 * 배경: GPT 외부 평가가 "커버리지·뮤테이션 수치는 측정 트리·범위가 달라
 * 한 묶음으로 주장할 수 없다"고 지적했다. 이 설정은 같은 커밋(e9d6726)에서
 * 보안 핵심 범위를 새로 측정하기 위해 추가한 측정 도구 설정이다.
 * (docs/quality-measurement-20261029.md 참조)
 *
 * - mutate: 보안 핵심 8개 파일
 *   - src/services/crypto.ts — AES-GCM 암복호화·isEncrypted 판정
 *   - src/services/ai-access.ts — AI 접근 계층 (잠긴 메모 경계)
 *   - src/modules/memo/routes.ts — 메모 잠금/해제·잠금 인지 PUT·소유자 복호화
 *   - src/modules/mcp/{routes,server,tasks,tokens,tools}.ts — MCP 서버·토큰
 * - 인증(src/modules/auth/routes.ts)은 기존 stryker.config.auth.mjs로 별도 측정.
 * - testMatch: 위 파일을 직접 import하는 Jest 스위트만 풀(pool)로 제한한다.
 *   coverageAnalysis perTest + enableFindRelatedTests로 뮤턴트별 커버
 *   테스트만 실행된다. tests/runtime/(vitest·miniflare) 스위트는 Jest
 *   러너로 돌릴 수 없어 풀에 없다 — 런타임에서만 커버되는 뮤턴트는
 *   survived로 보일 수 있다 (기준선 해석 시 감안할 것).
 * - checkers: 기본 설정과 동일하게 끈다 (VM 메모리 제약 — stryker.config.mjs 참조).
 *
 * 실행: npx stryker run --config stryker.config.security.mjs
 */
export default {
  $schema: './node_modules/@stryker-mutator/core/schema/stryker-schema.json',
  mutate: [
    'src/services/crypto.ts',
    'src/services/ai-access.ts',
    'src/modules/memo/routes.ts',
    'src/modules/mcp/routes.ts',
    'src/modules/mcp/server.ts',
    'src/modules/mcp/tasks.ts',
    'src/modules/mcp/tokens.ts',
    'src/modules/mcp/tools.ts',
  ],
  testRunner: 'jest',
  jest: {
    projectType: 'custom',
    configFile: 'jest.config.js',
    config: {
      testMatch: [
        '<rootDir>/tests/unit/svc-crypto.test.ts',
        '<rootDir>/tests/unit/memo-routes.test.ts',
        '<rootDir>/tests/unit/coverage-final-cov.test.ts',
        '<rootDir>/tests/unit/svc2-ai-access.test.ts',
        '<rootDir>/tests/unit/ai-policy-guard.test.ts',
        '<rootDir>/tests/unit/mcp-routes-cov.test.ts',
        '<rootDir>/tests/unit/mcp-server-cov.test.ts',
        '<rootDir>/tests/unit/mcp-tokens-cov.test.ts',
        '<rootDir>/tests/unit/mcp-tools-cov.test.ts',
        '<rootDir>/tests/mcp-tokens.test.ts',
        '<rootDir>/tests/mcp-tasks.test.ts',
        '<rootDir>/tests/mcp-tools.test.ts',
        '<rootDir>/tests/google-services-cov.test.ts',
      ],
    },
    enableFindRelatedTests: true,
  },
  checkers: [],
  reporters: ['clear-text', 'json', 'html'],
  coverageAnalysis: 'perTest',
  timeoutMS: 60000,
  maxConcurrentTestRunners: 2,
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
}
