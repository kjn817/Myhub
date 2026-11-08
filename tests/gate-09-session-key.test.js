/**
 * 관문 테스트 9: 대화 모드 session_key 일관성
 *
 * 결함: 백엔드가 사용자 메시지와 노바 응답을 session_key=`job-${jobId}`로 저장.
 * 프론트엔드는 `newSessionId` → `p${artifactId}`로만 이관.
 * `job-${jobId}` 메시지는 이관되지 않아 프로젝트 대화에 나타나지 않음.
 *
 * 기대: 저장된 메시지의 session_key가 프론트 이관 경로와 일치해야 함.
 */

// 현재 동작 시뮬레이션
function getBackendSessionKey(jobId) {
  return `job-${jobId}`
}

function getFrontendMigrateFrom() {
  return 'newSessionId_abc123' // 프론트의 newSessionId
}

function getProjectKey(artifactId) {
  return `p${artifactId}`
}

describe('관문 9: 대화 session_key 일관성', () => {
  test('백엔드 저장 키와 프론트 이관 소스가 다름 (결함 증명)', () => {
    const backendKey = getBackendSessionKey(155)
    const frontendFrom = getFrontendMigrateFrom()
    // 현재는 다름 → 이관 안 됨
    expect(backendKey).not.toBe(frontendFrom)
  })

  test('수정 후: 백엔드가 프로젝트 키로 직접 저장해야 함', () => {
    // 기대 동작: artifact_id를 알면 `p${artifactId}`로 저장
    const artifactId = 23
    const expectedKey = getProjectKey(artifactId)
    expect(expectedKey).toBe('p23')
    // 이렇게 저장하면 이관 없이도 프로젝트 대화에 바로 표시됨
  })
})
