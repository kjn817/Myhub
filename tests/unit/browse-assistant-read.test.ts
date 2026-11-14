/// <reference types="jest" />
/**
 * src/modules/browse/assistant-read.ts — SSRF 검증과 페이지 읽기 성질 테스트 (C3).
 *
 * 고정하는 성질:
 * - validatePublicUrl: 사설·링크-local·CGNAT·멀티캐스트·0.0.0.0 대역과
 *   localhost/.local/.internal/.lan/.home.arpa 호스트, 자격증명이 든 URL은
 *   blocked_host/invalid_url로 막고, 경계 밖 공인 주소(172.32.x, 100.128.x,
 *   공인 IPv6, IPv4-mapped 공인 IPv6)는 통과시킨다 — 경계값 양쪽을 고정한다.
 * - readPage: 세션 발급 실패 종류(quota/upstream/connect)를 구분하고,
 *   성공 시 본문·제목을 돌려주며 상한 초과분은 truncated와 함께 잘린다.
 *   렌더링이 끝나지 않으면 timeout, 추출 실패는 extract, 빈 본문은 empty로
 *   구분된다. 어떤 경로에서도 세션 정리(DELETE)를 시도한다.
 * CDP 소켓은 CdpSocket 인터페이스의 가짜 구현, 세션 발급은 주입된 fetchFn —
 * 실 Browser Run 연결은 하지 않는다.
 * 카나리아: 차단 대역 판정이나 절단 로직을 깨면 해당 테스트가 실패한다.
 */
import { readPage, validatePublicUrl, type PageReadResult } from '../../src/modules/browse/assistant-read'
import type { CdpSocket } from '../../src/modules/browse/cdp'

describe('validatePublicUrl — 차단 대역', () => {
  const blocked = [
    'http://127.0.0.1/admin',
    'http://127.255.0.9/',
    'http://10.1.2.3/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.0.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://100.64.0.1/',
    'http://100.127.255.255/',
    'http://0.0.0.0/',
    'http://0.1.2.3/',
    'http://192.0.0.1/',
    'http://198.18.0.1/',
    'http://198.19.0.1/',
    'http://224.0.0.1/',
    'http://255.255.255.255/',
    'http://localhost:8787/',
    'http://api.localhost/',
    'http://printer.local/',
    'http://db.internal/',
    'http://nas.lan/',
    'http://router.home.arpa/',
    'http://[::1]/',
    'http://[::]/',
    'http://[fe80::1]/',
    'http://[febf::abcd]/',
    'http://[fd12::1]/',
    'http://[fc00::1]/',
    'http://[ff02::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:10.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:7f00:0001]/',
  ]
  test.each(blocked)('%s → blocked_host', (url) => {
    expect(validatePublicUrl(url)).toEqual({ ok: false, error: 'blocked_host' })
  })

  const allowed = [
    'https://example.com/path?q=1',
    'http://8.8.8.8/dns',
    'http://172.32.0.1/', // 172.16/12 경계 밖
    'http://172.15.0.1/',
    'http://100.128.0.1/', // CGNAT 100.64/10 경계 밖
    'http://192.0.1.1/', // 192.0.0.0/24가 아닌 공인 대역
    'http://198.20.0.1/', // 벤치마크 대역(18/19) 밖
    'http://223.255.255.255/', // 멀티캐스트(224+) 아래
    'https://sub.example.co.kr/',
    'http://[2606:4700:4700::1111]/',
    'http://[::ffff:8.8.8.8]/', // IPv4-mapped 공인 주소
    'http://[::ffff:808:808]/',
    'http://[::ffff:101:101]/', // hex 쌍 형태의 1.1.1.1
  ]
  test.each(allowed)('%s → ok', (url) => {
    const r = validatePublicUrl(url)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.url).toBe(new URL(url).toString())
  })

  const invalid: Array<[string, unknown]> = [
    ['빈 문자열', ''],
    ['공백만', '   '],
    ['숫자', 42],
    ['null', null],
    ['undefined', undefined],
    ['객체', { url: 'https://x' }],
    ['파싱 불가', 'ht tp://bad url'],
    ['ftp 스킴', 'ftp://example.com/file'],
    ['file 스킴', 'file:///etc/passwd'],
    ['javascript 스킴', 'javascript:alert(1)'],
    ['자격증명 포함', 'https://user:pass@example.com/'],
    ['비밀번호만 포함', 'https://:pass@example.com/'],
    ['과길이', 'https://example.com/' + 'a'.repeat(2048)],
  ]
  test.each(invalid)('%s → invalid_url', (_name, raw) => {
    expect(validatePublicUrl(raw)).toEqual({ ok: false, error: 'invalid_url' })
  })

  test('앞뒤 공백은 잘라서 검증하고 정규화된 URL을 돌려준다', () => {
    expect(validatePublicUrl('  https://example.com  ')).toEqual({ ok: true, url: 'https://example.com/' })
  })
})

type Listener = (ev: { data: unknown }) => void

interface ScriptOpts {
  readyState?: string
  extractValue?: unknown
  extractException?: boolean
  navigateErrorText?: string
  createError?: boolean
  attachError?: boolean
}

class ScriptSocket implements CdpSocket {
  closed = false
  sentMethods: string[] = []
  sentMessages: Array<{ method: string; sessionId?: string; params?: Record<string, unknown> }> = []
  private listeners: Listener[] = []
  constructor(private opts: ScriptOpts = {}) {}
  send(data: string): void {
    const msg = JSON.parse(data) as { id: number; method: string; sessionId?: string; params?: { expression?: string; targetId?: string } }
    this.sentMethods.push(msg.method)
    this.sentMessages.push({ method: msg.method, sessionId: msg.sessionId, params: msg.params as Record<string, unknown> | undefined })
    const reply = (m: unknown) => queueMicrotask(() => {
      const s = JSON.stringify(m)
      for (const l of this.listeners) l({ data: s })
    })
    if (msg.method === 'Target.createTarget') {
      if (this.opts.createError) reply({ id: msg.id, error: { message: 'create denied' } })
      else reply({ id: msg.id, result: { targetId: 't-new' } })
    } else if (msg.method === 'Target.attachToTarget') {
      if (this.opts.attachError) reply({ id: msg.id, error: { message: 'attach denied' } })
      else reply({ id: msg.id, result: { sessionId: 'sess-1' } })
    } else if (msg.method === 'Target.closeTarget') {
      reply({ id: msg.id, result: {} })
    } else if (msg.method === 'Page.enable') {
      reply({ id: msg.id, result: {} })
    } else if (msg.method === 'Page.navigate') {
      reply({ id: msg.id, result: this.opts.navigateErrorText ? { errorText: this.opts.navigateErrorText } : {} })
    } else if (msg.method === 'Runtime.evaluate') {
      const expr = msg.params?.expression ?? ''
      if (expr.includes('readyState')) {
        const value = JSON.stringify({ rs: this.opts.readyState ?? 'complete', href: 'https://example.com/page' })
        reply({ id: msg.id, result: { result: { value } } })
      } else if (this.opts.extractException) {
        reply({ id: msg.id, result: { exceptionDetails: { text: 'boom' } } })
      } else {
        reply({ id: msg.id, result: { result: { value: this.opts.extractValue ?? { title: '제목', url: 'https://example.com/page', text: '본문 내용' } } } })
      }
    }
  }
  addEventListener(_type: 'message', listener: Listener): void {
    this.listeners.push(listener)
  }
  close(): void {
    this.closed = true
  }
}

const ENV = {
  ORACLE_BROWSER_HOST: '203.0.113.7',
  ORIGIN_SECRET: 'origin-secret',
  CDP_SECRET: 'cdp-secret',
  SELKIES_PASSWORD: 'selkies-pw',
} as never
const PAGE_URL = 'https://example.com/page'
const VERSION_DATA = {
  Browser: 'Chrome/120.0',
  webSocketDebuggerUrl: 'wss://myhub.myhub-app.workers.dev/api/browse/cdp/devtools/browser/abc',
}

function versionFetch(versionData: unknown, status = 200) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = []
  const fetchFn = (async (url: unknown, init?: { method?: string; headers?: Record<string, string> }) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', headers: init?.headers ?? {} })
    return { ok: status >= 200 && status < 300, status, json: async () => versionData }
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

function deps(fetchFn: typeof fetch, socket: CdpSocket | null, connected: { url?: string } = {}) {
  return {
    fetchFn,
    connect: (async (url: string) => {
      connected.url = url
      return socket
    }) as (url: string, headers?: Record<string, string>) => Promise<CdpSocket | null>,
  }
}

describe('readPage — 버전 조회·연결 단계 실패 구분', () => {
  test('차단 URL은 네트워크 이전에 blocked_host로 돌아온다', async () => {
    const { fetchFn, calls } = versionFetch(VERSION_DATA)
    const r = await readPage(ENV, 'http://192.168.1.1/', deps(fetchFn, new ScriptSocket()))
    expect(r).toEqual({ ok: false, error: 'blocked_host' })
    expect(calls).toHaveLength(0)
  })

  test('시크릿이 하나라도 없으면 not_configured', async () => {
    const { fetchFn } = versionFetch(VERSION_DATA)
    const r1 = await readPage({} as never, PAGE_URL, deps(fetchFn, new ScriptSocket()))
    expect(r1).toEqual({ ok: false, error: 'not_configured' })
    const partial = { ORACLE_BROWSER_HOST: '203.0.113.7', ORIGIN_SECRET: 'o' } as never
    const r2 = await readPage(partial, PAGE_URL, deps(fetchFn, new ScriptSocket()))
    expect(r2).toEqual({ ok: false, error: 'not_configured' })
  })

  test('/json/version 5xx·예외·ws 없음·ws 비CDP 경로는 upstream', async () => {
    const sock = new ScriptSocket()
    let f = versionFetch({}, 500)
    await expect(readPage(ENV, PAGE_URL, deps(f.fetchFn, sock))).resolves.toEqual({ ok: false, error: 'upstream' })
    const throwing = (async () => { throw new Error('down') }) as unknown as typeof fetch
    await expect(readPage(ENV, PAGE_URL, deps(throwing, sock))).resolves.toEqual({ ok: false, error: 'upstream' })
    f = versionFetch({ Browser: 'Chrome' })
    await expect(readPage(ENV, PAGE_URL, deps(f.fetchFn, sock))).resolves.toEqual({ ok: false, error: 'upstream' })
    f = versionFetch({ webSocketDebuggerUrl: 'wss://example.com/somewhere/else' })
    await expect(readPage(ENV, PAGE_URL, deps(f.fetchFn, sock))).resolves.toEqual({ ok: false, error: 'upstream' })
  })

  test('/json/version 조회는 사이드카 직접 URL에 두 시크릿을 싣는다', async () => {
    const { fetchFn, calls } = versionFetch(VERSION_DATA)
    await readPage(ENV, PAGE_URL, deps(fetchFn, new ScriptSocket()))
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://203.0.113.7:8081/json/version')
    expect(calls[0].headers['x-origin-secret']).toBe('origin-secret')
    expect(calls[0].headers['x-cdp-secret']).toBe('cdp-secret')
  })

  test('connect가 null이거나 던지면 connect', async () => {
    const f1 = versionFetch(VERSION_DATA)
    await expect(readPage(ENV, PAGE_URL, deps(f1.fetchFn, null))).resolves.toEqual({ ok: false, error: 'connect' })
    const f2 = versionFetch(VERSION_DATA)
    const throwingConnect = async () => { throw new Error('ws refused') }
    await expect(readPage(ENV, PAGE_URL, { fetchFn: f2.fetchFn, connect: throwingConnect })).resolves.toEqual({ ok: false, error: 'connect' })
  })
})

describe('readPage — 읽기 결과', () => {
  test('성공: 제목·본문이 돌아오고 별도 탭으로 읽고 닫으며 소켓이 닫힌다', async () => {
    const { fetchFn } = versionFetch(VERSION_DATA)
    const sock = new ScriptSocket()
    const connected: { url?: string } = {}
    const r = await readPage(ENV, PAGE_URL, deps(fetchFn, sock, connected))
    expect(r).toEqual({ ok: true, url: PAGE_URL, title: '제목', text: '본문 내용', truncated: false })
    // 공개 베이스가 아니라 사이드카 직접 URL로 연결해야 한다.
    expect(connected.url).toBe('ws://203.0.113.7:8081/devtools/browser/abc')
    expect(sock.closed).toBe(true)
    // 별도 탭 생성 → attach → navigate → 추출 → 탭 닫기 순서가 고정된다.
    expect(sock.sentMethods).toEqual(
      expect.arrayContaining(['Target.createTarget', 'Target.attachToTarget', 'Page.navigate', 'Runtime.evaluate', 'Target.closeTarget']),
    )
    expect(sock.sentMethods.indexOf('Target.createTarget')).toBeLessThan(
      sock.sentMethods.indexOf('Page.navigate'),
    )
    expect(sock.sentMethods.indexOf('Target.closeTarget')).toBeGreaterThan(
      sock.sentMethods.lastIndexOf('Runtime.evaluate'),
    )
    const close = sock.sentMessages.find((m) => m.method === 'Target.closeTarget')!
    expect(close.params?.targetId).toBe('t-new')
    // 기존 탭을 건드리지 않는다: getTargets는 쓰지 않는다.
    expect(sock.sentMethods).not.toContain('Target.getTargets')
  })

  test('본문이 상한을 넘으면 truncated=true와 함께 정확히 상한만큼 잘린다', async () => {
    const { fetchFn } = versionFetch(VERSION_DATA)
    const longText = '가'.repeat(500)
    const sock = new ScriptSocket({ extractValue: { title: 't', url: PAGE_URL, text: longText } })
    const r = await readPage(ENV, PAGE_URL, deps(fetchFn, sock), { maxTextChars: 120 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.truncated).toBe(true)
      expect(r.text).toBe('가'.repeat(120))
    }
  })

  test('제목은 300자로 잘리고, 추출 url이 비면 대상 URL로 대체된다', async () => {
    const { fetchFn } = versionFetch(VERSION_DATA)
    const sock = new ScriptSocket({ extractValue: { title: '제'.repeat(400), url: '', text: '본문' } })
    const r = await readPage(ENV, PAGE_URL, deps(fetchFn, sock))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.title).toBe('제'.repeat(300))
      expect(r.url).toBe(PAGE_URL)
    }
  })

  test('navigate errorText면 navigate, 추출 예외면 extract, 빈 본문이면 empty', async () => {
    const f = () => versionFetch(VERSION_DATA).fetchFn
    await expect(readPage(ENV, PAGE_URL, deps(f(), new ScriptSocket({ navigateErrorText: 'ERR_ABORTED' }))))
      .resolves.toEqual({ ok: false, error: 'navigate' })
    await expect(readPage(ENV, PAGE_URL, deps(f(), new ScriptSocket({ extractException: true }))))
      .resolves.toEqual({ ok: false, error: 'extract' })
    await expect(readPage(ENV, PAGE_URL, deps(f(), new ScriptSocket({ extractValue: { title: 't', url: PAGE_URL, text: '   ' } }))))
      .resolves.toEqual({ ok: false, error: 'empty' })
    await expect(readPage(ENV, PAGE_URL, deps(f(), new ScriptSocket({ extractValue: { title: 't', url: PAGE_URL, text: 42 } }))))
      .resolves.toEqual({ ok: false, error: 'extract' })
  })

  test('readyState가 끝내 complete가 아니면 timeout이고 탭은 그래도 닫힌다', async () => {
    const { fetchFn } = versionFetch(VERSION_DATA)
    const sock = new ScriptSocket({ readyState: 'loading' })
    const r = await readPage(ENV, PAGE_URL, deps(fetchFn, sock), { renderDeadlineMs: 60 })
    expect(r).toEqual({ ok: false, error: 'timeout' })
    expect(sock.sentMethods).toContain('Target.closeTarget')
  })

  test('createTarget 실패면 connect이고 닫을 탭이 없으니 closeTarget은 안 간다', async () => {
    const { fetchFn } = versionFetch(VERSION_DATA)
    const sock = new ScriptSocket({ createError: true })
    const r = await readPage(ENV, PAGE_URL, deps(fetchFn, sock))
    expect(r).toEqual({ ok: false, error: 'connect' })
    expect(sock.sentMethods).not.toContain('Target.closeTarget')
    expect(sock.sentMethods).not.toContain('Page.navigate')
  })

  test('attach 실패면 connect이지만 만든 탭은 반드시 닫는다', async () => {
    const { fetchFn } = versionFetch(VERSION_DATA)
    const sock = new ScriptSocket({ attachError: true })
    const r = await readPage(ENV, PAGE_URL, deps(fetchFn, sock))
    expect(r).toEqual({ ok: false, error: 'connect' })
    expect(sock.sentMethods).toContain('Target.closeTarget')
    const close = sock.sentMessages.find((m) => m.method === 'Target.closeTarget')!
    expect(close.params?.targetId).toBe('t-new')
  })
})

type _Unused = PageReadResult
