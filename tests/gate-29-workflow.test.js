/**
 * 관문 테스트 29: Workflow 제거 — 저장소 상태 회귀 테스트.
 *
 * 2026-10-27 전면 재작성: 이전 버전은 expect(true).toBe(true) 연극이었다.
 * 이 관문의 성질은 "Workflow 코드가 제거되고 Queue가 유일한 처리 경로다"라는
 * 저장소 상태 자체이므로, 실제 파일·소스를 직접 검사하는 회귀 테스트로
 * 검증한다 (DB나 HTTP 동작이 아니라 코드 제거 사실이 검증 대상).
 *
 * 검증하는 성질:
 * 1) src/modules/artifact/nova-workflow.ts 파일이 없다.
 * 2) src/ 어디에도 STUDIO_USE_WORKFLOW / NOVA_WORKFLOW / nova-workflow
 *    참조가 없다 (재도입 방지).
 * 3) wrangler.toml에 workflows 섹션이 없다.
 * 4) 대신 Queue 경로가 살아 있다: routes.ts가 ARTIFACT_QUEUE.send를
 *    호출하고, job-processor.ts에 processArtifactJob이 있다.
 */
const fs = require('fs')
const path = require('path')

const REPO = path.join(__dirname, '..')

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|js|tsx|jsx)$/.test(e.name)) out.push(p)
  }
  return out
}

function grepFiles(files, pattern) {
  const hits = []
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    if (pattern.test(src)) hits.push(f)
  }
  return hits
}

describe('관문 29: Workflow 제거 (저장소 상태)', () => {
  test('nova-workflow.ts 파일이 없다', () => {
    expect(fs.existsSync(path.join(REPO, 'src/modules/artifact/nova-workflow.ts'))).toBe(false)
  })

  test('src/ 어디에도 Workflow 관련 식별자가 없다', () => {
    const files = walk(path.join(REPO, 'src'))
    expect(files.length).toBeGreaterThan(0)
    expect(grepFiles(files, /STUDIO_USE_WORKFLOW/)).toEqual([])
    expect(grepFiles(files, /NOVA_WORKFLOW/)).toEqual([])
    expect(grepFiles(files, /nova-workflow/)).toEqual([])
  })

  test('wrangler.toml에 workflows 섹션이 없다', () => {
    const toml = fs.readFileSync(path.join(REPO, 'wrangler.toml'), 'utf8')
    expect(toml).not.toMatch(/^\s*\[workflows\]/m)
    expect(toml).not.toMatch(/workflows\s*=/)
  })

  test('대신 Queue 경로가 살아 있다', () => {
    // 잡 등록 라우트는 job-routes.ts로 분리됐다 (routes.ts는 등록만 담당)
    const routes = fs.readFileSync(path.join(REPO, 'src/modules/artifact/job-routes.ts'), 'utf8')
    expect(routes).toContain('ARTIFACT_QUEUE.send')
    const jp = fs.readFileSync(path.join(REPO, 'src/modules/artifact/job-processor.ts'), 'utf8')
    expect(jp).toContain('export async function processArtifactJob')
    // Queue consumer가 processArtifactJob을 호출한다
    const index = fs.readFileSync(path.join(REPO, 'src/index.ts'), 'utf8')
    expect(index).toContain('processArtifactJob')
  })
})
