/**
 * 데스크톱 배경화면 서비스 — Bing 오늘의 사진을 KST 날짜 기준으로 가져오고
 * KV에 캐시한다. 실패하면 Picsum 시드 이미지로 폴백한다.
 */

import type { Env } from '../../types'
import { kstDateStr } from '../../lib/kst'

export interface Wallpaper {
  date: string
  source: 'bing' | 'picsum'
  imageUrl: string
  caption: string | null
  credit: string | null
  link: string | null
}

export interface WallpaperDeps {
  fetchFn?: (url: string) => Promise<Response>
  now?: Date
}

const BING_FEED_URL = 'https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=ko-KR'
const BING_ORIGIN = 'https://www.bing.com'
const CACHE_PREFIX = 'desktop:wallpaper:v1:'
const BING_CACHE_TTL = 21600
const FALLBACK_CACHE_TTL = 900

/** KST 기준 날짜 'YYYY-MM-DD' (공용 코어 src/lib/kst.ts — en-US 본문과 출력 동일). */
export function kstDateString(now: Date): string {
  return kstDateStr(now)
}

export function parseBingCopyright(copyright: unknown): { caption: string | null; credit: string | null } {
  if (typeof copyright !== 'string' || !copyright.trim()) return { caption: null, credit: null }
  const m = copyright.match(/^(.*?)\s*\((©[^)]*)\)\s*$/)
  if (m) {
    return { caption: m[1].trim() || null, credit: m[2].trim() || null }
  }
  return { caption: copyright.trim(), credit: null }
}

export function parseBingResponse(json: any, date: string): Wallpaper | null {
  const img = json?.images?.[0]
  if (!img || typeof img.url !== 'string' || !img.url.startsWith('/')) return null
  const { caption, credit } = parseBingCopyright(img.copyright)
  return {
    date,
    source: 'bing',
    imageUrl: BING_ORIGIN + img.url,
    caption,
    credit,
    link: typeof img.copyrightlink === 'string' ? img.copyrightlink : null,
  }
}

export function picsumFallback(date: string): Wallpaper {
  return {
    date,
    source: 'picsum',
    imageUrl: `https://picsum.photos/seed/myhub-${date}/1920/1080`,
    caption: null,
    credit: null,
    link: null,
  }
}

export async function getTodayWallpaper(env: Env, deps: WallpaperDeps = {}): Promise<Wallpaper> {
  const fetchFn = deps.fetchFn ?? ((url: string) => fetch(url))
  const date = kstDateString(deps.now ?? new Date())
  const cacheKey = CACHE_PREFIX + date
  try {
    const cached = await env.KV.get<Wallpaper>(cacheKey, 'json')
    if (cached && typeof cached === 'object' && cached.imageUrl) {
      return cached
    }
  } catch {
    // 캐시 조회 실패 시 새로 가져온다
  }
  let wallpaper: Wallpaper | null = null
  try {
    const res = await fetchFn(BING_FEED_URL)
    if (res.ok) {
      wallpaper = parseBingResponse(await res.json(), date)
    }
  } catch {
    wallpaper = null
  }
  if (!wallpaper) {
    wallpaper = picsumFallback(date)
    try {
      await env.KV.put(cacheKey, JSON.stringify(wallpaper), { expirationTtl: FALLBACK_CACHE_TTL })
    } catch {
      // 캐시 저장 실패는 무시
    }
    return wallpaper
  }
  try {
    await env.KV.put(cacheKey, JSON.stringify(wallpaper), { expirationTtl: BING_CACHE_TTL })
  } catch {
    // 캐시 저장 실패는 무시
  }
  return wallpaper
}

export async function getTodayWallpaperImage(
  env: Env,
  deps: WallpaperDeps = {}
): Promise<{ contentType: string; body: ArrayBuffer } | null> {
  const fetchFn = deps.fetchFn ?? ((url: string) => fetch(url))
  const wallpaper = await getTodayWallpaper(env, deps)
  const tryFetchImage = async (url: string): Promise<{ contentType: string; body: ArrayBuffer } | null> => {
    const res = await fetchFn(url)
    if (!res || !res.ok || typeof res.arrayBuffer !== 'function') return null
    const body = await res.arrayBuffer()
    if (!body || body.byteLength === 0) return null
    const contentType = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-type') : null
    return { contentType: contentType || 'image/jpeg', body }
  }
  try {
    const hit = await tryFetchImage(wallpaper.imageUrl)
    if (hit) return hit
  } catch {
    // 폴백으로 진행
  }
  if (wallpaper.source === 'bing') {
    try {
      return await tryFetchImage(picsumFallback(wallpaper.date).imageUrl)
    } catch {
      return null
    }
  }
  return null
}
