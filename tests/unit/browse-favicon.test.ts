/// <reference types="jest" />
/**
 * 브라우저 파비콘 프록시 API (2026-11-20, 브라우저 3단계).
 *
 * 실제 Hono 앱 + DoH·페이지·아이콘 fetch 스텁 + 메모리 KV로 고정하는 성질:
 * - <link rel="icon">을 찾아 절대 URL로 가져오고, 바이트·content-type을
 *   그대로 돌려보내며 KV에 7일 TTL로 저장한다.
 * - rel/href 순서가 뒤집힌 shortcut icon도 찾고, icon이 없으면
 *   apple-touch-icon을, 그것도 없으면 /favicon.ico를 쓴다.
 * - 페이지 fetch가 실패해도 /favicon.ico 폴백은 시도한다.
 * - 사설 IP로 해석되는 호스트는 차단한다 (페이지 fetch가 안 나간다).
 * - 캐시 적중이면 페이지·아이콘 fetch가 전혀 안 나간다 (KV 조회만).
 * - 256KB 초과 아이콘·이미지가 아닌 content-type은 404이고 캐시 안 한다.
 * - data: URI 아이콘은 네트워크 없이 직접 푼다.
 * - url 파라미터가 없으면 400이다.
 * 카나리아: resolveFavicon의 KV 조회를 빼면 캐시 테스트가 실패한다
 * (fetch가 나가고, fetch 스텁이 404를 내기 때문 — 보고 참조).
 */
import { Hono } from 'hono'
import { browseApp } from '../../src/modules/browse/routes'
import { pickIconLink, FAVICON_MAX_BYTES } from '../../src/modules/browse/favicon'

const app = new Hono()
app.route('/api/browse', browseApp)

const PNG_1PX = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])

class MemoryKV {
  store = new Map<string, string>()
  putOpts = new Map<string, any>()
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null
  }
  async put(key: string, value: string, opts?: any): Promise<void> {
    this.store.set(key, value)
    this.putOpts.set(key, opts)
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }
}

interface StubPage {
  status: number
  contentType: string
  body: string | Uint8Array
  location?: string
}

let fetchUrls: string[] = []
let dohMap: Record<string, string[]> = {}
let pages: Record<string, StubPage> = {}

function stubFetch(): void {
  global.fetch = (async (url: unknown) => {
    const u = String(url)
    if (u.includes('dns-query')) {
      const parsed = new URL(u)
      const name = parsed.searchParams.get('name') ?? ''
      const type = parsed.searchParams.get('type')
      const ips = dohMap[name] ?? ['93.184.216.34']
      const answers = ips
        .filter((ip) => (type === '1' ? ip.includes('.') : ip.includes(':')))
        .map((ip) => ({ name, type: Number(type), data: ip }))
      return new Response(JSON.stringify({ Status: 0, Answer: answers }), {
        status: 200,
        headers: { 'content-type': 'application/dns-json' },
      })
    }
    fetchUrls.push(u)
    const page = pages[u]
    if (!page) return new Response('not found', { status: 404 })
    const headers: Record<string, string> = { 'content-type': page.contentType }
    if (page.location) headers['location'] = page.location
    const body =
      typeof page.body === 'string'
        ? page.body
        : (page.body as unknown as BodyInit)
    return new Response(body, { status: page.status, headers })
  }) as typeof fetch
}

const realFetch = global.fetch
beforeEach(() => {
  fetchUrls = []
  dohMap = {}
  pages = {}
  stubFetch()
})
afterEach(() => {
  global.fetch = realFetch
})

async function callFavicon(kv: MemoryKV, url: string) {
  const res = await app.request(
    `/api/browse/favicon?url=${encodeURIComponent(url)}`,
    {},
    { KV: kv } as never,
  )
  return res
}

function pageOf(html: string, status = 200): StubPage {
  return { status, contentType: 'text/html; charset=utf-8', body: html }
}

function iconOf(bytes: Uint8Array, contentType = 'image/png'): StubPage {
  return { status: 200, contentType, body: bytes }
}

describe('pickIconLink (순수 파싱)', () => {
  test('rel="icon"을 찾고 상대 경로를 절대 URL로 바꾼다', () => {
    const html = '<html><head><link rel="icon" href="/icons/a.png"></head></html>'
    expect(pickIconLink(html, 'https://example.com/page')).toBe(
      'https://example.com/icons/a.png',
    )
  })

  test('href가 rel보다 앞에 있는 shortcut icon도 찾는다', () => {
    const html = '<link href="/i.ico" rel="shortcut icon">'
    expect(pickIconLink(html, 'https://example.com/')).toBe('https://example.com/i.ico')
  })

  test('icon이 없으면 apple-touch-icon을 쓴다', () => {
    const html = '<link rel="apple-touch-icon" href="touch.png">'
    expect(pickIconLink(html, 'https://example.com/dir/page')).toBe(
      'https://example.com/dir/touch.png',
    )
  })

  test('icon이 apple-touch-icon보다 우선한다', () => {
    const html =
      '<link rel="apple-touch-icon" href="/touch.png"><link rel="icon" href="/fav.png">'
    expect(pickIconLink(html, 'https://example.com/')).toBe('https://example.com/fav.png')
  })

  test('아이콘 링크가 없으면 null이다', () => {
    expect(pickIconLink('<link rel="stylesheet" href="/a.css">', 'https://example.com/')).toBeNull()
    expect(pickIconLink('<html></html>', 'https://example.com/')).toBeNull()
  })
})

describe('GET /api/browse/favicon', () => {
  test('link icon을 가져와 바이트를 돌려보내고 KV에 7일 TTL로 저장한다', async () => {
    const kv = new MemoryKV()
    pages['https://example.com/'] = pageOf(
      '<html><head><link rel="icon" href="/icons/a.png"></head></html>',
    )
    pages['https://example.com/icons/a.png'] = iconOf(PNG_1PX)
    const res = await callFavicon(kv, 'https://example.com/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(bytes).toEqual(PNG_1PX)
    const cached = kv.store.get('favicon:example.com')
    expect(cached).toBeTruthy()
    const parsed = JSON.parse(cached!)
    expect(parsed.contentType).toBe('image/png')
    expect(typeof parsed.data).toBe('string')
    expect(kv.putOpts.get('favicon:example.com')?.expirationTtl).toBe(7 * 24 * 3600)
  })

  test('link가 없으면 /favicon.ico로 폴백한다', async () => {
    const kv = new MemoryKV()
    pages['https://example.com/'] = pageOf('<html><head></head></html>')
    pages['https://example.com/favicon.ico'] = iconOf(new Uint8Array([0, 0, 1, 0]), 'image/x-icon')
    const res = await callFavicon(kv, 'https://example.com/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/x-icon')
    expect(fetchUrls).toContain('https://example.com/favicon.ico')
  })

  test('페이지 fetch가 실패해도 /favicon.ico 폴백은 시도한다', async () => {
    const kv = new MemoryKV()
    pages['https://example.com/'] = pageOf('blocked', 403)
    pages['https://example.com/favicon.ico'] = iconOf(PNG_1PX)
    const res = await callFavicon(kv, 'https://example.com/')
    expect(res.status).toBe(200)
    expect(fetchUrls).toContain('https://example.com/favicon.ico')
  })

  test('사설 IP로 해석되는 호스트는 차단하고 페이지 fetch가 안 나간다', async () => {
    const kv = new MemoryKV()
    dohMap['internal.example.com'] = ['10.0.0.5']
    const res = await callFavicon(kv, 'https://internal.example.com/')
    expect(res.status).toBe(404)
    expect(fetchUrls).toHaveLength(0)
    expect(kv.store.size).toBe(0)
  })

  test('캐시 적중이면 페이지·아이콘 fetch가 전혀 안 나간다', async () => {
    const kv = new MemoryKV()
    const b64 = Buffer.from(PNG_1PX).toString('base64')
    await kv.put(
      'favicon:example.com',
      JSON.stringify({ contentType: 'image/png', data: b64 }),
    )
    // fetch 스텁이 404만 내도 캐시로 응답해야 한다.
    const res = await callFavicon(kv, 'https://example.com/anything')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(fetchUrls).toHaveLength(0)
  })

  test('256KB 초과 아이콘은 404이고 캐시하지 않는다', async () => {
    const kv = new MemoryKV()
    const big = new Uint8Array(FAVICON_MAX_BYTES + 1)
    pages['https://example.com/'] = pageOf('<link rel="icon" href="/big.png">')
    pages['https://example.com/big.png'] = iconOf(big)
    const res = await callFavicon(kv, 'https://example.com/')
    expect(res.status).toBe(404)
    expect(kv.store.size).toBe(0)
  })

  test('이미지가 아닌 content-type은 404이고 캐시하지 않는다', async () => {
    const kv = new MemoryKV()
    pages['https://example.com/'] = pageOf('<link rel="icon" href="/icon">')
    pages['https://example.com/icon'] = {
      status: 200,
      contentType: 'text/html',
      body: '<html>not an image</html>',
    }
    const res = await callFavicon(kv, 'https://example.com/')
    expect(res.status).toBe(404)
    expect(kv.store.size).toBe(0)
  })

  test('data: URI 아이콘은 네트워크 없이 직접 푼다', async () => {
    const kv = new MemoryKV()
    const b64 = Buffer.from(PNG_1PX).toString('base64')
    pages['https://example.com/'] = pageOf(
      `<link rel="icon" href="data:image/png;base64,${b64}">`,
    )
    const res = await callFavicon(kv, 'https://example.com/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(bytes).toEqual(PNG_1PX)
    // 아이콘 fetch는 안 나가고 페이지 fetch만 나간다.
    expect(fetchUrls).toEqual(['https://example.com/'])
  })

  test('url 파라미터가 없으면 400이다', async () => {
    const kv = new MemoryKV()
    const res = await app.request('/api/browse/favicon', {}, { KV: kv } as never)
    expect(res.status).toBe(400)
  })

  test('페이지 302 리디렉트를 따라가서 파싱한다', async () => {
    const kv = new MemoryKV()
    pages['https://example.com/'] = {
      status: 302,
      contentType: 'text/html',
      body: '',
      location: 'https://example.com/real',
    }
    pages['https://example.com/real'] = pageOf('<link rel="icon" href="/r.png">')
    pages['https://example.com/r.png'] = iconOf(PNG_1PX)
    const res = await callFavicon(kv, 'https://example.com/')
    expect(res.status).toBe(200)
    expect(fetchUrls).toContain('https://example.com/real')
  })
})
