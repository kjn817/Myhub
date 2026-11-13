/**
 * @jest-environment jsdom
 */
/// <reference types="jest" />
/**
 * 5-2 F-L6 메모 파일 칩 다운로드 핸들러 통합 (2026-11-14).
 *
 * 검증하는 성질 (깨지면 실패해야 한다):
 * - downloadMemoFile이 두 호출처(list.js·pane.js)의 구 동작과 동일하다:
 *   잠금 파일은 /api/memo/files/{id}/content를 _fetchStepUp으로,
 *   일반 파일은 f.url을 fetch로 받는다. 성공 시 blob URL 앵커를
 *   download=파일명으로 클릭하고 1초 뒤 revoke한다.
 * - 실패 시 분기가 유지된다: 잠금 파일은 토스트(PIN 안내)만, 일반
 *   파일은 원본 URL을 새 탭으로 연다. !ok 응답도 같은 실패 경로다.
 * - 중복 본문이 사라졌다: list.js·pane.js에는 호출만 남고 핸들러
 *   본문(download_failed·createObjectURL)이 없으며, 정의는
 *   utils.js에 1개뿐이다. 번들도 같은 상태다 (소스-번들 동기).
 *
 * 카나리아: utils.js의 잠금 URL을 f.url로 바꾸면 잠금 테스트가
 * 실패하고, 실패 분기를 뒤집으면 실패 경로 테스트가 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
const win = (): any => (globalThis as any).window
const doc = (): any => (globalThis as any).document

const UTILS_SRC = read('public/js/memo/utils.js')

function loadUtils() {
  const w = win()
  w.toast = jest.fn()
  w.open = jest.fn()
  w.fetch = jest.fn()
  w._fetchStepUp = jest.fn()
  w.URL.createObjectURL = jest.fn(() => 'blob:fake-url')
  w.URL.revokeObjectURL = jest.fn()
  w.eval(UTILS_SRC)
  return w.downloadMemoFile as (f: any) => Promise<void>
}

const okResp = () => ({ ok: true, blob: async () => new Blob(['x']) })

describe('downloadMemoFile 동작 (구 핸들러와 동일)', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
    doc().body.innerHTML = ''
  })

  it('일반 파일은 f.url을 fetch로 받아 blob 앵커를 파일명으로 다운로드한다', async () => {
    const download = loadUtils()
    const w = win()
    const clickSpy = jest.spyOn(w.HTMLAnchorElement.prototype, 'click')
    w.fetch.mockResolvedValue(okResp())
    const f = { id: 7, url: 'https://cdn.example.com/a.pdf', filename: 'a.pdf', is_locked: false }

    await download(f)

    expect(w.fetch).toHaveBeenCalledWith('https://cdn.example.com/a.pdf')
    expect(w._fetchStepUp).not.toHaveBeenCalled()
    expect(w.URL.createObjectURL).toHaveBeenCalledTimes(1)
    expect(clickSpy).toHaveBeenCalledTimes(1)
    const anchor = clickSpy.mock.instances[0] as any
    expect(anchor.href).toContain('blob:fake-url')
    expect(anchor.download).toBe('a.pdf')
    expect(doc().body.contains(anchor)).toBe(false)
    jest.advanceTimersByTime(1000)
    expect(w.URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake-url')
  })

  it('잠긴 파일은 /content 경로를 _fetchStepUp으로 받는다', async () => {
    const download = loadUtils()
    const w = win()
    jest.spyOn(w.HTMLAnchorElement.prototype, 'click')
    w._fetchStepUp.mockResolvedValue(okResp())
    const f = { id: 7, url: 'https://cdn.example.com/enc.bin', filename: 'secret.pdf', is_locked: true }

    await download(f)

    expect(w._fetchStepUp).toHaveBeenCalledWith('/api/memo/files/7/content')
    expect(w.fetch).not.toHaveBeenCalled()
  })

  it('잠긴 파일 실패 시 토스트만 띄우고 새 탭을 열지 않는다', async () => {
    const download = loadUtils()
    const w = win()
    w._fetchStepUp.mockRejectedValue(new Error('403'))
    const f = { id: 7, url: 'https://cdn.example.com/enc.bin', filename: 'secret.pdf', is_locked: true }

    await download(f)

    expect(w.toast).toHaveBeenCalledWith('파일이 열 수 없어요. PIN 확인이 필요합니다.')
    expect(w.open).not.toHaveBeenCalled()
  })

  it('일반 파일 실패 시 원본 URL을 새 탭으로 연다', async () => {
    const download = loadUtils()
    const w = win()
    w.fetch.mockRejectedValue(new Error('net'))
    const f = { id: 7, url: 'https://cdn.example.com/a.pdf', filename: 'a.pdf', is_locked: false }

    await download(f)

    expect(w.open).toHaveBeenCalledWith('https://cdn.example.com/a.pdf', '_blank')
    expect(w.toast).not.toHaveBeenCalled()
  })

  it('!ok 응답도 같은 실패 경로를 탄다 (잠금→토스트, 일반→새 탭)', async () => {
    const download = loadUtils()
    const w = win()
    w._fetchStepUp.mockResolvedValue({ ok: false })
    w.fetch.mockResolvedValue({ ok: false })

    await download({ id: 1, url: 'https://cdn.example.com/e.bin', filename: 'e.pdf', is_locked: true })
    expect(w.toast).toHaveBeenCalledTimes(1)
    expect(w.open).not.toHaveBeenCalled()

    await download({ id: 2, url: 'https://cdn.example.com/b.pdf', filename: 'b.pdf', is_locked: false })
    expect(w.open).toHaveBeenCalledWith('https://cdn.example.com/b.pdf', '_blank')
    expect(w.toast).toHaveBeenCalledTimes(1)
  })
})

describe('F-L6 중복 제거 구조', () => {
  const list = read('public/js/memo/list.js')
  const pane = read('public/js/memo/pane.js')
  const utils = read('public/js/memo/utils.js')
  const bundle = read('public/js/memo-bundle.js')

  it('list.js·pane.js에는 호출만 남고 핸들러 본문이 없다', () => {
    for (const [name, src] of [['list.js', list], ['pane.js', pane]] as const) {
      expect(src).toContain('downloadMemoFile(f)')
      expect(src).not.toContain('download_failed')
      expect(src).not.toContain('createObjectURL')
    }
  })

  it('정의는 utils.js에 1개뿐이다', () => {
    const defs = utils.match(/async function downloadMemoFile\(f\)/g) || []
    expect(defs).toHaveLength(1)
    expect(utils).toContain("'/api/memo/files/' + f.id + '/content'")
  })

  it('번들도 통합 상태를 싣는다 (정의 1개·호출 2개)', () => {
    const defs = bundle.match(/async function downloadMemoFile\(f\)/g) || []
    expect(defs).toHaveLength(1)
    const calls = bundle.match(/await downloadMemoFile\(f\)/g) || []
    expect(calls).toHaveLength(2)
    // download_failed는 헬퍼 본문에만 1회 (구 핸들러 2본문이면 2회)
    const fails = bundle.match(/download_failed/g) || []
    expect(fails).toHaveLength(1)
  })
})
