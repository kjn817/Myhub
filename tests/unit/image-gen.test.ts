/// <reference types="jest" />
/**
 * src/services/image-gen.ts — 이미지 프로바이더 상태·발행 결정 성질 테스트.
 *
 * 핵심 성질: ① 프롬프트는 URL 인코딩되어 원문이 그대로 나가지 않는다
 * ② 발행 로그에는 프롬프트 원문이 아니라 길이만 남는다 (유출 방지)
 * ③ 상태 레코드가 없거나 깨졌으면 unknown으로 fail-soft 한다
 * ④ paywalled/error 상태에서는 발행을 막고, 그 외에는 허용한다.
 * 카나리아: decideImageEmission의 paywalled 분기를 지우거나
 * getImageProviderState의 JSON 검증( status 문자열 확인)을 빼면 실패한다.
 */
import {
  POLLINATIONS_IMAGE_BASE,
  UNKNOWN_IMAGE_STATE,
  buildPollinationsImageUrl,
  decideImageEmission,
  getImageProviderState,
  logImageUrlIssued,
  type ImageProviderState,
} from '../../src/services/image-gen'

function stubDb(row: { value: string } | null, opts: { throwOnFirst?: boolean } = {}) {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => {
          if (opts.throwOnFirst) throw new Error('db down')
          return row
        },
      }),
    }),
  } as unknown as D1Database
}

describe('buildPollinationsImageUrl', () => {
  test('프롬프트를 인코딩하고 nologo 파라미터를 붙인다', () => {
    const url = buildPollinationsImageUrl('a cat & dog? 100%')
    expect(url.startsWith(POLLINATIONS_IMAGE_BASE)).toBe(true)
    expect(url).toBe(`${POLLINATIONS_IMAGE_BASE}${encodeURIComponent('a cat & dog? 100%')}?nologo=true`)
    expect(url).not.toContain('a cat & dog')
  })

  test('한글 프롬프트도 인코딩된다', () => {
    const url = buildPollinationsImageUrl('고양이 그림')
    expect(url).not.toContain('고양이')
    expect(url).toContain(encodeURIComponent('고양이 그림'))
  })

  test('빈 프롬프트는 베이스 + 빈 세그먼트', () => {
    expect(buildPollinationsImageUrl('')).toBe(`${POLLINATIONS_IMAGE_BASE}?nologo=true`)
  })
})

describe('logImageUrlIssued', () => {
  test('프롬프트 원문이 아닌 길이만 로그에 남는다', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {})
    try {
      logImageUrlIssued('secret prompt text', 'chat')
      expect(spy).toHaveBeenCalledTimes(1)
      const [event, payload] = spy.mock.calls[0] as any[]
      expect(event).toBe('image_url_issued_unverified')
      expect(payload).toEqual({ provider: 'pollinations', surface: 'chat', promptLength: 18 })
      expect(JSON.stringify(payload)).not.toContain('secret')
    } finally {
      spy.mockRestore()
    }
  })

  test('문자열이 아닌 프롬프트는 길이 0으로 기록한다', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {})
    try {
      logImageUrlIssued(undefined as unknown as string, 'studio')
      const [, payload] = spy.mock.calls[0] as any[]
      expect(payload.promptLength).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('getImageProviderState', () => {
  test('레코드가 없으면 UNKNOWN 상태', async () => {
    await expect(getImageProviderState({ DB: stubDb(null) })).resolves.toEqual(UNKNOWN_IMAGE_STATE)
  })

  test('빈 값이면 UNKNOWN 상태', async () => {
    await expect(getImageProviderState({ DB: stubDb({ value: '' }) })).resolves.toEqual(UNKNOWN_IMAGE_STATE)
  })

  test('깨진 JSON이면 UNKNOWN 상태 (fail-soft)', async () => {
    await expect(getImageProviderState({ DB: stubDb({ value: '{not json' }) })).resolves.toEqual(
      UNKNOWN_IMAGE_STATE,
    )
  })

  test('status가 문자열이 아니면 UNKNOWN 상태', async () => {
    await expect(
      getImageProviderState({ DB: stubDb({ value: JSON.stringify({ status: 402 }) }) }),
    ).resolves.toEqual(UNKNOWN_IMAGE_STATE)
    await expect(
      getImageProviderState({ DB: stubDb({ value: JSON.stringify(null) }) }),
    ).resolves.toEqual(UNKNOWN_IMAGE_STATE)
  })

  test('DB 조회 자체가 실패해도 UNKNOWN 상태', async () => {
    await expect(
      getImageProviderState({ DB: stubDb(null, { throwOnFirst: true }) }),
    ).resolves.toEqual(UNKNOWN_IMAGE_STATE)
  })

  test('유효한 레코드는 그대로 반환한다', async () => {
    const state: ImageProviderState = {
      status: 'paywalled',
      httpStatus: 402,
      checkedAt: '2026-11-08T00:00:00.000Z',
      detail: 'payment required',
    }
    await expect(
      getImageProviderState({ DB: stubDb({ value: JSON.stringify(state) }) }),
    ).resolves.toEqual(state)
  })
})

describe('decideImageEmission', () => {
  const base: ImageProviderState = { ...UNKNOWN_IMAGE_STATE }

  test('paywalled면 발행 차단 + 사유·안내 문구', () => {
    const d = decideImageEmission({ ...base, status: 'paywalled', httpStatus: 402 })
    expect(d.emit).toBe(false)
    if (!d.emit) {
      expect(d.reason).toBe('paywalled')
      expect(d.message).toContain('402')
    }
  })

  test('error면 발행 차단 + 기록된 detail을 문구에 포함', () => {
    const d = decideImageEmission({ ...base, status: 'error', detail: 'timeout_probe' })
    expect(d.emit).toBe(false)
    if (!d.emit) {
      expect(d.reason).toBe('provider_error')
      expect(d.message).toContain('timeout_probe')
    }
  })

  test('unknown·ok 등 그 외 상태는 발행 허용', () => {
    expect(decideImageEmission(base)).toEqual({ emit: true })
    expect(decideImageEmission({ ...base, status: 'ok', httpStatus: 200 })).toEqual({ emit: true })
  })
})
