/// <reference types="jest" />
/**
 * F-L8 http-json 공용 코어 단위 테스트 (5-5)
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - res.ok && body.ok면 본문을 그대로 반환한다.
 * - 본문 파싱 실패 시 null로 보고 기본 문구로 던진다.
 * - body.error가 있으면 그 문구로 던진다.
 * - fallbackMsg 기본값은 '요청이 실패했습니다 (status)' — 기존
 *   `.then(jsonOrThrow)` 호출이 그대로 된다. 명시 인자는 그 문구를 쓴다
 *   (drop-upload의 '업로드에 실패했습니다' 경로).
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { jsonOrThrow } = require('../../public/js/common/http-json.js')

describe('http-json jsonOrThrow', () => {
  test('ok 본문이면 그대로 반환한다', async () => {
    const res = { ok: true, status: 200, json: async () => ({ ok: true, v: 1 }) }
    await expect(jsonOrThrow(res)).resolves.toEqual({ ok: true, v: 1 })
  })

  test('본문이 JSON이 아니면 기본 문구로 던진다', async () => {
    const res = {
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json')
      },
    }
    await expect(jsonOrThrow(res)).rejects.toThrow('요청이 실패했습니다 (200)')
  })

  test('body.error가 있으면 그 문구로 던진다', async () => {
    const res = {
      ok: false,
      status: 403,
      json: async () => ({ ok: false, error: '권한 없음' }),
    }
    await expect(jsonOrThrow(res)).rejects.toThrow('권한 없음')
  })

  test('오류 본문이 없으면 기본 문구에 상태를 넣는다', async () => {
    const res = { ok: false, status: 500, json: async () => ({ ok: false }) }
    await expect(jsonOrThrow(res)).rejects.toThrow('요청이 실패했습니다 (500)')
  })

  test('명시 fallbackMsg를 쓴다 (업로드 경로)', async () => {
    const res = { ok: false, status: 413, json: async () => null }
    await expect(jsonOrThrow(res, '업로드에 실패했습니다 (413)')).rejects.toThrow(
      '업로드에 실패했습니다 (413)',
    )
  })

  test('.then(jsonOrThrow) 형태로 써도 기본 문구가 적용된다', async () => {
    const res = { ok: false, status: 404, json: async () => ({ ok: false }) }
    await expect(Promise.resolve(res).then(jsonOrThrow)).rejects.toThrow(
      '요청이 실패했습니다 (404)',
    )
  })
})
