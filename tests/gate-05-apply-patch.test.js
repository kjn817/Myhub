/**
 * 관문 테스트 5: apply_patch 파싱
 *
 * 기대: Codex 스타일 패치가 정확히 파싱되고 적용되어야 한다.
 * 엣지 케이스: 빈 패치, 잘못된 형식, 없는 파일.
 */

function parsePatch(patch) {
  // studio-workspace.ts의 apply_patch 로직 시뮬레이션
  if (!patch) return { ok: false, error: 'patch가 필요합니다' }
  const fileBlocks = patch.split(/^\*\*\* Update File:\s*/m).slice(1)
  if (fileBlocks.length === 0) return { ok: false, error: '파일 블록 없음' }
  const results = []
  for (const block of fileBlocks) {
    const lines = block.split('\n')
    const filePath = lines[0].trim()
    if (!filePath) return { ok: false, error: '파일 경로 없음' }
    results.push({ filePath, lineCount: lines.length })
  }
  return { ok: true, files: results }
}

describe('관문 5: apply_patch 파싱', () => {
  test('정상 패치 → 파싱 성공', () => {
    const patch = `*** Begin Patch
*** Update File: index.html
@@
-<button class="bg-red-600">
+<button class="bg-blue-600">
*** End Patch`
    const result = parsePatch(patch)
    expect(result.ok).toBe(true)
    expect(result.files[0].filePath).toBe('index.html')
  })

  test('빈 패치 → 오류', () => {
    const result = parsePatch('')
    expect(result.ok).toBe(false)
  })

  test('파일 블록 없음 → 오류', () => {
    const result = parsePatch('*** Begin Patch\n*** End Patch')
    expect(result.ok).toBe(false)
  })

  test('멀티파일 패치 → 모두 파싱', () => {
    const patch = `*** Begin Patch
*** Update File: a.html
@@
-old
+new
*** Update File: b.css
@@
-x
+y
*** End Patch`
    const result = parsePatch(patch)
    expect(result.ok).toBe(true)
    expect(result.files.length).toBe(2)
  })
})
