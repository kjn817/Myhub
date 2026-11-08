// 스튜디오 도구 실행기 - D1 artifact_files와 연동
import type { StudioToolCall, StudioToolResult } from './studio-tools'

// ask_question: 에이전트가 사용자 입력을 기다려야 함을 알리는 시그널
// execute()의 try/catch를 통과해야 하므로 Error 서브클래스로 던짐
export class AwaitingInputSignal extends Error {
  questions: any[]
  constructor(questions: any[]) {
    super('AWAITING_INPUT')
    this.name = 'AwaitingInputSignal'
    this.questions = questions
  }
}

// 작업 공간: 메모리에 파일들을 임시 보관 (에이전트 루프 동안)
// 최종적으로 artifact_files에 저장됨
export class StudioWorkspace {
  private files = new Map<string, string>()
  private versionId: number | null = null
  // B2: 파일 변경 시 호출되는 콜백 (file.stream 이벤트용 — job-processor에서 연결)
  public onMutation: ((path: string, content: string | null) => void) | null = null

  constructor(initialFiles?: Record<string, string>) {
    if (initialFiles) {
      for (const [path, content] of Object.entries(initialFiles)) {
        this.files.set(path, content)
      }
    }
  }

  // 관문 44: 경로 검증 헬퍼
  private validatePath(path: string): string | null {
    if (!path) return 'path가 필요합니다'
    if (path.includes('..') || path.startsWith('/')) {
      return `잘못된 경로: ${path}`
    }
    return null
  }

  async execute(call: StudioToolCall): Promise<StudioToolResult> {
    const args = call.arguments || {}
    try {
      switch (call.name) {
        case 'create_file': {
          const path = String(args.path || '').trim()
          const content = String(args.content || '')
          const pathErr = this.validatePath(path)
          if (pathErr) return { ok: false, output: '', error: pathErr }
          this.files.set(path, content)
          if (this.onMutation) { try { this.onMutation(path, content) } catch {} }
          return { ok: true, output: `파일 생성됨: ${path} (${content.length}자)` }
        }
        case 'edit_file': {
          const path = String(args.path || '').trim()
          const pathErr = this.validatePath(path)
          if (pathErr) return { ok: false, output: '', error: pathErr }
          const oldStr = String(args.old_string || '')
          const newStr = String(args.new_string || '')
          const current = this.files.get(path)
          if (current === undefined) {
            return { ok: false, output: '', error: `파일 없음: ${path}` }
          }
          if (!oldStr) {
            return { ok: false, output: '', error: 'old_string이 비어있습니다' }
          }
          // 1. 정확한 매칭 시도
          if (current.includes(oldStr)) {
            // 여러 개 있으면 첫 번째만 교체 (기존 동작 유지)
            const updated = current.replace(oldStr, newStr)
            this.files.set(path, updated)
            if (this.onMutation) { try { this.onMutation(path, updated) } catch {} }
            return { ok: true, output: `파일 수정됨: ${path}` }
          }
          // 2. 공백 정규화 후 매칭 시도 (들여쓰기 차이 허용)
          const normalize = (s: string) => s.replace(/\s+/g, ' ').trim()
          const normOld = normalize(oldStr)
          const lines = current.split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (normalize(lines[i]).includes(normOld) || normOld.includes(normalize(lines[i]))) {
              // 해당 줄을 통째로 교체 (부분 매칭)
              const newLines = [...lines]
              // oldStr이 줄의 일부면 그 부분만 교체 시도
              if (lines[i].includes(oldStr.trim())) {
                newLines[i] = lines[i].replace(oldStr.trim(), newStr)
              } else {
                // 줄 단위 교체
                newLines[i] = newStr
              }
              const updatedFlex = newLines.join('\n')
              this.files.set(path, updatedFlex)
              if (this.onMutation) { try { this.onMutation(path, updatedFlex) } catch {} }
              return { ok: true, output: `파일 수정됨: ${path} (유연 매칭, ${i + 1}번째 줄)` }
            }
          }
          // 3. 실패 시 유사한 줄 제안
          const candidates: string[] = []
          const keywords = oldStr.split(/\s+/).filter(w => w.length > 3).slice(0, 3)
          for (let i = 0; i < lines.length && candidates.length < 3; i++) {
            if (keywords.some(k => lines[i].includes(k))) {
              candidates.push(`${i + 1}: ${lines[i].trim().slice(0, 80)}`)
            }
          }
          const hint = candidates.length ? `\n유사한 줄:\n${candidates.join('\n')}` : ''
          return { ok: false, output: '', error: `old_string이 파일에 없습니다.${hint}\nread_file로 정확한 내용을 확인하세요.` }
        }
        case 'read_file': {
          const path = String(args.path || '').trim()
          const pathErr = this.validatePath(path)
          if (pathErr) return { ok: false, output: '', error: pathErr }
          const content = this.files.get(path)
          if (content === undefined) {
            return { ok: false, output: '', error: `파일 없음: ${path}` }
          }
          return { ok: true, output: content.slice(0, 20000) }
        }
        case 'list_files': {
          const list = [...this.files.keys()].sort()
          return { ok: true, output: list.length ? list.join('\n') : '(파일 없음)' }
        }
        case 'delete_file': {
          const path = String(args.path || '').trim()
          const pathErr = this.validatePath(path)
          if (pathErr) return { ok: false, output: '', error: pathErr }
          if (!this.files.has(path)) {
            return { ok: false, output: '', error: `파일 없음: ${path}` }
          }
          this.files.delete(path)
          if (this.onMutation) { try { this.onMutation(path, null) } catch {} }
          return { ok: true, output: `파일 삭제됨: ${path}` }
        }
        case 'apply_patch': {
          const patch = String(args.patch || '')
          if (!patch) return { ok: false, output: '', error: 'patch가 필요합니다' }
          try {
            const results: string[] = []
            // 간단한 패치 파서: *** Update File: path ... @@ ... -old ... +new
            const fileBlocks = patch.split(/^\*\*\* Update File:\s*/m).slice(1)
            for (const block of fileBlocks) {
              const lines = block.split('\n')
              const filePath = lines[0].trim()
              const pathErr = this.validatePath(filePath)
              if (pathErr) return { ok: false, output: '', error: pathErr }
              const content = this.files.get(filePath)
              if (content === undefined) {
                return { ok: false, output: '', error: `파일 없음: ${filePath}` }
              }
              let newContent = content
              let i = 1
              while (i < lines.length) {
                if (lines[i].trim() === '@@') {
                  i++
                  const removals: string[] = []
                  const additions: string[] = []
                  while (i < lines.length && (lines[i].startsWith('-') || lines[i].startsWith('+') || lines[i].trim() === '')) {
                    if (lines[i].startsWith('-')) removals.push(lines[i].slice(1))
                    else if (lines[i].startsWith('+')) additions.push(lines[i].slice(1))
                    i++
                  }
                  // 삭제할 줄들을 찾아서 교체
                  if (removals.length > 0) {
                    const oldBlock = removals.join('\n')
                    const newBlock = additions.join('\n')
                    if (newContent.includes(oldBlock)) {
                      newContent = newContent.replace(oldBlock, newBlock)
                      results.push(`${filePath}: 패치 적용됨 (${removals.length}줄 → ${additions.length}줄)`)
                    } else {
                      // 유연 매칭: 공백 정규화
                      const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
                      const normOld = norm(oldBlock)
                      const contentLines = newContent.split('\n')
                      let found = false
                      for (let j = 0; j < contentLines.length; j++) {
                        if (norm(contentLines[j]).includes(normOld) || normOld.includes(norm(contentLines[j]))) {
                          contentLines[j] = newBlock
                          found = true
                          break
                        }
                      }
                      if (found) {
                        newContent = contentLines.join('\n')
                        results.push(`${filePath}: 패치 적용됨 (유연 매칭)`)
                      } else {
                        return { ok: false, output: '', error: `패치 실패: ${filePath}에서 찾을 수 없음\n찾는 내용: ${oldBlock.slice(0, 100)}` }
                      }
                    }
                  }
                } else {
                  i++
                }
              }
              this.files.set(filePath, newContent)
              if (this.onMutation) { try { this.onMutation(filePath, newContent) } catch {} }
            }
            return { ok: true, output: results.length ? results.join('\n') : '패치 적용됨' }
          } catch (e: any) {
            return { ok: false, output: '', error: `패치 오류: ${e.message}` }
          }
        }
        case 'search_in_files': {
          const pattern = String(args.pattern || '')
          const filePattern = String(args.file_pattern || '')
          if (!pattern) return { ok: false, output: '', error: 'pattern이 필요합니다' }
          const results: string[] = []
          for (const [path, content] of this.files) {
            if (filePattern) {
              // 와일드카드 매칭 (*.html, *.js 등) — 관문 14: 정규식 특수문자 escape
              const escaped = filePattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
              const regex = new RegExp('^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
              if (!regex.test(path)) continue
            }
            const lines = content.split('\n')
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes(pattern)) {
                results.push(`${path}:${i + 1}: ${lines[i].trim().slice(0, 120)}`)
                if (results.length >= 50) break
              }
            }
            if (results.length >= 50) break
          }
          return { ok: true, output: results.length ? results.join('\n') : '(검색 결과 없음)' }
        }
        case 'validate_files': {
          const filesArg = String(args.files || '').trim()
          const targetPaths = filesArg
            ? filesArg.split(',').map(s => s.trim()).filter(Boolean)
            : [...this.files.keys()]
          const errors: string[] = []
          for (const path of targetPaths) {
            const content = this.files.get(path)
            if (content === undefined) {
              errors.push(`${path}: 파일 없음`)
              continue
            }
            if (path.endsWith('.html')) {
              // 기본 HTML 구조 검증
              if (!content.includes('<!DOCTYPE html>') && !content.includes('<!doctype html>')) {
                errors.push(`${path}: DOCTYPE이 없습니다`)
              }
              const openHtml = (content.match(/<html/gi) || []).length
              const closeHtml = (content.match(/<\/html>/gi) || []).length
              if (openHtml !== closeHtml) errors.push(`${path}: <html> 태그 불일치`)
              const openBody = (content.match(/<body/gi) || []).length
              const closeBody = (content.match(/<\/body>/gi) || []).length
              if (openBody !== closeBody) errors.push(`${path}: <body> 태그 불일치`)
            }
            if (path.endsWith('.js')) {
              // JS 문법 검증 (Function 생성자로 파싱)
              try {
                new Function(content)
              } catch (e: any) {
                errors.push(`${path}: JS 문법 오류 - ${e.message}`)
              }
            }
            if (path.endsWith('.css')) {
              // 관문 16: CSS 중괄호 균형 검증
              const openBrace = (content.match(/{/g) || []).length
              const closeBrace = (content.match(/}/g) || []).length
              if (openBrace !== closeBrace) {
                errors.push(`${path}: CSS 중괄호 불일치 ({ ${openBrace}개 vs } ${closeBrace}개)`)
              }
            }
          }
          if (errors.length > 0) {
            return { ok: false, output: errors.join('\n'), error: '검증 실패' }
          }
          return { ok: true, output: `검증 통과: ${targetPaths.length}개 파일` }
        }
        case 'ask_question': {
          // 사용자 입력 대기 시그널 — catch에서 그대로 다시 던짐
          const questions = args.questions
          if (!Array.isArray(questions) || questions.length === 0) {
            return { ok: false, output: '', error: 'questions가 필요합니다' }
          }
          throw new AwaitingInputSignal(questions.slice(0, 3))
        }
        default:
          return { ok: false, output: '', error: `알 수 없는 도구: ${call.name}` }
      }
    } catch (e: any) {
      // AwaitingInputSignal은 결과값이 아니라 제어 흐름이므로 그대로 전파
      if (e instanceof AwaitingInputSignal) throw e
      return { ok: false, output: '', error: e.message || '실행 오류' }
    }
  }

  getFiles(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of this.files) out[k] = v
    return out
  }

  // 미리보기용: index.html 또는 단일 HTML 조합
  getPreviewHtml(): string {
    // index.html이 있으면 참조된 CSS/JS를 인라인으로 합침
    if (this.files.has('index.html')) {
      let html = this.files.get('index.html')!
      // <link rel="stylesheet" href="..."> 를 <style>로 인라인
      html = html.replace(
        /<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi,
        (match, href) => {
          const css = this.files.get(href) || this.files.get(href.replace(/^\.\//, ''))
          if (css) return `<style>\n/* 인라인: ${href} */\n${css}\n</style>`
          return match
        }
      )
      // <script src="..."></script> 를 인라인
      html = html.replace(
        /<script\s+[^>]*src=["']([^"']+)["'][^>]*><\/script>/gi,
        (match, src) => {
          const js = this.files.get(src) || this.files.get(src.replace(/^\.\//, ''))
          if (js) return `<script>\n/* 인라인: ${src} */\n${js}\n</script>`
          return match
        }
      )
      return html
    }
    // 단일 html 파일이 하나면 그것
    const htmlFiles = [...this.files.keys()].filter(k => k.endsWith('.html'))
    if (htmlFiles.length === 1) {
      return this.files.get(htmlFiles[0])!
    }
    return ''
  }
}

// D1에 작업 공간 저장 (관문 42: batch로 최적화)
export async function saveWorkspaceToD1(
  db: any,
  versionId: number,
  files: Record<string, string>
): Promise<void> {
  const cryptoObj = crypto as any
  const statements = []
  for (const [path, content] of Object.entries(files)) {
    const hashBuf = await cryptoObj.subtle.digest('SHA-256', new TextEncoder().encode(content))
    const hash = [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, '0')).join('')
    const size = new TextEncoder().encode(content).length
    statements.push(
      db.prepare(
        `INSERT INTO artifact_files (version_id, file_path, content, content_sha256, file_size)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (version_id, file_path) DO UPDATE SET content=excluded.content, content_sha256=excluded.content_sha256, file_size=excluded.file_size`
      ).bind(versionId, path, content, hash, size)
    )
  }
  if (statements.length > 0) {
    await db.batch(statements)
  }
}

// D1에서 작업 공간 로드
export async function loadWorkspaceFromD1(db: any, versionId: number): Promise<Record<string, string>> {
  const { results } = await db.prepare(
    'SELECT file_path, content FROM artifact_files WHERE version_id=?'
  ).bind(versionId).all()
  const out: Record<string, string> = {}
  for (const r of (results || []) as any[]) {
    out[r.file_path] = r.content
  }
  return out
}
