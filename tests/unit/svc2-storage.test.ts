/// <reference types="jest" />
/**
 * storage.ts 커버리지 테스트
 * - storageUpload: 성공 / 실패 throw / text() throw
 * - storageDestroy: 성공 / fetch throw 무시
 * - thumbUrl: URL 포맷
 * - cloudSign: 서명 결정성 (간접 검증)
 */
import { storageUpload, storageDestroy, thumbUrl } from '../../src/services/storage'

const env = {
  CLOUDINARY_API_SECRET: 'secret123',
  CLOUDINARY_API_KEY: 'key123',
  CLOUDINARY_CLOUD_NAME: 'mycloud',
} as any

function mockFile(name = 'test.png'): File {
  return new File(['data'], name, { type: 'image/png' })
}

describe('storageUpload', () => {
  const origFetch = global.fetch

  afterEach(() => {
    global.fetch = origFetch
  })

  test('성공', async () => {
    const fakeRes = {
      ok: true,
      json: async () => ({ public_id: 'abc', secure_url: 'https://x', resource_type: 'image', bytes: 123 }),
    }
    global.fetch = jest.fn().mockResolvedValue(fakeRes)

    const out = await storageUpload(env, mockFile())
    expect(out.public_id).toBe('abc')
    expect(out.bytes).toBe(123)

    // Cloudinary URL 확인
    const fetchMock = global.fetch as jest.Mock
    expect(fetchMock.mock.calls[0][0]).toContain('api.cloudinary.com/v1_1/mycloud/auto/upload')
    expect(fetchMock.mock.calls[0][1].method).toBe('POST')
  })

  test('기본 folder = myhub', async () => {
    const fakeRes = { ok: true, json: async () => ({}) }
    let sentForm: FormData | null = null
    global.fetch = jest.fn().mockImplementation((_u: string, opts: any) => {
      sentForm = opts.body
      return Promise.resolve(fakeRes)
    })
    await storageUpload(env, mockFile())
    expect(sentForm!.get('folder')).toBe('myhub')
  })

  test('커스텀 folder', async () => {
    const fakeRes = { ok: true, json: async () => ({}) }
    let sentForm: FormData | null = null
    global.fetch = jest.fn().mockImplementation((_u: string, opts: any) => {
      sentForm = opts.body
      return Promise.resolve(fakeRes)
    })
    await storageUpload(env, mockFile(), 'custom')
    expect(sentForm!.get('folder')).toBe('custom')
  })

  test('실패 → throw (상태+본문)', async () => {
    const fakeRes = {
      ok: false,
      status: 400,
      text: async () => 'bad request detail',
    }
    global.fetch = jest.fn().mockResolvedValue(fakeRes)
    await expect(storageUpload(env, mockFile())).rejects.toThrow(
      'Cloudinary upload failed: 400 bad request detail'
    )
  })

  test('실패 + text() throw → 빈 본문', async () => {
    const fakeRes = {
      ok: false,
      status: 500,
      text: async () => { throw new Error('x') },
    }
    global.fetch = jest.fn().mockResolvedValue(fakeRes)
    await expect(storageUpload(env, mockFile())).rejects.toThrow(
      'Cloudinary upload failed: 500 '
    )
  })

  test('본문 200자 절단', async () => {
    const fakeRes = {
      ok: false,
      status: 400,
      text: async () => 'e'.repeat(500),
    }
    global.fetch = jest.fn().mockResolvedValue(fakeRes)
    await expect(storageUpload(env, mockFile())).rejects.toThrow(
      `Cloudinary upload failed: 400 ${'e'.repeat(200)}`
    )
  })

  test('서명에 timestamp 포함', async () => {
    const fakeRes = { ok: true, json: async () => ({}) }
    let sentForm: FormData | null = null
    global.fetch = jest.fn().mockImplementation((_u: string, opts: any) => {
      sentForm = opts.body
      return Promise.resolve(fakeRes)
    })
    await storageUpload(env, mockFile())
    expect(sentForm!.get('timestamp')).toMatch(/^\d+$/)
    expect(sentForm!.get('signature')).toMatch(/^[0-9a-f]{40}$/) // SHA-1 hex
    expect(sentForm!.get('api_key')).toBe('key123')
  })
})

describe('storageDestroy', () => {
  const origFetch = global.fetch

  afterEach(() => {
    global.fetch = origFetch
  })

  test('성공: result ok → true + invalidate=true 전송 (CDN 캐시 무효화)', async () => {
    let sentForm: FormData | null = null
    global.fetch = jest.fn().mockImplementation((_u: string, opts: any) => {
      sentForm = opts.body
      return Promise.resolve({
        ok: true,
        json: async () => ({ result: 'ok' }),
      })
    })
    // D-1: 성공 여부를 boolean으로 알린다 (throw는 하지 않음 — 정리 경로 보호)
    await expect(storageDestroy(env, 'pid123', 'image')).resolves.toBe(true)
    const fetchMock = global.fetch as jest.Mock
    expect(fetchMock.mock.calls[0][0]).toContain('/image/destroy')
    // invalidate가 없으면 삭제 후에도 CDN 캐시가 구 평문을 서빙한다
    expect(sentForm!.get('invalidate')).toBe('true')
  })

  test('HTTP 200 + result not found → false (성공 오인 금지)', async () => {
    // resource_type 불일치 등: Cloudinary는 200에 {"result":"not found"}를 준다.
    // 본문을 보지 않으면 destroy 실패인데도 잠금 핸들러가 warning을 못 띄운다.
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: 'not found' }),
    })
    await expect(storageDestroy(env, 'pid123', 'image')).resolves.toBe(false)
  })

  test('fetch throw → throw 없이 false 반환 (호출자가 warning으로 표면화)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network'))
    await expect(storageDestroy(env, 'pid123', 'video')).resolves.toBe(false)
  })

  test('HTTP 실패 → false 반환', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 })
    await expect(storageDestroy(env, 'pid123', 'image')).resolves.toBe(false)
  })

  test('video resource_type', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: 'ok' }),
    })
    await storageDestroy(env, 'pid', 'video')
    const fetchMock = global.fetch as jest.Mock
    expect(fetchMock.mock.calls[0][0]).toContain('/video/destroy')
  })
})

describe('thumbUrl', () => {
  test('URL 포맷', () => {
    expect(thumbUrl('mycloud', 'folder/abc')).toBe(
      'https://res.cloudinary.com/mycloud/image/upload/w_600,c_limit,q_auto,f_auto/folder/abc'
    )
  })
})
