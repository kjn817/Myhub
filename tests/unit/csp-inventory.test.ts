/// <reference types="jest" />
/**
 * CSP 실태 인벤토리 회귀 (2026-11-01, docs/security-csp-20261101.md).
 *
 * 성질:
 * - /desktop.html 파일럿 enforce의 전제(인라인 스크립트 0·속성형 핸들러 0·
 *   <style> 블록 0)가 깨지면 이 테스트가 실패한다. 전제가 깨진 채 정책만
 *   남으면 페이지가 조용히 죽으므로, 인라인을 추가하는 변경은 정책 재검토를
 *   강제받아야 한다.
 * - public/ 전체에 eval·new Function·document.write·동적 <script> 주입이
 *   없다는 실측이 유지돼야 한다 (script-src 'unsafe-eval' 불요의 근거).
 * - 속성형 핸들러(onclick="..." 문자열)와 프로퍼티 할당(el.onclick = fn)은
 *   구분한다: 후자는 CSP가 차단하지 않으므로 인벤토리에서 제외한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const PUB = path.join(__dirname, '..', '..', 'public')

function read(p: string): string {
  return fs.readFileSync(path.join(PUB, p), 'utf-8')
}

/** src 없는 인라인 <script> 블록 수 */
function inlineScriptBlocks(html: string): number {
  return (html.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*>/gi) || []).length
}

/** 속성형 인라인 핸들러: 태그 안 또는 템플릿 문자열 안의 on*="..." 형태 */
function attrFormHandlers(text: string): number {
  return (text.match(/(?<![\w.])on\w+\s*=\s*\\?["']/g) || []).length
}

const DESKTOP_JS = ['js/desktop/state.js', 'js/desktop/windows.js', 'js/desktop/main.js', 'nav.js']

describe('CSP 파일럿 전제 — desktop', () => {
  test('desktop.html에 인라인 스크립트·속성형 핸들러·<style> 블록이 없다', () => {
    const html = read('desktop.html')
    expect(inlineScriptBlocks(html)).toBe(0)
    expect(attrFormHandlers(html)).toBe(0)
    expect((html.match(/<style\b/gi) || []).length).toBe(0)
  })

  test('desktop이 로드하는 JS에 속성형 핸들러 문자열이 없다', () => {
    for (const f of DESKTOP_JS) {
      expect(attrFormHandlers(read(f))).toBe(0)
    }
  })

  test('desktop.html의 외부 스크립트는 self와 unpkg뿐이다 (정책 script-src와 일치)', () => {
    const html = read('desktop.html')
    const srcs = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)/gi)].map((m) => m[1])
    expect(srcs.length).toBeGreaterThan(0)
    for (const s of srcs) {
      const ok = s.startsWith('/') || s.startsWith('https://unpkg.com/')
      expect(ok).toBe(true)
    }
  })
})

describe('CSP 실태 — public 전체', () => {
  const allFiles: string[] = []
  // 벤더·엔진 빌드 산출물은 일파티 코드가 아니라 제외한다 (gate-23과 동일 범위)
  const VENDOR_DIRS = new Set(['vendor', 'pdf-viewer', 'rhwp-studio'])
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (VENDOR_DIRS.has(e.name)) continue
        walk(full)
      }
      else if (/\.(html|js)$/.test(e.name)) allFiles.push(full)
    }
  }
  walk(PUB)

  test('eval·new Function·document.write·createElement(script)가 없다', () => {
    const offenders: string[] = []
    for (const f of allFiles) {
      const t = fs.readFileSync(f, 'utf-8')
      if (/\beval\s*\(/.test(t)) offenders.push(`${f}: eval(`)
      if (/new\s+Function\s*\(/.test(t)) offenders.push(`${f}: new Function(`)
      if (/document\.write/.test(t)) offenders.push(`${f}: document.write`)
      if (/createElement\(\s*['"]script/.test(t)) offenders.push(`${f}: createElement('script')`)
      if (/setAttribute\(\s*['"]on/.test(t)) offenders.push(`${f}: setAttribute('on...')`)
    }
    expect(offenders).toEqual([])
  })

  test('<object>·<embed>·<base>·<form> 사용처가 없다 (object/base/form 지시자의 근거)', () => {
    const offenders: string[] = []
    for (const f of allFiles) {
      const t = fs.readFileSync(f, 'utf-8')
      for (const tag of ['object', 'embed', 'base', 'form', 'applet']) {
        if (new RegExp(`<${tag}\\b`, 'i').test(t)) offenders.push(`${f}: <${tag}>`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('인라인 스크립트가 남은 페이지가 있어 전 페이지 enforce가 불가함을 기록한다', () => {
    // 이 인벤토리가 전부 0이 되면 전 페이지 enforce 재검토 시점이다.
    // 그때는 이 테스트를 지우지 말고 정책을 올린 뒤 수치 기대값을 갱신할 것.
    // 2026-11-07 F2·F3: enforce 대상 15페이지는 전부 인라인 0이 됐다 —
    // 남은 것은 GENERAL 정책(스크립트 무제한) 페이지뿐이다. enforce
    // 페이지에 인라인이 되돌아오면 이 목록이 늘어나며 실패한다.
    // 2026-11-11 장부 갱신: HTML 5종 운영 원본을 전부 설치했다 (인라인 0).
    // sheet-fortune.html은 운영 번들(부트스트랩 내장)을 바이트 회수해
    // 함께 설치한 뒤에야 원본 페이지가 성립한다 — 번들 회수 전에는
    // 재구성본 페이지(인라인 부트스트랩)를 유지했었다.
    const withInline = fs
      .readdirSync(PUB)
      .filter((n) => n.endsWith('.html'))
      .filter((n) => inlineScriptBlocks(read(n)) > 0)
      .sort()
    expect(withInline).toEqual([
      'agent.html',
      'index.html',
      'memo.html',
      'memory.html',
    ])
  })
})
