/// <reference types="jest" />
/**
 * 정적 에셋 업로드 집합 테스트 (audit P-1, 2026-10-28)
 *
 * scripts/static-assets.json이 유일한 기준이다:
 * - 집합의 모든 파일이 public/에 실제로 존재한다.
 * - public/·src/에서 참조하는 모든 로컬 에셋이 집합 안에 있다
 *   (집합에서 파일을 빼면 참조 검사에서, 참조를 추가하면 집합 검사에서 실패한다).
 * - 집합의 모든 파일은 어딘가에서 참조되거나, 직접 URL로만 여는 페이지로
 *   명시돼 있다 (죽은 업로드 방지).
 * - public/ 원본에 하드코딩된 ?v= 쿼리가 없다 (버전은 배포 시 ver()가 붙인다.
 *   하드코딩이 있으면 ?v=AV?v=... 이중 쿼리가 된다 — memo.html 회귀).
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '../..')
const PUBLIC = path.join(ROOT, 'public')
const ASSET_LIST = path.join(ROOT, 'scripts', 'static-assets.json')

// 직접 URL로만 여는 페이지 (어디에서도 링크하지 않지만 운영에서 서빙 중이라 집합 유지)
const DIRECTLY_SERVED = new Set(['/backup.html', '/briefing.html'])

const REF_RE =
  /["'](\/[\w\-./]+\.(?:html|js|css|png|webp|json|ico|svg|woff2?|mjs))["']|url\((["']?)(\/[\w\-./]+\.\w+)\2\)/g
const HARDCODED_VERSIONED_URL_RE = /\/[\w\-./]+\.\w+\?v=/g

function loadList(): { files: string[]; versioned: string[] } {
  return JSON.parse(fs.readFileSync(ASSET_LIST, 'utf-8'))
}

function collectReferences(): Map<string, string[]> {
  const refs = new Map<string, string[]>()
  const scan = (dir: string, exts: Set<string>): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        scan(full, exts)
        continue
      }
      if (!exts.has(path.extname(entry.name))) continue
      if (full === path.join(ROOT, 'src', 'index-inline.ts')) continue // 생성 파일
      const text = fs.readFileSync(full, 'utf-8')
      for (const m of text.matchAll(REF_RE)) {
        const ref = m[1] || m[3]
        if (!ref || ref.startsWith('/api/')) continue
        const list = refs.get(ref) ?? []
        list.push(path.relative(ROOT, full))
        refs.set(ref, list)
      }
    }
  }
  scan(PUBLIC, new Set(['.html', '.js', '.css', '.json']))
  scan(path.join(ROOT, 'src'), new Set(['.ts', '.js']))
  return refs
}

describe('static-assets.json 집합', () => {
  test('files는 중복 없이 / 로 시작하고 public/에 존재한다', () => {
    const { files, versioned } = loadList()
    expect(files.length).toBeGreaterThan(0)
    expect(new Set(files).size).toBe(files.length)
    for (const f of files) {
      expect(f.startsWith('/')).toBe(true)
      expect(fs.statSync(path.join(PUBLIC, f)).isFile()).toBe(true)
    }
    // versioned는 files의 부분집합이고 텍스트 파일만 해당한다
    const fileSet = new Set(files)
    for (const v of versioned) {
      expect(fileSet.has(v)).toBe(true)
      expect(['.html', '.json'].includes(path.extname(v))).toBe(true)
    }
  })

  test('참조하는 모든 로컬 에셋이 집합 안에 있다', () => {
    const { files } = loadList()
    const fileSet = new Set(files)
    const refs = collectReferences()
    expect(refs.size).toBeGreaterThan(0)
    const missing = [...refs.keys()].filter((r) => !fileSet.has(r))
    expect(missing).toEqual([])
  })

  test('집합의 모든 파일은 참조되거나 직접 서빙 페이지로 명시돼 있다', () => {
    const { files } = loadList()
    const refs = collectReferences()
    const dead = files.filter((f) => !refs.has(f) && !DIRECTLY_SERVED.has(f))
    expect(dead).toEqual([])
  })

  test('public/ 원본에 하드코딩된 ?v= URL이 없다', () => {
    const offenders: string[] = []
    const scan = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          scan(full)
          continue
        }
        if (!['.html', '.js', '.css'].includes(path.extname(entry.name))) continue
        const text = fs.readFileSync(full, 'utf-8')
        if (HARDCODED_VERSIONED_URL_RE.test(text)) offenders.push(path.relative(ROOT, full))
      }
    }
    scan(PUBLIC)
    expect(offenders).toEqual([])
  })
})
