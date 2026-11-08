/// <reference types="jest" />
/**
 * src/services/studio-verify.ts — 스튜디오 산출물 정적 검증 성질 테스트.
 *
 * 고정하는 성질:
 * - 태그 균형: 닫히지 않은/어긋난 태그는 실패로 잡고, void·선택 닫힘·
 *   raw-text(script/style)·주석·SVG foreign void는 정상으로 통과시킨다.
 * - 참조 검사: 로컬 참조는 파일 집합에 실재해야 하고, 외부·특수 참조
 *   (http, //, /, #, data:, mailto:)는 검사 대상이 아니다. 상대 경로는
 *   기준 파일 위치에서 정규화(./ ../ 쿼리·해시 제거, URL 디코드)된다.
 * - id 중복은 실패다.
 * - 보고서 산술: passed/total/score가 검사 결과와 정확히 일치하고,
 *   실패 목록은 실패한 검사만 담는다. limitations는 항상 3건 공지.
 * - 수리 흐름: 만점이면 수리를 부르지 않고, 시간 한도를 넘기면 부르지
 *   않으며, 수리 결과가 더 나쁘면 버리고 원본을 유지한다 (repairDiscarded).
 * 카나리아: checkTagBalance의 균형 판정을 무력화하면 실패한다.
 */
import {
  checkTagBalance,
  resolveRef,
  checkReferences,
  checkDuplicateIds,
  verifyStudioFiles,
  verifyAndMaybeRepair,
  REPAIR_ELAPSED_LIMIT_MS,
  STUDIO_VERIFY_LIMITATIONS,
} from '../../src/services/studio-verify'

describe('checkTagBalance — 정상 형태', () => {
  test('중첩 태그가 올바르게 닫히면 통과', () => {
    expect(checkTagBalance('<div><span>텍스트</span><b>굵게</b></div>').ok).toBe(true)
  })

  test('void 태그는 닫지 않아도 통과', () => {
    expect(checkTagBalance('<div><br><img src="a.png"><input type="text"><hr></div>').ok).toBe(true)
  })

  test('선택 닫힘 태그(p·li)는 암시적 닫힘을 허용한다', () => {
    expect(checkTagBalance('<ul><li>하나<li>둘</ul><p>문단<p>다음').ok).toBe(true)
  })

  test('주석과 doctype 안의 태그는 세지 않는다', () => {
    expect(checkTagBalance('<!DOCTYPE html><!-- <div> --><html><body></body></html>').ok).toBe(true)
  })

  test('script 본문 안의 태그 모양 문자열은 태그로 세지 않는다', () => {
    const html = '<div><script>if (a < b) { el.innerHTML = "</p>"; }</script></div>'
    expect(checkTagBalance(html).ok).toBe(true)
  })

  test('style·textarea·title도 raw-text로 취급한다', () => {
    expect(checkTagBalance('<style>.a > .b { color: red; }</style><textarea><div></textarea>').ok).toBe(true)
  })

  test('SVG 내부 void 도형(path·circle·rect)은 닫지 않아도 통과', () => {
    expect(checkTagBalance('<svg viewBox="0 0 10 10"><path d="M0 0"/><circle cx="1" cy="1" r="1"/><rect x="0" y="0" width="2" height="2"/></svg>').ok).toBe(true)
  })

  test('자기 닫힘 태그는 통과', () => {
    expect(checkTagBalance('<div/><custom-el/>').ok).toBe(true)
  })

  test('빈 문자열·태그 없는 텍스트는 통과', () => {
    expect(checkTagBalance('').ok).toBe(true)
    expect(checkTagBalance('그냥 텍스트 < 아님').ok).toBe(true)
  })
})

describe('checkTagBalance — 깨진 형태', () => {
  test('닫히지 않은 태그는 실패하고 태그 이름을 알린다', () => {
    const r = checkTagBalance('<div><span>텍스트</span>')
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('div')
  })

  test('열린 태그와 다른 닫힘 태그는 실패', () => {
    const r = checkTagBalance('<div></span>')
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('</span>')
  })

  test('교차 중첩(<div><b></div>)은 실패', () => {
    expect(checkTagBalance('<div><b></div>').ok).toBe(false)
  })

  test('닫히지 않은 script는 실패', () => {
    const r = checkTagBalance('<div><script>var a = 1;')
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('script')
  })

  test('닫힘만 있는 태그는 실패', () => {
    expect(checkTagBalance('</div>').ok).toBe(false)
  })
})

describe('resolveRef — 경로 정규화', () => {
  test('같은 폴더 참조', () => {
    expect(resolveRef('pages/index.html', 'app.js')).toBe('pages/app.js')
  })

  test('상위 폴더 참조', () => {
    expect(resolveRef('pages/sub/index.html', '../assets/app.js')).toBe('pages/assets/app.js')
  })

  test('./ 접두와 쿼리·해시는 제거된다', () => {
    expect(resolveRef('index.html', './app.js?v=3#top')).toBe('app.js')
  })

  test('루트 파일 기준에서는 폴더 접두가 없다', () => {
    expect(resolveRef('index.html', 'css/main.css')).toBe('css/main.css')
  })

  test('URL 인코딩된 파일명을 디코드한다', () => {
    expect(resolveRef('index.html', 'images/%EC%82%AC%EC%A7%84.png')).toBe('images/사진.png')
  })

  test('폴더보다 위로 올라가면 가능한 만큼만 pop한다', () => {
    expect(resolveRef('a/index.html', '../../x.js')).toBe('x.js')
  })
})

describe('checkReferences', () => {
  const files = new Set(['index.html', 'app.js', 'css/main.css', 'pages/a.html'])

  test('로컬 참조가 전부 실재하면 통과하고 건수를 알린다', () => {
    const r = checkReferences('index.html', '<script src="app.js"></script><link href="css/main.css">', files)
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('2건')
  })

  test('없는 파일을 참조하면 실패하고 참조와 해석 경로를 알린다', () => {
    const r = checkReferences('pages/a.html', '<img src="missing.png">', files)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('missing.png')
    expect(r.detail).toContain('pages/missing.png')
  })

  test('외부·특수 참조는 검사하지 않는다', () => {
    const html = [
      '<script src="https://cdn.example.com/x.js"></script>',
      '<script src="//cdn.example.com/y.js"></script>',
      '<link href="/absolute.css">',
      '<a href="#section">x</a>',
      '<a href="mailto:a@b.c">m</a>',
      '<img src="data:image/png;base64,AAAA">',
    ].join('')
    const r = checkReferences('index.html', html, files)
    expect(r.ok).toBe(true)
    expect(r.detail).toBe('로컬 참조 없음')
  })
})

describe('checkDuplicateIds', () => {
  test('id가 고유하면 통과', () => {
    expect(checkDuplicateIds('<div id="a"></div><span id="b"></span>').ok).toBe(true)
  })

  test('id가 중복되면 실패하고 그 id를 알린다', () => {
    const r = checkDuplicateIds('<div id="main"></div><span id=\'main\'></span>')
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('"main"')
  })
})

describe('verifyStudioFiles — 보고서 산술', () => {
  test('HTML이 없으면 entry 검사가 실패하고 점수는 0', () => {
    const r = verifyStudioFiles({ 'app.js': 'var a = 1;' })
    expect(r.total).toBe(1)
    expect(r.passed).toBe(0)
    expect(r.score).toBe(0)
    expect(r.failures.map((f) => f.id)).toEqual(['entry'])
    expect(r.limitations).toEqual(STUDIO_VERIFY_LIMITATIONS)
    expect(r.limitations.length).toBe(3)
  })

  test('정상 HTML 1개면 전 검사 통과·점수 100', () => {
    const r = verifyStudioFiles({
      'index.html': '<!DOCTYPE html><html><body><script src="app.js"></script></body></html>',
      'app.js': 'var a = 1;',
    })
    expect(r.total).toBe(4) // entry + tag-balance + references + duplicate-ids
    expect(r.passed).toBe(4)
    expect(r.score).toBe(100)
    expect(r.failures).toEqual([])
  })

  test('깨진 참조가 있으면 그 검사만 실패로 집계된다', () => {
    const r = verifyStudioFiles({
      'index.html': '<html><body><img src="none.png"></body></html>',
    })
    expect(r.total).toBe(4)
    expect(r.passed).toBe(3)
    expect(r.score).toBe(75)
    expect(r.failures.length).toBe(1)
    expect(r.failures[0].id).toBe('references')
    expect(r.failures[0].file).toBe('index.html')
  })

  test('HTML이 여러 개면 파일마다 3검사씩 붙는다', () => {
    const r = verifyStudioFiles({
      'a.html': '<p>단락',
      'b.html': '<div id="x"></div><div id="x"></div>',
      'style.css': 'body{}',
    })
    expect(r.total).toBe(1 + 3 * 2)
    // a.html은 p 선택 닫힘이라 통과, b.html은 id 중복 실패 1건
    expect(r.failures.length).toBe(1)
    expect(r.failures[0].id).toBe('duplicate-ids')
    expect(r.failures[0].file).toBe('b.html')
  })
})

describe('verifyAndMaybeRepair — 수리 흐름 경계', () => {
  const broken = { 'index.html': '<html><body><img src="none.png"></body></html>' }
  const fixed = { 'index.html': '<html><body><p>수리됨</p></body></html>' }

  test('수리 한도 상수는 5분이다', () => {
    expect(REPAIR_ELAPSED_LIMIT_MS).toBe(5 * 60 * 1000)
  })

  test('만점이면 수리 함수를 부르지 않는다', async () => {
    const repair = jest.fn(async () => fixed)
    const r = await verifyAndMaybeRepair(fixed, { repair, elapsedMs: 0 })
    expect(repair).not.toHaveBeenCalled()
    expect(r.repaired).toBe(false)
    expect(r.files).toBe(fixed)
  })

  test('수리 함수가 없으면 원본 그대로 반환', async () => {
    const r = await verifyAndMaybeRepair(broken, { elapsedMs: 0 })
    expect(r.repaired).toBe(false)
    expect(r.files).toBe(broken)
    expect(r.report.score).toBeLessThan(100)
  })

  test('경과 시간이 한도 이상이면 수리를 시도하지 않는다', async () => {
    const repair = jest.fn(async () => fixed)
    const r = await verifyAndMaybeRepair(broken, { repair, elapsedMs: REPAIR_ELAPSED_LIMIT_MS })
    expect(repair).not.toHaveBeenCalled()
    expect(r.repaired).toBe(false)
  })

  test('커스텀 한도를 넘기면 수리하지 않는다', async () => {
    const repair = jest.fn(async () => fixed)
    const r = await verifyAndMaybeRepair(broken, { repair, repairElapsedLimitMs: 1000, elapsedMs: 1000 })
    expect(repair).not.toHaveBeenCalled()
    expect(r.repaired).toBe(false)
  })

  test('수리가 null을 돌려주면 원본 유지', async () => {
    const r = await verifyAndMaybeRepair(broken, { repair: async () => null, elapsedMs: 0 })
    expect(r.repaired).toBe(false)
    expect(r.files).toBe(broken)
  })

  test('수리 후 점수가 오르지 않으면 버리고 원본을 유지한다 (repairDiscarded)', async () => {
    const stillBroken = { 'index.html': '<html><body><img src="other.png"></body></html>' }
    const r = await verifyAndMaybeRepair(broken, { repair: async () => stillBroken, elapsedMs: 0 })
    expect(r.repaired).toBe(false)
    expect(r.repairDiscarded).toBe(true)
    expect(r.files).toBe(broken)
  })

  test('수리 후 점수가 오르면 교체하고 beforeScore를 남긴다', async () => {
    const seen: unknown[] = []
    const r = await verifyAndMaybeRepair(broken, {
      repair: async (files, failures) => {
        seen.push(failures.map((f) => f.id))
        return fixed
      },
      elapsedMs: 0,
    })
    expect(r.repaired).toBe(true)
    expect(r.files).toBe(fixed)
    expect(r.report.score).toBe(100)
    expect(r.beforeScore).toBe(75)
    // 수리 함수에는 실패 목록만 전달된다
    expect(seen[0]).toEqual(['references'])
  })
})
