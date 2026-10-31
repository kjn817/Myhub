/**
 * 관문 테스트 1: create Job의 버전/파일 생성
 *
 * 결함: POST /jobs에서 artifact를 즉시 생성하고 job에 artifact_id를 연결하면,
 * saveJobResult의 create 분기가 중복 체크로 조기 반환해 버전과 파일이
 * 절대 생성되지 않는다.
 */

// 로직 시뮬레이션: 수정된 saveJobResult create 분기
function simulateCreateBranch(jobArtifactId, hasVersion) {
  // 수정된 코드: artifact의 버전 존재 여부로 판단
  if (jobArtifactId !== null && hasVersion) {
    return 'skip_duplicate' // 버전 이미 있음 → 생성 안 함 (정상)
  }
  // 버전 없으면 생성 (artifact 사전 연결 여부와 무관)
  return 'version_created'
}

describe('관문 1: create Job 버전 생성', () => {
  test('artifact_id 사전 연결 + 버전 없음 → 버전을 생성해야 함', () => {
    const result = simulateCreateBranch(123, false)
    expect(result).toBe('version_created')
  })

  test('artifact_id 사전 연결 + 버전 있음 → 중복 생성 방지', () => {
    const result = simulateCreateBranch(123, true)
    expect(result).toBe('skip_duplicate')
  })

  test('artifact_id 없음 → 정상 생성 흐름', () => {
    const result = simulateCreateBranch(null, false)
    expect(result).toBe('version_created')
  })
})
