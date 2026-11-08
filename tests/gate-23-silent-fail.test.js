/**
 * 관문 테스트 23: 조용한 실패 — 실제 프론트엔드 소스 정적 검증.
 *
 * 2026-10-27 전면 재작성: 이전 버전은 하드코딩한 문자열 배열의 길이를
 * 세는 연극이었다. 이제 public/ 아래의 실제 .js/.html 파일을 스캔해
 * 본문이 비어 있거나 주석만 있는 catch 블록(에러를 조용히 삼키는 곳)이
 * 하나라도 있으면 실패한다.
 *
 * 검증하는 성질: catch 블록은 최소 하나의 실행 문장을 가져야 한다
 * (console.warn 기록, 폴백 값 할당, throw, UI 표시 등). 빈 catch는
 * 디버깅을 불가능하게 하고 사용자에게 실패 원인을 숨긴다.
 *
 * 2026-10-27에 48곳을 전부 console.warn 기록으로 고쳤다
 * (agent.html 9·nav.js 1·sw.js 1·memo/*.js 13·chat.js 6·index.html 3·
 * schedule.html 2·todo.html 2·assistant-widget.js 1 + 생성물
 * memo-bundle.js 재생성). 이 테스트는 재발 방지용이다.
 */
const fs = require('fs')
const path = require('path')

const PUBLIC_DIR = path.join(__dirname, '../public')

// 벤더·엔진 빌드 산출물은 일파티 코드가 아니라 스캔에서 제외한다
// (pdf.js·rhwp·kordoc 등 — 남의 빌드 결과물의 catch까지 고칠 수는 없다).
// 게이트의 성질은 우리 코드의 조용한 실패를 막는 것이다.
const VENDOR_DIRS = new Set(['vendor', 'pdf-viewer', 'rhwp-studio'])

function collectFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (VENDOR_DIRS.has(e.name)) continue
      collectFiles(p, out)
    }
    else if (/\.(js|html)$/.test(e.name)) out.push(p)
  }
  return out
}

// 본문이 비어 있거나 주석뿐인 catch 블록을 찾는다.
// catch (...) { } / catch { } / .catch(() => {}) / .catch(function () {}) 형태.
function findSilentCatches(src) {
  const hits = []
  const re = /catch\s*(?:\([^)]*\))?\s*\{/g
  let m
  while ((m = re.exec(src))) {
    let j = re.lastIndex
    while (j < src.length) {
      if (/\s/.test(src[j])) { j++; continue }
      if (src.startsWith('//', j)) { j = src.indexOf('\n', j); if (j < 0) j = src.length; continue }
      if (src.startsWith('/*', j)) { j = src.indexOf('*/', j) + 2; continue }
      break
    }
    if (src[j] === '}') {
      hits.push({
        line: src.slice(0, m.index).split('\n').length,
        snippet: src.slice(m.index, j + 1).replace(/\n/g, ' ').slice(0, 120),
      })
    }
  }
  const re2 = /\.catch\(\s*(?:\(\s*\)\s*=>\s*\{\s*\}|function\s*\([^)]*\)\s*\{\s*\})/g
  while ((m = re2.exec(src))) {
    hits.push({
      line: src.slice(0, m.index).split('\n').length,
      snippet: m[0].slice(0, 120),
    })
  }
  return hits
}

describe('관문 23: 조용한 실패 (실제 프론트엔드 소스 스캔)', () => {
  test('public/에 본문이 빈 catch 블록이 하나도 없다', () => {
    const files = collectFiles(PUBLIC_DIR)
    expect(files.length).toBeGreaterThan(0)
    const problems = []
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8')
      for (const h of findSilentCatches(src)) {
        problems.push(`${path.relative(PUBLIC_DIR, f)}:${h.line}: ${h.snippet}`)
      }
    }
    expect(problems).toEqual([])
  })
})
