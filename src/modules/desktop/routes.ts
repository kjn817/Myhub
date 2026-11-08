/**
 * 데스크톱 모듈 — 오늘의 배경화면 API.
 * 이미지는 CSP(enforce) 때문에 동일 출처 프록시(/wallpaper/image)로 서빙한다.
 */

import { Hono } from 'hono'
import type { Env } from '../../types'
import { getTodayWallpaper, getTodayWallpaperImage, kstDateString } from './service'

export const desktopApp = new Hono<{ Bindings: Env }>()

desktopApp.get('/wallpaper/today', async (c) => {
  const wallpaper = await getTodayWallpaper(c.env)
  return c.json({ ok: true, wallpaper })
})

desktopApp.get('/wallpaper/image', async (c) => {
  const date = kstDateString(new Date())
  const cacheKey = new Request(`https://myhub.internal/wallpaper-image/${date}`)
  let cache: Cache | undefined
  try {
    cache = caches.default
  } catch {
    cache = undefined
  }
  if (cache) {
    try {
      const hit = await cache.match(cacheKey)
      if (hit) return hit
    } catch {
      // 캐시 조회 실패 시 원본을 가져온다
    }
  }
  const image = await getTodayWallpaperImage(c.env)
  if (!image) {
    return c.json({ ok: false, error: '배경 이미지를 가져오지 못했습니다' }, 502)
  }
  const res = new Response(image.body, {
    headers: {
      'Content-Type': image.contentType,
      // 클라이언트 URL에 날짜(?v=YYYY-MM-DD)가 붙어 그날의 사진은 불변
      // 이므로 하루 캐시 + immutable (2026-11-02 추가 지시 6). 날짜가
      // 바뀌면 URL이 바뀌어 새로 받는다.
      'Cache-Control': 'public, max-age=86400, immutable',
    },
  })
  if (cache) {
    try {
      c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()))
    } catch {
      // 캐시 저장 실패는 무시
    }
  }
  return res
})
