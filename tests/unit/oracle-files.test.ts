/// <reference types="jest" />
/**
 * src/services/oracle-files.ts — 오라클 파일 클라이언트 성질 테스트.
 *
 * 고정하는 성질 (하이브리드 저장소 2026-11-19):
 * - 평탄 파일명만 허용한다 — 구분자·`..`·NUL·255자 초과는 요청 자체를
 *   만들지 않는다 (경로 순회 구조적 차단, 사이드카도 이중 검사).
 * - 요청은 https://<host>:8081/control/file?path=<인코딩>으로 가고,
 *   x-origin-secret + x-cdp-secret 이중 헤더를 싣는다.
 * - 미구성(호스트·시크릿 누락)·네트워크 실패는 null/{ok:false, status:0}
 *   으로 떨어지고, 호출자가 502로 매핑한다.
 * - GET은 Range를 그대로 전달하고 상류 응답(200/206/404)을 그대로
 *   돌려준다. PUT 404는 status 404로 구분된다. DELETE는 멱등이다.
 * 카나리아: 헤더·URL·평탄 검사를 깨면 해당 테스트가 실패한다.
 */
import {
  ORACLE_FILE_PORT,
  deleteOracleFile,
  fetchOracleFile,
  isFlatFilename,
  oracleFileConfigOf,
  putOracleFile,
} from '../../src/services/oracle-files'

const ENV = {
  ORACLE_BROWSER_HOST: 'oracle.test',
  ORIGIN_SECRET: 'origin-secret-16',
  CDP_SECRET: 'cdp-secret-16',
} as never

type FetchCall = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: unknown } }

function recordingFetch(
  respond: (call: FetchCall) => Response | Promise<Response>,
): { calls: FetchCall[]; fetchFn: typeof fetch } {
  const calls: FetchCall[] = []
  const fetchFn = (async (url: unknown, init?: FetchCall['init']) => {
    const call = { url: String(url), init }
    calls.push(call)
    return respond(call)
  }) as unknown as typeof fetch
  return { calls, fetchFn }
}

describe('isFlatFilename — 평탄 파일명만 허용', () => {
  test('정상 파일명은 통과', () => {
    expect(isFlatFilename('문서.hwp')).toBe(true)
    expect(isFlatFilename('a b (1).pdf')).toBe(true)
    expect(isFlatFilename('.hidden')).toBe(true)
    expect(isFlatFilename('a'.repeat(255))).toBe(true)
  })

  test('구분자·상위 참조·NUL·빈 값·과길이는 거부', () => {
    for (const bad of ['', '.', '..', '../etc/passwd', 'a/b', 'a\\b', 'a\0b', 'a'.repeat(256), 42, null, undefined]) {
      expect(isFlatFilename(bad)).toBe(false)
    }
  })
})

describe('oracleFileConfigOf — 세 값 중 하나라도 없으면 null', () => {
  test('전부 있으면 설정, 하나라도 없으면 null', () => {
    expect(oracleFileConfigOf(ENV)).toEqual({
      host: 'oracle.test',
      originSecret: 'origin-secret-16',
      cdpSecret: 'cdp-secret-16',
    })
    expect(oracleFileConfigOf({} as never)).toBeNull()
    expect(oracleFileConfigOf({ ORACLE_BROWSER_HOST: 'h', ORIGIN_SECRET: 'o' } as never)).toBeNull()
    expect(oracleFileConfigOf({ ORACLE_BROWSER_HOST: 'h', CDP_SECRET: 'c' } as never)).toBeNull()
    expect(oracleFileConfigOf({ ORIGIN_SECRET: 'o', CDP_SECRET: 'c' } as never)).toBeNull()
  })
})

describe('fetchOracleFile — GET + Range + 이중 헤더', () => {
  test('URL·포트·이중 헤더·인코딩이 정확하다', async () => {
    const { calls, fetchFn } = recordingFetch(async () => new Response('bytes', { status: 200 }))
    const res = await fetchOracleFile(ENV, '큰 문서.hwp', null, fetchFn)
    expect(res?.status).toBe(200)
    expect(await res?.text()).toBe('bytes')
    expect(ORACLE_FILE_PORT).toBe(8081)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://oracle.test:8081/control/file?path=%ED%81%B0%20%EB%AC%B8%EC%84%9C.hwp')
    expect(calls[0].init?.headers).toEqual({
      'x-origin-secret': 'origin-secret-16',
      'x-cdp-secret': 'cdp-secret-16',
    })
  })

  test('Range가 있으면 그대로 전달하고, 없으면 Range 헤더가 없다', async () => {
    const { calls, fetchFn } = recordingFetch(async () => new Response('x', { status: 206 }))
    await fetchOracleFile(ENV, 'a.mp4', 'bytes=0-99', fetchFn)
    expect(calls[0].init?.headers?.['Range']).toBe('bytes=0-99')
    await fetchOracleFile(ENV, 'a.mp4', null, fetchFn)
    expect(calls[1].init?.headers?.['Range']).toBeUndefined()
    await fetchOracleFile(ENV, 'a.mp4', undefined, fetchFn)
    expect(calls[2].init?.headers?.['Range']).toBeUndefined()
  })

  test('상류 404·206은 그대로 돌려주고, 네트워크 실패·미구성·나쁜 경로는 null', async () => {
    const { fetchFn } = recordingFetch(async () => new Response('gone', { status: 404 }))
    const gone = await fetchOracleFile(ENV, 'a.hwp', null, fetchFn)
    expect(gone?.status).toBe(404)
    const throwing = (async () => {
      throw new Error('down')
    }) as unknown as typeof fetch
    expect(await fetchOracleFile(ENV, 'a.hwp', null, throwing)).toBeNull()
    const { calls, fetchFn: good } = recordingFetch(async () => new Response('x'))
    expect(await fetchOracleFile({} as never, 'a.hwp', null, good)).toBeNull()
    expect(await fetchOracleFile(ENV, '../etc/passwd', null, good)).toBeNull()
    expect(calls).toHaveLength(0)
  })
})

describe('putOracleFile — PUT + mime + 404 구분', () => {
  test('PUT 바이트·mime·이중 헤더가 전달되고 성공 시 ok', async () => {
    const { calls, fetchFn } = recordingFetch(async () => new Response('{}', { status: 200 }))
    const bytes = new TextEncoder().encode('new-content')
    const r = await putOracleFile(ENV, '편집.hwp', bytes, 'application/x-hwp', fetchFn)
    expect(r).toEqual({ ok: true, status: 200 })
    expect(calls).toHaveLength(1)
    expect(calls[0].init?.method).toBe('PUT')
    expect(calls[0].init?.headers?.['content-type']).toBe('application/x-hwp')
    expect(calls[0].init?.headers?.['x-origin-secret']).toBe('origin-secret-16')
    expect(new TextDecoder().decode(calls[0].init?.body as Uint8Array)).toBe('new-content')
  })

  test('mime이 없으면 content-type 헤더가 없다', async () => {
    const { calls, fetchFn } = recordingFetch(async () => new Response('{}', { status: 200 }))
    await putOracleFile(ENV, 'a.hwp', new Uint8Array([1]), undefined, fetchFn)
    expect(calls[0].init?.headers?.['content-type']).toBeUndefined()
  })

  test('상류 404는 status 404, 500은 ok:false, 실패·미구성·나쁜 경로는 status 0', async () => {
    const { fetchFn: notFound } = recordingFetch(async () => new Response('gone', { status: 404 }))
    expect(await putOracleFile(ENV, 'a.hwp', new Uint8Array([1]), null, notFound)).toEqual({ ok: false, status: 404 })
    const { fetchFn: broken } = recordingFetch(async () => new Response('err', { status: 500 }))
    expect(await putOracleFile(ENV, 'a.hwp', new Uint8Array([1]), null, broken)).toEqual({ ok: false, status: 500 })
    const throwing = (async () => {
      throw new Error('down')
    }) as unknown as typeof fetch
    expect(await putOracleFile(ENV, 'a.hwp', new Uint8Array([1]), null, throwing)).toEqual({ ok: false, status: 0 })
    const { calls, fetchFn: good } = recordingFetch(async () => new Response('{}'))
    expect(await putOracleFile({} as never, 'a.hwp', new Uint8Array([1]), null, good)).toEqual({ ok: false, status: 0 })
    expect(await putOracleFile(ENV, 'a/b', new Uint8Array([1]), null, good)).toEqual({ ok: false, status: 0 })
    expect(calls).toHaveLength(0)
  })
})

describe('deleteOracleFile — DELETE 멱등', () => {
  test('성공·404 모두 ok:true, 500·실패·미구성·나쁜 경로는 ok:false', async () => {
    const { calls, fetchFn: okFn } = recordingFetch(async () => new Response('{}', { status: 200 }))
    expect(await deleteOracleFile(ENV, '지울.hwp', okFn)).toEqual({ ok: true })
    expect(calls[0].init?.method).toBe('DELETE')
    expect(calls[0].init?.headers?.['x-cdp-secret']).toBe('cdp-secret-16')
    const { fetchFn: gone } = recordingFetch(async () => new Response('gone', { status: 404 }))
    expect(await deleteOracleFile(ENV, '지울.hwp', gone)).toEqual({ ok: true })
    const { fetchFn: broken } = recordingFetch(async () => new Response('err', { status: 500 }))
    expect(await deleteOracleFile(ENV, '지울.hwp', broken)).toEqual({ ok: false })
    const throwing = (async () => {
      throw new Error('down')
    }) as unknown as typeof fetch
    expect(await deleteOracleFile(ENV, '지울.hwp', throwing)).toEqual({ ok: false })
    const { calls: noCalls, fetchFn: good } = recordingFetch(async () => new Response('{}'))
    expect(await deleteOracleFile({} as never, '지울.hwp', good)).toEqual({ ok: false })
    expect(await deleteOracleFile(ENV, '..', good)).toEqual({ ok: false })
    expect(noCalls).toHaveLength(0)
  })
})
