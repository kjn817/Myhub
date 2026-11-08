/// <reference types="jest" />
/**
 * src/modules/desktop/service.ts — 배경화면 서비스 성질 테스트.
 *
 * 핵심 성질: ① 날짜는 KST 기준이다 ② 캐시가 유효하면 네트워크를 타지
 * 않는다 ③ Bing이 어떤 식으로 실패해도(네트워크·형식·빈 응답) Picsum
 * 폴백이 반환되고, 폴백 캐시 TTL은 짧다 ④ 이미지 본문이 비거나 실패하면
 * bing일 때만 picsum으로 한 번 더 시도하고 최종 실패는 null이다.
 * 카나리아: BING_CACHE_TTL과 FALLBACK_CACHE_TTL을 맞바꾸거나 캐시 히트
 * 조건에서 imageUrl 검사를 빼면 실패한다.
 */
import {
  getTodayWallpaper,
  getTodayWallpaperImage,
  kstDateString,
  parseBingCopyright,
  parseBingResponse,
  picsumFallback,
} from '../../src/modules/desktop/service'
import type { Env } from '../../src/types'

describe('kstDateString — KST 경계', () => {
  test('UTC 15:00이 KST 자정 경계다', () => {
    expect(kstDateString(new Date('2026-11-08T14:59:59.000Z'))).toBe('2026-11-08')
    expect(kstDateString(new Date('2026-11-08T15:00:00.000Z'))).toBe('2026-11-09')
    expect(kstDateString(new Date('2026-11-07T16:00:00.000Z'))).toBe('2026-11-08')
  })
})

describe('parseBingCopyright', () => {
  test.each([
    [undefined],
    [null],
    [42],
    [''],
    ['   '],
  ])('문자열이 아니거나 비면 null 쌍: %p', (input) => {
    expect(parseBingCopyright(input)).toEqual({ caption: null, credit: null })
  })

  test('(© ...)가 있으면 캡션과 크레딧을 분리한다', () => {
    expect(parseBingCopyright('아름다운 해변 (© 홍길동)')).toEqual({ caption: '아름다운 해변', credit: '© 홍길동' })
    expect(parseBingCopyright('(© 홍길동)')).toEqual({ caption: null, credit: '© 홍길동' })
  })

  test('괄호가 없거나 ©가 아니면 전체가 캡션이다', () => {
    expect(parseBingCopyright('그냥 설명')).toEqual({ caption: '그냥 설명', credit: null })
    expect(parseBingCopyright('설명 (괄호 메모)')).toEqual({ caption: '설명 (괄호 메모)', credit: null })
  })
})

describe('parseBingResponse', () => {
  test('정상 응답을 Wallpaper로 변환한다', () => {
    const w = parseBingResponse(
      { images: [{ url: '/th?id=OHR.X', copyright: '설명 (© 저작자)', copyrightlink: 'https://link' }] },
      '2026-11-08',
    )
    expect(w).toEqual({
      date: '2026-11-08',
      source: 'bing',
      imageUrl: 'https://www.bing.com/th?id=OHR.X',
      caption: '설명',
      credit: '© 저작자',
      link: 'https://link',
    })
  })

  test.each([
    ['null json', null],
    ['images 없음', {}],
    ['images 빈 배열', { images: [] }],
    ['url 없음', { images: [{}] }],
    ['url이 절대 URL', { images: [{ url: 'https://evil.test/x.jpg' }] }],
    ['url이 숫자가 아님', { images: [{ url: 42 }] }],
  ])('형식이 깨지면 null: %s', (_label, json) => {
    expect(parseBingResponse(json, '2026-11-08')).toBeNull()
  })

  test('copyrightlink가 문자열이 아니면 link는 null', () => {
    const w = parseBingResponse({ images: [{ url: '/a.jpg', copyrightlink: 7 }] }, '2026-11-08')
    expect(w?.link).toBeNull()
  })
})

describe('picsumFallback', () => {
  test('날짜 시드 URL을 만든다', () => {
    expect(picsumFallback('2026-11-08')).toEqual({
      date: '2026-11-08',
      source: 'picsum',
      imageUrl: 'https://picsum.photos/seed/myhub-2026-11-08/1920/1080',
      caption: null,
      credit: null,
      link: null,
    })
  })
})

const NOW = new Date('2026-11-08T00:00:00.000Z') // KST 2026-11-08 09:00
const DATE = '2026-11-08'
const CACHE_KEY = `desktop:wallpaper:v1:${DATE}`

function fakeKv(cached?: unknown, opts: { getThrows?: boolean; putThrows?: boolean } = {}) {
  const puts: Array<{ key: string; value: string; ttl?: number }> = []
  let getCalls = 0
  const kv = {
    get: async () => {
      getCalls++
      if (opts.getThrows) throw new Error('kv get down')
      return cached ?? null
    },
    put: async (key: string, value: string, o?: { expirationTtl?: number }) => {
      if (opts.putThrows) throw new Error('kv put down')
      puts.push({ key, value, ttl: o?.expirationTtl })
    },
  }
  return { kv: kv as unknown as KVNamespace, puts, getCalls: () => getCalls }
}

const bingJson = { images: [{ url: '/img.jpg', copyright: '설명 (© 저작자)', copyrightlink: 'https://l' }] }
const okRes = (json: unknown) => ({ ok: true, json: async () => json }) as unknown as Response

describe('getTodayWallpaper', () => {
  test('유효한 캐시가 있으면 fetch 없이 캐시를 반환한다', async () => {
    const cached = { ...picsumFallback(DATE), source: 'bing' as const, imageUrl: 'https://www.bing.com/x.jpg' }
    const { kv, puts } = fakeKv(cached)
    const fetchFn = jest.fn(async () => okRes(bingJson))
    const w = await getTodayWallpaper({ KV: kv } as unknown as Env, { fetchFn, now: NOW })
    expect(w).toEqual(cached)
    expect(fetchFn).not.toHaveBeenCalled()
    expect(puts).toEqual([])
  })

  test('캐시에 imageUrl이 없으면 무효로 보고 새로 가져온다', async () => {
    const { kv } = fakeKv({ date: DATE, source: 'bing' })
    const w = await getTodayWallpaper({ KV: kv } as unknown as Env, { fetchFn: async () => okRes(bingJson), now: NOW })
    expect(w.source).toBe('bing')
    expect(w.imageUrl).toBe('https://www.bing.com/img.jpg')
  })

  test('Bing 성공 시 긴 TTL(21600)로 캐시한다', async () => {
    const { kv, puts } = fakeKv()
    const w = await getTodayWallpaper({ KV: kv } as unknown as Env, { fetchFn: async () => okRes(bingJson), now: NOW })
    expect(w.source).toBe('bing')
    expect(puts).toEqual([{ key: CACHE_KEY, value: JSON.stringify(w), ttl: 21600 }])
  })

  test.each([
    ['fetch throw', async () => { throw new Error('net down') }],
    ['res.ok=false', async () => ({ ok: false, json: async () => ({}) }) as unknown as Response],
    ['형식 깨진 json', async () => okRes({ images: [] })],
  ])('Bing 실패(%s) → picsum 폴백 + 짧은 TTL(900)', async (_label, fetchFn) => {
    const { kv, puts } = fakeKv()
    const w = await getTodayWallpaper({ KV: kv } as unknown as Env, { fetchFn: fetchFn as never, now: NOW })
    expect(w).toEqual(picsumFallback(DATE))
    expect(puts[0]?.ttl).toBe(900)
  })

  test('KV get이 throw해도 새로 가져오고, KV put이 throw해도 결과를 반환한다', async () => {
    const getDown = fakeKv(undefined, { getThrows: true })
    const w1 = await getTodayWallpaper({ KV: getDown.kv } as unknown as Env, { fetchFn: async () => okRes(bingJson), now: NOW })
    expect(w1.source).toBe('bing')
    const putDown = fakeKv(undefined, { putThrows: true })
    const w2 = await getTodayWallpaper({ KV: putDown.kv } as unknown as Env, { fetchFn: async () => okRes(bingJson), now: NOW })
    expect(w2.source).toBe('bing')
    const putDownFb = fakeKv(undefined, { putThrows: true })
    const w3 = await getTodayWallpaper({ KV: putDownFb.kv } as unknown as Env, {
      fetchFn: async () => { throw new Error('net') },
      now: NOW,
    })
    expect(w3.source).toBe('picsum')
  })
})

function imgRes(body: ArrayBuffer | null, contentType: string | null = 'image/jpeg', ok = true) {
  return {
    ok,
    headers: { get: (n: string) => (n === 'content-type' ? contentType : null) },
    arrayBuffer: async () => body,
  } as unknown as Response
}
const BYTES = new Uint8Array([1, 2, 3]).buffer

describe('getTodayWallpaperImage', () => {
  test('벽지 이미지를 가져오면 contentType과 본문을 반환한다', async () => {
    const { kv } = fakeKv({ ...picsumFallback(DATE), source: 'bing', imageUrl: 'https://www.bing.com/img.jpg' })
    const out = await getTodayWallpaperImage({ KV: kv } as unknown as Env, {
      fetchFn: async () => imgRes(BYTES, 'image/png'),
      now: NOW,
    })
    expect(out?.contentType).toBe('image/png')
    expect(out?.body).toBe(BYTES)
  })

  test('content-type 헤더가 없으면 image/jpeg로 간주한다', async () => {
    const { kv } = fakeKv(picsumFallback(DATE))
    const out = await getTodayWallpaperImage({ KV: kv } as unknown as Env, {
      fetchFn: async () => imgRes(BYTES, null),
      now: NOW,
    })
    expect(out?.contentType).toBe('image/jpeg')
  })

  test('bing 이미지가 실패하면 picsum 이미지로 폴백한다', async () => {
    const { kv } = fakeKv({ ...picsumFallback(DATE), source: 'bing', imageUrl: 'https://www.bing.com/img.jpg' })
    const fetchFn = jest.fn(async (url: string) =>
      url.includes('bing.com') ? imgRes(null, 'image/jpeg', false) : imgRes(BYTES),
    )
    const out = await getTodayWallpaperImage({ KV: kv } as unknown as Env, { fetchFn, now: NOW })
    expect(out?.body).toBe(BYTES)
    expect(fetchFn.mock.calls[1][0]).toContain('picsum.photos')
  })

  test('빈 본문은 실패로 취급한다', async () => {
    const { kv } = fakeKv(picsumFallback(DATE))
    const out = await getTodayWallpaperImage({ KV: kv } as unknown as Env, {
      fetchFn: async () => imgRes(new ArrayBuffer(0)),
      now: NOW,
    })
    expect(out).toBeNull()
  })

  test('picsum 벽지 이미지가 실패하면 더 폴백하지 않고 null', async () => {
    const { kv } = fakeKv(picsumFallback(DATE))
    const fetchFn = jest.fn(async () => imgRes(null, null, false))
    const out = await getTodayWallpaperImage({ KV: kv } as unknown as Env, { fetchFn, now: NOW })
    expect(out).toBeNull()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  test('bing 이미지 fetch가 throw해도 picsum으로 폴백하고, 그것도 throw하면 null', async () => {
    const cached = { ...picsumFallback(DATE), source: 'bing' as const, imageUrl: 'https://www.bing.com/img.jpg' }
    const { kv } = fakeKv(cached)
    const throwing = jest.fn(async (url: string) => {
      if (url.includes('bing.com')) throw new Error('img down')
      return imgRes(BYTES)
    })
    const out = await getTodayWallpaperImage({ KV: kv } as unknown as Env, { fetchFn: throwing, now: NOW })
    expect(out?.body).toBe(BYTES)
    const allDown = jest.fn(async () => { throw new Error('all down') })
    const { kv: kv2 } = fakeKv(cached)
    await expect(
      getTodayWallpaperImage({ KV: kv2 } as unknown as Env, { fetchFn: allDown, now: NOW }),
    ).resolves.toBeNull()
  })
})
