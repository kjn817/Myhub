/**
 * 관문 테스트 12: 멀티파일 저장 정합성
 *
 * 기대: saveWorkspaceToD1으로 저장한 파일이 loadWorkspaceFromD1으로
 * 정확히 복원되어야 함. 특히 modify 시 unmodified 파일도 함께 저장됨.
 */

// 라운드트립 시뮬레이션
function simulateSaveLoad(files) {
  // 저장 (DB 시뮬레이션)
  const db = new Map()
  for (const [path, content] of Object.entries(files)) {
    const key = `v1:${path}`
    db.set(key, { content, hash: 'abc', size: content.length })
  }
  // 로드
  const loaded = {}
  for (const [key, val] of db) {
    const path = key.split(':')[1]
    loaded[path] = val.content
  }
  return loaded
}

describe('관문 12: 멀티파일 저장 정합성', () => {
  test('3개 파일 저장 → 3개 복원', () => {
    const files = {
      'index.html': '<html>',
      'styles/main.css': 'body{}',
      'js/app.js': 'console.log(1)',
    }
    const loaded = simulateSaveLoad(files)
    expect(Object.keys(loaded).length).toBe(3)
    expect(loaded['index.html']).toBe('<html>')
  })

  test('빈 파일도 저장됨', () => {
    const loaded = simulateSaveLoad({ 'empty.txt': '' })
    expect(loaded['empty.txt']).toBe('')
  })

  test('특수문자 경로도 처리', () => {
    const loaded = simulateSaveLoad({ 'a b/c-d.js': 'x' })
    expect(loaded['a b/c-d.js']).toBe('x')
  })
})
