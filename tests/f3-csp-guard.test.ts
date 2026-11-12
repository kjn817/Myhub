/// <reference types="jest" />
/**
 * F3 가드 테스트 (2026-11-07) — CSP enforce 페이지의 침묵 사망 재발 방지.
 *
 * 검증하는 성질: src/index.ts가 script-src 'self' (unsafe-inline 없음)로
 * enforce하는 페이지는, 그 CSP가 실제로 차단하는 것들을 하나도 포함하지
 * 않는다:
 * - 인라인 <script> 블록 (본문 있는 것)
 * - 외부 출처 스크립트 src (http/https/프로토콜 상대)
 * - <style> 요소 (style-src-elem/style-src 'self' — unsafe-inline 없음)
 * - 인라인 이벤트 핸들러 속성 (script-src-attr 'none')
 *
 * enforce 집합은 src/index.ts의 pathname→CSP 매핑에서 직접 파싱한다 —
 * 새 enforce 페이지가 생기면 자동으로 이 가드의 대상이 된다.
 * 카나리아: 어느 페이지에든 인라인 스크립트를 되돌리면 해당 페이지
 * 테스트가 실패한다 (수동 실증 완료 — 보고 참조).
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const PUB = path.join(ROOT, 'public')
const INDEX_TS = fs.readFileSync(path.join(ROOT, 'src', 'index.ts'), 'utf-8')

/** CSP 상수명 → 정책 문자열 */
function parseCspConstants(src: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of src.matchAll(/const (\w+_CSP) =\s*\n?\s*"([^"]+)"/g)) out.set(m[1], m[2])
  return out
}

/** pathname → 적용되는 CSP 상수명 (헤더 set 매핑에서 파싱) */
function parsePageCsp(src: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of src.matchAll(/pathname === '(\/[^']+\.html)'\)\s*headers\.set\('Content-Security-Policy', (\w+)\)/g)) {
    out.set(m[1], m[2])
  }
  return out
}

function directive(policy: string, name: string): string[] {
  for (const part of policy.split(';')) {
    const t = part.trim()
    if (t.startsWith(name + ' ')) return t.split(/\s+/)
  }
  return []
}

const constants = parseCspConstants(INDEX_TS)
const pageCsp = parsePageCsp(INDEX_TS)

/** script-src 'self' enforce (unsafe-inline 없음)인 페이지 목록 */
const enforcePages: string[] = []
for (const [page, constName] of pageCsp) {
  const policy = constants.get(constName)
  if (!policy) continue
  const scriptSrc = directive(policy, 'script-src')
  if (scriptSrc.includes("'self'") && !scriptSrc.includes("'unsafe-inline'")) enforcePages.push(page)
}

describe('CSP enforce 페이지 집합 (src/index.ts 매핑 파싱)', () => {
  test('알려진 enforce 페이지 13개가 전부 잡힌다 (매핑 파싱 rot 방지)', () => {
    const known = [
      '/login.html', '/desktop.html', '/key-rotation.html', '/backup.html',
      '/trace.html', '/offline.html',
      '/chat.html', '/finder.html', '/office.html', '/schedule.html',
      '/todo.html', '/browser.html', '/sheet.html',
    ]
    for (const p of known) expect(enforcePages).toContain(p)
  })
})

describe.each(enforcePages)('enforce 페이지 %s', (page) => {
  const html = fs.readFileSync(path.join(PUB, page), 'utf-8')
  const policy = constants.get(pageCsp.get(page)!)!

  test('인라인 <script> 블록이 없다', () => {
    const offenders: string[] = []
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      if (!/\bsrc\s*=/.test(m[1]) && m[2].trim()) offenders.push(m[2].trim().slice(0, 50))
    }
    expect(offenders).toEqual([])
  })

  test('외부 출처 스크립트 src가 없다', () => {
    const offenders: string[] = []
    for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
      if (/^(https?:)?\/\//.test(m[1])) offenders.push(m[1])
    }
    expect(offenders).toEqual([])
  })

  test('<style> 요소가 없다 (style-src-elem이 unsafe-inline을 허용하지 않는 한)', () => {
    const elem = directive(policy, 'style-src-elem')
    const fallback = directive(policy, 'style-src')
    const effective = elem.length ? elem : fallback
    if (effective.includes("'unsafe-inline'")) return
    expect(/<style\b/i.test(html)).toBe(false)
  })

  test('인라인 이벤트 핸들러 속성이 없다 (script-src-attr 대상)', () => {
    const attr = directive(policy, 'script-src-attr')
    if (!attr.includes("'none'")) return
    const offenders = html.match(/<[a-z][^>]*\son[a-z]+\s*=/gi) || []
    expect(offenders).toEqual([])
  })
})
