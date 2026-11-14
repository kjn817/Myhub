/// <reference types="jest" />
/**
 * public/js/common/text-utils.js — 유틸 4~5중복 통합 코어 단위 테스트 (5-4 F-L3).
 *
 * 고정하는 성질 (설계 노트 .scratch/f-l3-utils-design.md):
 * - esc는 5문자 버전(& < > " ') — memo본만 4자였는데 5자로 올린다.
 *   null/undefined는 ''로, 숫자 0은 '0'으로 (4개 사본의 다수 동작).
 * - friendlyError는 풀 패턴 버전: 위임(window.friendlyErrorMessage) +
 *   fail-safe(http_\d{3}·서버 오류 (NNN)·snake_case·SNAKE_CASE·
 *   ALL-CAPS 2자 이상, trim, input.message 폴백). chat본에만 없던
 *   패턴·trim·message 폴백을 채운다. 위임 분기는 5-4에서 유지한다
 *   (제거는 6단계 D5에서 이 파일 한 곳에만 적용).
 * 카나리아: esc를 4자로 되돌리면 ' 이스케이프 테스트가, chat본 패턴
 * (snake/SNAKE만)으로 되돌리면 http_/서버 오류/ALL-CAPS·trim·message
 * 테스트가 실패한다.
 */
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..', '..')
const CORE_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'common', 'text-utils.js'), 'utf-8')

function loadCore(win: any = {}): any {
  const moduleObj: any = { exports: {} }
  const fn = new Function('window', 'document', 'navigator', 'setTimeout', 'module', CORE_SRC)
  fn(win, undefined, undefined, setTimeout, moduleObj)
  return win.MyHubTextUtils || moduleObj.exports
}

describe('text-utils 코어 — esc (5문자)', () => {
  const core = loadCore()

  it.each([
    ['&', '&amp;'],
    ['<', '&lt;'],
    ['>', '&gt;'],
    ['"', '&quot;'],
    ["'", '&#39;'],
  ])('%s → %s', (input, expected) => {
    expect(core.esc(input)).toBe(expected)
  })

  it('5문자가 섞인 문자열을 한 번에 이스케이프한다', () => {
    expect(core.esc(`<a href="x">'&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;')
  })

  it('null·undefined는 빈 문자열로 만든다', () => {
    expect(core.esc(null)).toBe('')
    expect(core.esc(undefined)).toBe('')
  })

  it('숫자 0은 0으로 만든다 (다수 사본의 동작 — chat본의 || 폴백과 다름)', () => {
    expect(core.esc(0)).toBe('0')
    expect(core.esc(123)).toBe('123')
  })

  it('빈 문자열·일반 텍스트는 그대로 둔다', () => {
    expect(core.esc('')).toBe('')
    expect(core.esc('안녕하세요 메모')).toBe('안녕하세요 메모')
  })

  it('이미 이스케이프된 입력은 &를 다시 이스케이프한다 (이중 이스케이프)', () => {
    expect(core.esc('&amp;')).toBe('&amp;amp;')
  })
})

describe('text-utils 코어 — friendlyError (풀 패턴)', () => {
  const FALLBACK = '잠시 후 다시 시도해 주세요.'
  let warnSpy: jest.SpyInstance

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('위임 함수가 있으면 그 결과를 그대로 반환한다', () => {
    const win: any = {}
    const core = loadCore(win)
    const delegate = jest.fn((input: any, fb: any) => `맵:${String(input)}:${fb}`)
    win.friendlyErrorMessage = delegate
    expect(core.friendlyError('decrypt_failed', FALLBACK)).toBe(`맵:decrypt_failed:${FALLBACK}`)
    expect(delegate).toHaveBeenCalledWith('decrypt_failed', FALLBACK)
  })

  it('위임 함수가 던지면 fail-safe로 폴백한다', () => {
    const win: any = {}
    const core = loadCore(win)
    win.friendlyErrorMessage = () => {
      throw new Error('맵 고장')
    }
    expect(core.friendlyError('decrypt_failed', FALLBACK)).toBe(FALLBACK)
    expect(core.friendlyError('일반 문구', FALLBACK)).toBe('일반 문구')
    expect(warnSpy).toHaveBeenCalledWith('오류 문구 변환 실패:', expect.any(Error))
  })

  it.each([
    'http_500',
    'HTTP_404',
    '서버 오류 (500)',
    '서버 오류(404)',
    'decrypt_failed',
    'DECRYPT_FAILED',
    'AB',
    'ABC',
  ])('코드 패턴 %s → 폴백', (input) => {
    const core = loadCore()
    expect(core.friendlyError(input, FALLBACK)).toBe(FALLBACK)
  })

  it('코드 감지 시 콘솔에 오류 코드를 남긴다', () => {
    const core = loadCore()
    core.friendlyError('decrypt_failed', FALLBACK)
    expect(warnSpy).toHaveBeenCalledWith('[MyHub] 오류 코드:', 'decrypt_failed')
  })

  it('일반 문구·한 단어는 그대로 반환한다', () => {
    const core = loadCore()
    expect(core.friendlyError('잠시 후 다시 시도해 주세요.', FALLBACK)).toBe('잠시 후 다시 시도해 주세요.')
    expect(core.friendlyError('hello', FALLBACK)).toBe('hello')
    expect(core.friendlyError('a', FALLBACK)).toBe('a')
    expect(core.friendlyError('Error!', FALLBACK)).toBe('Error!')
  })

  it('앞뒤 공백이 있는 코드는 trim 후 패턴에 걸린다', () => {
    const core = loadCore()
    expect(core.friendlyError('  decrypt_failed  ', FALLBACK)).toBe(FALLBACK)
  })

  it('일반 문구는 trim 없이 원문 그대로 반환한다', () => {
    const core = loadCore()
    expect(core.friendlyError('  일반 문구  ', FALLBACK)).toBe('  일반 문구  ')
  })

  it('input.message 폴백을 쓴다 (chat본 누락분)', () => {
    const core = loadCore()
    expect(core.friendlyError({ message: 'decrypt_failed' }, FALLBACK)).toBe(FALLBACK)
    expect(core.friendlyError({ message: '일반 문구' }, FALLBACK)).toBe('일반 문구')
  })

  it('input.error 객체의 code·message를 읽는다', () => {
    const core = loadCore()
    expect(core.friendlyError({ error: { code: 'decrypt_failed' } }, FALLBACK)).toBe(FALLBACK)
    expect(core.friendlyError({ error: { message: '일반 문구' } }, FALLBACK)).toBe('일반 문구')
    expect(core.friendlyError({ error: { code: '', message: '일반 문구' } }, FALLBACK)).toBe('일반 문구')
  })

  it('input.error 문자열·input.code를 읽는다', () => {
    const core = loadCore()
    expect(core.friendlyError({ error: 'decrypt_failed' }, FALLBACK)).toBe(FALLBACK)
    expect(core.friendlyError({ error: '일반 문구' }, FALLBACK)).toBe('일반 문구')
    expect(core.friendlyError({ code: 'decrypt_failed' }, FALLBACK)).toBe(FALLBACK)
  })

  it('null·undefined·숫자·빈 문자열 입력은 폴백을 반환한다', () => {
    const core = loadCore()
    expect(core.friendlyError(null, FALLBACK)).toBe(FALLBACK)
    expect(core.friendlyError(undefined, FALLBACK)).toBe(FALLBACK)
    expect(core.friendlyError(123, FALLBACK)).toBe(FALLBACK)
    expect(core.friendlyError('', FALLBACK)).toBe(FALLBACK)
    expect(core.friendlyError({}, FALLBACK)).toBe(FALLBACK)
  })

  it('window 전역과 module.exports 양쪽으로 노출된다', () => {
    const win: any = {}
    const moduleObj: any = { exports: {} }
    const fn = new Function('window', 'document', 'navigator', 'setTimeout', 'module', CORE_SRC)
    fn(win, undefined, undefined, setTimeout, moduleObj)
    expect(win.MyHubTextUtils.esc).toBe(moduleObj.exports.esc)
    expect(win.MyHubTextUtils.friendlyError).toBe(moduleObj.exports.friendlyError)
  })
})
