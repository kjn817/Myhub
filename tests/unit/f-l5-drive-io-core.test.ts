/// <reference types="jest" />
/**
 * F-L5 drive-io 공용 코어 단위 테스트 (5-5)
 *
 * 검증 성질 (깨지면 실패해야 한다):
 * - uploadDriveFile은 FormData(files 파트 + folder_id) POST 후
 *   saved(files[0])를 확정한다. folder_id가 없으면 파트를 안 붙인다.
 * - 오류 문구는 label로 갈린다 ('create http'/'create shape' vs
 *   'import http'/'import shape') — finder·office·가져오기 세 호출처의
 *   문구가 코어 한 곳에서 나온다.
 * - resolveDriveFileVersion은 목록에서 행을 찾아 version 또는 null을
 *   낸다. 목록 조회 실패는 전파한다 (호출처 catch가 처리한다).
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const driveIo = require('../../public/js/common/drive-io.js')

function resOk(body: any, status = 200) {
  return { ok: true, status, json: async () => body }
}
function resFail(status: number, body: any = null) {
  return { ok: false, status, json: async () => body }
}

describe('drive-io uploadDriveFile', () => {
  test('성공 시 saved를 반환하고 files·folder_id 파트를 보낸다', async () => {
    let seenUrl = ''
    let seenOpts: any = null
    const fetchFn = jest.fn(async (url: string, opts: any) => {
      seenUrl = url
      seenOpts = opts
      return resOk({ ok: true, files: [{ id: 7, filename: 'a.txt' }] })
    })
    const blob = new Blob(['x'], { type: 'text/plain' })
    const saved = await driveIo.uploadDriveFile(fetchFn, blob, 'a.txt', 3, 'create')
    expect(saved).toEqual({ id: 7, filename: 'a.txt' })
    expect(seenUrl).toBe('/api/drive/files')
    expect(seenOpts.method).toBe('POST')
    expect(seenOpts.body).toBeInstanceOf(FormData)
    const sentFile = seenOpts.body.get('files') as File
    expect(sentFile).toBeInstanceOf(Blob)
    expect(sentFile.name).toBe('a.txt')
    expect(sentFile.size).toBe(1)
    expect(seenOpts.body.get('folder_id')).toBe('3')
  })

  test('folderId가 없으면 folder_id 파트를 붙이지 않는다', async () => {
    let seenBody: any = null
    const fetchFn = jest.fn(async (_u: string, opts: any) => {
      seenBody = opts.body
      return resOk({ ok: true, files: [{ id: 1 }] })
    })
    await driveIo.uploadDriveFile(fetchFn, new Blob(['x']), 'a.txt', null, 'create')
    expect(seenBody.get('folder_id')).toBeNull()
  })

  test('HTTP 실패 시 label http 오류를 던진다', async () => {
    const fetchFn = jest.fn(async () => resFail(500))
    await expect(
      driveIo.uploadDriveFile(fetchFn, new Blob(['x']), 'a.txt', null, 'create'),
    ).rejects.toThrow('create http 500')
    await expect(
      driveIo.uploadDriveFile(fetchFn, new Blob(['x']), 'a.txt', null, 'import'),
    ).rejects.toThrow('import http 500')
  })

  test('본문 형식이 어긋나면 label shape 오류를 던진다', async () => {
    const fetchFn = jest.fn(async () => resOk({ ok: true, files: [] }))
    await expect(
      driveIo.uploadDriveFile(fetchFn, new Blob(['x']), 'a.txt', null, 'create'),
    ).rejects.toThrow('create shape')
    const fetchFn2 = jest.fn(async () => resOk({ ok: false, error: 'nope' }))
    await expect(
      driveIo.uploadDriveFile(fetchFn2, new Blob(['x']), 'a.txt', null, 'import'),
    ).rejects.toThrow('import shape')
  })
})

describe('drive-io resolveDriveFileVersion', () => {
  test('행이 있으면 version을, 없으면 null을 낸다', async () => {
    const listFn = jest.fn(async (folderId: any) => {
      expect(folderId).toBe(3)
      return { files: [{ id: 7, version: 'v9' }, { id: 8, version: 'v1' }] }
    })
    await expect(driveIo.resolveDriveFileVersion(listFn, 3, 7)).resolves.toBe('v9')
    await expect(driveIo.resolveDriveFileVersion(listFn, 3, 99)).resolves.toBeNull()
  })

  test('목록이 null이면 null을 낸다 (finder의 !ok 경로)', async () => {
    const listFn = jest.fn(async () => null)
    await expect(driveIo.resolveDriveFileVersion(listFn, null, 7)).resolves.toBeNull()
  })

  test('version이 없는 행이면 null을 낸다', async () => {
    const listFn = jest.fn(async () => ({ files: [{ id: 7 }] }))
    await expect(driveIo.resolveDriveFileVersion(listFn, null, 7)).resolves.toBeNull()
  })

  test('목록 조회 실패는 전파한다 (호출처가 warn·adoptError로 처리)', async () => {
    const listFn = jest.fn(async () => {
      throw new Error('list http 500')
    })
    await expect(driveIo.resolveDriveFileVersion(listFn, null, 7)).rejects.toThrow(
      'list http 500',
    )
  })
})
