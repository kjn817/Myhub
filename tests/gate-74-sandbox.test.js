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
    // 들어가지 못하게" 하는 것이다. 아래 3개는 부모와 같은 출처에서
    // 서로 통신하며 동작하는 자사 앱 엔진 프레임이라 샌드박스 대상이
    // 아니다 (2026-11 원본 구성). 새 iframe이 이 목록 밖에서 샌드박스
    // 없이 추가되면 이 테스트가 실패한다 — 목록에 넣으려면 자사 엔진
    // 프레임인 근거가 필요하다.
    const FIRST_PARTY_ENGINE_FRAMES = new Set([
      'browserFrame', // browser.html — 원격 브라우저 표면
      'officeEngine', // office.html — 문서 엔진
      'sheetEngine', // sheet.html — 스프레드시트 엔진
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
})
