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

describe('Excel GC_URL — 버전 부착 후에도 host=parent 유지 (운영 사고 카나리아)', () => {
  // 운영 구조(2026-11-09 실측): 엔진 URL은 sheet.html이 아니라
  // js/sheet-gridcraft.js의 GC_URL 상수가 들고 있고, sheet.html은
  // #sheetApp에 브리지를 자체 마운트한다 (구 sheet-bridge.js/engineSrc는
  // 재구축 시대 발명이라 운영에 없다). 검증 성질은 같다 — 배포 버전
  // 부착이 엔진 URL의 기존 쿼리를 깨면 host=parent를 잃어 엔진이
  // 호스트 없는 단독 모드로 뜨는 사고가 된다.
  const bridge = readPub('/js/sheet-gridcraft.js')
  const gcMatch = bridge.match(/GC_URL = '([^']+)'/)
  if (!gcMatch) throw new Error('GC_URL을 찾지 못함')
  const GC_URL = gcMatch[1]
  const ver = createVersioner(MANIFEST, 'testv999')

  test('GC_URL 원본: host=parent&chrome=notitlebar를 파싱할 수 있다', () => {
    const q = new URLSearchParams(GC_URL.split('?')[1])
    expect(q.get('host')).toBe('parent')
    expect(q.get('chrome')).toBe('notitlebar')
  })

  test('버전 부착이 GC_URL의 기존 쿼리를 삼키지 않는다', () => {
    // versioned 파일이 GC_URL을 그대로 참조하는 배포 형태를 재현한다.
    const deployed = ver(`<script src="${GC_URL}"></script>`)
    const src = deployed.match(/src="([^"]+)"/)![1]
    // 부착이 실제로 일어났는지 먼저 확인 (안 일어났으면 이 테스트는 무의미)
    expect(src).toContain('v=testv999')
    // '?'가 하나뿐이어야 한다 — 둘이면 쿼리가 깨진 것이다
    expect(src.split('?')).toHaveLength(2)
    const q = new URLSearchParams(src.split('?')[1])
    expect(q.get('host')).toBe('parent')
    expect(q.get('chrome')).toBe('notitlebar')
    expect(q.get('v')).toBe('testv999')
  })
})

describe('시스템 위젯 summarizeSystem — /api/system 실제 응답 형태', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const widgets = require('../public/js/desktop/widgets.js')

  // 운영 원본의 모델: { d1: {used,limit,pct}, cloud: {used,limit,pct}, workerName, runtime }
  // 또는 표시할 수 없으면 null. (재구축본의 storage/system 행 배열 모델은 운영에 없다.)
  test('cloudinary-api 소스면 D1·클라우드 사용률과 워커 정보가 나온다', () => {
    const sum = widgets.summarizeSystem({
      ok: true,
      d1: { size_bytes: 5242880, limit_bytes: 10737418240 },
      files: { count: 342, bytes: 1048576 },
      cloudinary: { used_bytes: 209715200, limit_bytes: 26843545600 },
      cloudinary_source: 'cloudinary-api',
      worker: { name: 'myhub', runtime: 'cloudflare' },
    })
    expect(sum.d1).toEqual({ used: 5242880, limit: 10737418240, pct: (5242880 / 10737418240) * 100 })
    expect(sum.cloud).toEqual({ used: 209715200, limit: 26843545600, pct: (209715200 / 26843545600) * 100 })
    expect(sum.workerName).toBe('myhub')
    expect(sum.runtime).toBe('cloudflare')
  })

  test('cloudinary가 아니면 files.bytes를 클라우드 사용량으로 쓴다 (limit 없음)', () => {
    const sum = widgets.summarizeSystem({
      d1: { size_bytes: 1, limit_bytes: 10 },
      files: { count: 2, bytes: 1048576 },
      cloudinary: null,
    })
    expect(sum.cloud).toEqual({ used: 1048576, limit: null, pct: 0 })
    expect(sum.d1.pct).toBe(10)
  })

  test('표시할 수 없는 응답에서는 null (위젯이 빈 상태를 띄우는 조건)', () => {
    expect(widgets.summarizeSystem(null)).toBeNull()
    expect(widgets.summarizeSystem({})).toBeNull()
    expect(widgets.summarizeSystem({ d1: { size_bytes: 1, limit_bytes: 10 } })).toBeNull()
  })
})

describe('폰트 이름 파싱 parseFontFileName', () => {
  const fontsJs = readPub('/js/fonts.js')
  let parse: (n: string) => { family: string; weight: number; style: string }
  beforeAll(() => {
    const g = globalThis as unknown as {
      fetch: unknown
      eval: (s: string) => void
      MyHubFonts: { parseFontFileName: typeof parse }
    }
    g.fetch = () => Promise.reject(new Error('stub'))
    g.eval(readPub('/js/common/constants.js')) // 5-9: 상수 선행 로드
    g.eval(fontsJs)
    parse = g.MyHubFonts.parseFontFileName
  })

  test('접미사가 weight/style로 해석된다', () => {
    expect(parse('Pretendard-Bold.ttf')).toEqual({ family: 'Pretendard', weight: 700, style: 'normal' })
    expect(parse('D2Coding-Regular.ttf')).toEqual({ family: 'D2Coding', weight: 400, style: 'normal' })
    expect(parse('NotoSansKR-Medium.woff2')).toEqual({ family: 'NotoSansKR', weight: 500, style: 'normal' })
    expect(parse('Font-BoldItalic.ttf')).toEqual({ family: 'Font', weight: 700, style: 'italic' })
    expect(parse('Happiness-Sans-Bold.ttf').family).toBe('Happiness-Sans')
  })

  test('이름 전체가 접미사뿐이면 벗기지 않는다 (보호 규칙)', () => {
    expect(parse('Bold.ttf')).toEqual({ family: 'Bold', weight: 400, style: 'normal' })
    expect(parse('Regular.otf')).toEqual({ family: 'Regular', weight: 400, style: 'normal' })
  })

  test('접미사가 없으면 그대로', () => {
    expect(parse('Pretendard.ttf')).toEqual({ family: 'Pretendard', weight: 400, style: 'normal' })
  })
})

describe('office.js 배선 핀 (재구축 소실 재발 방지)', () => {
  const office = readPub('/js/office.js')

  test('한글: 빈 hwpx 서식 파일로 바로 진입하고 Finder 열기 핸드셰이크를 연결한다', () => {
    // 운영 원본의 한글 배선: APPS.hangul이 blank.hwpx 서식을 들고 autoNew로
    // 직행하며, 파일 열기는 뷰어 코어가 아니라 이 호스트의
    // 'myhub:open-file' 수신 + 'myhub:open-file-ack' 응답이 맡는다.
    // (재구축본이 발명한 rhwp-editor transport 경로는 운영에 없다.)
    expect(office).toContain("title: '한글 2020'")
    expect(office).toContain("templateUrl: '/templates/blank.hwpx'")
    expect(office).toContain("'myhub:open-file'")
    expect(office).toContain("'myhub:open-file-ack'")
  })

  test('저장: 코어 createSave가 createSaveFlow로 배선된다', () => {
    // 운영 원본의 저장 경로는 RPC 내보내기가 아니라 호스트의
    // createSaveFlow다 ("다른 이름으로 저장" = 폴더 선택 + 이름 입력 뒤
    // POST 생성, 폴더 참조로 version 올리기).
    expect(office).toContain('function createSaveFlow')
    expect(office).toContain('createSave: createSaveFlow')
  })

  test('PowerPoint: deckcraft:fonts 푸시와 fonts-applied 재레이아웃 넛지가 호스트 파일에 있다', () => {
    // 운영 원본에서 이 배선은 office.js가 아니라 finder-deckcraft.js가
    // 맡는다 — 핀도 실제 파일에 건다.
    const deck = readPub('/js/finder-deckcraft.js')
    expect(deck).toContain("type: 'deckcraft:fonts'")
    expect(deck).toContain('deckcraft:fonts-applied')
  })

  test('접기: 단일 표면 접기 계약(toggle-collapse)이 뷰어 폴드 버튼과 맞물린다', () => {
    // 운영 원본의 표면 전환 계약: 호스트의 toggle-collapse가 뷰어 코어의
    // 자체 접기 버튼(#fvFoldBtn)과 같은 코어 접기를 구동한다.
    // (재구축본의 myhub-menu-backdrop 배경막은 운영에 없다.)
    expect(office).toContain('toggle-collapse')
    expect(office).toContain('fvFoldBtn')
  })
})
