/// <reference types="jest" />
/**
 * @jest-environment jsdom
 *
 * F1 프론트/엔진 부팅 결함군 회귀 테스트 (2026-11-07 운영 QA 실패의 카나리아)
 *
 * 검증하는 성질:
 * 1. 매니페스트 완전성: HTML이 참조하는 에셋은 전부 매니페스트에 있고,
 *    절대경로로 에셋을 참조하는 HTML은 전부 versioned에 있다 (원본 가드
 *    계약 — 빠지면 배포 후 구버전 캐시/404로 표면이 깨진다).
 * 2. 엔진 진입 파일(gridcraft·deckcraft·rhwp-studio)의 상대 참조까지
 *    매니페스트에 있다 (엔진은 런타임에 상대 URL로 WASM·글루를 더 읽는다).
 * 3. Excel: 배포 버전 부착(?v=)을 적용한 sheet.html에서도 engineSrc()가
 *    host=parent를 멀쩡한 쿼리 파라미터로 만든다 (운영 사고의 직접 원인 —
 *    부착된 ?v= 뒤에 '?host='를 문자열 결합해 파라미터가 삼켜졌었다).
 * 4. 시스템 위젯: /api/system의 실제 응답 형태(운영 번들 확정)에서
 *    메모·파일 개수와 저장소 행이 나온다.
 * 5. 폰트 이름 파싱: -Bold 등 접미사가 weight/style로 해석되고, 이름
 *    전체가 접미사뿐이면 벗기지 않는다.
 * 6. office.js 배선 핀: 한글 임베드 핸드셰이크·deckcraft 폰트 푸시·
 *    메뉴 배경막이 존재한다 (재구축 소실 재발 방지용 정적 가드 —
 *    실동작 증명은 실브라우저 하네스가 담당한다).
 */
import * as fs from 'fs'
import * as path from 'path'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createVersioner } = require('../scripts/asset-version.cjs')

const ROOT = path.resolve(__dirname, '..')
const PUB = path.join(ROOT, 'public')
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'static-assets.json'), 'utf-8'))
const FILES: Set<string> = new Set(MANIFEST.files)
const VERSIONED: Set<string> = new Set(MANIFEST.versioned)

function readPub(p: string): string {
  return fs.readFileSync(path.join(PUB, p), 'utf-8')
}

/** HTML 본문의 src=/href= 절대 참조 (쿼리 제거) */
function absoluteRefs(html: string): string[] {
  const out = new Set<string>()
  for (const m of html.matchAll(/(?:src|href)\s*=\s*["'](\/[^"']+)["']/g)) {
    const p = m[1].split('?')[0]
    if (!p.startsWith('//')) out.add(p)
  }
  return [...out]
}

/** 엔진 진입 HTML의 상대 참조를 진입 파일 기준으로 절대화 */
function relativeRefs(html: string, baseDir: string): string[] {
  const out = new Set<string>()
  for (const m of html.matchAll(/(?:src|href)\s*=\s*["'](\.\/[^"']+|\.\.\/[^"']+)["']/g)) {
    const abs = path.posix.normalize(path.posix.join(baseDir, m[1].split('?')[0]))
    out.add(abs.startsWith('/') ? abs : '/' + abs)
  }
  // module import / init() 안의 상대 경로 문자열
  for (const m of html.matchAll(/['"](\.\/[^'"]+\.(?:js|wasm))['"]/g)) {
    const abs = path.posix.normalize(path.posix.join(baseDir, m[1]))
    out.add(abs.startsWith('/') ? abs : '/' + abs)
  }
  return [...out]
}

describe('매니페스트 완전성 가드', () => {
  const htmlFiles = MANIFEST.files.filter((f: string) => f.endsWith('.html'))

  test('HTML이 절대경로로 참조하는 에셋은 전부 매니페스트에 있다', () => {
    const missing: string[] = []
    for (const p of htmlFiles) {
      for (const ref of absoluteRefs(readPub(p))) {
        if (ref === p) continue
        // API·페이지 네비게이션 등 에셋이 아닌 경로는 제외: 매니페스트 등재
        // 대상(정적 파일 확장자)만 검사한다.
        if (/\.(js|css|png|jpg|jpeg|svg|ico|webp|woff2?|ttf|otf|json|wasm|pdf)$/i.test(ref) && !FILES.has(ref)) {
          missing.push(`${p} → ${ref}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  test('절대경로로 에셋을 참조하는 HTML은 전부 versioned에 있다 (구버전 캐시 사고 카나리아)', () => {
    const offenders: string[] = []
    for (const p of htmlFiles) {
      const refs = absoluteRefs(readPub(p)).filter((r) => r !== p && FILES.has(r))
      if (refs.length && !VERSIONED.has(p)) offenders.push(p)
    }
    expect(offenders).toEqual([])
  })

  test('엔진 진입 파일의 상대 참조(WASM·글루·스니펫)가 전부 매니페스트에 있다', () => {
    const entries: Array<[string, string]> = [
      ['/vendor/gridcraft/index.html', '/vendor/gridcraft'],
      ['/vendor/deckcraft/index.html', '/vendor/deckcraft'],
      ['/vendor/pdfcraft/index.html', '/vendor/pdfcraft'],
      ['/rhwp-studio/index.html', '/rhwp-studio'],
    ]
    const missing: string[] = []
    for (const [entry, dir] of entries) {
      for (const ref of relativeRefs(readPub(entry), dir)) {
        if (!FILES.has(ref)) missing.push(`${entry} → ${ref}`)
      }
    }
    expect(missing).toEqual([])
  })

  test('매니페스트 등재 파일은 전부 디스크에 실재한다', () => {
    const missing = MANIFEST.files.filter((f: string) => !fs.existsSync(path.join(PUB, f)))
    expect(missing).toEqual([])
  })
})

describe('Excel engineSrc — 버전 부착 후에도 host=parent 유지 (운영 사고 카나리아)', () => {
  // engineSrc는 F3에서 sheet.html 인라인에서 js/sheet-bridge.js로 추출됐다
  // (SHEET_CSP script-src 'self' enforce). 검증 성질은 동일하다.
  const sheet = readPub('/js/sheet-bridge.js')
  const ver = createVersioner(MANIFEST, 'testv999')
  const deployed = ver(sheet)

  function runEngineSrc(html: string, fileId: string | null): string {
    const m = html.match(/function engineSrc\(\) \{[\s\S]*?\n  \}/)
    if (!m) throw new Error('engineSrc를 찾지 못함')
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function(
      'location',
      'fileId',
      m[0] + '\nreturn engineSrc();',
    ) as (loc: unknown, fid: unknown) => string
    return factory({ origin: 'http://harness.local' }, fileId)
  }

  test('원본 sheet.html: 새 문서 URL에 host=parent&new=1', () => {
    const q = new URLSearchParams(runEngineSrc(sheet, null).split('?')[1])
    expect(q.get('host')).toBe('parent')
    expect(q.get('new')).toBe('1')
  })

  test('배포본(?v= 부착) sheet.html: host 파라미터가 v 값에 삼켜지지 않는다', () => {
    // 부착이 실제로 일어났는지 먼저 확인 (안 일어났으면 이 테스트는 무의미)
    expect(deployed).toContain('/vendor/gridcraft/index.html?v=testv999')
    const q = new URLSearchParams(runEngineSrc(deployed, null).split('?')[1])
    expect(q.get('host')).toBe('parent')
    expect(q.get('new')).toBe('1')
  })

  test('배포본 sheet.html: 파일 열기 URL에 file 파라미터가 유지된다', () => {
    const q = new URLSearchParams(runEngineSrc(deployed, 'file-42').split('?')[1])
    expect(q.get('host')).toBe('parent')
    expect(q.get('file')).toBe('file-42')
  })
})

describe('시스템 위젯 summarizeSystem — /api/system 실제 응답 형태', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const widgets = require('../public/js/desktop/widgets.js')

  test('번들 확정 형태에서 메모·파일·저장소 행이 나온다', () => {
    const sum = widgets.summarizeSystem({
      ok: true,
      d1: { size_bytes: 5242880, limit_bytes: 10737418240 },
      memos: 128,
      files: { count: 342, bytes: 1048576 },
      cloudinary: { used_bytes: 209715200, limit_bytes: 26843545600 },
    })
    expect(sum.system).toEqual([
      { label: '메모', text: '128개' },
      { label: '파일', text: '342개' },
    ])
    expect(sum.storage.map((r: { label: string }) => r.label)).toEqual(['데이터베이스', '미디어'])
  })

  test('cloudinary가 null이면 미디어 행만 빠지고 나머지는 나온다', () => {
    const sum = widgets.summarizeSystem({
      d1: { size_bytes: 1, limit_bytes: 10 },
      memos: 3,
      files: { count: 2, bytes: 0 },
      cloudinary: null,
    })
    expect(sum.system).toHaveLength(2)
    expect(sum.storage).toHaveLength(1)
  })

  test('빈 응답에서는 빈 모델 (위젯이 "표시할 정보가 없어요"를 띄우는 조건)', () => {
    expect(widgets.summarizeSystem(null)).toEqual({ storage: [], system: [] })
    expect(widgets.summarizeSystem({})).toEqual({ storage: [], system: [] })
  })
})

describe('폰트 이름 파싱 parseFontName', () => {
  const fontsJs = readPub('/js/fonts.js')
  let parse: (n: string) => { family: string; weight: number; style: string }
  beforeAll(() => {
    const g = globalThis as unknown as {
      fetch: unknown
      eval: (s: string) => void
      MyHubFonts: { parseFontName: typeof parse }
    }
    g.fetch = () => Promise.reject(new Error('stub'))
    g.eval(fontsJs)
    parse = g.MyHubFonts.parseFontName
  })

  test('접미사가 weight/style로 해석된다', () => {
    expect(parse('Pretendard-Bold')).toEqual({ family: 'Pretendard', weight: 700, style: 'normal' })
    expect(parse('D2Coding-Regular')).toEqual({ family: 'D2Coding', weight: 400, style: 'normal' })
    expect(parse('NotoSansKR-Medium')).toEqual({ family: 'NotoSansKR', weight: 500, style: 'normal' })
    expect(parse('Font-BoldItalic')).toEqual({ family: 'Font', weight: 700, style: 'italic' })
    expect(parse('Happiness-Sans-Bold').family).toBe('Happiness-Sans')
  })

  test('이름 전체가 접미사뿐이면 벗기지 않는다 (보호 규칙)', () => {
    expect(parse('Bold')).toEqual({ family: 'Bold', weight: 400, style: 'normal' })
    expect(parse('Regular')).toEqual({ family: 'Regular', weight: 400, style: 'normal' })
  })

  test('접미사가 없으면 그대로', () => {
    expect(parse('Pretendard')).toEqual({ family: 'Pretendard', weight: 400, style: 'normal' })
  })
})

describe('office.js 배선 핀 (재구축 소실 재발 방지)', () => {
  const office = readPub('/js/office.js')

  test('한글: rhwp 임베드 핸드셰이크(EditorTransport)를 연결한다', () => {
    expect(office).toContain("import('/vendor/rhwp-editor/transport.js')")
    expect(office).toContain('EditorTransport')
    expect(office).toContain('RhwpEditor')
  })

  test('한글: 저장이 RPC 내보내기(exportHwpx/exportHwp)를 탄다', () => {
    expect(office).toContain('exportHwpx')
    expect(office).toContain('exportHwp')
    expect(office).toContain('notifySaved')
  })

  test('PowerPoint: deckcraft:fonts 푸시와 fonts-applied 재레이아웃 넛지가 있다', () => {
    expect(office).toContain("type: 'deckcraft:fonts'")
    expect(office).toContain('deckcraft:fonts-applied')
  })

  test('파일 메뉴: 배경막(myhub-menu-backdrop)으로 바깥 클릭을 닫는다', () => {
    expect(office).toContain('myhub-menu-backdrop')
    const css = readPub('/css/office.css')
    expect(css).toContain('.myhub-menu-backdrop')
  })
})
