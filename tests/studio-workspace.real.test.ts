/**
 * StudioWorkspace 실제 단위 테스트 (관문 31)
 * tsx로 실행: npx tsx tests/studio-workspace.real.test.ts
 */
import { StudioWorkspace } from '../src/services/studio-workspace'

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`✓ ${name}`)
  } catch (e: any) {
    console.log(`✕ ${name}: ${e.message}`)
    process.exitCode = 1
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

async function main() {
  // create_file
  await test('create_file: 정상 생성', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({ name: 'create_file', arguments: { path: 'a.txt', content: 'hello' } } as any)
    assert(r.ok, '실패: ' + r.error)
    assert(ws.getFiles()['a.txt'] === 'hello', '내용 불일치')
  })

  await test('create_file: path 없음 → 실패', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({ name: 'create_file', arguments: { path: '', content: 'x' } } as any)
    assert(!r.ok, '성공하면 안 됨')
  })

  await test('create_file: 경로 탐색 차단', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({ name: 'create_file', arguments: { path: '../evil.txt', content: 'x' } } as any)
    assert(!r.ok, '차단되어야 함')
  })

  // read_file
  await test('read_file: 존재하는 파일', async () => {
    const ws = new StudioWorkspace({ 'b.txt': 'world' })
    const r = await ws.execute({ name: 'read_file', arguments: { path: 'b.txt' } } as any)
    assert(r.ok && r.output === 'world', '읽기 실패')
  })

  await test('read_file: 없는 파일 → 실패', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({ name: 'read_file', arguments: { path: 'none.txt' } } as any)
    assert(!r.ok, '성공하면 안 됨')
  })

  // edit_file
  await test('edit_file: 정확한 매칭', async () => {
    const ws = new StudioWorkspace({ 'c.html': '<button class="red">' })
    const r = await ws.execute({
      name: 'edit_file',
      arguments: { path: 'c.html', old_string: 'red', new_string: 'blue' },
    } as any)
    assert(r.ok, '실패: ' + r.error)
    assert(ws.getFiles()['c.html'].includes('blue'), '변경 안 됨')
  })

  // search_in_files (관문 14 검증)
  await test('search_in_files: 와일드카드 안전성', async () => {
    const ws = new StudioWorkspace({
      'index.html': '<div>',
      'xhtml': 'fake', // *.html에 매칭되면 안 됨
    })
    const r = await ws.execute({
      name: 'search_in_files',
      arguments: { pattern: 'div', file_pattern: '*.html' },
    } as any)
    assert(r.ok, '실패')
    assert(r.output.includes('index.html'), 'index.html을 찾아야 함')
    assert(!r.output.includes('xhtml'), 'xhtml은 매칭되면 안 됨 (관문 14)')
  })

  // validate_files (관문 16 검증)
  await test('validate_files: CSS 중괄호 검증', async () => {
    const ws = new StudioWorkspace({ 's.css': 'body { color: red; ' }) // 닫기 없음
    const r = await ws.execute({ name: 'validate_files', arguments: { files: 's.css' } } as any)
    assert(!r.ok, '실패해야 함')
    assert(r.output.includes('중괄호'), '중괄호 오류 메시지 필요')
  })

  await test('validate_files: 정상 CSS 통과', async () => {
    const ws = new StudioWorkspace({ 's.css': 'body { color: red; }' })
    const r = await ws.execute({ name: 'validate_files', arguments: { files: 's.css' } } as any)
    assert(r.ok, '통과해야 함: ' + r.output)
  })

  // delete_file (관문 44)
  await test('delete_file: 정상 삭제', async () => {
    const ws = new StudioWorkspace({ 'd.txt': 'x' })
    const r = await ws.execute({ name: 'delete_file', arguments: { path: 'd.txt' } } as any)
    assert(r.ok, '실패: ' + r.error)
    assert(!ws.getFiles()['d.txt'], '삭제되어야 함')
  })

  await test('delete_file: 없는 파일 → 실패', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({ name: 'delete_file', arguments: { path: 'none.txt' } } as any)
    assert(!r.ok, '성공하면 안 됨')
  })

  await test('delete_file: 경로 탐색 차단', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({ name: 'delete_file', arguments: { path: '../x' } } as any)
    assert(!r.ok, '차단되어야 함')
  })

  // apply_patch
  await test('apply_patch: 기본 수정', async () => {
    const ws = new StudioWorkspace({ 'e.html': '<div>old</div>' })
    const patch = `*** Begin Patch
*** Update File: e.html
@@
-old
+new
*** End Patch`
    const r = await ws.execute({ name: 'apply_patch', arguments: { patch } } as any)
    assert(r.ok, '실패: ' + r.error)
    assert(ws.getFiles()['e.html'].includes('new'), '변경 안 됨')
  })

  await test('apply_patch: 없는 파일 → 실패', async () => {
    const ws = new StudioWorkspace()
    const patch = `*** Begin Patch
*** Update File: none.html
@@
-a
+b
*** End Patch`
    const r = await ws.execute({ name: 'apply_patch', arguments: { patch } } as any)
    assert(!r.ok, '성공하면 안 됨')
  })

  await test('apply_patch: 경로 탐색 차단', async () => {
    const ws = new StudioWorkspace()
    const patch = `*** Begin Patch
*** Update File: ../evil
@@
-a
+b
*** End Patch`
    const r = await ws.execute({ name: 'apply_patch', arguments: { patch } } as any)
    assert(!r.ok, '차단되어야 함')
  })

  // edit_file 유연 매칭
  await test('edit_file: 유연 매칭 (공백 차이)', async () => {
    const ws = new StudioWorkspace({ 'f.html': '<div  class="x">' }) // 공백 2개
    const r = await ws.execute({
      name: 'edit_file',
      arguments: { path: 'f.html', old_string: '<div class="x">', new_string: '<div>' },
    } as any)
    // 유연 매칭으로 성공하거나, 유사한 줄 제안으로 실패
    assert(r.ok || r.error.includes('유사한'), '유연 매칭 또는 제안 필요')
  })

  await test('edit_file: 경로 탐색 차단', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({
      name: 'edit_file',
      arguments: { path: '../x', old_string: 'a', new_string: 'b' },
    } as any)
    assert(!r.ok, '차단되어야 함')
  })

  // read_file 경로 검증
  await test('read_file: 경로 탐색 차단', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({ name: 'read_file', arguments: { path: '../x' } } as any)
    assert(!r.ok, '차단되어야 함')
  })

  // getPreviewHtml
  await test('getPreviewHtml: CSS 인라인', async () => {
    const ws = new StudioWorkspace({
      'index.html': '<html><head><link rel="stylesheet" href="s.css"></head></html>',
      's.css': 'body { color: red; }',
    })
    const html = ws.getPreviewHtml()
    assert(html.includes('<style>'), 'CSS 인라인되어야 함')
    assert(html.includes('color: red'), 'CSS 내용 포함')
  })

  await test('getPreviewHtml: JS 인라인', async () => {
    const ws = new StudioWorkspace({
      'index.html': '<html><script src="a.js"></script></html>',
      'a.js': 'console.log(1)',
    })
    const html = ws.getPreviewHtml()
    assert(html.includes('console.log'), 'JS 인라인되어야 함')
  })

  await test('getPreviewHtml: 단일 HTML', async () => {
    const ws = new StudioWorkspace({ 'only.html': '<html>hi</html>' })
    const html = ws.getPreviewHtml()
    assert(html.includes('hi'), '단일 HTML 반환')
  })

  await test('getPreviewHtml: 없음 → 빈 문자열', async () => {
    const ws = new StudioWorkspace({ 'a.txt': 'x' })
    const html = ws.getPreviewHtml()
    assert(html === '', '빈 문자열이어야 함')
  })

  // validate_files 추가
  await test('validate_files: HTML DOCTYPE 없음 → 실패', async () => {
    const ws = new StudioWorkspace({ 'x.html': '<html></html>' })
    const r = await ws.execute({ name: 'validate_files', arguments: { files: 'x.html' } } as any)
    assert(!r.ok, 'DOCTYPE 없어야 실패')
  })

  await test('validate_files: JS 문법 오류 → 실패', async () => {
    const ws = new StudioWorkspace({ 'a.js': 'function ( {' })
    const r = await ws.execute({ name: 'validate_files', arguments: { files: 'a.js' } } as any)
    assert(!r.ok, '문법 오류는 실패해야 함')
  })

  await test('validate_files: 전체 검증', async () => {
    const ws = new StudioWorkspace({
      'index.html': '<!DOCTYPE html><html><body></body></html>',
      's.css': 'a { b: c; }',
    })
    const r = await ws.execute({ name: 'validate_files', arguments: {} } as any)
    assert(r.ok, '통과해야 함: ' + r.output)
  })

  // search_in_files 추가
  await test('search_in_files: 패턴 없음 → 실패', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({ name: 'search_in_files', arguments: { pattern: '' } } as any)
    assert(!r.ok, '성공하면 안 됨')
  })

  await test('search_in_files: 결과 50개 제한', async () => {
    const files: Record<string, string> = {}
    let content = ''
    for (let i = 0; i < 100; i++) content += 'match\n'
    files['big.txt'] = content
    const ws = new StudioWorkspace(files)
    const r = await ws.execute({ name: 'search_in_files', arguments: { pattern: 'match' } } as any)
    assert(r.ok, '실패: ' + r.error)
    const lines = r.output.split('\n').filter(Boolean)
    assert(lines.length <= 50, '50개 제한')
  })

  // saveWorkspaceToD1 / loadWorkspaceFromD1
  await test('saveWorkspaceToD1: 배치 저장', async () => {
    const { saveWorkspaceToD1, loadWorkspaceFromD1 } = await import('../src/services/studio-workspace')
    const stmts: any[] = []
    const mockDb = {
      prepare: (sql: string) => ({
        bind: (...args: any[]) => ({ sql, args }),
      }),
      batch: async (s: any[]) => { stmts.push(...s); return [] },
    }
    await saveWorkspaceToD1(mockDb, 1, { 'a.html': '<html>' })
    assert(stmts.length === 1, '1개 statement')
  })

  await test('saveWorkspaceToD1: 빈 파일 → batch 안 함', async () => {
    const { saveWorkspaceToD1 } = await import('../src/services/studio-workspace')
    let batchCalled = false
    const mockDb = {
      prepare: (sql: string) => ({ bind: (...args: any[]) => ({}) }),
      batch: async (s: any[]) => { batchCalled = true; return [] },
    }
    await saveWorkspaceToD1(mockDb, 1, {})
    assert(!batchCalled, 'batch 호출되면 안 됨')
  })

  await test('loadWorkspaceFromD1: 로드', async () => {
    const { loadWorkspaceFromD1 } = await import('../src/services/studio-workspace')
    const mockDb = {
      prepare: (sql: string) => ({
        bind: (...args: any[]) => ({
          all: async () => ({ results: [{ file_path: 'a.html', content: '<hi>' }] }),
        }),
      }),
    }
    const files = await loadWorkspaceFromD1(mockDb, 1)
    assert(files['a.html'] === '<hi>', '로드 실패')
  })

  // apply_patch 유연 매칭 실패
  await test('apply_patch: 찾을 수 없음 → 실패', async () => {
    const ws = new StudioWorkspace({ 'g.html': '<div>xxx</div>' })
    const patch = `*** Begin Patch
*** Update File: g.html
@@
-notfound123
+new
*** End Patch`
    const r = await ws.execute({ name: 'apply_patch', arguments: { patch } } as any)
    assert(!r.ok, '성공하면 안 됨')
    assert(r.error.includes('찾을 수 없음') || r.error.includes('패치 실패'), '에러 메시지')
  })

  // validate_files 파일 없음
  await test('validate_files: 없는 파일 → 오류', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({ name: 'validate_files', arguments: { files: 'none.html' } } as any)
    assert(!r.ok, '실패해야 함')
  })

  console.log('\n완료')
}

main()
