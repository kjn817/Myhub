/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 채팅 프론트 라우터 실시간 예외 + 전환 안내 조사 테스트 (2026-11-16)
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - "날씨 정리해줘" 같은 실시간 정보 질의는 '정리해'/'요약' 키워드가
 *   있어도 에코(keeper)가 아니라 루미(concierge)로 라우팅된다.
 * - 메모 대상이 명시되면 ("날씨 메모 정리해줘") 예외를 적용하지 않고
 *   에코로 간다.
 * - 전환 안내의 조사는 "(으)로"가 아니라 받침에 맞는 "로"/"으로"다.
 * - 서버 라우터(legacy-router.ts)와 같은 실시간 키워드 집합을 쓴다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '../..')
const doc: any = (globalThis as any).document
const win: any = (globalThis as any).window
const CHAT_JS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chat.js'), 'utf-8')
const TEXT_UTILS_JS = fs.readFileSync(
  path.join(ROOT, 'public', 'js', 'common', 'text-utils.js'),
  'utf-8',
)
const CHAT_HTML = fs.readFileSync(path.join(ROOT, 'public', 'chat.html'), 'utf-8')

function loadRouter() {
  const bodyHtml = CHAT_HTML.split('<body>')[1].split('</body>')[0]
  doc.body.innerHTML = bodyHtml
  win.eval(TEXT_UTILS_JS)
  // chat.js 끝에 return을 붙여 routeMessage·particleRo를 꺼낸다.
  // (chat.js는 new Function 본문으로 들어가므로 최상위 함수는 로컬이다.)
  const loader = new Function(
    'window',
    'document',
    'fetch',
    'marked',
    'DOMPurify',
    'hljs',
    'confirm',
    CHAT_JS + '\n;return { routeMessage, particleRo };',
  )
  return loader(
    win,
    doc,
    async () => ({ ok: true, json: async () => ({ ok: true }) }),
    { setOptions: () => {}, parse: (t: string) => t },
    { sanitize: (t: string) => t },
    { highlightElement: () => {} },
    () => true,
  ) as {
    routeMessage: (text: string) => { personaId: string; clean: string; routedBy?: string }
    particleRo: (name: string) => string
  }
}

describe('프론트 라우터 실시간 예외', () => {
  const { routeMessage } = loadRouter()

  test('날씨 정리해줘 → 루미 (에코 아님)', () => {
    const r = routeMessage('오늘 날씨 정리해줘 서울특별시')
    expect(r.personaId).toBe('concierge')
    expect(r.routedBy).toBe('realtime')
  })

  test('뉴스 요약해줘 → 루미', () => {
    const r = routeMessage('오늘 뉴스 요약해줘')
    expect(r.personaId).toBe('concierge')
    expect(r.routedBy).toBe('realtime')
  })

  test('주가 정리해줘 → 루미', () => {
    const r = routeMessage('삼성전자 주가 정리해줘')
    expect(r.personaId).toBe('concierge')
  })

  test('날씨 메모 정리해줘 → 에코 (메모 대상 명시)', () => {
    const r = routeMessage('날씨 메모 정리해줘')
    expect(r.personaId).toBe('keeper')
    expect(r.routedBy).toBe('keyword')
  })

  test('메모 요약해줘 → 에코 (실시간 키워드 없음)', () => {
    const r = routeMessage('어제 메모 요약해줘')
    expect(r.personaId).toBe('keeper')
  })

  test('날씨 코드 만들어줘 → 노바 (개발 키워드 우선)', () => {
    const r = routeMessage('날씨 코드 만들어줘')
    expect(r.personaId).toBe('builder')
  })

  test('서버 라우터와 같은 실시간 키워드 집합', () => {
    // 프론트와 서버의 실시간 키워드가 어긋나면 한쪽만 예외를 적용한다.
    const serverRouter = fs.readFileSync(
      path.join(ROOT, 'src', 'services', 'legacy-router.ts'),
      'utf-8',
    )
    const frontMatch = CHAT_JS.match(/const realtimeKw = \[([^\]]+)\]/)
    const serverMatch = serverRouter.match(/private realtimeKw = \[([^\]]+)\]/)
    expect(frontMatch).not.toBeNull()
    expect(serverMatch).not.toBeNull()
    const frontKws = frontMatch![1].split(',').map((s) => s.trim()).sort()
    const serverKws = serverMatch![1].split(',').map((s) => s.trim()).sort()
    expect(frontKws).toEqual(serverKws)
  })
})

describe('전환 안내 조사 particleRo', () => {
  const { particleRo } = loadRouter()

  test('비서 이름 4개는 모두 "로"', () => {
    expect(particleRo('루미')).toBe('로')
    expect(particleRo('에코')).toBe('로')
    expect(particleRo('노바')).toBe('로')
    expect(particleRo('캘리')).toBe('로')
  })

  test('받침 있는 이름은 "으로"', () => {
    expect(particleRo('민준')).toBe('으로')
    expect(particleRo('철민')).toBe('으로')
  })

  test('chat.js에 "(으)로" 문자열이 남아 있지 않다', () => {
    expect(CHAT_JS).not.toContain('(으)로')
  })
})
