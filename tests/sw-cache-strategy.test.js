/**
 * 서비스워커 캐싱 전략 테스트 (트랙 C8, workbox 패턴 차용 — 번들 삽입 없음)
 * public/sw.js를 직접 require하고 self/caches/fetch를 스텁한다.
 * 운영 DB·네트워크에 닿지 않음.
 */
const ORIGIN = 'https://myhub.myhub-app.workers.dev'

function makeCacheStore() {
  const store = new Map()
  return {
    store,
    match: jest.fn(async (r) => store.get(typeof r === 'string' ? r : r.url)),
    put: jest.fn(async (r, res) => {
      store.set(typeof r === 'string' ? r : r.url, res)
    }),
    add: jest.fn(async (url) => {
      store.set(url, new Response('offline page', { status: 200 }))
    }),
  }
}

let cacheStore
let cacheNames
const cachesMock = {
  open: jest.fn(async (name) => {
    cacheNames.add(name)
    return cacheStore
  }),
  keys: jest.fn(async () => [...cacheNames]),
  delete: jest.fn(async (name) => cacheNames.delete(name)),
}
global.caches = cachesMock
global.fetch = jest.fn()

const listeners = {}
global.self = {
  location: { origin: ORIGIN },
  addEventListener: jest.fn((type, fn) => {
    listeners[type] = fn
  }),
  skipWaiting: jest.fn(async () => {}),
  clients: {
    claim: jest.fn(async () => {}),
    matchAll: jest.fn(async () => []),
    openWindow: jest.fn(async () => {}),
  },
  registration: { showNotification: jest.fn(async () => {}) },
}

const sw = require('../public/sw.js')
const { decideCacheStrategy, CACHE_NAME, OFFLINE_URL } = sw

function req(url, opts = {}) {
  return { url, method: opts.method || 'GET', mode: opts.mode || 'cors' }
}
function navReq(path) {
  return req(ORIGIN + path, { mode: 'navigate' })
}
function fetchEvent(request) {
  const calls = {}
  return {
    request,
    respondWith: jest.fn((p) => {
      calls.respondWith = p
    }),
    waitUntil: jest.fn((p) => {
      calls.waitUntil = p
    }),
    calls,
  }
}
async function dispatchWaitUntil(type, event) {
  listeners[type](event)
  await event.calls.waitUntil
}

beforeEach(() => {
  jest.clearAllMocks()
  cacheStore = makeCacheStore()
  cacheNames = new Set([CACHE_NAME])
  global.fetch.mockReset()
})

describe('decideCacheStrategy — 전략 판정', () => {
  test('/api/*는 버전이 있어도 NetworkOnly (인증·신선도)', () => {
    expect(decideCacheStrategy(req(ORIGIN + '/api/ai/chat'))).toBe('network-only')
    expect(decideCacheStrategy(req(ORIGIN + '/api/ai/chat', { method: 'POST' }))).toBe('network-only')
    expect(decideCacheStrategy(req(ORIGIN + '/api/memos?v=abc12345'))).toBe('network-only')
    expect(decideCacheStrategy(req(ORIGIN + '/api/push/vapid-key'))).toBe('network-only')
  })

  test('?v= 버전 있는 정적 에셋은 CacheFirst', () => {
    for (const path of [
      '/shell.css?v=abc12345',
      '/js/chat.js?v=deadbeef',
      '/js/login.js?v=01234567',
      '/css/login.css?v=89abcdef',
      '/nav.js?v=abcdef01',
      '/icon-192.png?v=12345678',
      '/avatars/rumi.webp?v=87654321',
      '/manifest.json?v=11223344',
    ]) {
      expect(decideCacheStrategy(req(ORIGIN + path))).toBe('cache-first')
    }
  })

  test('버전 없는 정적 에셋은 NetworkOnly (구버전 고착 방지)', () => {
    expect(decideCacheStrategy(req(ORIGIN + '/shell.css'))).toBe('network-only')
    expect(decideCacheStrategy(req(ORIGIN + '/js/chat.js'))).toBe('network-only')
    expect(decideCacheStrategy(req(ORIGIN + '/icon-192.png'))).toBe('network-only')
  })

  test('빈 ?v=는 버전 없음으로 취급', () => {
    expect(decideCacheStrategy(req(ORIGIN + '/shell.css?v='))).toBe('network-only')
  })

  test('버전 있어도 HTML·미등록 확장자는 NetworkOnly', () => {
    expect(decideCacheStrategy(req(ORIGIN + '/memo.html?v=abc12345'))).toBe('network-only')
    expect(decideCacheStrategy(req(ORIGIN + '/offline.html?v=abc12345'))).toBe('network-only')
    expect(decideCacheStrategy(req(ORIGIN + '/data.txt?v=abc12345'))).toBe('network-only')
  })

  test('네비게이션은 오프라인 폴백 전략', () => {
    expect(decideCacheStrategy(navReq('/memo.html'))).toBe('navigation-fallback')
    expect(decideCacheStrategy(navReq('/'))).toBe('navigation-fallback')
    expect(decideCacheStrategy(navReq('/login.html'))).toBe('navigation-fallback')
  })

  test('네비게이션이어도 /api/*는 NetworkOnly가 우선', () => {
    expect(decideCacheStrategy(req(ORIGIN + '/api/ai/chat', { mode: 'navigate' }))).toBe('network-only')
  })

  test('타 도메인·비 GET·/sw.js 자체는 NetworkOnly', () => {
    expect(decideCacheStrategy(req('https://unpkg.com/react@18/umd/react.min.js?v=1'))).toBe('network-only')
    expect(decideCacheStrategy(req(ORIGIN + '/shell.css?v=abc12345', { method: 'POST' }))).toBe('network-only')
    expect(decideCacheStrategy(req(ORIGIN + '/shell.css?v=abc12345', { method: 'HEAD' }))).toBe('network-only')
    expect(decideCacheStrategy(req(ORIGIN + '/sw.js?v=abc12345'))).toBe('network-only')
    expect(decideCacheStrategy(req(ORIGIN + '/sw.js'))).toBe('network-only')
  })
})

describe('install / activate — 오프라인 페이지 프리캐시·구버전 정리', () => {
  test('install 시 /offline.html을 프리캐시하고 skipWaiting', async () => {
    const event = fetchEvent(req(ORIGIN + '/'))
    await dispatchWaitUntil('install', event)
    expect(cacheStore.add).toHaveBeenCalledWith(OFFLINE_URL)
    expect(cacheStore.store.has(OFFLINE_URL)).toBe(true)
    expect(global.self.skipWaiting).toHaveBeenCalled()
  })

  test('프리캐시 실패해도 install은 실패하지 않음', async () => {
    cacheStore.add.mockRejectedValueOnce(new Error('offline'))
    const event = fetchEvent(req(ORIGIN + '/'))
    // install 핸들러의 waitUntil 프로미스가 reject되지 않고 resolve된다
    await expect(dispatchWaitUntil('install', event)).resolves.toBeUndefined()
    expect(cacheStore.add).toHaveBeenCalledWith(OFFLINE_URL)
    // 프리캐시는 실제로 실패했으므로 오프라인 페이지는 캐시에 없다
    expect(cacheStore.store.has(OFFLINE_URL)).toBe(false)
    // 그래도 설치는 완료되어 skipWaiting까지 간다
    expect(event.waitUntil).toHaveBeenCalledTimes(1)
    expect(global.self.skipWaiting).toHaveBeenCalled()
  })

  test('activate 시 구버전 캐시를 지우고 현행만 유지', async () => {
    cacheNames.add('myhub-static-v0')
    cacheNames.add('other-cache')
    const event = fetchEvent(req(ORIGIN + '/'))
    await dispatchWaitUntil('activate', event)
    expect(cachesMock.delete).toHaveBeenCalledWith('myhub-static-v0')
    expect(cachesMock.delete).toHaveBeenCalledWith('other-cache')
    expect(cachesMock.delete).not.toHaveBeenCalledWith(CACHE_NAME)
    expect(cacheNames.has(CACHE_NAME)).toBe(true)
    expect(global.self.clients.claim).toHaveBeenCalled()
  })
})

describe('fetch — 전략별 동작', () => {
  // (c) 정리(2026-11-08 최종 배치): 미개입은 mock 호출 단언이 아니라
  // 하네스가 기록한 상태(respondWith 기록 없음·fetch 기록 없음)로 단언한다.
  test('/api/* 요청에는 SW가 개입하지 않음 (respondWith 미호출)', () => {
    const event = fetchEvent(req(ORIGIN + '/api/ai/chat'))
    listeners.fetch(event)
    expect(event.calls.respondWith).toBeUndefined()
    expect(global.fetch.mock.calls).toHaveLength(0)
  })

  test('버전 없는 정적 요청에도 개입하지 않음', () => {
    const event = fetchEvent(req(ORIGIN + '/shell.css'))
    listeners.fetch(event)
    expect(event.calls.respondWith).toBeUndefined()
  })

  test('CacheFirst 캐시 미스: 네트워크 응답을 반환하고 캐시에 저장', async () => {
    global.fetch.mockResolvedValueOnce(new Response('.a{color:red}', { status: 200 }))
    const event = fetchEvent(req(ORIGIN + '/shell.css?v=abc12345'))
    listeners.fetch(event)
    expect(event.respondWith).toHaveBeenCalled()
    const res = await event.calls.respondWith
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('.a{color:red}')
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(cacheStore.put).toHaveBeenCalledTimes(1)
    expect(cacheStore.store.has(ORIGIN + '/shell.css?v=abc12345')).toBe(true)
  })

  test('CacheFirst 캐시 히트: 네트워크 요청 없이 캐시 반환', async () => {
    const cached = new Response('.cached{}', { status: 200 })
    cacheStore.store.set(ORIGIN + '/shell.css?v=abc12345', cached)
    const event = fetchEvent(req(ORIGIN + '/shell.css?v=abc12345'))
    listeners.fetch(event)
    const res = await event.calls.respondWith
    expect(res).toBe(cached)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('CacheFirst 오류 응답(500)은 캐시에 저장하지 않음', async () => {
    global.fetch.mockResolvedValueOnce(new Response('err', { status: 500 }))
    const event = fetchEvent(req(ORIGIN + '/shell.css?v=abc12345'))
    listeners.fetch(event)
    const res = await event.calls.respondWith
    expect(res.status).toBe(500)
    expect(cacheStore.put).not.toHaveBeenCalled()
  })

  test('네비게이션 네트워크 성공 시 네트워크 응답 반환', async () => {
    global.fetch.mockResolvedValueOnce(new Response('<html>memo</html>', { status: 200 }))
    const event = fetchEvent(navReq('/memo.html'))
    listeners.fetch(event)
    const res = await event.calls.respondWith
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<html>memo</html>')
  })

  test('네비게이션 네트워크 실패 시 캐시한 오프라인 페이지 반환', async () => {
    cacheStore.store.set(OFFLINE_URL, new Response('offline page', { status: 200 }))
    global.fetch.mockRejectedValueOnce(new Error('offline'))
    const event = fetchEvent(navReq('/memo.html'))
    listeners.fetch(event)
    const res = await event.calls.respondWith
    expect(await res.text()).toBe('offline page')
  })

  test('네비게이션 실패 + 오프라인 페이지도 없으면 503 텍스트 응답', async () => {
    global.fetch.mockRejectedValueOnce(new Error('offline'))
    const event = fetchEvent(navReq('/memo.html'))
    listeners.fetch(event)
    const res = await event.calls.respondWith
    expect(res.status).toBe(503)
  })
})

describe('기존 푸시 동작 유지', () => {
  test('push·notificationclick 리스너가 등록되어 있음', () => {
    expect(typeof listeners.push).toBe('function')
    expect(typeof listeners.notificationclick).toBe('function')
  })

  test('push 수신 시 알림 표시', async () => {
    // (c) 정리: showNotification을 기록형 함수로 교체해 실제로 표시된
    // 알림의 제목·옵션을 데이터로 단언한다.
    const shown = []
    global.self.registration.showNotification = async (title, options) => {
      shown.push([title, options])
    }
    const event = {
      data: { json: () => ({ title: '일정 알림', body: '회의 10분 전' }) },
      waitUntil: jest.fn((p) => p),
    }
    listeners.push(event)
    await event.waitUntil.mock.calls[0][0]
    expect(shown).toHaveLength(1)
    expect(shown[0][0]).toBe('일정 알림')
    expect(shown[0][1]).toEqual(expect.objectContaining({ body: '회의 10분 전' }))
  })
})
