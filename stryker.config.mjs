/**
 * StrykerJS 뮤테이션 테스팅 설정 (기준선)
 *
 * 스코프를 좁게 잡는다 (docs/github-test-ai-research-20261027.md 1-1절 권장):
 * 전 파일을 돌리지 않고, 뉴스 날짜 필터·기사 날짜 검증·마커 파서·인용 잠금
 * 같은 순수 로직부터. Workers 런타임 코드(D1 바인딩·fetch 등)는 Jest
 * 러너로 돌릴 수 있는 부분만 대상으로 삼는다.
 *
 * - mutate: 대상 소스 파일 5개
 *   - src/lib/news-summary.ts — 뉴스 창 하드 필터·URL 날짜 추출·출처 검증
 *   - src/services/news-sources.ts — 뉴스 소스 체인 (fetch 주입 테스트)
 *   - src/services/article-date.ts — 기사 HTML 날짜 직접 검증
 *   - src/lib/search-marker.ts — [SEARCH:] 마커 정규화·추출 (순수)
 *   - src/lib/citation-lock.ts — 인용 잠금 공용 코어 (순수)
 * - testRunner: jest (프로젝트 jest.config.js 그대로 사용)
 * - jest.config.testMatch: 대상 파일을 직접 커버하는 단위 테스트만으로
 *   제한한다. 전체 스위트(5000+ 테스트)는 뮤턴트마다 돌리기엔 너무
 *   느리고, 이 파일들의 성질은 아래 스위트가 직접 검증한다.
 *   (주의: 이 제한 때문에 다른 스위트에서만 잡히는 뮤턴트는
 *   survived로 보일 수 있다 — 기준선 해석 시 감안할 것)
 * - checkers: typescript — 컴파일 안 되는 뮤턴트는 제외한다.
 *   (2026-10-27: 이 VM에서는 메모리 문제로 꺼둠 — 아래 checkers 항목 참조)
 * - reporters: clear-text + json + html (reports/mutation/)
 *
 * 실행: npm run test:mutation (또는 npx stryker run)
 * CI 게이트(스코어 임계값)는 아직 두지 않는다 — 기준선 측정 단계.
 */
export default {
  $schema: './node_modules/@stryker-mutator/core/schema/stryker-schema.json',
  mutate: [
    'src/lib/news-summary.ts',
    'src/lib/search-marker.ts',
    'src/lib/citation-lock.ts',
    'src/services/article-date.ts',
    'src/services/news-sources.ts',
  ],
  testRunner: 'jest',
  jest: {
    projectType: 'custom',
    configFile: 'jest.config.js',
    config: {
      testMatch: [
        '<rootDir>/tests/unit/news-summary.test.ts',
        '<rootDir>/tests/unit/news-sources.test.ts',
        '<rootDir>/tests/unit/article-date.test.ts',
        '<rootDir>/tests/unit/search-marker.test.ts',
        '<rootDir>/tests/unit/news-source-validation.test.ts',
        '<rootDir>/tests/unit/citation-lock.test.ts',
        '<rootDir>/tests/unit/context-sandbox.test.ts',
      ],
    },
    enableFindRelatedTests: true,
  },
  // checkers: TypeScript 체커는 이 VM에서 끈다 (2026-10-27 실측).
  // - 이유: 체커 워커가 프로젝트 전체 TS 프로그램을 메모리에 올려
  //   8GB 공유 VM에서 베이스라인 실행이 조용히 죽었다 (형제 에이전트의
  //   full-Jest와 경합 중, OOM으로 추정 — 로그에 에러 없이 소실).
  //   메모리가 넉넉한 머신에서는 ['typescript']로 되돌릴 것.
  // - 없이도: Stryker가 mutant 실행 시 ts-jest 타입 검사를 끄고
  //   transpile-only로 돌리므로, 타입을 깨뜨리는 뮤턴트는 테스트
  //   실패로 killed 되거나 살아남는다 (컴파일 에러로 사전 제외되지
  //   않으므로 errors/killed 분포가 체커 사용 시와 다를 수 있음).
  checkers: [],
  reporters: ['clear-text', 'json', 'html'],
  coverageAnalysis: 'perTest',
  timeoutMS: 60000,
  maxConcurrentTestRunners: 2,
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
}
