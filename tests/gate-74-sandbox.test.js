/**
 * 관문 74: 미리보기 샌드박스 — 실제 파일 검증.
 *
 * 2026-10-27 전면 재작성: 이전 버전은 expect(true).toBe(true) 연극이었다.
 * 이제 실제 public/agent.html을 파싱해 미리보기 iframe의 sandbox 속성을 검증한다.
 * 성질: 미리보기 iframe은 sandbox="allow-scripts"만 가져야 한다.
 * allow-same-origin이 들어가면 미리보기 HTML이 부모 DOM에 접근할 수 있어
 * 샌드박스가 무력화되고, allow-top-navigation이 들어가면 부모를 이탈시킬 수 있다.
 *
 * 실행: npx jest tests/gate-74-sandbox.test.js
 */
const fs = require('fs')
const path = require('path')

const PUBLIC_DIR = path.join(__dirname, '..', 'public')
const AGENT_HTML = path.join(PUBLIC_DIR, 'agent.html')

// sandbox 토큰 중 부모 접근·이탈을 허용하는 위험 토큰
const DANGEROUS_TOKENS = [
  'allow-same-origin',
  'allow-top-navigation',
  'allow-top-navigation-by-user-activation',
  'allow-forms',
  'allow-popups',
  'allow-modals',
]

function findIframes(html) {
  const frames = []
  const re = /<iframe\b[^>]*>/gi
  let m
  while ((m = re.exec(html)) !== null) frames.push(m[0])
  return frames
}

function sandboxTokens(tag) {
  const m = tag.match(/sandbox\s*=\s*"([^"]*)"/i)
  if (!m) return null
  return m[1].split(/\s+/).filter(Boolean)
}

describe('관문 74: 미리보기 샌드박스 (실제 agent.html 검증)', () => {
  test('미리보기 iframe이 존재하고 sandbox="allow-scripts"만 가진다', () => {
    const html = fs.readFileSync(AGENT_HTML, 'utf8')
    const frames = findIframes(html)
    expect(frames.length).toBeGreaterThanOrEqual(1)
    const preview = frames.find((t) => t.includes('id="rightPreviewFrame"'))
    expect(preview).toBeTruthy()
    const tokens = sandboxTokens(preview)
    expect(tokens).not.toBeNull()
    // allow-scripts만 허용 — 그 외 토큰이 하나라도 있으면 부모 접근 경로가 생긴다
    expect(tokens.sort()).toEqual(['allow-scripts'])
  })

  test('미리보기 iframe에 부모 접근을 허용하는 위험 토큰이 없다', () => {
    const html = fs.readFileSync(AGENT_HTML, 'utf8')
    const preview = findIframes(html).find((t) => t.includes('id="rightPreviewFrame"'))
    const tokens = sandboxTokens(preview)
    for (const bad of DANGEROUS_TOKENS) {
      expect(tokens).not.toContain(bad)
    }
  })

  test('public/*.html의 iframe은 sandbox를 가지거나, 등록된 자사 엔진 프레임이다', () => {
    // 가드 목적은 "신뢰할 수 없는 콘텐츠를 싣는 iframe이 샌드박스 없이
    // 들어가지 못하게" 하는 것이다. 운영 구성(2026-11-09 실측): 정적
    // iframe은 agent.html 미리보기(sandbox 보유)와 아래 라이브 프레임뿐
    // 이고, 문서 엔진 프레임은 전부 JS가 만들며 생성 코드가 sandbox를
    // 건다(다음 테스트가 그 계약을 고정한다). 새 iframe이 이 목록 밖에
    // 샌드박스 없이 추가되면 이 테스트가 실패한다 — 목록에 넣으려면
    // 자사 엔진 프레임인 근거가 필요하다.
    const FIRST_PARTY_ENGINE_FRAMES = new Set([
      'bwLiveFrame', // browser.html — 원격 브라우저 라이브 표면 (browser-live.js가 서명 URL을 건다)
    ])
    const files = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html'))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8')
      for (const tag of findIframes(html)) {
        const id = (tag.match(/id\s*=\s*"([^"]*)"/i) || [])[1]
        if (id && FIRST_PARTY_ENGINE_FRAMES.has(id)) continue
        expect(sandboxTokens(tag)).not.toBeNull()
      }
    }
  })

  test('JS가 만드는 엔진 프레임은 생성 코드에서 sandbox를 건다', () => {
    // 운영의 문서 엔진 프레임(시트·슬라이드·PDF·GridCraft)은 정적 HTML에
    // 없고 형식 모듈·브리지가 createElement로 만든다. 그 생성 지점에서
    // sandbox 속성이 빠지면 신뢰할 수 없는 문서 콘텐츠가 부모와 같은
    // 권한으로 실행되므로, 파일별로 sandbox 부여 코드를 고정한다.
    const FACTORIES = [
      'js/finder-format-sheet.js', // 시트 뷰어 프레임
      'js/finder-format-pdf.js', // pdf.js 뷰어 프레임
      'js/finder-deckcraft.js', // DeckCraft 편집기 프레임
      'js/finder-pdfcraft.js', // PdfCraft 편집기 프레임
      'js/sheet-gridcraft.js', // GridCraft 엔진 프레임
    ]
    for (const rel of FACTORIES) {
      const src = fs.readFileSync(path.join(PUBLIC_DIR, rel), 'utf8')
      expect(src).toMatch(/setAttribute\(\s*'sandbox'\s*,\s*'allow-scripts/)
    }
  })
})
