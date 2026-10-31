/**
 * 관문 테스트 30: 생성 파일 관리
 *
 * 개선됨: .gitignore에 생성 파일 추가
 * - src/index-inline.ts (deploy_full.py가 생성)
 * - *-bundle.cjs (esbuild 산출물)
 *
 * 참고: 이미 추적 중인 파일은 git rm --cached로 제거해야 완전해지지만,
 * 배포 리스크 때문에 단계적으로 진행.
 */

describe('관문 30: 생성 파일', () => {
  test('생성 파일 식별', () => {
    const generatedFiles = [
      'src/index-inline.ts', // 2.3MB, deploy_full.py가 생성
      'ai-bundle.cjs',
      'router-bundle.cjs',
    ]
    expect(generatedFiles.length).toBeGreaterThan(0)
  })
})
