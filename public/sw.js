/* MyHub 서비스워커 — Web Push 수신 + 캐싱 전략
 *
 * 캐싱 전략 표 (docs/github-apply-research-20261026.md 2-8절,
 * workbox ★13,034 MIT의 패턴만 차용 — workbox 번들은 삽입하지 않음):
 *
 * | 요청                          | 전략                          | 근거                                  |
 * | /api/*                        | NetworkOnly                   | 인증·신선도 — API 응답을 캐시하면 안 됨 |
 * | 정적 에셋 (?v= 버전 있음)      | CacheFirst                    | 콘텐츠 기반 버전 — 바뀔 때 URL이 바뀜   |
 * | 네비게이션 (mode: navigate)    | NetworkFirst + 오프라인 폴백   | 실패 시 미리 캐시한 /offline.html       |
 * | 그 외 (버전 없는 정적·타 도메인·비 GET·/sw.js) | NetworkOnly | 기본 거부 — 모르는 것은 캐시하지 않음 |
 *
 * 주의: /sw.js 자체는 절대 캐시하지 않는다 (오래된 SW가 갇히는 고전적 함정).
 * HTML 페이지는 Worker가 no-cache로 서빙하므로 SW도 캐시하지 않는다.
 */

// v2 (2026-11-01): 오프 라인 대관과 파일 css/js 문서에서 파일로 분리
// 프리캐시 집합에 넣었던 등 구 캐시(v1)는 등 파일이 없으므로 버전을 올려
// activate 단계에서 구조를 정리로 강제 교체한다.
const CACHE_NAME = 'myhub-static-v2'
const OFFLINE_URL = '/offline.html'
// 오프라인 대관 문서를 그 하위 파일 등 CSP 추출(2026-11-01)로 나눠 만들
// 전부 프리캐시해야 오프라인에서 스켈레톤이 내어 있다.
const OFFLINE_PRECACHE_URLS = [OFFLINE_URL, '/css/offline.css', '/js/offline.js']

// CacheFirst 대상 확장자 (Worker가 immutable로 서빙하는 버전 관리 정적 에셋)
const STATIC_EXTENSIONS = new Set([
  '.css', '.js', '.mjs', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif', '.ico',
  '.woff', '.woff2', '.json', // manifest.json (?v= 포함)
])

/**
 * 요청에 적용할 캐싱 전략을 판정한다 — 순수 함수 (I/O 없음, 테스트 가능).
 * @param {Request} request
 * @param {string} [origin] 비교 기준 오리진 (기본값: self.location.origin)
 * @returns {'cache-first' | 'network-only' | 'navigation-fallback'}
 */
function decideCacheStrategy(request, origin) {
  if (request.method !== 'GET') return 'network-only'

  const url = new URL(request.url)
  const selfOrigin = origin || (typeof self !== 'undefined' && self.location && self.location.origin) || ''
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return 'network-only'
  if (request.mode === 'navigate') return 'navigation-fallback'
  if (url.pathname === '/sw.js') return 'network-only'
  if (url.origin !== selfOrigin) return 'network-only'

  const v = url.searchParams.get('v')
  if (!v) return 'network-only'
  const dot = url.pathname.lastIndexOf('.')
  const ext = dot === -1 ? '' : url.pathname.slice(dot).toLowerCase()
  if (!STATIC_EXTENSIONS.has(ext)) return 'network-only'
  return 'cache-first'
}

async function handleCacheFirst(request) {
  const cache = await caches.open(CACHE_NAME)
  const hit = await cache.match(request)
  if (hit) return hit
  const res = await fetch(request)
  // 200대만 캐시한다 — 오류 응답·리다이렉트는 저장하지 않음
  if (res && res.ok) await cache.put(request, res.clone())
  return res
}

async function handleNavigation(request) {
  try {
    return await fetch(request)
  } catch {
    const cache = await caches.open(CACHE_NAME)
    const offline = await cache.match(OFFLINE_URL)
    if (offline) return offline
    return new Response('오프라인 상태입니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      // 파일마다 별도 add하다 등 하나가 실패해도 나머지는 캐시하고,
      // 프리캐시 실패가 설치 자체를 막지 않게 한다 (첫 설치 시 오프라인 등)
      .then((cache) =>
        Promise.all(
          OFFLINE_PRECACHE_URLS.map((u) =>
            cache.add(u).catch((e) => { console.warn('오프라인 프리캐시 실패:', u, e); })
          )
        )
      )
      .catch((e) => { console.warn('오프라인 페이지 프리캐시 실패:', e); })
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const strategy = decideCacheStrategy(event.request)
  if (strategy === 'cache-first') {
    event.respondWith(handleCacheFirst(event.request))
  } else if (strategy === 'navigation-fallback') {
    event.respondWith(handleNavigation(event.request))
  }
  // network-only: SW가 개입하지 않음 — 브라우저가 직접 네트워크로 요청한다
})

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }
  const title = data.title || 'MyHub'
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'myhub-push',
    renotify: true,
    data: { url: data.url || '/schedule.html' },
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/schedule.html'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          c.navigate(url)
          return c.focus()
        }
      }
      return self.clients.openWindow(url)
    })
  )
})

// Node 테스트용 export (서비스워커 런타임에서는 module이 없어 동작하지 않음)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { decideCacheStrategy, CACHE_NAME, OFFLINE_URL, OFFLINE_PRECACHE_URLS, STATIC_EXTENSIONS }
}
