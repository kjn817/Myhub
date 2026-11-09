/// <reference types="jest" />
/**
 * src/modules/desktop/routes.ts — 배경화면 라우트 응답 계약.
 * (서비스 자체의 성질은 desktop-wallpaper.test.ts가 다룬다. 여기는
 * HTTP 표면: 상태 코드·헤더·캐시 왕복만 본다. 인증은 전역 미들웨어가
 * /api/*에 강제하므로 이 모듈의 책임이 아니다.)
 *
 * 핵심 성질: ① /wallpaper/image는 서비스가 준 Content-Type과 본문을
 * 그대로 내보내고 하루 immutable 캐시 헤더를 단다 ② 이미지를 못
 * 가져오면 502 + 한국어 오류 본문이다 ③ Cache API에 히트하면 서비스를
 * 타지 않고 캐시 응답이 나가고, 미스면 응답이 캐시에 저장돼 다음
 * 요청은 서비스 장애에도 캐시로 답한다 ④ 캐시 조회·저장이 실패해도
 * 이미지 응답 자체는 실패하지 않는다.
 * 카나리아: Cache-Control 값을 바꾸거나 캐시 히트 시에도 서비스를
 * 타게 만들면 실패한다.
 */
import { desktopApp } from '../../src/modules/desktop/routes'
import { getTodayWallpaper, getTodayWallpaperImage, kstDateString } from '../../src/modules/desktop/service'

jest.mock('../../src/modules/desktop/service', () => ({
  getTodayWallpaper: jest.fn(),
  getTodayWallpaperImage: jest.fn(),
  kstDateString: jest.fn(() => '2026-11-08'),
}))

const mockedToday = getTodayWallpaper as unknown as jest.Mock
const mockedImage = getTodayWallpaperImage as unknown as jest.Mock

const ENV = {} as any
const WALLPAPER = {
  date: '2026-11-08',
  source: 'bing',
  imageUrl: 'https://www.bing.com/th?id=OHR.X',
  caption: '캡션',
  credit: '© 누군가',
  link: null,
}

function imageBytes(bytes: number[], contentType = 'image/webp') {
  return { contentType, body: new Uint8Array(bytes).buffer }
}

/** 최소 Cache API fake — URL 문자열을 키로 응답을 보관한다. */
class FakeCache {
  store = new Map<string, Response>()
  matchError: Error | null = null
  async match(req: Request) {
    if (this.matchError) throw this.matchError
    const hit = this.store.get(req.url)
    return hit ? hit.clone() : undefined
  }
  async put(req: Request, res: Response) {
    this.store.set(req.url, res)
  }
}

let fakeCache: FakeCache
let waitUntilPromises: Promise<unknown>[]
const executionCtx = {
  waitUntil: (p: Promise<unknown>) => {
    waitUntilPromises.push(p)
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext

beforeEach(() => {
  jest.clearAllMocks()
  ;(kstDateString as unknown as jest.Mock).mockReturnValue('2026-11-08')
  mockedToday.mockResolvedValue(WALLPAPER)
  fakeCache = new FakeCache()
  waitUntilPromises = []
})

afterEach(() => {
  delete (globalThis as any).caches
})

function useCache() {
  ;(globalThis as any).caches = { default: fakeCache }
}

describe('GET /wallpaper/today', () => {
  test('서비스 결과를 { ok: true, wallpaper }로 감싸 200으로 낸다', async () => {
    const res = await desktopApp.request('http://localhost/wallpaper/today', {}, ENV, executionCtx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, wallpaper: WALLPAPER })
  })
})

describe('GET /wallpaper/image — 캐시 없음', () => {
  test('Content-Type·본문을 그대로 내보내고 하루 immutable 헤더를 단다', async () => {
    mockedImage.mockResolvedValue(imageBytes([1, 2, 3]))
    const res = await desktopApp.request('http://localhost/wallpaper/image', {}, ENV, executionCtx)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/webp')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400, immutable')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  test('이미지를 못 가져오면 502 + 오류 본문', async () => {
    mockedImage.mockResolvedValue(null)
    const res = await desktopApp.request('http://localhost/wallpaper/image', {}, ENV, executionCtx)
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ ok: false, error: '배경 이미지를 가져오지 못했습니다' })
  })
})

describe('GET /wallpaper/image — Cache API 왕복', () => {
  test('미스면 저장되고, 다음 요청은 서비스가 실패해도 캐시로 답한다', async () => {
    useCache()
    mockedImage.mockResolvedValue(imageBytes([9, 8, 7]))
    const first = await desktopApp.request('http://localhost/wallpaper/image', {}, ENV, executionCtx)
    expect(first.status).toBe(200)
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]))
    await Promise.all(waitUntilPromises)
    expect([...fakeCache.store.keys()]).toEqual(['https://myhub.internal/wallpaper-image/2026-11-08'])

    mockedImage.mockResolvedValue(null) // 서비스가 죽어도
    const second = await desktopApp.request('http://localhost/wallpaper/image', {}, ENV, executionCtx)
    expect(second.status).toBe(200)
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]))
  })

  test('캐시 조회가 던지면 원본을 가져와 정상 응답한다', async () => {
    useCache()
    fakeCache.matchError = new Error('cache down')
    mockedImage.mockResolvedValue(imageBytes([5]))
    const res = await desktopApp.request('http://localhost/wallpaper/image', {}, ENV, executionCtx)
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([5]))
  })

  test('캐시 저장이 동기적으로 실패해도 응답은 나간다', async () => {
    useCache()
    mockedImage.mockResolvedValue(imageBytes([6]))
    const throwingCtx = {
      waitUntil: () => {
        throw new Error('ctx down')
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext
    const res = await desktopApp.request('http://localhost/wallpaper/image', {}, ENV, throwingCtx)
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([6]))
  })
})
