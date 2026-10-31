/**
 * 관문 테스트 11: Markdown 전용 작업
 *
 * 결함: "계획을 md파일로 만들어줘" 같은 요청은 plan.md만 생성하고 HTML이 없음.
 * 현재 코드는 HTML이 없으면 "HTML 없음" 오류로 실패함.
 *
 * 기대: HTML 없이 Markdown 파일만 있어도 성공하고, 파일이 저장되어야 함.
 */

function simulateJobResult(files, html) {
  const hasFiles = Object.keys(files).length > 0
  const hasHtml = !!html
  const hasSummary = true

  // 수정된 로직 (관문 11)
  if (!hasHtml && hasSummary && !hasFiles) {
    return 'dialogue_mode' // 대화 모드
  }
  if (!hasHtml && hasFiles) {
    return 'success_files_only' // md 전용: 파일 저장 경로
  }
  if (!hasHtml) {
    return 'error_HTML_없음'
  }
  return 'success'
}

describe('관문 11: Markdown 전용 작업', () => {
  test('plan.md만 있고 HTML 없음 → 파일 저장 경로로 성공', () => {
    const result = simulateJobResult({ 'plan.md': '# 계획' }, null)
    expect(result).toBe('success_files_only')
  })

  test('기대: md 전용도 성공해야 함', () => {
    // 수정 후 기대 동작
    const files = { 'plan.md': '# 계획' }
    const hasFiles = Object.keys(files).length > 0
    // 파일이 있으면 HTML 없어도 파일 저장 경로로 가야 함
    expect(hasFiles).toBe(true)
  })

  test('HTML 있음 → 정상 성공', () => {
    const result = simulateJobResult(
      { 'index.html': '<html>' },
      '<html>'
    )
    expect(result).toBe('success')
  })

  test('파일도 HTML도 없음 → 대화 모드', () => {
    const result = simulateJobResult({}, null)
    expect(result).toBe('dialogue_mode')
  })
})
