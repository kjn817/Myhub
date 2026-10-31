/// <reference types="jest" />
/**
 * StudioWorkspace Jest 단위 테스트 (관문 31에서 변환)
 * 실행: npx jest tests/unit/studio-workspace.test.ts
 */
import { StudioWorkspace } from '../../src/services/studio-workspace'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

test('create_file: 정상 생성', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({ name: 'create_file', arguments: { path: 'a.txt', content: 'hello' } } as any)
    assert(r.ok, '실패: ' + r.error)
    assert(ws.getFiles()['a.txt'] === 'hello', '내용 불일치')
})

test('create_file: path 없음 → 실패', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({ name: 'create_file', arguments: { path: '', content: 'x' } } as any)
    assert(!r.ok, '성공하면 안 됨')
})

test('create_file: 경로 탐색 차단', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({ name: 'create_file', arguments: { path: '../evil.txt', content: 'x' } } as any)
    assert(!r.ok, '차단되어야 함')
})

test('read_file: 존재하는 파일', async () => {
    const ws = new StudioWorkspace({ 'b.txt': 'world' })
    const r = await ws.execute({ name: 'read_file', arguments: { path: 'b.txt' } } as any)
    assert(r.ok && r.output === 'world', '읽기 실패')
})

test('read_file: 없는 파일 → 실패', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({ name: 'read_file', arguments: { path: 'none.txt' } } as any)
    assert(!r.ok, '성공하면 안 됨')
})

test('edit_file: 정확한 매칭', async () => {
    const ws = new StudioWorkspace({ 'c.html': '<button class="red">' })
    const r = await ws.execute({
      name: 'edit_file',
      arguments: { path: 'c.html', old_string: 'red', new_string: 'blue' },
    } as any)
    assert(r.ok, '실패: ' + r.error)
    assert(ws.getFiles()['c.html'].includes('blue'), '변경 안 됨')
})

test('search_in_files: 와일드카드 안전성', async () => {
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

test('validate_files: CSS 중괄호 검증', async () => {
    const ws = new StudioWorkspace({ 's.css': 'body { color: red; ' }) // 닫기 없음
    const r = await ws.execute({ name: 'validate_files', arguments: { files: 's.css' } } as any)
    assert(!r.ok, '실패해야 함')
    assert(r.output.includes('중괄호'), '중괄호 오류 메시지 필요')
})

test('validate_files: 정상 CSS 통과', async () => {
    const ws = new StudioWorkspace({ 's.css': 'body { color: red; }' })
    const r = await ws.execute({ name: 'validate_files', arguments: { files: 's.css' } } as any)
    assert(r.ok, '통과해야 함: ' + r.output)
})

test('delete_file: 정상 삭제', async () => {
    const ws = new StudioWorkspace({ 'd.txt': 'x' })
    const r = await ws.execute({ name: 'delete_file', arguments: { path: 'd.txt' } } as any)
    assert(r.ok, '실패: ' + r.error)
    assert(!ws.getFiles()['d.txt'], '삭제되어야 함')
})

test('delete_file: 없는 파일 → 실패', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({ name: 'delete_file', arguments: { path: 'none.txt' } } as any)
    assert(!r.ok, '성공하면 안 됨')
})

test('delete_file: 경로 탐색 차단', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({ name: 'delete_file', arguments: { path: '../x' } } as any)
    assert(!r.ok, '차단되어야 함')
})

test('apply_patch: 기본 수정', async () => {
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

test('apply_patch: 없는 파일 → 실패', async () => {
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

test('apply_patch: 경로 탐색 차단', async () => {
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

test('edit_file: 유연 매칭 (공백 차이)', async () => {
    const ws = new StudioWorkspace({ 'f.html': '<div  class="x">' }) // 공백 2개
    const r = await ws.execute({
      name: 'edit_file',
      arguments: { path: 'f.html', old_string: '<div class="x">', new_string: '<div>' },
    } as any)
    // 유연 매칭으로 성공하거나, 유사한 줄 제안으로 실패
    assert(r.ok || r.error.includes('유사한'), '유연 매칭 또는 제안 필요')
})

test('edit_file: 경로 탐색 차단', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({
      name: 'edit_file',
      arguments: { path: '../x', old_string: 'a', new_string: 'b' },
    } as any)
    assert(!r.ok, '차단되어야 함')
})

test('read_file: 경로 탐색 차단', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({ name: 'read_file', arguments: { path: '../x' } } as any)
    assert(!r.ok, '차단되어야 함')
})

test('getPreviewHtml: CSS 인라인', async () => {
    const ws = new StudioWorkspace({
      'index.html': '<html><head><link rel="stylesheet" href="s.css"></head></html>',
      's.css': 'body { color: red; }',
    })
    const html = ws.getPreviewHtml()
    assert(html.includes('<style>'), 'CSS 인라인되어야 함')
    assert(html.includes('color: red'), 'CSS 내용 포함')
})

test('getPreviewHtml: JS 인라인', async () => {
    const ws = new StudioWorkspace({
      'index.html': '<html><script src="a.js"></script></html>',
      'a.js': 'console.log(1)',
    })
    const html = ws.getPreviewHtml()
    assert(html.includes('console.log'), 'JS 인라인되어야 함')
})

test('getPreviewHtml: 단일 HTML', async () => {
    const ws = new StudioWorkspace({ 'only.html': '<html>hi</html>' })
    const html = ws.getPreviewHtml()
    assert(html.includes('hi'), '단일 HTML 반환')
})

test('getPreviewHtml: 없음 → 빈 문자열', async () => {
    const ws = new StudioWorkspace({ 'a.txt': 'x' })
    const html = ws.getPreviewHtml()
    assert(html === '', '빈 문자열이어야 함')
})

test('validate_files: HTML DOCTYPE 없음 → 실패', async () => {
    const ws = new StudioWorkspace({ 'x.html': '<html></html>' })
    const r = await ws.execute({ name: 'validate_files', arguments: { files: 'x.html' } } as any)
    assert(!r.ok, 'DOCTYPE 없어야 실패')
})

test('validate_files: JS 문법 오류 → 실패', async () => {
    const ws = new StudioWorkspace({ 'a.js': 'function ( {' })
    const r = await ws.execute({ name: 'validate_files', arguments: { files: 'a.js' } } as any)
    assert(!r.ok, '문법 오류는 실패해야 함')
})

test('validate_files: 전체 검증', async () => {
    const ws = new StudioWorkspace({
      'index.html': '<!DOCTYPE html><html><body></body></html>',
      's.css': 'a { b: c; }',
    })
    const r = await ws.execute({ name: 'validate_files', arguments: {} } as any)
    assert(r.ok, '통과해야 함: ' + r.output)
})

test('search_in_files: 패턴 없음 → 실패', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({ name: 'search_in_files', arguments: { pattern: '' } } as any)
    assert(!r.ok, '성공하면 안 됨')
})

test('search_in_files: 결과 50개 제한', async () => {
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

test('saveWorkspaceToD1: 배치 저장', async () => {
    const { saveWorkspaceToD1, loadWorkspaceFromD1 } = await import('../../src/services/studio-workspace')
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

test('saveWorkspaceToD1: 빈 파일 → batch 안 함', async () => {
    const { saveWorkspaceToD1 } = await import('../../src/services/studio-workspace')
    let batchCalled = false
    const mockDb = {
      prepare: (sql: string) => ({ bind: (...args: any[]) => ({}) }),
      batch: async (s: any[]) => { batchCalled = true; return [] },
    }
    await saveWorkspaceToD1(mockDb, 1, {})
    assert(!batchCalled, 'batch 호출되면 안 됨')
})

test('loadWorkspaceFromD1: 로드', async () => {
    const { loadWorkspaceFromD1 } = await import('../../src/services/studio-workspace')
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

test('apply_patch: 찾을 수 없음 → 실패', async () => {
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

test('validate_files: 없는 파일 → 오류', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({ name: 'validate_files', arguments: { files: 'none.html' } } as any)
    assert(!r.ok, '실패해야 함')
})


describe('branch 커버리지 추가 (실제 테스트)', () => {
  test('execute: arguments 없음 → list_files 동작', async () => {
    const ws = new StudioWorkspace({ 'a.txt': 'x' })
    const r = await ws.execute({ name: 'list_files' } as any)
    assert(r.ok && r.output === 'a.txt', 'list_files 실패: ' + r.output)
  })

  test('list_files: 빈 작업공간 → (파일 없음)', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({ name: 'list_files', arguments: {} } as any)
    assert(r.ok && r.output === '(파일 없음)', '빈 목록 메시지: ' + r.output)
  })

  test('execute: 알 수 없는 도구 → 실패', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({ name: 'nope', arguments: {} } as any)
    assert(!r.ok && r.error.includes('알 수 없는 도구'), 'default 분기: ' + r.error)
  })

  test('create_file: content 없음 → 빈 문자열', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({ name: 'create_file', arguments: { path: 'e.txt' } } as any)
    assert(r.ok, '실패: ' + r.error)
    assert(ws.getFiles()['e.txt'] === '', '빈 내용이어야 함')
  })

  test('edit_file: path 없음 → 실패', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({ name: 'edit_file', arguments: { old_string: 'a', new_string: 'b' } } as any)
    assert(!r.ok, '성공하면 안 됨')
  })

  test('edit_file: 없는 파일 → 실패', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({
      name: 'edit_file',
      arguments: { path: 'no.txt', old_string: 'a', new_string: 'b' },
    } as any)
    assert(!r.ok && r.error.includes('파일 없음'), '파일 없음 에러: ' + r.error)
  })

  test('edit_file: old_string 없음 → 실패', async () => {
    const ws = new StudioWorkspace({ 'f.txt': 'content' })
    const r = await ws.execute({
      name: 'edit_file',
      arguments: { path: 'f.txt', new_string: 'b' },
    } as any)
    assert(!r.ok && r.error.includes('old_string이 비어있습니다'), 'old_string 에러: ' + r.error)
  })

  test('edit_file: new_string 없음 → 빈 문자열로 교체', async () => {
    const ws = new StudioWorkspace({ 'g.txt': 'hello world' })
    const r = await ws.execute({
      name: 'edit_file',
      arguments: { path: 'g.txt', old_string: 'world' },
    } as any)
    assert(r.ok, '실패: ' + r.error)
    assert(ws.getFiles()['g.txt'] === 'hello ', '삭제되어야 함: ' + ws.getFiles()['g.txt'])
  })

  test('edit_file: 유연 매칭 부분 교체 (trim 포함)', async () => {
    const ws = new StudioWorkspace({ 'h.txt': 'say hello world now' })
    const r = await ws.execute({
      name: 'edit_file',
      arguments: { path: 'h.txt', old_string: '  hello world  ', new_string: 'X' },
    } as any)
    assert(r.ok, '실패: ' + r.error)
    assert(ws.getFiles()['h.txt'] === 'say X now', '부분 교체: ' + ws.getFiles()['h.txt'])
  })

  test('edit_file: 유연 매칭 역방향 포함 + 불일치 줄', async () => {
    const ws = new StudioWorkspace({ 'i.txt': 'nomatch at all\nworld' })
    const r = await ws.execute({
      name: 'edit_file',
      arguments: { path: 'i.txt', old_string: 'hello world foo', new_string: 'REPLACED' },
    } as any)
    assert(r.ok, '실패: ' + r.error)
    assert(ws.getFiles()['i.txt'].includes('REPLACED'), '교체되어야 함: ' + ws.getFiles()['i.txt'])
  })

  test('edit_file: 유사한 줄 3개 제안 (후보 상한)', async () => {
    const ws = new StudioWorkspace({
      'j.txt': 'alpha one\nbeta two\ngamma three\ndelta four',
    })
    const r = await ws.execute({
      name: 'edit_file',
      arguments: { path: 'j.txt', old_string: 'alpha beta gamma delta', new_string: 'X' },
    } as any)
    assert(!r.ok, '성공하면 안 됨')
    assert(r.error.includes('유사한 줄'), '힌트 필요: ' + r.error)
    assert(r.error.includes('1: alpha one'), '후보 1: ' + r.error)
  })

  test('edit_file: 유사한 줄 1개 제안 (루프 정상 종료)', async () => {
    const ws = new StudioWorkspace({ 'k.txt': 'alpha here\nnothing' })
    const r = await ws.execute({
      name: 'edit_file',
      arguments: { path: 'k.txt', old_string: 'alpha beta', new_string: 'X' },
    } as any)
    assert(!r.ok, '성공하면 안 됨')
    assert(r.error.includes('유사한 줄'), '힌트 필요: ' + r.error)
  })

  test('edit_file: 유사한 줄 없음 → 힌트 생략', async () => {
    const ws = new StudioWorkspace({ 'l.txt': 'zzz\nyyy' })
    const r = await ws.execute({
      name: 'edit_file',
      arguments: { path: 'l.txt', old_string: 'alpha beta', new_string: 'X' },
    } as any)
    assert(!r.ok, '성공하면 안 됨')
    assert(!r.error.includes('유사한 줄'), '힌트 없어야 함: ' + r.error)
    assert(r.error.includes('read_file'), '안내 메시지: ' + r.error)
  })

  test('read_file: path 없음 → 실패', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({ name: 'read_file', arguments: {} } as any)
    assert(!r.ok, '성공하면 안 됨')
  })

  test('delete_file: path 없음 → 실패', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({ name: 'delete_file', arguments: {} } as any)
    assert(!r.ok, '성공하면 안 됨')
  })

  test('apply_patch: patch 없음 → 실패', async () => {
    const ws = new StudioWorkspace()
    const r = await ws.execute({ name: 'apply_patch', arguments: {} } as any)
    assert(!r.ok && r.error.includes('patch가 필요합니다'), 'patch 에러: ' + r.error)
  })

  test('apply_patch: 추가만 있는 헝크 → 결과 없음 메시지', async () => {
    const ws = new StudioWorkspace({ 'm.txt': 'old content' })
    const patch = `*** Begin Patch
*** Update File: m.txt
@@
+new line
*** End Patch`
    const r = await ws.execute({ name: 'apply_patch', arguments: { patch } } as any)
    assert(r.ok, '실패: ' + r.error)
    assert(r.output === '패치 적용됨', '결과 없음 메시지: ' + r.output)
  })

  test('apply_patch: 유연 매칭 (공백 차이)', async () => {
    const ws = new StudioWorkspace({ 'n.txt': '  hello   world  ' })
    const patch = `*** Begin Patch
*** Update File: n.txt
@@
-hello world
+hi
*** End Patch`
    const r = await ws.execute({ name: 'apply_patch', arguments: { patch } } as any)
    assert(r.ok, '실패: ' + r.error)
    assert(r.output.includes('유연 매칭'), '유연 매칭 메시지: ' + r.output)
    assert(ws.getFiles()['n.txt'] === 'hi', '교체되어야 함: ' + ws.getFiles()['n.txt'])
  })

  test('apply_patch: 내부 오류 → 패치 오류', async () => {
    const ws = new StudioWorkspace({ 'o.txt': 'x' })
    ;(ws as any).files = { get: () => { throw new Error('boom') } }
    const patch = `*** Begin Patch
*** Update File: o.txt
@@
-x
+y
*** End Patch`
    const r = await ws.execute({ name: 'apply_patch', arguments: { patch } } as any)
    assert(!r.ok && r.error.includes('패치 오류'), '내부 오류 처리: ' + r.error)
  })

  test('search_in_files: 불일치 줄 스킵', async () => {
    const ws = new StudioWorkspace({ 'p.txt': 'nomatch here\npattern here' })
    const r = await ws.execute({ name: 'search_in_files', arguments: { pattern: 'pattern' } } as any)
    assert(r.ok, '실패: ' + r.error)
    assert(r.output.includes('p.txt:2'), '두 번째 줄만: ' + r.output)
    assert(!r.output.includes('p.txt:1'), '첫 줄 제외: ' + r.output)
  })

  test('search_in_files: 결과 없음', async () => {
    const ws = new StudioWorkspace({ 'q.txt': 'aaa' })
    const r = await ws.execute({ name: 'search_in_files', arguments: { pattern: 'zzz' } } as any)
    assert(r.ok && r.output === '(검색 결과 없음)', '결과 없음 메시지: ' + r.output)
  })

  test('validate_files: html 태그 없는 HTML 통과', async () => {
    const ws = new StudioWorkspace({ 'r.html': '<!DOCTYPE html><body></body>' })
    const r = await ws.execute({ name: 'validate_files', arguments: { files: 'r.html' } } as any)
    assert(r.ok, '통과해야 함: ' + r.output)
  })

  test('validate_files: html 태그 불일치 → 실패', async () => {
    const ws = new StudioWorkspace({ 's.html': '<!DOCTYPE html><html><body></body>' })
    const r = await ws.execute({ name: 'validate_files', arguments: { files: 's.html' } } as any)
    assert(!r.ok && r.output.includes('<html> 태그 불일치'), 'html 불일치: ' + r.output)
  })

  test('validate_files: body 태그 불일치 → 실패', async () => {
    const ws = new StudioWorkspace({ 't.html': '<!DOCTYPE html><html><body></html>' })
    const r = await ws.execute({ name: 'validate_files', arguments: { files: 't.html' } } as any)
    assert(!r.ok && r.output.includes('<body> 태그 불일치'), 'body 불일치: ' + r.output)
  })

  test('validate_files: CSS 중괄호 없음 → 통과', async () => {
    const ws = new StudioWorkspace({ 'u.css': 'just text no braces' })
    const r = await ws.execute({ name: 'validate_files', arguments: { files: 'u.css' } } as any)
    assert(r.ok, '통과해야 함: ' + r.output)
  })

  test('execute: 내부 throw → 에러 메시지 전달', async () => {
    const ws = new StudioWorkspace()
    const evilArgs = new Proxy({}, { get() { throw new Error('proxy boom') } })
    const r = await ws.execute({ name: 'read_file', arguments: evilArgs } as any)
    assert(!r.ok && r.error === 'proxy boom', '에러 전달: ' + r.error)
  })

  test('execute: 내부 throw(메시지 없음) → 기본 실행 오류', async () => {
    const ws = new StudioWorkspace()
    const evilArgs = new Proxy({}, { get() { throw 'plain' } })
    const r = await ws.execute({ name: 'read_file', arguments: evilArgs } as any)
    assert(!r.ok && r.error === '실행 오류', '기본 에러: ' + r.error)
  })

  test('getPreviewHtml: ./ 접두사 CSS 인라인', async () => {
    const ws = new StudioWorkspace({
      'index.html': '<html><head><link rel="stylesheet" href="./s.css"></head></html>',
      's.css': 'a { color: red; }',
    })
    const html = ws.getPreviewHtml()
    assert(html.includes('color: red'), './ 접두사 해석: ' + html)
  })

  test('getPreviewHtml: 없는 CSS → 원본 유지', async () => {
    const ws = new StudioWorkspace({
      'index.html': '<html><head><link rel="stylesheet" href="missing.css"></head></html>',
    })
    const html = ws.getPreviewHtml()
    assert(html.includes('<link'), '원본 유지되어야 함: ' + html)
  })

  test('getPreviewHtml: ./ 접두사 JS 인라인', async () => {
    const ws = new StudioWorkspace({
      'index.html': '<html><script src="./a.js"></script></html>',
      'a.js': 'var x = 1;',
    })
    const html = ws.getPreviewHtml()
    assert(html.includes('var x = 1'), './ 접두사 해석: ' + html)
  })

  test('getPreviewHtml: 없는 JS → 원본 유지', async () => {
    const ws = new StudioWorkspace({
      'index.html': '<html><script src="missing.js"></script></html>',
    })
    const html = ws.getPreviewHtml()
    assert(html.includes('<script src'), '원본 유지되어야 함: ' + html)
  })

  test('loadWorkspaceFromD1: results null → 빈 객체', async () => {
    const { loadWorkspaceFromD1 } = await import('../../src/services/studio-workspace')
    const mockDb = {
      prepare: (sql: string) => ({
        bind: (...args: any[]) => ({ all: async () => ({ results: null }) }),
      }),
    }
    const files = await loadWorkspaceFromD1(mockDb, 1)
    assert(Object.keys(files).length === 0, '빈 객체여야 함')
  })
})

describe('branch 커버리지 추가 2 (마지막 분기)', () => {
  test('apply_patch: 헝크 내 빈 줄 → else 분기', async () => {
    const ws = new StudioWorkspace({ 'v.txt': 'old' })
    const patch = `*** Begin Patch
*** Update File: v.txt
@@
-old

+new
*** End Patch`
    const r = await ws.execute({ name: 'apply_patch', arguments: { patch } } as any)
    assert(r.ok, '실패: ' + r.error)
    assert(ws.getFiles()['v.txt'] === 'new', '교체: ' + ws.getFiles()['v.txt'])
  })
})
