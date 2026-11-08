export interface StudioVerifyCheck {
  id: string
  file?: string
  ok: boolean
  detail: string
}

export interface StudioVerifyReport {
  checks: StudioVerifyCheck[]
  passed: number
  total: number
  score: number
  failures: StudioVerifyCheck[]
  limitations: string[]
}

export const STUDIO_VERIFY_LIMITATIONS: string[] = [
  '인라인 스크립트의 구문·실행 결과는 검사하지 않습니다',
  '실제 렌더링 화면(레이아웃·폰트·색상)은 대조하지 않습니다',
  '외부 URL 참조는 도달 가능성을 검사하지 않습니다',
]

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title'])

const OPTIONAL_CLOSE_TAGS = new Set([
  'p',
  'li',
  'dt',
  'dd',
  'tr',
  'td',
  'th',
  'thead',
  'tbody',
  'tfoot',
  'option',
])

const FOREIGN_VOID_TAGS = new Set([
  'path',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'rect',
  'stop',
  'use',
])

const TAG_RE = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/y
const REF_RE = /(?:src|href)\s*=\s*["']([^"']+)["']/gi

export const REPAIR_ELAPSED_LIMIT_MS = 5 * 60_000

export function checkTagBalance(html: string): { ok: boolean; detail: string } {
  const stack: string[] = []
  const src = String(html || '')
  let pos = 0
  while (pos < src.length) {
    const lt = src.indexOf('<', pos)
    if (lt === -1) break
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4)
      pos = end === -1 ? src.length : end + 3
      continue
    }
    if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
      const end = src.indexOf('>', lt + 2)
      pos = end === -1 ? src.length : end + 1
      continue
    }
    TAG_RE.lastIndex = lt
    const m = TAG_RE.exec(src)
    if (!m) {
      pos = lt + 1
      continue
    }
    const isClose = m[1] === '/'
    const tag = m[2].toLowerCase()
    const attrs = m[3] || ''
    pos = TAG_RE.lastIndex
    if (!isClose && RAW_TEXT_TAGS.has(tag) && !/\/\s*$/.test(attrs)) {
      const closeRe = new RegExp(`</\\s*${tag}\\s*>`, 'i')
      const cm = closeRe.exec(src.slice(pos))
      if (!cm) return { ok: false, detail: `<${tag}> 태그가 닫히지 않았습니다` }
      pos += cm.index + cm[0].length
      continue
    }
    if (isClose) {
      if ((tag === 'svg' || tag === 'math') && stack.includes(tag)) {
        while (stack.length > 0 && stack.pop() !== tag) {
        }
        continue
      }
      while (
        stack.length > 0 &&
        stack[stack.length - 1] !== tag &&
        OPTIONAL_CLOSE_TAGS.has(stack[stack.length - 1])
      ) {
        stack.pop()
      }
      if (stack.length === 0 || stack[stack.length - 1] !== tag) {
        return { ok: false, detail: `닫힘 태그 </${tag}>가 열림 태그와 맞지 않습니다` }
      }
      stack.pop()
      continue
    }
    if (VOID_TAGS.has(tag) || /\/\s*$/.test(attrs)) continue
    if (FOREIGN_VOID_TAGS.has(tag) && (stack.includes('svg') || stack.includes('math'))) continue
    if (OPTIONAL_CLOSE_TAGS.has(tag) && stack[stack.length - 1] === tag) stack.pop()
    stack.push(tag)
  }
  const unclosed = stack.filter((t) => !OPTIONAL_CLOSE_TAGS.has(t))
  if (unclosed.length > 0) {
    return { ok: false, detail: `<${unclosed[unclosed.length - 1]}> 태그가 닫히지 않았습니다` }
  }
  return { ok: true, detail: '태그 균형 정상' }
}

function isExternalOrSpecialRef(ref: string): boolean {
  return (
    /^(https?:)?\/\//i.test(ref) ||
    ref.startsWith('/') ||
    ref.startsWith('#') ||
    /^(data|mailto|tel|javascript):/i.test(ref)
  )
}

export function resolveRef(fromFile: string, ref: string): string {
  const clean = ref.split(/[?#]/)[0]
  let decoded = clean
  try {
    decoded = decodeURIComponent(clean)
  } catch {
  }
  const parts = fromFile.split('/').slice(0, -1)
  for (const seg of decoded.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  return parts.join('/')
}

export function checkReferences(
  fromFile: string,
  html: string,
  fileSet: Set<string>,
): { ok: boolean; detail: string } {
  let m: RegExpExecArray | null
  REF_RE.lastIndex = 0
  let count = 0
  while ((m = REF_RE.exec(String(html || '')))) {
    const ref = m[1].trim()
    if (!ref || isExternalOrSpecialRef(ref)) continue
    count++
    const resolved = resolveRef(fromFile, ref)
    if (!fileSet.has(resolved)) {
      return { ok: false, detail: `참조한 파일이 없습니다: ${ref} (→ ${resolved})` }
    }
  }
  return { ok: true, detail: count > 0 ? `로컬 참조 ${count}건 모두 실재` : '로컬 참조 없음' }
}

export function checkDuplicateIds(html: string): { ok: boolean; detail: string } {
  const seen = new Set<string>()
  const re = /\bid\s*=\s*["']([^"']+)["']/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(String(html || '')))) {
    const id = m[1]
    if (seen.has(id)) return { ok: false, detail: `id가 중복됩니다: "${id}"` }
    seen.add(id)
  }
  return { ok: true, detail: 'id 중복 없음' }
}

function isHtmlFile(name: string): boolean {
  return /\.html?$/i.test(name)
}

export function verifyStudioFiles(files: Record<string, string>): StudioVerifyReport {
  const checks: StudioVerifyCheck[] = []
  const names = Object.keys(files || {})
  const fileSet = new Set(names.map((n) => n.replace(/^\.\//, '')))
  const htmlFiles = names.filter(isHtmlFile)
  checks.push({
    id: 'entry',
    ok: htmlFiles.length > 0,
    detail: htmlFiles.length > 0 ? `진입 HTML: ${htmlFiles[0]}` : 'HTML 파일이 없습니다',
  })
  for (const name of htmlFiles) {
    const content = files[name]
    const balance = checkTagBalance(content)
    checks.push({ id: 'tag-balance', file: name, ok: balance.ok, detail: balance.detail })
    const refs = checkReferences(name, content, fileSet)
    checks.push({ id: 'references', file: name, ok: refs.ok, detail: refs.detail })
    const ids = checkDuplicateIds(content)
    checks.push({ id: 'duplicate-ids', file: name, ok: ids.ok, detail: ids.detail })
  }
  const passed = checks.filter((c) => c.ok).length
  const total = checks.length
  return {
    checks,
    passed,
    total,
    score: total > 0 ? Math.round((passed / total) * 100) : 100,
    failures: checks.filter((c) => !c.ok),
    limitations: [...STUDIO_VERIFY_LIMITATIONS],
  }
}

export async function verifyAndMaybeRepair(
  files: Record<string, string>,
  opts: {
    repair?: (
      files: Record<string, string>,
      failures: StudioVerifyCheck[],
    ) => Promise<Record<string, string> | null>
    repairElapsedLimitMs?: number
    elapsedMs: number
  },
): Promise<{
  files: Record<string, string>
  report: StudioVerifyReport
  repaired: boolean
  repairDiscarded?: boolean
  beforeScore?: number
}> {
  const report = verifyStudioFiles(files)
  if (report.score >= 100 || !opts.repair) return { files, report, repaired: false }
  const limit = opts.repairElapsedLimitMs ?? REPAIR_ELAPSED_LIMIT_MS
  if (opts.elapsedMs >= limit) return { files, report, repaired: false }
  const repairedFiles = await opts.repair(files, report.failures)
  if (!repairedFiles) return { files, report, repaired: false }
  const repairedReport = verifyStudioFiles(repairedFiles)
  if (repairedReport.score <= report.score) {
    return { files, report, repaired: false, repairDiscarded: true }
  }
  return { files: repairedFiles, report: repairedReport, repaired: true, beforeScore: report.score }
}
