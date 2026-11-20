/**
 * 브라우저 파비콘 프록시 (src/modules/browse/favicon.ts).
 *
 * 브라우저 3단계 (2026-11-20): 탭·사이드바·개요의 첫 글자 타일 대신
 * 실제 사이트 파비콘을 보여준다. 프론트는 동일 출처
 * GET /api/browse/favicon?url=<페이지 URL>로 <img>를 걸고, 실패하면
 * 첫 글자 타일로 폴백한다 (404 + ok:false — 조용한 실패가 아니다).
 *
 * 흐름: URL 동기 검사(모양·사설 IP 차단) → KV 조회
 * (favicon:<host>, 7일) → 미스면 DoH 검사(validatePublicUrlAsync)
 * → 페이지 HTML을 가져와 <link rel=icon>을 찾고 → 없으면
 * /favicon.ico → 아이콘 바이트를 크기·타입 검사 후 KV에 저장해 반환.
 *
 * 안전:
 * - 페이지·아이콘 fetch는 redirect:'manual'로 최대 3회까지 직접
 *   따라가며, 매 홉마다 validatePublicUrlAsync로 검사한다 — 검증된
 *   공인 URL이 사설 IP로 리디렉트되는 SSRF 우회를 막는다.
 * - 아이콘은 256KB 상한(스트리밍 누적, 초과 시 중단)·이미지
 *   content-type만 허용한다. HTML은 512KB까지만 읽는다
 *   (<link>은 <head>에 있으므로 충분하다).
 * - 실패(404·차단·초과)는 캐시하지 않는다 — 나중에 다시 시도할 수 있다.
 */
import { Hono } from 'hono'
import type { Env } from '../../types'
import { validatePublicUrl, validatePublicUrlAsync } from './assistant-read'

export const FAVICON_MAX_BYTES = 256 * 1024
export const FAVICON_HTML_MAX_BYTES = 512 * 1024
export const FAVICON_TIMEOUT_MS = 5000
export const FAVICON_CACHE_TTL_SECONDS = 7 * 24 * 3600
export const FAVICON_MAX_REDIRECTS = 3

const ICON_CONTENT_TYPES = new Set([
  'image/svg+xml',
  'image/png',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export function faviconCacheKey(host: string): string {
  return `favicon:${host.toLowerCase()}`
}

interface CachedFavicon {
  contentType: string
  data: string // base64
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * <link> 태그에서 파비콘 href를 찾는다. rel 토큰에 'icon'이 있으면
 * (shortcut icon 포함) 최우선, 없으면 apple-touch-icon을 쓴다.
 * href·rel 순서는 제각각이므로 태그 단위로 속성을 뽑아 판정한다.
 */
export function pickIconLink(html: string, pageUrl: string): string | null {
  const linkRe = /<link\b[^>]*>/gi
  let appleTouch: string | null = null
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0]
    const relMatch = /rel\s*=\s*["']([^"']*)["']/i.exec(tag)
    const hrefMatch = /href\s*=\s*["']([^"']*)["']/i.exec(tag)
    if (!relMatch || !hrefMatch) continue
    const href = hrefMatch[1].trim()
    if (!href) continue
    const tokens = relMatch[1].toLowerCase().split(/\s+/)
    if (tokens.includes('icon')) {
      try {
        return new URL(href, pageUrl).toString()
      } catch {
        continue
      }
    }
    if (appleTouch === null && tokens.includes('apple-touch-icon')) {
      try {
        appleTouch = new URL(href, pageUrl).toString()
      } catch {
        // 깨진 href는 무시하고 계속 찾는다
      }
    }
  }
  return appleTouch
}

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal; redirect?: 'manual' | 'follow' | 'error' },
) => Promise<{
  ok: boolean
  status: number
  headers: { get: (name: string) => string | null }
  body: ReadableStream<Uint8Array> | null
}>

/** 본문을 최대 maxBytes까지만 누적해 읽는다. 초과하면 null (중단). */
export async function readCappedBytes(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.length
    if (total > maxBytes) {
      try {
        await reader.cancel()
      } catch {
        // 취소 실패는 무시한다 (이미 끊긴 경우)
      }
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

/**
 * 리디렉트를 직접 따라가며 fetch한다. 매 홉마다 DoH 검사를 하므로
 * 공인 URL이 사설 IP로 꺾이는 우회가 안 된다. 최종 응답(리디렉트
 * 아닌 것)을 돌려주고, 리디렉트 한도를 넘기거나 검사에 걸리면 null.
 */
async function fetchChecked(
  url: string,
  fetchFn: FetchLike,
): Promise<{
  ok: boolean
  status: number
  headers: { get: (name: string) => string | null }
  body: ReadableStream<Uint8Array> | null
} | null> {
  let current = url
  for (let hop = 0; hop <= FAVICON_MAX_REDIRECTS; hop++) {
    const checked = await validatePublicUrlAsync(current, fetchFn as unknown as typeof fetch)
    if (!checked.ok) return null
    let res
    try {
      res = await fetchFn(checked.url, {
        method: 'GET',
        headers: { 'user-agent': CHROME_UA, accept: '*/*' },
        signal: AbortSignal.timeout(FAVICON_TIMEOUT_MS),
        redirect: 'manual',
      })
    } catch {
      return null
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc || hop === FAVICON_MAX_REDIRECTS) return null
      try {
        current = new URL(loc, checked.url).toString()
      } catch {
        return null
      }
      continue
    }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, headers: res.headers, body: res.body }
  }
  return null
}

export interface FaviconResult {
  ok: boolean
  bytes?: Uint8Array
  contentType?: string
  error?: string
}

/**
 * 파비콘 전체 흐름 (KV 조회 → 페이지 파싱 → 아이콘 fetch → KV 저장).
 * fetchFn·kv를 주입받아 테스트에서 모킹한다.
 */
export async function resolveFavicon(
  env: { KV: KVNamespace },
  rawUrl: string,
  fetchFn: FetchLike = fetch as unknown as FetchLike,
): Promise<FaviconResult> {
  const base = validatePublicUrl(rawUrl)
  if (!base.ok) return { ok: false, error: base.error }
  const host = new URL(base.url).hostname.toLowerCase()
  const key = faviconCacheKey(host)
  // 캐시 적중이면 DoH 검사·페이지 fetch를 전부 건너뛴다 — 저장 당시
  // 이미 검증된 바이트이고, 키는 호스트에서 직접 유도된다.
  try {
    const cached = await env.KV.get(key)
    if (cached) {
      const parsed = JSON.parse(cached) as CachedFavicon
      if (
        parsed &&
        typeof parsed.contentType === 'string' &&
        ICON_CONTENT_TYPES.has(parsed.contentType) &&
        typeof parsed.data === 'string' &&
        parsed.data.length > 0
      ) {
        const bytes = base64ToBytes(parsed.data)
        if (bytes.length > 0 && bytes.length <= FAVICON_MAX_BYTES) {
          return { ok: true, bytes, contentType: parsed.contentType }
        }
      }
      // 깨진 캐시는 무시하고 새로 가져온다 (아래에서 덮어쓴다).
    }
  } catch {
    // KV 읽기 실패는 캐시 미스로 취급한다 (fetch 경로로 진행).
  }

  // 페이지 HTML에서 <link rel=icon>을 찾는다. 페이지 fetch가 실패해도
  // /favicon.ico 폴백은 시도한다 (봇 차단은 HTML만 막는 경우가 많다).
  let iconUrl: string | null = null
  const pageRes = await fetchChecked(base.url, fetchFn)
  if (pageRes && pageRes.ok) {
    const ctype = (pageRes.headers.get('content-type') || '').toLowerCase()
    if (ctype.includes('text/html')) {
      const htmlBytes = await readCappedBytes(pageRes.body, FAVICON_HTML_MAX_BYTES)
      if (htmlBytes) {
        iconUrl = pickIconLink(new TextDecoder().decode(htmlBytes), base.url)
      }
    }
  }
  if (!iconUrl) {
    try {
      // 폴백은 대상 사이트 루트의 favicon.ico. 상대 경로로 적는다 —
      // 슬래시로 시작하는 리터럴은 static-assets 스캔이 로컬 에셋
      // 참조로 오인한다 (이 경로는 외부 원점 기준이라 로컬 에셋이
      // 아니다 — 주석에 따옴표 형태를 쓰지 말 것).
      iconUrl = new URL('favicon.ico', new URL(base.url).origin + '/').toString()
    } catch {
      return { ok: false, error: 'invalid_url' }
    }
  }

  // data: URI 아이콘은 네트워크 없이 직접 푼다 (SSRF 위험 없음).
  // base64만 지원하고, 디코딩 뒤에도 크기 상한을 적용한다.
  if (iconUrl.startsWith('data:')) {
    const dataMatch = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(iconUrl)
    if (!dataMatch || !ICON_CONTENT_TYPES.has(dataMatch[1].toLowerCase())) {
      return { ok: false, error: 'not_image' }
    }
    let bytes: Uint8Array
    try {
      bytes = base64ToBytes(dataMatch[2])
    } catch {
      return { ok: false, error: 'not_image' }
    }
    if (bytes.length === 0 || bytes.length > FAVICON_MAX_BYTES) {
      return { ok: false, error: 'too_large' }
    }
    const contentType = dataMatch[1].toLowerCase()
    const cached: CachedFavicon = { contentType, data: bytesToBase64(bytes) }
    try {
      await env.KV.put(key, JSON.stringify(cached), {
        expirationTtl: FAVICON_CACHE_TTL_SECONDS,
      })
    } catch {
      // KV 저장 실패는 응답을 막지 않는다.
    }
    return { ok: true, bytes, contentType }
  }

  const iconRes = await fetchChecked(iconUrl, fetchFn)
  if (!iconRes || !iconRes.ok) return { ok: false, error: 'not_found' }
  const contentType = (iconRes.headers.get('content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (!ICON_CONTENT_TYPES.has(contentType)) return { ok: false, error: 'not_image' }
  const bytes = await readCappedBytes(iconRes.body, FAVICON_MAX_BYTES)
  if (!bytes || bytes.length === 0) return { ok: false, error: 'too_large' }

  const cached: CachedFavicon = { contentType, data: bytesToBase64(bytes) }
  try {
    await env.KV.put(key, JSON.stringify(cached), {
      expirationTtl: FAVICON_CACHE_TTL_SECONDS,
    })
  } catch {
    // KV 저장 실패는 응답을 막지 않는다 (다음 요청이 다시 가져온다).
  }
  return { ok: true, bytes, contentType }
}

export function registerFaviconRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get('/favicon', async (c) => {
    const rawUrl = c.req.query('url') ?? ''
    if (!rawUrl) return c.json({ ok: false, error: 'missing_url' }, 400)
    try {
      const r = await resolveFavicon(c.env, rawUrl)
      if (!r.ok || !r.bytes || !r.contentType) {
        return c.json({ ok: false, error: r.error ?? 'not_found' }, 404)
      }
      return new Response(r.bytes as unknown as BodyInit, {
        status: 200,
        headers: {
          'content-type': r.contentType,
          'cache-control': `public, max-age=${FAVICON_CACHE_TTL_SECONDS}`,
        },
      })
    } catch (e) {
      return c.json({ ok: false, error: String(e).slice(0, 200) }, 500)
    }
  })
}
